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

import { createSnapshotIndex } from '../node-snapshot-index.js';

const keyOf = row => row.node_id;

test('a fresh index has no groups', () => {
  const index = createSnapshotIndex(keyOf);
  assert.equal(index.has('!a'), false);
  assert.deepEqual(index.get('!a'), []);
});

test('rebuild groups rows by key', () => {
  const index = createSnapshotIndex(keyOf);
  index.rebuild([
    { node_id: '!a', rx_time: 1 },
    { node_id: '!b', rx_time: 2 },
    { node_id: '!a', rx_time: 3 },
  ]);
  assert.equal(index.get('!a').length, 2);
  assert.equal(index.get('!b').length, 1);
  assert.equal(index.has('!a'), true);
  assert.equal(index.has('!c'), false);
});

test('rebuild clears any previous groups before reindexing', () => {
  const index = createSnapshotIndex(keyOf);
  index.rebuild([{ node_id: '!a', rx_time: 1 }, { node_id: '!b', rx_time: 2 }]);
  index.rebuild([{ node_id: '!a', rx_time: 9 }]);
  assert.equal(index.get('!a').length, 1);
  assert.equal(index.has('!b'), false, 'a group absent from the new rebuild is dropped');
});

test('rebuild tolerates a non-array argument (clears and stays empty)', () => {
  const index = createSnapshotIndex(keyOf);
  index.rebuild([{ node_id: '!a', rx_time: 1 }]);
  index.rebuild(null);
  assert.equal(index.has('!a'), false);
});

test('addRows appends to a group without touching any other group', () => {
  const index = createSnapshotIndex(keyOf);
  index.rebuild([{ node_id: '!a', rx_time: 1 }, { node_id: '!b', rx_time: 1 }]);
  index.addRows([{ node_id: '!a', rx_time: 2 }]);
  assert.equal(index.get('!a').length, 2);
  assert.equal(index.get('!b').length, 1, 'untouched group is unaffected');
});

test('addRows creates a new group for a previously unseen key', () => {
  const index = createSnapshotIndex(keyOf);
  index.addRows([{ node_id: '!new', rx_time: 1 }]);
  assert.equal(index.has('!new'), true);
  assert.equal(index.get('!new').length, 1);
});

test('addRows preserves insertion order within a group (oldest to newest, as appended)', () => {
  const index = createSnapshotIndex(keyOf);
  index.addRows([{ node_id: '!a', rx_time: 1 }]);
  index.addRows([{ node_id: '!a', rx_time: 2 }]);
  index.addRows([{ node_id: '!a', rx_time: 3 }]);
  assert.deepEqual(index.get('!a').map(r => r.rx_time), [1, 2, 3]);
});

test('addRows skips null/non-object rows and rows whose key resolves to null', () => {
  const index = createSnapshotIndex(keyOf);
  assert.doesNotThrow(() => index.addRows([null, 'x', {}, { node_id: null }]));
  assert.equal(index.get(undefined).length, 0);
});

test('addRows tolerates a non-array argument', () => {
  const index = createSnapshotIndex(keyOf);
  assert.doesNotThrow(() => index.addRows(null));
  assert.doesNotThrow(() => index.addRows(undefined));
});

test('get returns a fresh empty array (not a shared mutable default) for an unknown key', () => {
  const index = createSnapshotIndex(keyOf);
  const first = index.get('!missing');
  const second = index.get('!missing');
  first.push('mutated');
  assert.deepEqual(second, [], 'mutating one empty-array result must not affect a later call');
});

test('works with a custom keyOf resolver (composite/derived key)', () => {
  const compositeKeyOf = row => `${row.node_id}|${row.neighbor_id}`;
  const index = createSnapshotIndex(compositeKeyOf);
  index.rebuild([
    { node_id: '!a', neighbor_id: '!b', rx_time: 1 },
    { node_id: '!a', neighbor_id: '!c', rx_time: 1 },
  ]);
  assert.equal(index.get('!a|!b').length, 1);
  assert.equal(index.get('!a|!c').length, 1);
  assert.equal(index.get('!a').length, 0);
});
