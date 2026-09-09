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
 * Slack (px) within which the active panel counts as scrolled to the bottom.
 * A reader inside this band is treated as "pinned" and kept pinned across a
 * passive re-render (tail-follow); anyone scrolled further up keeps their exact
 * position. Small enough to ignore sub-pixel rounding, large enough to survive a
 * one-line layout jitter.
 * @type {number}
 */
const SCROLL_PIN_TOLERANCE_PX = 4;

/**
 * Capture the active panel's vertical scroll state before the subtree rebuild,
 * so a passive re-render can restore it instead of yanking the reader to the
 * bottom on every live update (bugfix B). ``renderChatTabs`` replaces the whole
 * panel subtree, so the post-render panel is a fresh element with ``scrollTop``
 * 0; without this capture the reader's position is lost on every refresh.
 *
 * @param {HTMLElement} container Chat container holding the *previous* render.
 * @returns {?{ top: number, pinned: boolean }} The active panel's scroll offset
 *   and whether it was at the bottom, or ``null`` when there is no prior panel
 *   (initial render) — in which case the caller pins to the bottom.
 */
function capturePreviousActivePanelScroll(container) {
  const panelWrapper = container && container.children && container.children[1];
  const panels = panelWrapper && panelWrapper.children;
  if (!panels) {
    return null;
  }
  for (const panel of panels) {
    if (!panel || panel.hidden !== false) continue;
    const distanceFromBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight;
    return { top: panel.scrollTop, pinned: distanceFromBottom <= SCROLL_PIN_TOLERANCE_PX };
  }
  return null;
}

/**
 * Apply the captured vertical scroll to the freshly-rendered active panel.
 * A reader that was pinned to the bottom (or an initial render with no prior
 * panel, ``previous == null``) is scrolled to the new bottom so freshly-arrived
 * entries stay visible (tail-follow); otherwise the reader's exact offset is
 * restored (bugfix B).
 *
 * @param {?HTMLElement} panel The active panel after the rebuild.
 * @param {?{ top: number, pinned: boolean }} previous Captured scroll state.
 * @returns {void}
 */
function applyActivePanelScroll(panel, previous) {
  if (!panel) {
    return;
  }
  if (!previous || previous.pinned) {
    panel.scrollTop = panel.scrollHeight;
  } else {
    panel.scrollTop = previous.top;
  }
}

/**
 * Build a tab entry's content on first need, then never again.
 *
 * A tab's ``content`` is either an already-built ``Node`` (appended
 * immediately, same as before lazy panels existed — a caller that has not
 * adopted factories keeps the old eager behaviour) or a factory function
 * (``() => Node``), deferred until the tab is actually activated. A chat with
 * many channels used to build every channel's DOM subtree on every render
 * even though the reader can only look at one at a time; a factory tab
 * defers that cost to the tab the reader actually switches to (Phase 3b,
 * issue: frontend perf regression).
 *
 * @param {{ panel: HTMLElement, built: boolean, contentFactory: ?Function }} entry
 *   Tab entry to materialise; mutated in place (``built`` flips to ``true``).
 * @returns {void}
 */
function materializeTabContent(entry) {
  if (!entry || entry.built) return;
  entry.built = true;
  if (typeof entry.contentFactory === 'function') {
    const node = entry.contentFactory();
    if (node) entry.panel.appendChild(node);
  }
}

/**
 * Render an accessible tab interface within ``container``.
 *
 * When a tab carries an ``iconSrc`` URL the icon is rendered as an
 * {@code <img>} element built entirely via DOM APIs — no ``innerHTML`` is
 * involved so the value is safe even if it originates from user-controlled
 * data (img src does not execute script).  The ``label`` field is always
 * inserted as a text node.
 *
 * When the tab list overflows its container, ◀ / ▶ scroll buttons are
 * rendered on either side of the list.  They are hidden via the
 * {@code hidden} attribute while the corresponding scroll direction is
 * not available.
 *
 * @param {{
 *   document: Document,
 *   container: HTMLElement,
 *   tabs: Array<{ id: string, label: string, iconSrc?: string|null, content: Node|(() => Node)|null }>,
 *   previousActiveTabId?: string|null,
 *   defaultActiveTabId?: string|null,
 *   onActivate?: ?(tabId: string) => void
 * }} options Rendering parameters. A tab's ``content`` may be a plain
 *   already-built ``Node`` (appended immediately) or a factory function
 *   (``() => Node``); a factory is called only for the tab that resolves as
 *   active, and for any other tab only on first activation (Phase 3b).
 *   ``onActivate`` fires every time a tab becomes the active one — the
 *   initial resolution, a passive re-render, and an explicit click/dropdown
 *   switch alike — so a caller can, for example, snap a shared relative-time
 *   ticker immediately for a panel that was hidden (and so unscanned) until
 *   just now (Phase 4).
 * @returns {?string} Identifier of the active tab after rendering.
 */
