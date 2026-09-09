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
 * Integration guard for the neighbor-line diffing cache (Phase 5, issue:
 * frontend perf regression). Drives the real dashboard over the Leaflet
 * stub + a resolving fetch stub carrying two nodes and one neighbor edge,
 * across two live-driven refresh ticks, and pins:
 *
 *   - a second render with the exact same neighbor data creates 0 new
 *     polylines (the cached one is kept, not recreated);
 *   - a render whose only change is the neighbor's SNR recreates exactly the
 *     one affected polyline (old one removed, one new one created) — every
 *     other segment (none, here) would stay untouched.
 *
 * The cache's removal path (an edge that drops out of the segment list
 * entirely) is unit-tested directly in
 * `main/__tests__/neighbor-line-cache.test.js` rather than here: in the real
 * app a neighbor edge is retained (window-trimmed, not delta-cleared) once
 * merged, so it never actually disappears from one live tick to the next —
 * only by aging past the 28-day retention floor, which this harness has no
 * reason to fast-forward through.
 *
 * @module app/__tests__/main-neighbor-line-render
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { makeLeafletStub } from './main-app-leaflet-stub.js';
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
  { node_id: '!a', short_name: 'A', long_name: 'Node A', role: 'CLIENT', latitude: 1, longitude: 2, last_heard: NOW },
  { node_id: '!b', short_name: 'B', long_name: 'Node B', role: 'CLIENT', latitude: 3, longitude: 4, last_heard: NOW },
];

/**
 * Spin up the real dashboard with the Leaflet stub and a controllable
 * resolving fetch (unlike `setupAppWithLeaflet`, whose fetch never resolves —
 * this test needs `refresh()` to actually complete so `renderMap` runs with
 * real node/neighbor data across more than one tick).
 *
 * @param {() => Array<Object>} neighborsProvider Called on every
 *   `/api/neighbors` fetch; lets each test vary the neighbor payload per
 *   `testUtils.refresh()` call.
 * @returns {{ testUtils: Object, leaflet: Object, cleanup: Function }}
 */
function setupMapAppWithFetch(neighborsProvider, { tracesProvider = () => [], nodes = NODES } = {}) {
  const env = createDomEnvironment({ includeBody: true });
  const mapContainer = env.createElement('div', 'map');
  env.registerElement('map', mapContainer);
  if (env.window && typeof env.window.matchMedia !== 'function') {
    env.window.matchMedia = () => ({
      matches: false,
      media: '',
      addEventListener() {},
      removeEventListener() {},
    });
  }

  const previousWindowL = globalThis.window.L;
  const previousGlobalL = globalThis.L;
  const previousFetch = globalThis.fetch;

  const leaflet = makeLeafletStub();
  globalThis.window.L = leaflet;
  globalThis.L = leaflet;
  globalThis.fetch = url => {
    if (url.startsWith('/api/nodes/')) return jsonResponse(null);
    if (url.startsWith('/api/nodes')) return jsonResponse(nodes);
    if (url.startsWith('/api/neighbors')) return jsonResponse(neighborsProvider());
    if (url.startsWith('/api/traces')) return jsonResponse(tracesProvider());
    return jsonResponse([]);
  };

  const { _testUtils } = initializeApp(BASE_CONFIG);
  return {
    testUtils: _testUtils,
    leaflet,
    cleanup() {
      globalThis.fetch = previousFetch;
      globalThis.window.L = previousWindowL;
      globalThis.L = previousGlobalL;
      env.cleanup();
    },
  };
}

test('a second render with unchanged neighbor data creates 0 new polylines', async () => {
  const neighbor = () => [{ node_id: '!a', neighbor_id: '!b', rx_time: NOW, snr: 5 }];
  const { testUtils, leaflet, cleanup } = setupMapAppWithFetch(neighbor);
  try {
    await testUtils.initialLoad;
    const polylinesAfterFirst = leaflet._recorded.polylines.length;
    assert.ok(polylinesAfterFirst >= 1, 'the first render draws the neighbor line');

    await testUtils.refresh();
    const polylinesAfterSecond = leaflet._recorded.polylines.length;

    assert.equal(
      polylinesAfterSecond, polylinesAfterFirst,
      'an unchanged neighbor set must not create any new polyline on the second render',
    );
  } finally {
    cleanup();
  }
});

test('a changed SNR recreates exactly the one affected neighbor polyline', async () => {
  let snr = 5;
  const neighbor = () => [{ node_id: '!a', neighbor_id: '!b', rx_time: NOW, snr }];
  const { testUtils, leaflet, cleanup } = setupMapAppWithFetch(neighbor);
  try {
    await testUtils.initialLoad;
    const polylinesAfterFirst = leaflet._recorded.polylines.length;

    snr = 9; // only the SNR changes between ticks
    await testUtils.refresh();
    const polylinesAfterChange = leaflet._recorded.polylines.length;

    assert.equal(
      polylinesAfterChange, polylinesAfterFirst + 1,
      'a changed segment recreates exactly one new polyline (the stale one is removed, not left in place)',
    );
  } finally {
    cleanup();
  }
});

test('trace lines share one canvas renderer across renders instead of leaking one per render', async () => {
  const nodesWithNums = NODES.map((node, index) => ({ ...node, num: index + 1 }));
  let rxTime = NOW;
  const traces = () => [{ id: 1, rx_time: rxTime, src: 1, dest: 2 }];
  const { testUtils, leaflet, cleanup } = setupMapAppWithFetch(() => [], { tracesProvider: traces, nodes: nodesWithNums });
  let canvasRenderers = 0;
  // The stub has no L.canvas; the real Leaflet does, and every renderer
  // handed to a path's `renderer` option is added to the map for good.
  leaflet.canvas = () => {
    canvasRenderers += 1;
    return { _stubCanvasRenderer: true };
  };
  try {
    await testUtils.initialLoad;
    assert.equal(canvasRenderers, 1, 'the first trace render creates the canvas renderer');
    const tracePolylines = () => leaflet._recorded.polylines.filter(
      line => line.options && line.options.renderer && line.options.renderer._stubCanvasRenderer,
    );
    assert.ok(tracePolylines().length >= 1, 'trace polylines draw through the canvas renderer');

    rxTime += 1; // a changed trace redraws the trace layer on the next tick
    await testUtils.refresh();
    rxTime += 1;
    await testUtils.refresh();

    assert.equal(canvasRenderers, 1, 'later trace renders must reuse the one renderer, not create another');
  } finally {
    cleanup();
  }
});
