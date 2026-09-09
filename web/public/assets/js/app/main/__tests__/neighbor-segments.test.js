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

import { buildNeighborSegments } from '../neighbor-segments.js';

/** Minimal deps stub: priority is alphabetical by role, colour/names are derived deterministically. */
function makeDeps(overrides = {}) {
  return {
    colorForNode: node => `#${node.role || 'x'}`,
    priorityForNode: node => (node.role === 'ROUTER' ? 0 : 1),
    displayNameForNode: node => node.long_name || node.node_id,
    shortNameForNode: node => node.short_name || null,
    ...overrides,
  };
}

function nodesMap(nodes) {
  return new Map(nodes.map(n => [n.node_id, n]));
}

test('returns an empty array for missing/empty inputs', () => {
  assert.deepEqual(buildNeighborSegments(null, new Map(), makeDeps()), []);
  assert.deepEqual(buildNeighborSegments([], new Map(), makeDeps()), []);
  assert.deepEqual(buildNeighborSegments([{ node_id: '!a', neighbor_id: '!b' }], null, makeDeps()), []);
});

test('builds one segment for a resolvable neighbor pair', () => {
  const nodes = nodesMap([
    { node_id: '!a', latitude: 1, longitude: 2, role: 'ROUTER', short_name: 'A', long_name: 'Alpha' },
    { node_id: '!b', latitude: 3, longitude: 4, role: 'CLIENT', short_name: 'B', long_name: 'Bravo' },
  ]);
  const segments = buildNeighborSegments(
    [{ node_id: '!a', neighbor_id: '!b', rx_time: 100, snr: 5.5 }],
    nodes,
    makeDeps(),
  );
  assert.equal(segments.length, 1);
  const seg = segments[0];
  assert.deepEqual(seg.latlngs, [[1, 2], [3, 4]]);
  assert.equal(seg.sourceId, '!a');
  assert.equal(seg.targetId, '!b');
  assert.equal(seg.rxTime, 100);
  assert.equal(seg.snr, 5.5);
  assert.equal(seg.sourceDisplayName, 'Alpha');
  assert.equal(seg.targetDisplayName, 'Bravo');
  assert.equal(seg.sourceShortName, 'A');
  assert.equal(seg.targetShortName, 'B');
  assert.equal(seg.sourceRole, 'ROUTER');
  assert.equal(seg.targetRole, 'CLIENT');
  assert.equal(typeof seg.signature, 'string');
  assert.ok(seg.signature.includes('!a'));
  assert.ok(seg.signature.includes('!b'));
});

test('skips an entry with a missing source/target id', () => {
  const nodes = nodesMap([{ node_id: '!a', latitude: 1, longitude: 2 }]);
  const segments = buildNeighborSegments(
    [{ node_id: '!a' }, { neighbor_id: '!a' }, { node_id: null, neighbor_id: '!a' }],
    nodes,
    makeDeps(),
  );
  assert.deepEqual(segments, []);
});

test('skips a pair when either endpoint node is unresolved', () => {
  const nodes = nodesMap([{ node_id: '!a', latitude: 1, longitude: 2 }]);
  const segments = buildNeighborSegments(
    [{ node_id: '!a', neighbor_id: '!missing', rx_time: 1 }],
    nodes,
    makeDeps(),
  );
  assert.deepEqual(segments, []);
});

test('skips a pair when an endpoint is missing coordinates', () => {
  const nodes = nodesMap([
    { node_id: '!a', latitude: 1, longitude: 2 },
    { node_id: '!b', latitude: null, longitude: 4 },
  ]);
  const segments = buildNeighborSegments(
    [{ node_id: '!a', neighbor_id: '!b', rx_time: 1 }],
    nodes,
    makeDeps(),
  );
  assert.deepEqual(segments, []);
});

test('skips a pair when an endpoint has non-numeric coordinates', () => {
  const nodes = nodesMap([
    { node_id: '!a', latitude: 1, longitude: 2 },
    { node_id: '!b', latitude: 'nope', longitude: 4 },
  ]);
  const segments = buildNeighborSegments(
    [{ node_id: '!a', neighbor_id: '!b', rx_time: 1 }],
    nodes,
    makeDeps(),
  );
  assert.deepEqual(segments, []);
});

