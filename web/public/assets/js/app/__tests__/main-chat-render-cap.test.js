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
 * Regression guard for the chat channel-tab render cap (frontend perf: render
 * scale, Phase 3c).
 *
 * A busy channel can carry thousands of messages over its seven-day window
 * (issue #796, amended: load the whole window, render on demand), and each is
 * a real DOM subtree. This test pins that a channel tab renders only the
 * newest {@link CHAT_CHANNEL_RENDER_CAP} messages, offers a "show older"
 * control, and expands to the full window in place (without disturbing other
 * tabs) when that control is used.
 *
 * @module app/__tests__/main-chat-render-cap
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';
import { CHAT_CHANNEL_RENDER_CAP, SHOW_OLDER_BUTTON_CLASS } from '../main/chat-render-cap.js';

/** Minimal config that disables the auto-refresh timer so timing is ours. */
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

/** Resolve a fetch-style JSON response. */
function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

/** Yield so the initial render settles. */
const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));

/** Format an integer as a canonical `!%08x` node id. */
const nid = n => `!${n.toString(16).padStart(8, '0')}`;

/**
 * Find the sole non-Log chat panel under the ``chatEl`` built by this test's
 * single-channel fixture, and return both the panel and its tab id (the
 * exact slug ``buildChannelTabId`` produces depends on the configured
 * primary-channel label, so this reads it back rather than hard-coding it).
 *
 * @param {Object} chatEl Root chat container (`#chat`).
 * @returns {{ panel: Object, tabId: string }} The channel panel and its id.
 */
function findChannelPanel(chatEl) {
  const [, panelWrapper] = chatEl.childNodes;
  const panel = panelWrapper.childNodes.find(p => p.attributes.get('id') !== 'chat-panel-log');
  const tabId = panel.attributes.get('id').replace(/^chat-panel-/, '');
  return { panel, tabId };
}

/**
 * Count message entry nodes under a panel (nodes stamped with
 * ``dataset.messageId`` by {@link buildChatFragment}) and locate a
 * "show older" button, without relying on attribute-selector support the
 * lightweight test-only DOM stub does not implement.
 *
 * @param {Object} panel Panel element to walk.
 * @returns {{ messageCount: number, showOlderButton: ?Object }} Counts and
 *   the show-older button, if present.
 */
function inspectPanel(panel) {
  let messageCount = 0;
  let showOlderButton = null;
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.dataset && node.dataset.messageId) messageCount += 1;
    // buildShowOlderRow stamps className as a plain string (matching
    // buildShowAllRow's node-table sibling), not via classList.add — check it
    // directly rather than through classList, which the lightweight DOM stub
    // used here does not sync from a plain className assignment.
    if (node.className === SHOW_OLDER_BUTTON_CLASS) {
      showOlderButton = node;
    }
    if (Array.isArray(node.childNodes)) node.childNodes.forEach(visit);
  };
  visit(panel);
  return { messageCount, showOlderButton };
}

test('a channel tab renders capped, then expands to the full window on "show older" (frontend perf)', async () => {
  const env = createDomEnvironment({ includeBody: true });
  const chatEl = env.document.createElement('div');
  env.registerElement('chat', chatEl);

  const now = Math.floor(Date.now() / 1000);
  const messageCount = CHAT_CHANNEL_RENDER_CAP + 80;
  const messagesPayload = Array.from({ length: messageCount }, (_, i) => ({
    id: i,
    channel: 0,
    from_id: nid(0x40000),
    to_id: '^all',
    text: `m${i}`,
    rx_time: now - (messageCount - i),
    protocol: 'meshtastic',
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = url => {
    if (url.startsWith('/api/nodes')) return jsonResponse([]);
    if (url.startsWith('/api/messages')) return jsonResponse(messagesPayload);
    return jsonResponse([]);
  };
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;
    await settle();

    const { tabId } = findChannelPanel(chatEl);
    const before = inspectPanel(findChannelPanel(chatEl).panel);
    assert.ok(before.showOlderButton, 'a capped channel renders a "show older" control');
    assert.match(before.showOlderButton.textContent, /^Show 80 older messages$/);
    assert.equal(before.messageCount, CHAT_CHANNEL_RENDER_CAP, 'only the newest CHAT_CHANNEL_RENDER_CAP messages render');
    assert.equal(_testUtils.isChatTabExpanded(tabId), false);

    _testUtils.expandChatTab(tabId);
    await settle();

    assert.equal(_testUtils.isChatTabExpanded(tabId), true, 'the cap is lifted after show-older');
    const after = inspectPanel(findChannelPanel(chatEl).panel);
    assert.equal(after.messageCount, messageCount, 'every message renders once the cap is lifted');
    assert.equal(after.showOlderButton, null, 'the show-older control is gone once fully expanded');

    // A second expand call is a harmless no-op (already expanded) — the
    // factory must not run again (mirrors the node-table "show all" guard).
    _testUtils.expandChatTab(tabId);
    await settle();
    assert.equal(_testUtils.isChatTabExpanded(tabId), true);
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});

test('a channel within the cap renders in full with no show-older control', async () => {
  const env = createDomEnvironment({ includeBody: true });
  const chatEl = env.document.createElement('div');
  env.registerElement('chat', chatEl);

  const now = Math.floor(Date.now() / 1000);
  const messagesPayload = Array.from({ length: 10 }, (_, i) => ({
    id: i,
    channel: 0,
    from_id: nid(0x50000),
    to_id: '^all',
    text: `s${i}`,
    rx_time: now - (10 - i),
    protocol: 'meshtastic',
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = url => {
    if (url.startsWith('/api/nodes')) return jsonResponse([]);
    if (url.startsWith('/api/messages')) return jsonResponse(messagesPayload);
    return jsonResponse([]);
  };
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;
    await settle();

    const { panel, tabId } = findChannelPanel(chatEl);
    const { messageCount, showOlderButton } = inspectPanel(panel);
    assert.equal(messageCount, 10, 'a small channel renders in full (no cap)');
    assert.equal(showOlderButton, null);
    assert.equal(_testUtils.isChatTabExpanded(tabId), false, 'no expansion needed');
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});
