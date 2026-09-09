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
 * Diffing cache for map neighbor-line polylines (issue: frontend perf
 * regression, Phase 5).
 *
 * `renderMap` used to `clearLayers()` the whole neighbor-lines layer and
 * recreate every polyline on every render that touched the map — full DOM/SVG
 * churn even when every segment was pixel-identical to the previous render.
 * This cache keeps one entry per `sourceId→targetId` direction and, given the
 * newly computed {@link module:main/neighbor-segments} output, only removes
 * the directions no longer present and only recreates the ones whose
 * {@link module:main/neighbor-segments~signature} actually changed —
 * unchanged segments keep their existing Leaflet polyline (and its bound
 * click handler/overlay state) untouched.
 *
 * @module main/neighbor-line-cache
 */

/**
 * Build a `sourceId→targetId` cache key for a segment.
 *
 * @param {{ sourceId: string, targetId: string }} segment Segment (or
 *   segment-shaped object) to key.
 * @returns {string} Direction key.
 */
function directionKey(segment) {
  return `${segment.sourceId}→${segment.targetId}`;
}

/**
 * Create an empty neighbor-line cache.
 *
 * @returns {{ sync: Function, size: () => number, clear: () => void }} Cache API.
 */
export function createNeighborLineCache() {
  /** @type {Map<string, { signature: string, layer: * }>} */
  const entries = new Map();

  /**
   * Reconcile the cache against a fresh set of segments: create a layer for
   * every new direction, recreate it for every direction whose signature
   * changed, remove it for every direction no longer present, and leave every
   * unchanged direction's layer untouched.
   *
   * @param {Array<{ sourceId: string, targetId: string, signature: string }>} segments
   *   Freshly computed segments (see {@link module:main/neighbor-segments}).
   * @param {{
   *   create: (segment: Object) => *,
   *   remove: (layer: *) => void,
   * }} handlers `create` builds (and adds to the map) the Leaflet layer for a
   *   segment, returning it for the cache to hold; `remove` detaches a
   *   previously-created layer (a direction that changed or disappeared).
   * @returns {{ created: number, removed: number, kept: number }} Counts of
   *   what happened this sync, for tests/instrumentation.
   */
  function sync(segments, { create, remove }) {
    const list = Array.isArray(segments) ? segments : [];
    const seen = new Set();
    let created = 0;
    let kept = 0;
    for (const segment of list) {
      if (!segment) continue;
      const key = directionKey(segment);
      seen.add(key);
      const existing = entries.get(key);
      if (existing && existing.signature === segment.signature) {
        kept += 1;
        continue;
      }
      if (existing) {
        remove(existing.layer);
      }
      const layer = create(segment);
      entries.set(key, { signature: segment.signature, layer });
      created += 1;
    }
    let removed = 0;
    for (const [key, entry] of entries) {
      if (seen.has(key)) continue;
      remove(entry.layer);
      entries.delete(key);
      removed += 1;
    }
    return { created, removed, kept };
  }

  /**
   * Number of directions currently cached.
   *
   * @returns {number} Cache size.
   */
  function size() {
    return entries.size;
  }

  /**
   * Forget every cached entry without removing anything from the map — for
   * a caller that has already cleared the layer itself (e.g. a full map
   * teardown) and just needs the cache's own bookkeeping reset to match.
   *
   * @returns {void}
   */
  function clear() {
    entries.clear();
  }

  return { sync, size, clear };
}
