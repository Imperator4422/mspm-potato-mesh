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
 * Chat channel-tab render cap (frontend perf: render scale).
 *
 * A channel tab renders its *entire* seven-day window (issue #796 — "load
 * the whole window, render on demand" as amended here), unlike the Log tab's
 * fixed {@link CHAT_LIMIT}. On a busy channel that window can be thousands of
 * entries, each a real DOM subtree (dividers, entry nodes), which stalls
 * layout on every tab activation. These pure helpers mirror
 * {@link module:main/nodes-table-cap} — cap the rendered slice to the newest
 * N entries and offer a "show older" control that expands the tab to its
 * full window on demand, matching the node table's "show all".
 *
 * @module main/chat-render-cap
 */

/** Newest entries rendered per channel tab before capping kicks in. */
export const CHAT_CHANNEL_RENDER_CAP = 500;

/** CSS class on the "show older" control (delegated click target lives here). */
export const SHOW_OLDER_ROW_CLASS = 'chat-show-older-row';

/** CSS class on the "show older" button — the delegated click selector. */
export const SHOW_OLDER_BUTTON_CLASS = 'chat-show-older';

/**
 * Decide how many of a channel tab's (already chronologically ordered)
 * entries to render.
 *
 * @param {Array<Object>} entries The full window of entries for this tab.
 * @param {number} cap Maximum entries to render when not expanded (a
 *   non-finite or non-positive cap disables capping).
 * @param {boolean} expanded When true the user asked to see the whole
 *   window, so every entry renders regardless of the cap.
 * @returns {{ rendered: Array<Object>, hiddenCount: number }} The newest
 *   slice to render, and how many older entries were left out (0 when not
 *   capped).
 */
export function capChatEntries(entries, cap, expanded) {
  const list = Array.isArray(entries) ? entries : [];
  const capActive = !expanded && Number.isFinite(cap) && cap > 0 && list.length > cap;
  if (!capActive) {
    return { rendered: list, hiddenCount: 0 };
  }
  const rendered = list.slice(list.length - cap);
  return { rendered, hiddenCount: list.length - rendered.length };
}

/**
 * Build the "show older" control prepended above a capped tab's rendered
 * entries.
 *
 * @param {Document} documentRef DOM document used to create the elements.
 * @param {number} hiddenCount Count of older, not-yet-rendered entries
 *   (shown in the button label).
 * @param {string} tabId Tab identifier, stamped on the button so the
 *   delegated click handler knows which tab to expand.
 * @returns {Element} A ``<div>`` hosting the "show older" button.
 */
export function buildShowOlderRow(documentRef, hiddenCount, tabId) {
  const row = documentRef.createElement('div');
  row.className = SHOW_OLDER_ROW_CLASS;
  const button = documentRef.createElement('button');
  button.type = 'button';
  button.className = SHOW_OLDER_BUTTON_CLASS;
  button.dataset.tabId = tabId;
  button.textContent = `Show ${hiddenCount.toLocaleString()} older messages`;
  row.appendChild(button);
  return row;
}
