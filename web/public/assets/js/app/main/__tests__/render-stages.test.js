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

import { stagesForChanges, ALL_RENDER_STAGES, hasNodeDisplayChange } from '../render-stages.js';

const NONE = {
  derive: false,
  table: false,
  markers: false,
  neighborLines: false,
  traceLines: false,
  waypoints: false,
  chatChannels: false,
  log: false,
  stats: false,
};

test('an empty changed set resolves every stage false', () => {
  assert.deepEqual(stagesForChanges(new Set()), NONE);
});

test('a non-Set changed value is treated as nothing changed', () => {
  assert.deepEqual(stagesForChanges(null), NONE);
  assert.deepEqual(stagesForChanges(undefined), NONE);
});

test('nodes changing triggers derive, table, markers, neighborLines, traceLines, waypoints, stats, and log — but not chatChannels', () => {
  const stages = stagesForChanges(new Set(['nodes']));
  assert.equal(stages.derive, true);
  assert.equal(stages.table, true);
  assert.equal(stages.markers, true);
  assert.equal(stages.neighborLines, true);
  assert.equal(stages.traceLines, true);
  assert.equal(stages.waypoints, true);
  assert.equal(stages.stats, true);
  assert.equal(stages.log, true);
  assert.equal(stages.chatChannels, false);
});

test('messages changing triggers only chatChannels and log', () => {
  const stages = stagesForChanges(new Set(['messages']));
  assert.equal(stages.chatChannels, true);
  assert.equal(stages.log, true);
  for (const stage of ['derive', 'table', 'markers', 'neighborLines', 'traceLines', 'waypoints', 'stats']) {
    assert.equal(stages[stage], false, `${stage} must stay false for a messages-only delta`);
  }
});

test('positions changing triggers derive/table/markers/neighborLines/traceLines but not waypoints/chatChannels/stats', () => {
  const stages = stagesForChanges(new Set(['positions']));
  assert.equal(stages.derive, true);
  assert.equal(stages.table, true);
  assert.equal(stages.markers, true);
  assert.equal(stages.neighborLines, true);
  assert.equal(stages.traceLines, true);
  assert.equal(stages.waypoints, false);
  assert.equal(stages.chatChannels, false);
  assert.equal(stages.stats, false);
});

test('telemetry changing triggers derive/table/markers only among the node-derived stages', () => {
  const stages = stagesForChanges(new Set(['telemetry']));
  assert.equal(stages.derive, true);
  assert.equal(stages.table, true);
  assert.equal(stages.markers, true);
  assert.equal(stages.neighborLines, false);
  assert.equal(stages.traceLines, false);
  assert.equal(stages.waypoints, false);
});

test('neighbors changing triggers only neighborLines and log', () => {
  const stages = stagesForChanges(new Set(['neighbors']));
  assert.equal(stages.neighborLines, true);
  assert.equal(stages.log, true);
  for (const stage of ['derive', 'table', 'markers', 'traceLines', 'waypoints', 'chatChannels', 'stats']) {
    assert.equal(stages[stage], false, `${stage} must stay false for a neighbors-only delta`);
  }
});

test('traces changing triggers only traceLines and log', () => {
  const stages = stagesForChanges(new Set(['traces']));
  assert.equal(stages.traceLines, true);
  assert.equal(stages.log, true);
  for (const stage of ['derive', 'table', 'markers', 'neighborLines', 'waypoints', 'chatChannels', 'stats']) {
    assert.equal(stages[stage], false, `${stage} must stay false for a traces-only delta`);
  }
});

test('waypoints changing triggers only waypoints and log', () => {
  const stages = stagesForChanges(new Set(['waypoints']));
  assert.equal(stages.waypoints, true);
  assert.equal(stages.log, true);
  for (const stage of ['derive', 'table', 'markers', 'neighborLines', 'traceLines', 'chatChannels', 'stats']) {
    assert.equal(stages[stage], false, `${stage} must stay false for a waypoints-only delta`);
  }
});

test('nodeDisplayChanged forces chatChannels on even with no message rows', () => {
  const stages = stagesForChanges(new Set(['nodes']), { nodeDisplayChanged: true });
  assert.equal(stages.chatChannels, true);
});

test('a burst covering several collections unions their stages', () => {
  const stages = stagesForChanges(new Set(['messages', 'neighbors']));
  assert.equal(stages.chatChannels, true);
  assert.equal(stages.neighborLines, true);
  assert.equal(stages.derive, false);
  assert.equal(stages.table, false);
});

test('ALL_RENDER_STAGES has every stage true', () => {
  for (const [stage, value] of Object.entries(ALL_RENDER_STAGES)) {
    assert.equal(value, true, `${stage} should be true in ALL_RENDER_STAGES`);
  }
  assert.deepEqual(Object.keys(ALL_RENDER_STAGES).sort(), [
    'chatChannels', 'derive', 'log', 'markers', 'neighborLines',
    'stats', 'table', 'traceLines', 'waypoints',
  ]);
});

test('hasNodeDisplayChange is false for an empty or non-Array delta', () => {
  assert.equal(hasNodeDisplayChange([], new Map()), false);
  assert.equal(hasNodeDisplayChange(null, new Map()), false);
});

test('hasNodeDisplayChange is true when a node id is not previously known', () => {
  const incoming = [{ node_id: '!new', short_name: 'New' }];
  assert.equal(hasNodeDisplayChange(incoming, new Map()), true);
});

test('hasNodeDisplayChange is false when no display field changed', () => {
  const existing = { node_id: '!a', short_name: 'A', long_name: 'Alpha', role: 'CLIENT', protocol: 'meshtastic' };
  const incoming = [{ node_id: '!a', short_name: 'A', long_name: 'Alpha', role: 'CLIENT', protocol: 'meshtastic', battery_level: 42 }];
  assert.equal(hasNodeDisplayChange(incoming, new Map([['!a', existing]])), false);
});

test('hasNodeDisplayChange is true when short_name changes', () => {
  const existing = { node_id: '!a', short_name: 'A' };
  const incoming = [{ node_id: '!a', short_name: 'B' }];
  assert.equal(hasNodeDisplayChange(incoming, new Map([['!a', existing]])), true);
});

test('hasNodeDisplayChange is true when role changes', () => {
  const existing = { node_id: '!a', role: 'CLIENT' };
  const incoming = [{ node_id: '!a', role: 'ROUTER' }];
  assert.equal(hasNodeDisplayChange(incoming, new Map([['!a', existing]])), true);
});

test('hasNodeDisplayChange skips non-object rows and rows with no node_id', () => {
  const incoming = [null, 'x', { short_name: 'no id' }];
  assert.equal(hasNodeDisplayChange(incoming, new Map()), false);
});

test('hasNodeDisplayChange treats a non-Map nodesById as empty (every row looks new)', () => {
  const incoming = [{ node_id: '!a', short_name: 'A' }];
  assert.equal(hasNodeDisplayChange(incoming, null), true);
});
