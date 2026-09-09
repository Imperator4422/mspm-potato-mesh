/*
 * Copyright © 2025-26 l5yth & contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Live-refresh coalescing scheduler.
 *
 * The SSE live-update stream can ping several times within a debounce window,
 * and the safety poll / resync / unpause paths can also request a refresh
 * while an SSE-driven fetch is still in flight. Without a guard, an overlapping
 * refresh starts a second `fetch` set before the first has applied its
 * response, doubling network + render work under load and racing two deltas
 * against the same mutable state (issue: frontend perf regression). This
 * module owns only the "when to run" decision — the actual fetch/merge/render
 * work is injected as `run()` — so it stays pure and independently testable.
 *
 * Two kinds of request are tracked:
 * - `mark(collection)`: a targeted SSE ping for one collection. Debounced;
 *   a burst of pings within `debounceMs` collapses into one run covering the
 *   union of dirty collections.
 * - `requestFull()`: an unconditional full refresh (resync, safety poll,
 *   unpause). Never flashes rows (SPEC VF2 reserves flashing for the SSE-ping
 *   path only) and always wins over a pending partial: once any full request
 *   is queued, the next run fetches everything.
 *
 * A request that arrives while a run is already in flight is not fetched
 * immediately — the in-flight run must finish and apply its result to
 * `nodesById`/`allMessages`/etc. first (CR-A1: renders never race the merge
 * they read from). Instead it is recorded and the scheduler immediately
 * launches a follow-up run the moment the in-flight one settles, with no
 * additional debounce wait, so a burst that arrives mid-fetch is not delayed
 * by a full `debounceMs` on top of the fetch it was already waiting on.
 *
 * @module main/live-refresh-scheduler
 */

/**
 * Create a live-refresh scheduler.
 *
 * @param {{
 *   run: (opts: { collections: ?Set<string>, flash: boolean }) => Promise<*>,
 *   debounceMs: number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} params Scheduler configuration.
 * @param {(opts: { collections: ?Set<string>, flash: boolean }) => Promise<*>} params.run
 *   Executes one refresh for the given options; `collections === null` means
 *   "refresh everything". Its returned promise is awaited before any queued
 *   follow-up run launches.
 * @param {number} params.debounceMs Delay before a partial (`mark`-driven) run
 *   fires, coalescing a burst of same-window pings into one run.
 * @param {typeof setTimeout} [params.setTimeoutFn] Injectable timer (tests).
 * @param {typeof clearTimeout} [params.clearTimeoutFn] Injectable timer (tests).
 * @returns {{
 *   mark: (collection: string) => void,
 *   requestFull: () => void,
 *   flush: () => void,
 *   cancel: () => void,
 *   inFlight: () => Promise<*>,
 *   pending: () => boolean,
 * }} Scheduler handle.
 */
export function createLiveRefreshScheduler({
  run,
  debounceMs,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  if (typeof run !== 'function') {
    throw new TypeError('createLiveRefreshScheduler requires a run function');
  }

  /** @type {Set<string>} Collections marked dirty since the last launch. */
  const dirty = new Set();
  /** Whether an unconditional full refresh has been requested. */
  let fullPending = false;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** Whether a `run()` call is currently unresolved. */
  let running = false;
  /** Promise of the most recent `run()` call (test hook / awaited by callers). */
  let inFlightPromise = Promise.resolve();

  /**
   * True while a partial or full request is queued but not yet launched.
   *
   * @returns {boolean} Whether a follow-up run is pending.
   */
  function hasPendingRequest() {
    return fullPending || dirty.size > 0;
  }

  /**
   * Clear any armed debounce timer.
   *
   * @returns {void}
   */
  function clearTimer() {
    if (timer != null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  /**
   * Launch a run for the currently queued request, snapshotting and clearing
   * the queue first so requests arriving during the run start a fresh batch.
   *
   * @returns {void}
   */
  function launch() {
    clearTimer();
    const isFull = fullPending;
    const collections = isFull ? null : new Set(dirty);
    dirty.clear();
    fullPending = false;
    running = true;
    // Full runs (resync/safety-poll/unpause) never flash — flashing is
    // reserved for the SSE-ping path (SPEC VF2). `run` is called synchronously
    // (callers rely on a requestFull()/flush() launch dispatching the fetch
    // before the current turn ends) but wrapped in try/catch so a synchronous
    // throw rejects `inFlightPromise` instead of escaping `launch`.
    let result;
    try {
      result = run({ collections, flash: !isFull });
    } catch (error) {
      result = Promise.reject(error);
    }
    inFlightPromise = Promise.resolve(result).finally(() => {
      running = false;
      // A request that arrived mid-run launches immediately, with no extra
      // debounce wait on top of the fetch it already waited through.
      if (hasPendingRequest()) launch();
    });
  }

  /**
   * Flag a collection dirty and arm the debounce timer if nothing is already
   * scheduled or in flight.
   *
   * @param {string} collection Changed collection name.
   * @returns {void}
   */
  function mark(collection) {
    dirty.add(collection);
    if (running || timer != null) return;
    timer = setTimeoutFn(() => {
      timer = null;
      launch();
    }, debounceMs);
  }

  /**
   * Request an unconditional full refresh, cancelling any debounced partial
   * run in favour of it. Launches immediately when nothing is in flight;
   * otherwise waits for the in-flight run to settle.
   *
   * @returns {void}
   */
  function requestFull() {
    fullPending = true;
    clearTimer();
    if (!running) launch();
  }

  /**
   * Launch the pending request immediately, skipping the remainder of any
   * debounce wait. No-op when nothing is queued or a run is already in
   * flight (the in-flight run's completion will pick it up).
   *
   * @returns {void}
   */
  function flush() {
    if (running) return;
    if (timer != null || hasPendingRequest()) launch();
  }

  /**
   * Cancel any armed timer and drop pending (not yet launched) requests.
   * Does not affect a run already in flight.
   *
   * @returns {void}
   */
  function cancel() {
    clearTimer();
    dirty.clear();
    fullPending = false;
  }

  return {
    mark,
    requestFull,
    flush,
    cancel,
    inFlight: () => inFlightPromise,
    pending: () => timer != null || hasPendingRequest(),
  };
}