export function renderChatTabs({
  document,
  container,
  tabs,
  previousActiveTabId = null,
  defaultActiveTabId = null,
  onActivate = null
}) {
  if (!container || !document) {
    return null;
  }
  const validTabs = Array.isArray(tabs) ? tabs.filter(Boolean) : [];
  if (validTabs.length === 0) {
    if (typeof container.replaceChildren === 'function') {
      container.replaceChildren();
    } else {
      container.innerHTML = '';
    }
    container.dataset.activeTab = '';
    return null;
  }

  const fragment = createFragment(document);

  // Wrapper holds the scroll buttons + the tab list so the border-bottom
  // spans the full width including the arrow buttons.
  const tabListWrapper = document.createElement('div');
  tabListWrapper.className = 'chat-tablist-wrapper';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'chat-tab-scroll-btn chat-tab-scroll-btn--prev';
  prevBtn.setAttribute('aria-hidden', 'true');
  prevBtn.setAttribute('tabindex', '-1');
  prevBtn.textContent = '◀';
  prevBtn.hidden = true;

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'chat-tab-scroll-btn chat-tab-scroll-btn--next';
  nextBtn.setAttribute('aria-hidden', 'true');
  nextBtn.setAttribute('tabindex', '-1');
  nextBtn.textContent = '▶';
  nextBtn.hidden = true;

  // Channel dropdown selector (LV8): a native <select> listing every tab so
  // the user can jump to a channel regardless of the horizontal scroll
  // position (the native control supplies the downward-triangle affordance).
  const tabSelect = document.createElement('select');
  tabSelect.className = 'chat-tab-select';
  tabSelect.setAttribute('aria-label', 'Jump to channel');

  const tabList = document.createElement('div');
  tabList.className = 'chat-tablist';
  tabList.setAttribute('role', 'tablist');

  tabListWrapper.appendChild(prevBtn);
  tabListWrapper.appendChild(tabList);
  tabListWrapper.appendChild(nextBtn);
  tabListWrapper.appendChild(tabSelect);

  const panelWrapper = document.createElement('div');
  panelWrapper.className = 'chat-tabpanels';

  fragment.appendChild(tabListWrapper);
  fragment.appendChild(panelWrapper);

  const tabElements = [];
  const existingActive = container.dataset?.activeTab || null;
  // Preserve the channel-tab list's horizontal scroll across the full-subtree
  // rebuild below (item 5): without this, every live refresh resets scrollLeft
  // to 0 and yanks the user back to the first tab. The previous render's tab
  // list is the second child of the first wrapper (see the structure built
  // below); guard defensively in case the container held no prior tab list.
  const previousTabListWrapper = container.children && container.children[0];
  const previousTabList =
    previousTabListWrapper && previousTabListWrapper.children
      ? previousTabListWrapper.children[1]
      : null;
  const previousScrollLeft =
    previousTabList &&
    previousTabList.className === 'chat-tablist' &&
    typeof previousTabList.scrollLeft === 'number'
      ? previousTabList.scrollLeft
      : 0;
  // Capture the active panel's VERTICAL scroll before the rebuild so a passive
  // refresh restores it rather than snapping the reader to the bottom (bugfix B).
  const previousActivePanelScroll = capturePreviousActivePanelScroll(container);
  const activeCandidateOrder = [existingActive, previousActiveTabId, defaultActiveTabId];

  // Resolve the active tab id from the deduped id set *before* building any
  // panel content, so exactly one tab's content is materialised eagerly
  // below and every other tab's factory (if it has one) is deferred until
  // first activation (Phase 3b). This dedup pass mirrors the one the build
  // loop performs below — kept separate (rather than reusing tabElements,
  // which does not exist yet at this point) precisely so this resolution can
  // happen first.
  const dedupedIds = [];
  const idSet = new Set();
  for (const tab of validTabs) {
    if (!tab || typeof tab.id !== 'string' || tab.id.length === 0 || idSet.has(tab.id)) {
      continue;
    }
    idSet.add(tab.id);
    dedupedIds.push(tab.id);
  }
  if (dedupedIds.length === 0) {
    if (typeof container.replaceChildren === 'function') {
      container.replaceChildren();
    } else {
      container.innerHTML = '';
    }
    container.dataset.activeTab = '';
    return null;
  }
  let activeTabId = null;
  for (const candidate of activeCandidateOrder) {
    if (candidate && idSet.has(candidate)) {
      activeTabId = candidate;
      break;
    }
  }
  if (!activeTabId) {
    activeTabId = dedupedIds[0];
  }

  idSet.clear();
  for (const tab of validTabs) {
    if (!tab || typeof tab.id !== 'string' || tab.id.length === 0) {
      continue;
    }
    const uniqueId = tab.id;
    if (idSet.has(uniqueId)) {
      continue;
    }
    idSet.add(uniqueId);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-tab';
    button.classList.add('chat-tab');
    button.setAttribute('role', 'tab');
    button.setAttribute('id', `chat-tab-${uniqueId}`);
    button.dataset.tabId = uniqueId;
    if (tab.iconSrc) {
      const icon = document.createElement('img');
      icon.setAttribute('src', tab.iconSrc);
      icon.setAttribute('alt', '');
      icon.setAttribute('width', '12');
      icon.setAttribute('height', '12');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('loading', 'lazy');
      icon.setAttribute('decoding', 'async');
      icon.className = 'protocol-icon';
      button.appendChild(icon);
      button.appendChild(document.createTextNode(tab.label || ''));
    } else {
      button.textContent = tab.label || '';
    }
    button.setAttribute('aria-selected', 'false');
    button.setAttribute('tabindex', '-1');

    const panel = document.createElement('div');
    panel.className = 'chat-tabpanel';
    panel.classList.add('chat-tabpanel');
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('id', `chat-panel-${uniqueId}`);
    panel.setAttribute('aria-labelledby', button.getAttribute('id'));
    panel.hidden = true;

    // A function is a lazy factory (Phase 3b): appended now only for the tab
    // that resolves as active, deferred for every other tab until it is
    // actually activated. A plain Node (or no content) keeps the pre-Phase-3b
    // behaviour of being appended immediately regardless of which tab is
    // active, so a caller that has not adopted factories is unaffected.
    const isLazy = typeof tab.content === 'function';
    const entry = {
      id: uniqueId,
      button,
      panel,
      built: !isLazy,
      contentFactory: isLazy ? tab.content : null
    };
    if (!isLazy) {
      if (tab.content) panel.appendChild(tab.content);
    } else if (uniqueId === activeTabId) {
      materializeTabContent(entry);
    }

    tabList.appendChild(button);
    panelWrapper.appendChild(panel);
    const option = document.createElement('option');
    option.value = uniqueId;
    option.textContent = tab.label || uniqueId;
    tabSelect.appendChild(option);
    tabElements.push(entry);
  }

  if (typeof container.replaceChildren === 'function') {
    container.replaceChildren(fragment);
  } else {
    container.innerHTML = '';
    container.appendChild(fragment);
  }

  /**
   * Refresh the hidden state of the scroll arrow buttons based on the
   * current scroll position of the tab list.
   */
  const updateArrows = () => {
    const scrollLeft = tabList.scrollLeft || 0;
    const clientWidth = tabList.clientWidth || 0;
    const scrollWidth = tabList.scrollWidth || 0;
    prevBtn.hidden = scrollLeft <= 0;
    // Allow 1 px rounding tolerance.
    nextBtn.hidden = scrollLeft + clientWidth >= scrollWidth - 1;
  };

  // Recalculate arrow visibility on scroll and on container resize.
  if (typeof tabList.addEventListener === 'function') {
    tabList.addEventListener('scroll', updateArrows);
  }
  if (typeof globalThis !== 'undefined' && typeof globalThis.ResizeObserver === 'function') {
    // The observer is intentionally not disconnected: renderChatTabs replaces
    // the entire DOM subtree on each call, so the previous tabList element is
    // detached and the observer will not fire again after that point.
    const ro = new globalThis.ResizeObserver(updateArrows);
    ro.observe(tabList);
  }

  prevBtn.addEventListener('click', () => {
    if (typeof tabList.scrollBy === 'function') {
      tabList.scrollBy({ left: -150, behavior: 'smooth' });
    }
  });
  nextBtn.addEventListener('click', () => {
    if (typeof tabList.scrollBy === 'function') {
      tabList.scrollBy({ left: 150, behavior: 'smooth' });
    }
  });

  const setActiveTab = (newId, { scrollActiveIntoView = false } = {}) => {
    if (!newId) return;
    let matched = false;
    for (const entry of tabElements) {
      const isActive = entry.id === newId;
      entry.button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      entry.button.setAttribute('tabindex', isActive ? '0' : '-1');
      if (isActive) {
        // A no-op for a tab already materialised (eagerly, at build time, or
        // by an earlier activation); builds a lazy tab's content the first
        // time it is actually switched to (Phase 3b).
        materializeTabContent(entry);
        entry.button.classList.add('is-active');
        entry.panel.hidden = false;
        matched = true;
        container.dataset.activeTab = newId;
        tabSelect.value = newId;
        // The panel may have just been hidden (and so unscanned by a
        // root-scoped ticker) until this very activation — snap its
        // relative-time fields now rather than waiting up to ~1s for the
        // next tick (Phase 4).
        if (typeof onActivate === 'function') onActivate(newId);
        // An explicit tab switch (click / dropdown) jumps to the newest entry and
        // scrolls the chosen tab into view. A passive re-render does NEITHER: the
        // reader's vertical scroll is restored by the caller below, and the
        // horizontal tab scroll is left untouched (bugfix B / LD-A2).
        if (scrollActiveIntoView) {
          if (typeof entry.panel.scrollHeight === 'number' && typeof entry.panel.scrollTop === 'number') {
            entry.panel.scrollTop = entry.panel.scrollHeight;
          }
          if (typeof entry.button.scrollIntoView === 'function') {
            entry.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }
        }
      } else {
        entry.button.classList.remove('is-active');
        entry.panel.hidden = true;
      }
    }
    if (!matched) {
      container.dataset.activeTab = '';
    }
  };

  setActiveTab(activeTabId);

  // Restore the active panel's vertical scroll captured before the rebuild: a
  // reader pinned to the bottom stays pinned (tail-follow), anyone scrolled up
  // keeps their place, and an initial render (no prior panel) pins to the
  // bottom so the newest entries show (bugfix B).
  // ``activeTabId`` is always one of ``tabElements`` (chosen from them above), so
  // the entry resolves; ``applyActivePanelScroll`` still guards a missing panel.
  const restoredActiveEntry = tabElements.find(entry => entry.id === activeTabId);
  applyActivePanelScroll(restoredActiveEntry.panel, previousActivePanelScroll);

  // Restore the horizontal scroll captured before the rebuild so a live
  // refresh does not reset the channel-tab list to the first tab (item 5).
  // Applied after setActiveTab, which no longer force-scrolls on a passive
  // render, so the restored position is authoritative.
  if (previousScrollLeft > 0 && typeof tabList.scrollLeft === 'number') {
    tabList.scrollLeft = previousScrollLeft;
  }

  // Single arrow-visibility pass, after every structural + scroll write above.
  // Reading the tab list geometry here — rather than also right after the subtree
  // rebuild, before setActiveTab un-hides the active panel — collapses a live
  // refresh from multiple forced synchronous reflows to one: the earlier read's
  // layout was thrown away by the un-hide anyway (frontend perf: the chat-tabs
  // `refresh` forced-reflow hotspot).
  updateArrows();

  for (const entry of tabElements) {
    entry.button.addEventListener('click', () => {
      setActiveTab(entry.id, { scrollActiveIntoView: true });
    });
  }

  // Jump to the chosen channel when the dropdown selection changes (LV8).
  tabSelect.addEventListener('change', () => {
    setActiveTab(tabSelect.value, { scrollActiveIntoView: true });
  });

  return container.dataset.activeTab || null;
}

/**
 * Create a DOM fragment with a graceful fallback for test environments.
 *
 * @param {Document} document Active document instance.
 * @returns {{ appendChild: Function }} Fragment-like node.
 */
function createFragment(document) {
  if (document && typeof document.createDocumentFragment === 'function') {
    return document.createDocumentFragment();
  }
  const nodes = [];
  return {
    childNodes: nodes,
    appendChild(node) {
      nodes.push(node);
      return node;
    }
  };
}

export const __test__ = {
  createFragment,
  SCROLL_PIN_TOLERANCE_PX,
  capturePreviousActivePanelScroll,
  applyActivePanelScroll,
  materializeTabContent
};
