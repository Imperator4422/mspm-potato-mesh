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
 * Integration guard for rebuildNodeDerivedState's partial-rebuild path
 * (Phase 8, issue: frontend perf regression). Drives the real dashboard over
 * two live-driven refresh ticks with a two-node fixture and pins:
 *
 *   - a tick where only one node's telemetry changes leaves the *other*
 *     node's object reference exactly as it was (reused, not recomputed);
 *   - the touched node's own object is a *new* reference reflecting the
 *     fresh data — untouched identity is not confused with "never updates".
 *
 * @module app/__tests__/main-node-snapshot-partial-rebuild
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { createFakeIndexedDb } from './fake-indexeddb.js';
import { createIndexedDbBackend } from '../main/data-cache-idb.js';
import { CACHE_SCHEMA_VERSION } from '../main/data-cache.js';
import { initializeApp } from '../main.js';

const NOW = Math.floor(Date.now() / 1000);

const BASE_CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 0,
  refreshIntervalSeconds: 0,
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,
  instancesFeatureEnabled: false,
  instanceDomain: null,
  snapshotWindowSeconds: 3600,
});

function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

const NODES = [
  { node_id: '!a', short_name: 'A', long_name: 'Node A', role: 'CLIENT', last_heard: NOW },
  { node_id: '!b', short_name: 'B', long_name: 'Node B', role: 'CLIENT', last_heard: NOW },
];

test('an untouched node keeps its exact object reference across a tick that only touches another node', async () => {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const originalFetch = globalThis.fetch;
  let telemetryBattery = 50;
  let nodesCallCount = 0;
  globalThis.fetch = url => {
    if (url.startsWith('/api/nodes/')) return jsonResponse(null);
    if (url.startsWith('/api/nodes')) {
      // A real `since=`-scoped delta returns nothing once a node's own
      // fields (e.g. last_heard) stop advancing past the cursor; every call
      // after the first here simulates that — only the telemetry endpoint
      // has new data on the second refresh.
      nodesCallCount += 1;
      return jsonResponse(nodesCallCount === 1 ? NODES : []);
    }
    if (url.startsWith('/api/telemetry')) {
      return jsonResponse([{ id: 1, node_id: '!a', rx_time: NOW, battery_level: telemetryBattery }]);
    }
    return jsonResponse([]);
  };
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;

    const nodeABefore = _testUtils.getNodeById('!a');
    const nodeBBefore = _testUtils.getNodeById('!b');
    assert.ok(nodeABefore, 'node A loaded');
    assert.ok(nodeBBefore, 'node B loaded');
    assert.equal(nodeABefore.battery_level, 50);

    telemetryBattery = 77; // only !a's telemetry changes this tick
    await _testUtils.refresh();

    const nodeAAfter = _testUtils.getNodeById('!a');
    const nodeBAfter = _testUtils.getNodeById('!b');

    assert.notStrictEqual(nodeAAfter, nodeABefore, 'the touched node gets a freshly re-aggregated object');
    assert.equal(nodeAAfter.battery_level, 77, 'the touched node reflects the new telemetry');
    assert.strictEqual(nodeBAfter, nodeBBefore, 'the untouched node keeps its exact previous object reference');
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});

test('a nodes-collection change to one node does not recreate an unrelated node object', async () => {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const originalFetch = globalThis.fetch;
  let secondCall = false;
  globalThis.fetch = url => {
    if (url.startsWith('/api/nodes/')) return jsonResponse(null);
    if (url.startsWith('/api/nodes')) {
      // Second call returns only node A with an updated short_name — a
      // `since=`-scoped delta in the real app returns only what changed.
      const body = secondCall ? [{ ...NODES[0], short_name: 'A2' }] : NODES;
      secondCall = true;
      return jsonResponse(body);
    }
    return jsonResponse([]);
  };
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;
    const nodeBBefore = _testUtils.getNodeById('!b');

    await _testUtils.refresh();

    const nodeAAfter = _testUtils.getNodeById('!a');
    const nodeBAfter = _testUtils.getNodeById('!b');
    assert.equal(nodeAAfter.short_name, 'A2', 'the changed node reflects the new short_name');
    assert.strictEqual(nodeBAfter, nodeBBefore, 'a node not present in the delta is untouched');
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});

