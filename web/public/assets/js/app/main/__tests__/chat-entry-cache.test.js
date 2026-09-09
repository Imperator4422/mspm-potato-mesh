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

import { createChatEntryCache } from '../chat-entry-cache.js';

/**
 * Build a minimal document double whose ``createElement`` returns a settable
 * node and counts how many nodes were created (i.e. how many parses occurred).
 *
 * @returns {{ createElement: Function, created: () => number }} Fake document.
 */
function makeDoc() {
  let created = 0;
  return {
    createElement() {
      created += 1;
      return { className: '', innerHTML: '' };
    },
    created: () => created,
  };
}

test('constructor rejects a document without createElement', () => {
  assert.throws(() => createChatEntryCache({ documentRef: {} }), TypeError);
  assert.throws(() => createChatEntryCache({ documentRef: null }), TypeError);
});

test('materialize builds a node on first sight and applies class + html', () => {
  const doc = makeDoc();
  const cache = createChatEntryCache({ documentRef: doc });
  const node = cache.materialize('log', 'k1', 'chat-entry-msg', '<b>hi</b>');
  assert.equal(node.className, 'chat-entry-msg');
  assert.equal(node.innerHTML, '<b>hi</b>');
  assert.equal(doc.created(), 1);
  assert.deepEqual(cache.stats(), { materialized: 1, built: 0 });
});

test('materialize reuses the cached node when the html is unchanged', () => {
  const doc = makeDoc();
  const cache = createChatEntryCache({ documentRef: doc });
  const first = cache.materialize('log', 'k1', 'c', '<b>hi</b>');
  const second = cache.materialize('log', 'k1', 'c', '<b>hi</b>');
  assert.strictEqual(second, first, 'unchanged entry should reuse the same node');
  assert.equal(doc.created(), 1, 'no second parse for an unchanged entry');
  assert.equal(cache.stats().materialized, 1);
});

test('materialize rebuilds when the html changes (e.g. a renamed sender)', () => {
  const doc = makeDoc();
  const cache = createChatEntryCache({ documentRef: doc });
  const first = cache.materialize('log', 'k1', 'c', 'old');
  const second = cache.materialize('log', 'k1', 'c', 'new');
  assert.notStrictEqual(second, first);
  assert.equal(second.innerHTML, 'new');
  assert.equal(doc.created(), 2);
  assert.equal(cache.stats().materialized, 2);
});

test('namespaces keep independent nodes for the same key', () => {
  const doc = makeDoc();
  const cache = createChatEntryCache({ documentRef: doc });
  const logNode = cache.materialize('log', 'msg:1', 'c', 'h');
  const chanNode = cache.materialize('channel-0', 'msg:1', 'c', 'h');
  assert.notStrictEqual(logNode, chanNode, 'same message in two tabs gets two nodes');
  assert.equal(cache.size('log'), 1);
  assert.equal(cache.size('channel-0'), 1);
  assert.equal(cache.size(), 2);
});

test('prune drops entries not seen during the cycle and keeps seen ones', () => {
  const doc = makeDoc();
  const cache = createChatEntryCache({ documentRef: doc });
  // Cycle 1: both a and b are present; prune closes the cycle.
  cache.materialize('log', 'a', 'c', 'A');
  cache.materialize('log', 'b', 'c', 'B');
  cache.prune('log');
  assert.equal(cache.size('log'), 2);

  // Cycle 2: only a is present.
  cache.materialize('log', 'a', 'c', 'A');
  cache.prune('log');
  assert.equal(cache.size('log'), 1, 'aged-out entry b should be pruned');

  // 'a' is reused, not rebuilt (still one materialisation total for it).
  assert.equal(cache.stats().materialized, 2);
});

test('prune on an unknown namespace is a no-op', () => {
  const cache = createChatEntryCache({ documentRef: makeDoc() });
  assert.doesNotThrow(() => cache.prune('never-seen'));
});

test('a second prune with no intervening materialize clears the namespace', () => {
  const cache = createChatEntryCache({ documentRef: makeDoc() });
  cache.materialize('log', 'a', 'c', 'A');
  cache.prune('log'); // drops the per-cycle seen set, keeps 'a'
  assert.equal(cache.size('log'), 1);
  cache.prune('log'); // no entries seen this cycle → empties the tab cache
  assert.equal(cache.size('log'), 0);
});

test('retainNamespaces forgets caches and seen sets outside the active set', () => {
  const cache = createChatEntryCache({ documentRef: makeDoc() });
  cache.materialize('log', 'a', 'c', 'A');
  cache.materialize('channel-0', 'b', 'c', 'B');
  cache.materialize('channel-9', 'c', 'c', 'C');
  assert.equal(cache.size(), 3);

  cache.retainNamespaces(new Set(['log', 'channel-0']));
  assert.equal(cache.size('channel-9'), 0, 'removed channel cache released');
  assert.equal(cache.size('log'), 1);
  assert.equal(cache.size('channel-0'), 1);
});

test('retainNamespaces accepts a plain iterable, not only a Set', () => {
  const cache = createChatEntryCache({ documentRef: makeDoc() });
  cache.materialize('log', 'a', 'c', 'A');
  cache.materialize('channel-0', 'b', 'c', 'B');
  cache.retainNamespaces(['log']);
  assert.equal(cache.size('log'), 1);
  assert.equal(cache.size('channel-0'), 0);
});

