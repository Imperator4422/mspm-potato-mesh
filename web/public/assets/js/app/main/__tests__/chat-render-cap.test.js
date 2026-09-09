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
 * Unit coverage for the chat channel-tab render cap helpers (frontend perf:
 * render scale).
 *
 * @module main/__tests__/chat-render-cap
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capChatEntries,
  buildShowOlderRow,
  CHAT_CHANNEL_RENDER_CAP,
  SHOW_OLDER_ROW_CLASS,
  SHOW_OLDER_BUTTON_CLASS,
} from '../chat-render-cap.js';

/** Build a list of ``count`` distinct entry-like objects, oldest first. */
const entries = count => Array.from({ length: count }, (_, i) => ({ ts: i, id: i }));

test('capChatEntries renders the whole list when it is within the cap', () => {
  const { rendered, hiddenCount } = capChatEntries(entries(10), 500, false);
  assert.equal(rendered.length, 10);
  assert.equal(hiddenCount, 0);
});

test('capChatEntries truncates to the newest N and reports how many were hidden', () => {
  const list = entries(700);
  const { rendered, hiddenCount } = capChatEntries(list, 500, false);
  assert.equal(rendered.length, 500);
  assert.equal(hiddenCount, 200);
  assert.strictEqual(rendered[0], list[200], 'keeps the newest slice (chronological tail)');
  assert.strictEqual(rendered[rendered.length - 1], list[list.length - 1]);
});

test('capChatEntries renders everything when expanded, ignoring the cap', () => {
  const { rendered, hiddenCount } = capChatEntries(entries(700), 500, true);
  assert.equal(rendered.length, 700);
  assert.equal(hiddenCount, 0);
});

test('capChatEntries disables capping for a non-positive or non-finite cap', () => {
  assert.equal(capChatEntries(entries(700), 0, false).hiddenCount, 0);
  assert.equal(capChatEntries(entries(700), 0, false).rendered.length, 700);
  assert.equal(capChatEntries(entries(700), Infinity, false).hiddenCount, 0);
  assert.equal(capChatEntries(entries(700), Number.NaN, false).hiddenCount, 0);
});

test('capChatEntries tolerates a non-array input', () => {
  const { rendered, hiddenCount } = capChatEntries(undefined, 500, false);
  assert.deepEqual(rendered, []);
  assert.equal(hiddenCount, 0);
});

test('CHAT_CHANNEL_RENDER_CAP is 500', () => {
  assert.equal(CHAT_CHANNEL_RENDER_CAP, 500);
});

/** Minimal document stub supporting the element shape buildShowOlderRow needs. */
function makeDocumentStub() {
  const created = [];
  return {
    created,
    createElement(tag) {
      const el = {
        tag,
        className: '',
        type: '',
        textContent: '',
        children: [],
        dataset: {},
        appendChild(child) {
          this.children.push(child);
          return child;
        },
      };
      created.push(el);
      return el;
    },
  };
}

test('buildShowOlderRow builds a row hosting the labelled, tab-stamped button', () => {
  const documentRef = makeDocumentStub();

  const row = buildShowOlderRow(documentRef, 1500, 'channel-3');

  assert.equal(row.tag, 'div');
  assert.equal(row.className, SHOW_OLDER_ROW_CLASS);
  const button = row.children[0];
  assert.equal(button.tag, 'button');
  assert.equal(button.type, 'button');
  assert.equal(button.className, SHOW_OLDER_BUTTON_CLASS);
  assert.equal(button.dataset.tabId, 'channel-3');
  assert.match(button.textContent, /^Show .+ older messages$/);
  assert.match(button.textContent, /1.?500/, 'includes the (locale-grouped) hidden count');
});
