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
 * Per-node row grouping index for the position/telemetry accumulators
 * (issue: frontend perf regression, Phase 8).
 *
 * `rebuildNodeDerivedState()` re-aggregates *every* node on every call —
 * `aggregatePositionSnapshots(allPositionEntries)` and
 * `aggregateTelemetrySnapshots(allTelemetryEntries)` each re-group the *whole*
 * accumulator by node id from scratch, an O(all rows) scan even when a single
 * node's single packet is the only thing that changed. On a busy instance
 * with thousands of nodes and days of packet history, that per-tick full
 * regroup dominates a live refresh's cost.
 *
 * This index maintains the same node-id grouping incrementally so a caller
 * that already knows *which* node ids were touched this tick (`main.js`'s
 * `collectNodeIds(incomingNodes, incomingPositions, incomingTelemetry)`, the
 * same set the live-flash path already computes) can fetch just those nodes'
 * row lists in O(touched) instead of re-scanning the full accumulator.
 *
 * The index is deliberately *not* the source of truth — `allPositionEntries`/
 * `allTelemetryEntries` remain that, and still get their own window-trimmed
 * merge every tick ({@link module:incremental-helpers.mergeAndTrim}). Between
 * full {@link rebuild} calls this index can accumulate a few rows past what a
 * window trim would keep; that's harmless for both consumers
 * (`aggregatePositionSnapshots` only ever uses the newest N per node,
 * and `aggregateTelemetrySnapshots` takes the newest non-null value per
 * field regardless of how many older rows are also present) and is
 * reconciled exactly on the next full {@link rebuild}. An
 * indexed-collection abstraction that replaces the flat `all*` arrays
 * outright (making this index the source of truth) is an explicit
 * follow-up, not this phase.
 *
 * @module main/node-snapshot-index
 */

/**
 * Create an empty per-key row index.
 *
 * @param {(row: Object) => *} keyOf Resolves a row's grouping key (typically
 *   a node id); a row whose key resolves to `null`/`undefined` is skipped.
 * @returns {{
 *   rebuild: (rows: Array<Object>) => void,
 *   addRows: (rows: Array<Object>) => void,
 *   get: (key: *) => Array<Object>,
 *   has: (key: *) => boolean,
 * }} Index API.
 */
export function createSnapshotIndex(keyOf) {
  /** @type {Map<*, Array<Object>>} */
  const byKey = new Map();

  /**
   * Fully resync the index from a complete row array — clears every existing
   * group first, so a row present in the index but no longer in `rows` (e.g.
   * evicted by a window trim) is dropped. Call this whenever the caller just
   * did (or is about to do) a full, unconditional re-derive: the initial
   * load, a resync, or a backfill flush — the same situations that pass no
   * `touchedNodeIds` to `rebuildNodeDerivedState`.
   *
   * @param {Array<Object>} rows Complete row set to index.
   * @returns {void}
   */
  function rebuild(rows) {
    byKey.clear();
    if (!Array.isArray(rows)) return;
    addRows(rows);
  }

  /**
   * Append rows to their key's group without touching any other group —
   * the cheap, common-case path for a live incremental tick's delta rows.
   *
   * @param {Array<Object>} rows Rows to add.
   * @returns {void}
   */
  function addRows(rows) {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const key = keyOf(row);
      if (key == null) continue;
      let list = byKey.get(key);
      if (!list) {
        list = [];
        byKey.set(key, list);
      }
      list.push(row);
    }
  }

  /**
   * Fetch the rows currently grouped under `key`.
   *
   * @param {*} key Grouping key.
   * @returns {Array<Object>} The group's rows (a live reference — do not
   *   mutate), or an empty array when the key has no group.
   */
  function get(key) {
    return byKey.get(key) || [];
  }

  /**
   * Whether `key` currently has a (non-empty) group.
   *
   * @param {*} key Grouping key.
   * @returns {boolean} True when the key has at least one indexed row.
   */
  function has(key) {
    return byKey.has(key);
  }

  return { rebuild, addRows, get, has };
}