test('resetStats clears both counters without evicting cached nodes', () => {
  const doc = makeDoc();
  const cache = createChatEntryCache({ documentRef: doc });
  const node = cache.materialize('log', 'a', 'c', 'A');
  cache.materializeLazy('log', 'b', 'sig', () => ({ className: 'c', html: 'B' }));
  cache.resetStats();
  assert.deepEqual(cache.stats(), { materialized: 0, built: 0 });
  // Still cached: re-materialising the same html returns the same node.
  assert.strictEqual(cache.materialize('log', 'a', 'c', 'A'), node);
  assert.equal(cache.stats().materialized, 0);
});

test('materializeLazy skips buildParts entirely on a signature hit', () => {
  const doc = makeDoc();
  const cache = createChatEntryCache({ documentRef: doc });
  let buildCalls = 0;
  const buildParts = () => {
    buildCalls += 1;
    return { className: 'chat-entry-msg', html: '<b>hi</b>' };
  };

  const first = cache.materializeLazy('channel-0', 'msg:1', 'sig-v1', buildParts);
  assert.equal(buildCalls, 1, 'first sight always calls buildParts');
  assert.equal(doc.created(), 1);
  assert.deepEqual(cache.stats(), { materialized: 1, built: 1 });

  const second = cache.materializeLazy('channel-0', 'msg:1', 'sig-v1', buildParts);
  assert.strictEqual(second, first, 'a signature hit reuses the same node');
  assert.equal(buildCalls, 1, 'a signature hit never calls buildParts');
  assert.deepEqual(cache.stats(), { materialized: 1, built: 1 }, 'neither counter advances on a signature hit');
});

test('materializeLazy calls buildParts on a signature mismatch, and rebuilds the DOM node when the html actually differs', () => {
  const doc = makeDoc();
  const cache = createChatEntryCache({ documentRef: doc });
  const first = cache.materializeLazy('log', 'k1', 'sig-v1', () => ({ className: 'c', html: 'old' }));
  const second = cache.materializeLazy('log', 'k1', 'sig-v2', () => ({ className: 'c', html: 'new' }));
  assert.notStrictEqual(second, first);
  assert.equal(second.innerHTML, 'new');
  assert.deepEqual(cache.stats(), { materialized: 2, built: 2 });
});

test('materializeLazy on a signature mismatch that yields identical html reuses the node but adopts the new signature', () => {
  const doc = makeDoc();
  const cache = createChatEntryCache({ documentRef: doc });
  const first = cache.materializeLazy('log', 'k1', 'sig-v1', () => ({ className: 'c', html: 'same' }));
  // A sender rename changes the signature, but this particular entry's HTML
  // happens not to depend on the changed field, so the html comes back
  // identical — the node is still reused (only the DOM parse is memoised
  // against html, not against signature), while the stored signature is
  // still updated so a *later* unrelated check does not re-flag it.
  const second = cache.materializeLazy('log', 'k1', 'sig-v2', () => ({ className: 'c', html: 'same' }));
  assert.strictEqual(second, first);
  assert.deepEqual(cache.stats(), { materialized: 1, built: 2 }, 'buildParts still ran (signature changed) but no re-parse');

  // The adopted signature is now sig-v2 — reusing it is a hit, no further build.
  const third = cache.materializeLazy('log', 'k1', 'sig-v2', () => {
    throw new Error('must not be called');
  });
  assert.strictEqual(third, first);
  assert.deepEqual(cache.stats(), { materialized: 1, built: 2 });
});

test('materializeLazy returns null and caches nothing when buildParts yields null', () => {
  const doc = makeDoc();
  const cache = createChatEntryCache({ documentRef: doc });
  let calls = 0;
  const result = cache.materializeLazy('log', 'hidden-1', 'sig', () => {
    calls += 1;
    return null;
  });
  assert.equal(result, null);
  assert.equal(cache.size('log'), 0);
  assert.deepEqual(cache.stats(), { materialized: 0, built: 1 });

  // Every subsequent call is treated as a fresh miss (nothing was cached),
  // so buildParts runs again each time, even with the same signature.
  cache.materializeLazy('log', 'hidden-1', 'sig', () => {
    calls += 1;
    return null;
  });
  assert.equal(calls, 2);
});

test('materializeLazy tolerates a non-function buildParts', () => {
  const cache = createChatEntryCache({ documentRef: makeDoc() });
  assert.equal(cache.materializeLazy('log', 'k1', 'sig', null), null);
});

test('materializeLazy keeps namespaces independent, same as materialize', () => {
  const doc = makeDoc();
  const cache = createChatEntryCache({ documentRef: doc });
  const build = () => ({ className: 'c', html: 'h' });
  const logNode = cache.materializeLazy('log', 'msg:1', 'sig', build);
  const chanNode = cache.materializeLazy('channel-0', 'msg:1', 'sig', build);
  assert.notStrictEqual(logNode, chanNode);
  assert.equal(cache.size('log'), 1);
  assert.equal(cache.size('channel-0'), 1);
});

test('prune and retainNamespaces treat materializeLazy entries the same as materialize entries', () => {
  const doc = makeDoc();
  const cache = createChatEntryCache({ documentRef: doc });
  cache.materializeLazy('log', 'a', 'sig', () => ({ className: 'c', html: 'A' }));
  cache.prune('log');
  assert.equal(cache.size('log'), 1);
  // 'a' not seen this cycle → pruned.
  cache.prune('log');
  assert.equal(cache.size('log'), 0);
});

test('size of an unknown namespace is zero', () => {
  const cache = createChatEntryCache({ documentRef: makeDoc() });
  assert.equal(cache.size('nope'), 0);
});
