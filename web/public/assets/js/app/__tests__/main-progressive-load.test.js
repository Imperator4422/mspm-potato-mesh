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
 * Regression guard for issue #802 (chat first-paint latency).
 *
 * PR #800 made the initial chat load page the entire seven-day window
 * *before* rendering anything (issue #796).  On a busy instance that is up to
 * ~10k messages across several sequential pages, so the chat stayed blank for
 * 10-20s.  The fix renders the newest page immediately and streams the older
 * history in the background; this test pins that behaviour: the newest page is
 * committed even while an older page is still in flight, and the older page is
 * still merged in once it arrives (the background pager keeps the same backward
 * `before`-cursor reachability as the pre-fix #796 walk — it changes *when*
 * rows render, not *which* rows are reachable).
 *
 * @module app/__tests__/main-progressive-load
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';
import { MESSAGE_LIMIT } from '../message-limit.js';

/** Minimal config that disables the auto-refresh timer so timing is ours. */
const BASE_CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 0,
  refreshIntervalSeconds: 0,
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,  instancesFeatureEnabled: false,
  instanceDomain: null,
  snapshotWindowSeconds: 3600,
});

/** Build a resolved fetch-style response around a JSON body. */
function jsonResponse(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

/** A promise plus its externally callable resolver. */
function deferred() {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Yield to pending microtasks/timers so async refresh work settles. */
function settle(ms = 60) {
  return new Promise(r => setTimeout(r, ms));
}

test('initial chat load renders the newest page without blocking on the full window (#802)', async () => {
  const now = Math.floor(Date.now() / 1000);
  // A *full* first page (=== MESSAGE_LIMIT) so backward pagination continues to
  // a second page; this is the only scenario in which the pre-fix code blocks.
  const firstPage = Array.from({ length: MESSAGE_LIMIT }, (_, i) => ({
    id: 200000 + i,
    rx_time: now - i, // strictly descending; oldest row is now-(LIMIT-1)
    from_id: '!aabb',
    text: `hello ${i}`,
    channel: 0,
    channel_name: 'Primary',
    portnum: 1,
  }));
  // One older row, gated so we can prove the newest page renders before it.
  const olderPage = [
    {
      id: 199999,
      rx_time: now - 100000, // older, but well inside the seven-day window
      from_id: '!aabb',
      text: 'older history row',
      channel: 0,
      channel_name: 'Primary',
      portnum: 1,
    },
  ];

  const olderGate = deferred();
  let gateResolved = false;
  let backfillRequested = false;
  const releaseGate = body => {
    if (gateResolved) return;
    gateResolved = true;
    olderGate.resolve(body);
  };

  function stubFetch(url) {
    if (url.startsWith('/api/messages')) {
      if (url.includes('encrypted=true')) return jsonResponse([]);
      if (url.includes('before=')) {
        backfillRequested = true;
        return olderGate.promise.then(jsonResponse);
      }
      return jsonResponse(firstPage); // newest page (no cursor)
    }
    if (url.startsWith('/api/nodes/')) {
      return jsonResponse({ node_id: '!aabb', short_name: 'AB', role: 'CLIENT' });
    }
    if (url.startsWith('/api/nodes')) {
      return jsonResponse([{ node_id: '!aabb', last_heard: now, short_name: 'AB', role: 'CLIENT' }]);
    }
    return jsonResponse([]); // positions / telemetry / neighbors / traces / stats
  }

  const env = createDomEnvironment({ includeBody: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = url => stubFetch(url);
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await settle();

    // The newest page is committed even though the older page is still gated.
    // Pre-fix this is 0: refresh() awaits the whole backward walk (the gated
    // second page) before assigning allMessages, so the chat never renders.
    assert.equal(
      _testUtils.getLoadedMessageCount(),
      MESSAGE_LIMIT,
      'newest page must render before the full window finishes loading',
    );
    assert.ok(backfillRequested, 'a background backfill page should have been requested');

    // Releasing the older page must still merge it in — the backward walk keeps
    // the same reachability as the pre-fix #796 pager, just progressively.
    releaseGate(olderPage);
    await settle();
    assert.equal(
      _testUtils.getLoadedMessageCount(),
      MESSAGE_LIMIT + 1,
      'older history must be merged in once the background page resolves',
    );
  } finally {
    releaseGate([]); // unblock any pending page so nothing dangles post-test
    await settle(0);
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});

test('a 3-page chat backfill renders the chat log at most twice (Phase 6 coalescing)', async () => {
  const now = Math.floor(Date.now() / 1000);
  // Full newest page so the backfill walks backward through more pages.
  const firstPage = Array.from({ length: MESSAGE_LIMIT }, (_, i) => ({
    id: 400000 + i,
    rx_time: now - i,
    from_id: '!aabb',
    text: `hello ${i}`,
    channel: 0,
    channel_name: 'Primary',
    portnum: 1,
  }));
  /**
   * Build one backward page; a full page continues pagination, a short one
   * ends it. Timestamps sit well before `firstPage`'s range but still safely
   * inside the 7-day retention window (unlike `firstPage`'s ~11+-day-old
   * would-be equivalent) — this exercises the backfill's normal case (older
   * rows *within* the window that a short newest page missed), not the
   * window-trim path.
   */
  const backfillPage = (pageIndex, count) => Array.from({ length: count }, (_, i) => ({
    id: 500000 + pageIndex * 10000 + i,
    rx_time: now - 100000 - pageIndex * 1000 - i,
    from_id: '!aabb',
    text: `hist ${pageIndex}-${i}`,
    channel: 0,
    channel_name: 'Primary',
    portnum: 1,
  }));
  let backfillCallCount = 0;

  function stubFetch(url) {
    if (url.startsWith('/api/messages')) {
      if (url.includes('encrypted=true')) return jsonResponse([]);
      if (url.includes('before=')) {
        backfillCallCount += 1;
        // Pages 1-2 are full (continue pagination); page 3 is short (stop).
        return jsonResponse(backfillPage(backfillCallCount, backfillCallCount <= 2 ? MESSAGE_LIMIT : 1));
      }
      return jsonResponse(firstPage);
    }
    if (url.startsWith('/api/nodes/')) {
      return jsonResponse({ node_id: '!aabb', short_name: 'AB', role: 'CLIENT' });
    }
    if (url.startsWith('/api/nodes')) {
      return jsonResponse([{ node_id: '!aabb', last_heard: now, short_name: 'AB', role: 'CLIENT' }]);
    }
    return jsonResponse([]);
  }

  const env = createDomEnvironment({ includeBody: true });
  // A registered #chat container so renderChatLog actually runs (and
  // increments the stage counter this test asserts on) instead of no-op'ing.
  env.registerElement('chat', env.createElement('div', 'chat'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = url => stubFetch(url);
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;
    // Reset immediately after the (already-settled) cold-load render, before
    // any backfill page has had a chance to run — backfillChatHistory is
    // fired void (fire-and-forget) from inside refresh(), so its pages land
    // in later microtask/timer ticks, not before initialLoad resolves.
    _testUtils.resetStageRenderCounts();

    await settle(150); // let all 3 backward pages + the coalesced repaint(s) settle

    assert.equal(backfillCallCount, 3, 'three backward pages were requested');
    assert.equal(
      _testUtils.getLoadedMessageCount(),
      MESSAGE_LIMIT * 3 + 1,
      'every backfilled page is merged in regardless of how the repaints coalesce',
    );
    const chatRenders = _testUtils.getStageRenderCounts().chat;
    assert.ok(
      chatRenders >= 1 && chatRenders <= 2,
      `a 3-page chat backfill should render the chat log 1-2 times (coalesced), saw ${chatRenders}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});

test('a chat-history page waiting alongside a collection page is painted by the same flush (Phase 6)', async () => {
  const now = Math.floor(Date.now() / 1000);
  const message = (id, text) => ({
    id, rx_time: now - (500000 - id), from_id: '!aabb', text, channel: 0, channel_name: 'Primary', portnum: 1,
  });
  function stubFetch(url) {
    if (url.startsWith('/api/messages')) {
      if (url.includes('encrypted=true') || url.includes('before=')) return jsonResponse([]);
      return jsonResponse([message(499999, 'newest')]);
    }
    if (url.startsWith('/api/nodes/')) {
      return jsonResponse({ node_id: '!aabb', short_name: 'AB', role: 'CLIENT' });
    }
    if (url.startsWith('/api/nodes')) {
      return jsonResponse([{ node_id: '!aabb', last_heard: now, short_name: 'AB', role: 'CLIENT' }]);
    }
    return jsonResponse([]);
  }
  const env = createDomEnvironment({ includeBody: true });
  const chat = env.createElement('div', 'chat');
  env.registerElement('chat', chat);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = url => stubFetch(url);
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;
    await _testUtils.flushBackfill();
    await _testUtils.flushCollectionBackfills();
    const tabLabel = () => chat.querySelectorAll('.chat-tab')
      .map(tab => tab.textContent)
      .find(text => text.includes('Primary')) || '';
    assert.ok(tabLabel().includes('(1)'), `one message painted before the pages land: ${tabLabel()}`);

    // Both kinds of page merge before the coalesced repaint runs — the shape
    // the cold load produces when the chat and collection backfills overlap.
    await _testUtils.commitHistoricalMessages([message(499990, 'older')]);
    _testUtils.commitBackfillPage('nodes', [{ node_id: '!ccdd', last_heard: now - 100, short_name: 'CD', role: 'CLIENT' }]);
    assert.equal(_testUtils.isBackfillChatDirty(), true, 'the history page is waiting to be painted');
    _testUtils.flushBackfillRepaint();

    assert.equal(_testUtils.isBackfillChatDirty(), false, 'a flush that paints collection pages must paint the chat page too');
    assert.equal(_testUtils.getLoadedMessageCount(), 2, 'the history page merged');
    assert.equal(_testUtils.getLoadedNodeCount(), 2, 'the nodes page merged');
    assert.ok(tabLabel().includes('(2)'), `the same flush must paint the history page: ${tabLabel()}`);
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});

test('a failed background backfill is swallowed and leaves the newest page intact (#802)', async () => {
  const now = Math.floor(Date.now() / 1000);
  // Full newest page so the backfill attempts a second (older) page, which here
  // rejects — the failure must not bubble out or drop the already-rendered page.
  const firstPage = Array.from({ length: MESSAGE_LIMIT }, (_, i) => ({
    id: 300000 + i,
    rx_time: now - i,
    from_id: '!aabb',
    text: `hi ${i}`,
    channel: 0,
    channel_name: 'Primary',
    portnum: 1,
  }));

  function stubFetch(url) {
    if (url.startsWith('/api/messages')) {
      if (url.includes('encrypted=true')) return jsonResponse([]);
      if (url.includes('before=')) return Promise.reject(new Error('backfill boom'));
      return jsonResponse(firstPage);
    }
    if (url.startsWith('/api/nodes/')) {
      return jsonResponse({ node_id: '!aabb', short_name: 'AB', role: 'CLIENT' });
    }
    if (url.startsWith('/api/nodes')) {
      return jsonResponse([{ node_id: '!aabb', last_heard: now, short_name: 'AB', role: 'CLIENT' }]);
    }
    return jsonResponse([]);
  }

  const env = createDomEnvironment({ includeBody: true });
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args); // capture the expected warning
  globalThis.fetch = url => stubFetch(url);
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await settle();

    // The backfill page rejected; the error is caught (not thrown out of the
    // void-ed call) and the newest page stays rendered.
    assert.equal(_testUtils.getLoadedMessageCount(), MESSAGE_LIMIT);
    assert.ok(
      warnings.some(args => String(args[0]).includes('chat history backfill failed')),
      'the backfill failure should be logged, not rethrown',
    );
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});