test('a brand-new node arriving via a live delta is not duplicated in the loaded set', async () => {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const originalFetch = globalThis.fetch;
  const nodeB = { node_id: '!b', short_name: 'B', long_name: 'Node B', role: 'CLIENT', last_heard: NOW };
  let nodesCallCount = 0;
  globalThis.fetch = url => {
    if (url.startsWith('/api/nodes/')) return jsonResponse(null);
    if (url.startsWith('/api/nodes')) {
      nodesCallCount += 1;
      // Cold load only ever saw !a; !b shows up for the first time on the
      // live delta (e.g. a node freshly joining the mesh).
      return jsonResponse(nodesCallCount === 1 ? [NODES[0]] : [nodeB]);
    }
    return jsonResponse([]);
  };
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;
    assert.equal(_testUtils.getLoadedNodeCount(), 1, 'cold load sees only !a');

    await _testUtils.refresh();

    assert.equal(
      _testUtils.getLoadedNodeCount(), 2,
      'the new node is added exactly once, not duplicated alongside !a',
    );
    const nodeBAfter = _testUtils.getNodeById('!b');
    assert.ok(nodeBAfter, 'the new node is present');
    assert.equal(nodeBAfter.short_name, 'B');

    // A second delta reusing the same (still new-ish) node must still not
    // duplicate it — the splice-back path must now find and overwrite it.
    await _testUtils.refresh();
    assert.equal(_testUtils.getLoadedNodeCount(), 2, 'a repeat touch of the same node stays at one row for it');
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});

test('a warm cache seed primes the snapshot indexes so a partial rebuild sees cached history', async () => {
  // Seed: node !a cached without coordinates or battery, but with a cached
  // position and telemetry packet carrying both. The only network delta is
  // !a's own bare node row, so the partial rebuild must find the position and
  // battery in the *seeded* index, not just in this session's delta rows.
  const config = { ...BASE_CONFIG, instanceDomain: 'demo.example' };
  const fake = createFakeIndexedDb();
  const seed = createIndexedDbBackend({ indexedDB: fake.factory, databaseName: 'potato-mesh-cache' });
  await seed.write('meta', 'meta', { schemaVersion: CACHE_SCHEMA_VERSION, instanceId: config.instanceDomain });
  await seed.write('nodes', '!a', { value: { node_id: '!a', short_name: 'A', long_name: 'Node A', role: 'CLIENT', last_heard: NOW - 60 }, cachedAt: NOW });
  await seed.write('positions', '1', { value: { id: 1, node_id: '!a', rx_time: NOW - 60, position_time: NOW - 60, latitude: 12.5, longitude: 34.25 }, cachedAt: NOW });
  await seed.write('telemetry', '1', { value: { id: 1, node_id: '!a', rx_time: NOW - 60, telemetry_time: NOW - 60, battery_level: 64 }, cachedAt: NOW });

  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const originalFetch = globalThis.fetch;
  const originalIdb = globalThis.indexedDB;
  globalThis.indexedDB = fake.factory;
  globalThis.fetch = url => {
    if (url.startsWith('/api/nodes/')) return jsonResponse(null);
    if (url.startsWith('/api/nodes')) return jsonResponse([{ node_id: '!a', short_name: 'A', long_name: 'Node A', role: 'CLIENT', last_heard: NOW }]);
    return jsonResponse([]);
  };
  try {
    const { _testUtils } = initializeApp(config);
    await _testUtils.initialLoad;
    const nodeA = _testUtils.getNodeById('!a');
    assert.ok(nodeA, 'node A loaded from the warm seed + delta');
    assert.equal(nodeA.latitude, 12.5, 'position comes from the seeded (indexed) position history');
    assert.equal(nodeA.battery_level, 64, 'battery comes from the seeded (indexed) telemetry history');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.indexedDB = originalIdb;
    env.cleanup();
  }
});
