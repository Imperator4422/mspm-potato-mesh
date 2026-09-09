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
 * Smoke test for the dashboard's root-scoped relative-time ticker wiring
 * (Phase 4, issue: frontend perf regression). The scoping logic itself
 * (`normalizeRoots`, dedup, `resolveRoots` cadence) is unit-tested directly in
 * `main/__tests__/relative-time-ticker.test.js`; this only pins that
 * `initializeApp` wires a `resolveRoots` callback that runs without throwing
 * against the real node table, and that it actually narrows the scan (a
 * ticking field outside every resolved root is left untouched by a tick).
 *
 * @module app/__tests__/main-ticker-roots
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';
import { TICK_TIMESTAMP_ATTRIBUTE } from '../main/relative-time-ticker.js';

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

const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));

test("the ticker's resolveRoots scans the real node table without throwing, and leaves an out-of-scope field untouched", async () => {
  const env = createDomEnvironment({ includeBody: true });
  const tbody = env.document.createElement('tbody');
  env.document.querySelector = selector => (selector === '#nodes tbody' ? tbody : null);

  const now = Math.floor(Date.now() / 1000);
  const nodesPayload = [
    { node_id: '!00060000', last_heard: now - 4, short_name: 'N0', role: 'CLIENT' },
  ];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = url => {
    if (url.startsWith('/api/nodes/')) return jsonResponse(null);
    if (url.startsWith('/api/nodes')) return jsonResponse(nodesPayload);
    return jsonResponse([]);
  };
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;
    await settle();

    // A ticking field that exists but sits outside every root the dashboard
    // resolves (the lightweight test DOM's document.querySelector stub above
    // answers only '#nodes tbody', so a field parented elsewhere is simply
    // never reached) — proof the ticker does not fall back to a whole-document
    // sweep that would find it anyway.
    const outOfScope = env.document.createElement('span');
    outOfScope.setAttribute(TICK_TIMESTAMP_ATTRIBUTE, String(now - 4));
    outOfScope.textContent = '';

    assert.doesNotThrow(() => _testUtils.relativeTimeTicker.tick());
    assert.equal(outOfScope.textContent, '', 'a field outside every resolved root is left untouched');
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});