test('only the first packet per direction renders — later duplicates in the same direction are skipped', () => {
  const nodes = nodesMap([
    { node_id: '!a', latitude: 1, longitude: 2 },
    { node_id: '!b', latitude: 3, longitude: 4 },
  ]);
  const segments = buildNeighborSegments(
    [
      { node_id: '!a', neighbor_id: '!b', rx_time: 100, snr: 1 },
      { node_id: '!a', neighbor_id: '!b', rx_time: 50, snr: 9 },
    ],
    nodes,
    makeDeps(),
  );
  assert.equal(segments.length, 1);
  assert.equal(segments[0].rxTime, 100, 'the first-seen packet for the direction wins');
});

test('the reverse direction is a distinct segment (a→b and b→a both render)', () => {
  const nodes = nodesMap([
    { node_id: '!a', latitude: 1, longitude: 2 },
    { node_id: '!b', latitude: 3, longitude: 4 },
  ]);
  const segments = buildNeighborSegments(
    [
      { node_id: '!a', neighbor_id: '!b', rx_time: 1 },
      { node_id: '!b', neighbor_id: '!a', rx_time: 1 },
    ],
    nodes,
    makeDeps(),
  );
  assert.equal(segments.length, 2);
});

test('respects the distance limit, excluding a pair with an out-of-range endpoint', () => {
  const nodes = nodesMap([
    { node_id: '!a', latitude: 1, longitude: 2, distance_km: 5 },
    { node_id: '!b', latitude: 3, longitude: 4, distance_km: 500 },
  ]);
  const withinLimit = buildNeighborSegments(
    [{ node_id: '!a', neighbor_id: '!b', rx_time: 1 }],
    nodes,
    makeDeps(),
  );
  assert.equal(withinLimit.length, 1, 'no limit configured — renders');

  const limited = buildNeighborSegments(
    [{ node_id: '!a', neighbor_id: '!b', rx_time: 1 }],
    nodes,
    { ...makeDeps() },
    // limitDistance/maxDistanceKm are passed via the options object below.
  );
  assert.equal(limited.length, 1);

  const limitedExcluded = buildNeighborSegments(
    [{ node_id: '!a', neighbor_id: '!b', rx_time: 1 }],
    nodes,
    { ...makeDeps(), limitDistance: true, maxDistanceKm: 100 },
  );
  assert.equal(limitedExcluded.length, 0, 'the far endpoint is excluded once the limit is active');
});

test('coerces a string snr/rx_time and falls back to null/0 for unusable values', () => {
  const nodes = nodesMap([
    { node_id: '!a', latitude: 1, longitude: 2 },
    { node_id: '!b', latitude: 3, longitude: 4 },
  ]);
  const [seg1] = buildNeighborSegments(
    [{ node_id: '!a', neighbor_id: '!b', rx_time: '100', snr: '5.5' }],
    nodes,
    makeDeps(),
  );
  assert.equal(seg1.rxTime, 100);
  assert.equal(seg1.snr, 5.5);

  const [seg2] = buildNeighborSegments(
    [{ node_id: '!a', neighbor_id: '!b', rx_time: 'nope', snr: 'nope' }],
    nodes,
    makeDeps(),
  );
  assert.equal(seg2.rxTime, 0);
  assert.equal(seg2.snr, null);
});

test('sorts by priority ascending, then rxTime descending, then source/target id', () => {
  const nodes = nodesMap([
    { node_id: '!a', latitude: 1, longitude: 1, role: 'CLIENT' },
    { node_id: '!b', latitude: 1, longitude: 1, role: 'CLIENT' },
    { node_id: '!r1', latitude: 1, longitude: 1, role: 'ROUTER' },
    { node_id: '!r2', latitude: 1, longitude: 1, role: 'ROUTER' },
    { node_id: '!c', latitude: 1, longitude: 1, role: 'CLIENT' },
  ]);
  const segments = buildNeighborSegments(
    [
      { node_id: '!a', neighbor_id: '!b', rx_time: 10 }, // CLIENT, priority 1
      { node_id: '!r1', neighbor_id: '!r2', rx_time: 5 }, // ROUTER, priority 0
      { node_id: '!c', neighbor_id: '!a', rx_time: 20 }, // CLIENT, priority 1, newer
    ],
    nodes,
    makeDeps(),
  );
  assert.equal(segments.length, 3);
  assert.equal(segments[0].sourceId, '!r1', 'ROUTER (priority 0) sorts first');
  assert.equal(segments[1].sourceId, '!c', 'higher rxTime among priority-1 segments sorts before the lower one');
  assert.equal(segments[2].sourceId, '!a');
});
