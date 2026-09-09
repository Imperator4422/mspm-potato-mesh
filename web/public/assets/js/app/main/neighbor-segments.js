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
 * Pure derivation of map neighbor-line segments from raw neighbor packets
 * (issue: frontend perf regression, Phase 5).
 *
 * `renderMap` used to rebuild every neighbor polyline on every render that
 * touched the map, even when the underlying neighbor set was unchanged tick
 * to tick — a full `clearLayers()` + recreate, however few (or zero) of the
 * segments actually differ. This module extracts the pure "which segments
 * should exist, and what would their line look like" computation, each
 * carrying a `signature` string so a caller (`main/neighbor-line-cache.js`)
 * can diff against the previous render and only touch the polylines that
 * actually changed.
 *
 * @module main/neighbor-segments
 */

/**
 * Coerce a raw `rx_time` value (number or numeric string) to a finite
 * timestamp, or `0` when absent/invalid.
 *
 * @param {*} value Raw `rx_time` field.
 * @returns {number} Finite timestamp, or 0.
 */
function coerceRxTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Build the sorted list of renderable neighbor-line segments from raw
 * neighbor packets, each carrying a `signature` capturing every field its
 * rendered line/tooltip depends on.
 *
 * A neighbor entry is skipped (no segment emitted) when: its source/target id
 * is missing, its direction was already seen (only the first packet per
 * `sourceId→targetId` direction renders — the newest-first caller order means
 * that is the newest one), either endpoint node is unresolvable or missing
 * coordinates, or either endpoint falls outside `maxDistanceKm` (when
 * `limitDistance` is set).
 *
 * @param {Array<Object>} neighbors Raw neighbor packets (id-keyed accumulator,
 *   newest-first is not required — `seenDirections` just keeps whichever
 *   packet for a direction is encountered first in the input order).
 * @param {Map<string, Object>} nodesById Node lookup, keyed by canonical id —
 *   typically the *visible* (filtered) node set, so a neighbor line never
 *   spans to a node the current filter/protocol-toggle has hidden.
 * @param {{
 *   limitDistance?: boolean,
 *   maxDistanceKm?: ?number,
 *   colorForNode: (node: Object) => string,
 *   priorityForNode: (node: Object) => number,
 *   displayNameForNode: (node: Object) => string,
 *   shortNameForNode: (node: Object) => ?string,
 * }} deps Rendering-relevant dependencies, injected so this module has no
 *   import-time coupling to the app's role/display-name helpers.
 * @returns {Array<Object>} Segments sorted by role priority (ascending), then
 *   newest-first (`rxTime` descending), then `sourceId`/`targetId` — the same
 *   order `renderMap` drew them in before this phase. Each segment carries
 *   `{ latlngs, color, priority, rxTime, sourceId, targetId, snr,
 *   sourceDisplayName, targetDisplayName, sourceShortName, sourceRole,
 *   targetShortName, targetRole, signature }`.
 */
export function buildNeighborSegments(neighbors, nodesById, {
  limitDistance = false,
  maxDistanceKm = null,
  colorForNode,
  priorityForNode,
  displayNameForNode,
  shortNameForNode,
} = {}) {
  const segments = [];
  if (!Array.isArray(neighbors) || neighbors.length === 0 || !(nodesById instanceof Map)) {
    return segments;
  }
  const seenDirections = new Set();
  for (const entry of neighbors) {
    if (!entry || typeof entry !== 'object') continue;
    const sourceId = typeof entry.node_id === 'string' ? entry.node_id : null;
    const targetId = typeof entry.neighbor_id === 'string' ? entry.neighbor_id : null;
    if (!sourceId || !targetId) continue;
    const directionKey = `${sourceId}→${targetId}`;
    if (seenDirections.has(directionKey)) continue;
    seenDirections.add(directionKey);

    const sourceNode = nodesById.get(sourceId);
    const targetNode = nodesById.get(targetId);
    if (!sourceNode || !targetNode) continue;

    const srcLatRaw = sourceNode.latitude;
    const srcLonRaw = sourceNode.longitude;
    const tgtLatRaw = targetNode.latitude;
    const tgtLonRaw = targetNode.longitude;
    if (
      srcLatRaw == null || srcLatRaw === '' || srcLonRaw == null || srcLonRaw === '' ||
      tgtLatRaw == null || tgtLatRaw === '' || tgtLonRaw == null || tgtLonRaw === ''
    ) {
      continue;
    }
    const srcLat = Number(srcLatRaw);
    const srcLon = Number(srcLonRaw);
    const tgtLat = Number(tgtLatRaw);
    const tgtLon = Number(tgtLonRaw);
    if (!Number.isFinite(srcLat) || !Number.isFinite(srcLon) || !Number.isFinite(tgtLat) || !Number.isFinite(tgtLon)) {
      continue;
    }
    if (limitDistance && sourceNode.distance_km != null && sourceNode.distance_km > maxDistanceKm) continue;
    if (limitDistance && targetNode.distance_km != null && targetNode.distance_km > maxDistanceKm) continue;

    const priority = priorityForNode(sourceNode);
    const rxTime = coerceRxTime(entry.rx_time);
    const snrRaw = entry.snr;
    const snr = typeof snrRaw === 'number' && Number.isFinite(snrRaw)
      ? snrRaw
      : (typeof snrRaw === 'string' && Number.isFinite(Number(snrRaw)) ? Number(snrRaw) : null);
    const color = colorForNode(sourceNode);
    const sourceDisplayName = displayNameForNode(sourceNode);
    const targetDisplayName = displayNameForNode(targetNode);
    const sourceShortName = shortNameForNode(sourceNode);
    const targetShortName = shortNameForNode(targetNode);
    const sourceRole = sourceNode.role;
    const targetRole = targetNode.role;

    segments.push({
      latlngs: [[srcLat, srcLon], [tgtLat, tgtLon]],
      color,
      priority,
      rxTime,
      sourceId,
      targetId,
      snr,
      sourceDisplayName,
      targetDisplayName,
      sourceShortName,
      sourceRole,
      targetShortName,
      targetRole,
      // Every field the drawn line (colour, position) or its tooltip
      // (names/roles/snr/rxTime) depends on — a neighbor-line-cache hit means
      // none of this changed, so the polyline/tooltip need not be rebuilt.
      signature: [
        sourceId, targetId, color,
        srcLat, srcLon, tgtLat, tgtLon,
        rxTime, snr,
        sourceDisplayName, targetDisplayName,
        sourceShortName, sourceRole,
        targetShortName, targetRole,
      ].join('|'),
    });
  }

  segments.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.rxTime !== b.rxTime) return b.rxTime - a.rxTime;
    if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
    if (a.targetId !== b.targetId) return a.targetId < b.targetId ? -1 : 1;
    return 0;
  });
  return segments;
}
