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

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLiveRefreshScheduler } from '../live-refresh-scheduler.js';

/**
 * Build a manual timer stub: `setTimeoutFn` records `{ id, fn }` pairs instead
 * of scheduling real timers, and `fireAll()` runs (and clears) whichever are
 * still pending, in registration order. Lets the debounce window be advanced
 * deterministically without fake-timer libraries.
 *
 * @returns {{ setTimeoutFn: Function, clearTimeoutFn: Function, fireAll: () => void, pendingCount: () => number }}
 */
function createManualTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeoutFn: (fn) => {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeoutFn: (id) => {
      pending.delete(id);
    },
    fireAll: () => {
      const fns = Array.from(pending.values());
      pending.clear();
      for (const fn of fns) fn();
    },
    pendingCount: () => pending.size,
  };
}

/**
 * Build a deferred promise plus its resolver, for controlling exactly when a
 * `run()` call settles.
 *
 * @returns {{ promise: Promise<*>, resolve: (value?: *) => void }}
 */
function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('a burst of marks within the debounce window collapses into one run', () => {
  const timers = createManualTimers();
  const calls = [];
  const scheduler = createLiveRefreshScheduler({
    run: (opts) => {
      calls.push(opts);
      return Promise.resolve();
    },
    debounceMs: 1000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  scheduler.mark('nodes');
  scheduler.mark('messages');
  scheduler.mark('nodes');
  assert.equal(calls.length, 0, 'run must not fire before the debounce timer elapses');
  assert.equal(timers.pendingCount(), 1, 'a burst arms exactly one timer');

  timers.fireAll();

  assert.equal(calls.length, 1);
  assert.deepEqual([...calls[0].collections].sort(), ['messages', 'nodes']);
  assert.equal(calls[0].flash, true, 'SSE-ping runs flash changed rows (VF2)');
});

test('a mark arriving while a run is in flight launches one follow-up run with the union, no extra debounce wait', async () => {
  const timers = createManualTimers();
  const calls = [];
  const deferred = [createDeferred(), createDeferred()];
  let callIndex = 0;
  const scheduler = createLiveRefreshScheduler({
    run: (opts) => {
      calls.push(opts);
      return deferred[callIndex++].promise;
    },
    debounceMs: 1000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  scheduler.mark('nodes');
  timers.fireAll();
  assert.equal(calls.length, 1);
  assert.equal(scheduler.inFlight(), scheduler.inFlight(), 'inFlight() is stable while running');

  // Two more marks land while the first run is still unresolved.
  scheduler.mark('messages');
  scheduler.mark('positions');
  assert.equal(calls.length, 1, 'a mid-flight mark must not launch a second run immediately');
  assert.equal(timers.pendingCount(), 0, 'no debounce timer is armed while a run is in flight');

  deferred[0].resolve();
  await scheduler.inFlight();
  // The finally-handler follow-up launch is synchronous with settlement, so by
  // the time the awaited promise (assigned before the follow-up runs) settles
  // the second run has already been dispatched.
  assert.equal(calls.length, 2, 'settlement launches the queued follow-up immediately');
  assert.deepEqual([...calls[1].collections].sort(), ['messages', 'positions']);

  deferred[1].resolve();
  await scheduler.inFlight();
});

test('requestFull cancels a pending debounced partial and runs with collections=null, flash=false', () => {
  const timers = createManualTimers();
  const calls = [];
  const scheduler = createLiveRefreshScheduler({
    run: (opts) => {
      calls.push(opts);
      return Promise.resolve();
    },
    debounceMs: 1000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  scheduler.mark('nodes');
  assert.equal(timers.pendingCount(), 1);

  scheduler.requestFull();

  assert.equal(timers.pendingCount(), 0, 'requestFull cancels the debounce timer');
  assert.equal(calls.length, 1, 'requestFull launches immediately when idle');
  assert.equal(calls[0].collections, null);
  assert.equal(calls[0].flash, false, 'full refreshes never flash (resync/safety-poll/unpause)');
});

test('requestFull during an in-flight run waits for it, then runs full with flash=false', async () => {
  const timers = createManualTimers();
  const calls = [];
  const deferred = [createDeferred(), createDeferred()];
  let callIndex = 0;
  const scheduler = createLiveRefreshScheduler({
    run: (opts) => {
      calls.push(opts);
      return deferred[callIndex++].promise;
    },
    debounceMs: 1000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  scheduler.mark('nodes');
  timers.fireAll();
  assert.equal(calls.length, 1);

  scheduler.requestFull();
  assert.equal(calls.length, 1, 'requestFull does not preempt an in-flight run');

  deferred[0].resolve();
  await scheduler.inFlight();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].collections, null);
  assert.equal(calls[1].flash, false);

  deferred[1].resolve();
  await scheduler.inFlight();
});

test('cancel drops pending debounced work without affecting an in-flight run', async () => {
  const timers = createManualTimers();
  const calls = [];
  const deferred = createDeferred();
  const scheduler = createLiveRefreshScheduler({
    run: (opts) => {
      calls.push(opts);
      return deferred.promise;
    },
    debounceMs: 1000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  scheduler.mark('nodes');
  timers.fireAll();
  assert.equal(calls.length, 1);

  scheduler.mark('messages');
  scheduler.cancel();
  assert.equal(scheduler.pending(), false, 'cancel clears the queued mark');

  deferred.resolve();
  await scheduler.inFlight();
  assert.equal(calls.length, 1, 'the in-flight run itself is unaffected by cancel');
});

test('pending() reflects queued timer, dirty set, and fullPending state', () => {
  const timers = createManualTimers();
  const scheduler = createLiveRefreshScheduler({
    run: () => Promise.resolve(),
    debounceMs: 1000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  assert.equal(scheduler.pending(), false);
  scheduler.mark('nodes');
  assert.equal(scheduler.pending(), true);
  scheduler.cancel();
  assert.equal(scheduler.pending(), false);
});

test('flush() launches a pending debounced run immediately, skipping the wait', async () => {
  const timers = createManualTimers();
  const calls = [];
  const scheduler = createLiveRefreshScheduler({
    run: (opts) => {
      calls.push(opts);
      return Promise.resolve();
    },
    debounceMs: 1000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  scheduler.mark('nodes');
  assert.equal(calls.length, 0);
  scheduler.flush();
  assert.equal(calls.length, 1);
  assert.equal(timers.pendingCount(), 0, 'flush also clears the now-redundant timer');
  await scheduler.inFlight();
});

test('flush() is a no-op when nothing is queued or a run is already in flight', async () => {
  const timers = createManualTimers();
  const calls = [];
  const deferred = createDeferred();
  const scheduler = createLiveRefreshScheduler({
    run: (opts) => {
      calls.push(opts);
      return deferred.promise;
    },
    debounceMs: 1000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  scheduler.flush();
  assert.equal(calls.length, 0, 'flush with nothing queued does not run');

  scheduler.requestFull();
  assert.equal(calls.length, 1);
  scheduler.flush();
  assert.equal(calls.length, 1, 'flush while running does not launch a second run');

  deferred.resolve();
  await scheduler.inFlight();
});

test('a synchronous throw from run() rejects inFlight() instead of escaping the scheduler', async () => {
  const timers = createManualTimers();
  const scheduler = createLiveRefreshScheduler({
    run: () => {
      throw new Error('boom');
    },
    debounceMs: 1000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  scheduler.requestFull();
  await assert.rejects(() => scheduler.inFlight(), /boom/);
});

test('createLiveRefreshScheduler requires a run function', () => {
  assert.throws(() => createLiveRefreshScheduler({ debounceMs: 100 }), TypeError);
});
