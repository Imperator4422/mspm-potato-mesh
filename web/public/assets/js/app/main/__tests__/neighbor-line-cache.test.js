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

import { createNeighborLineCache } from '../neighbor-line-cache.js';

/** Build a create/remove handler pair that records calls on plain arrays. */
function makeHandlers() {
  const createdLayers = [];
  const removedLayers = [];
  let nextId = 1;
  return {
    createdLayers,
    removedLayers,
    create: segment => {
      const layer = { id: nextId++, segment };
      createdLayers.push(layer);
      return layer;
    },
    remove: layer => {
      removedLayers.push(layer);
    },
  };
}

const seg = (sourceId, targetId, signature) => ({ sourceId, targetId, signature });

test('first sync creates a layer for every segment', () => {
  const cache = createNeighborLineCache();
  const { create, remove, createdLayers } = makeHandlers();
  const result = cache.sync([seg('!a', '!b', 'sig1'), seg('!c', '!d', 'sig2')], { create, remove });
  assert.equal(result.created, 2);
  assert.equal(result.kept, 0);
  assert.equal(result.removed, 0);
  assert.equal(createdLayers.length, 2);
  assert.equal(cache.size(), 2);
});

test('a second sync with identical segments keeps every layer, creating/removing nothing', () => {
  const cache = createNeighborLineCache();
  const handlers = makeHandlers();
  cache.sync([seg('!a', '!b', 'sig1')], handlers);
  const before = handlers.createdLayers.length;
  const result = cache.sync([seg('!a', '!b', 'sig1')], handlers);
  assert.equal(result.created, 0);
  assert.equal(result.kept, 1);
  assert.equal(result.removed, 0);
  assert.equal(handlers.createdLayers.length, before, 'no new layer was created');
  assert.equal(handlers.removedLayers.length, 0);
});

test('a changed signature recreates exactly that direction: remove then create', () => {
  const cache = createNeighborLineCache();
  const handlers = makeHandlers();
  cache.sync([seg('!a', '!b', 'sig1'), seg('!c', '!d', 'sig2')], handlers);
  const firstLayerForAB = handlers.createdLayers[0];

  const result = cache.sync([seg('!a', '!b', 'sig1-changed'), seg('!c', '!d', 'sig2')], handlers);

  assert.equal(result.created, 1, 'only the changed direction is recreated');
  assert.equal(result.kept, 1, 'the unchanged direction is kept');
  assert.equal(result.removed, 0, 'a changed (not disappeared) direction is a recreate, not a net removal');
  assert.deepEqual(handlers.removedLayers, [firstLayerForAB], 'the stale a→b layer was removed');
  assert.equal(cache.size(), 2);
});

test('a direction missing from the new segment list is removed', () => {
  const cache = createNeighborLineCache();
  const handlers = makeHandlers();
  cache.sync([seg('!a', '!b', 'sig1'), seg('!c', '!d', 'sig2')], handlers);
  const abLayer = handlers.createdLayers[0];

  const result = cache.sync([seg('!c', '!d', 'sig2')], handlers);

  assert.equal(result.created, 0);
  assert.equal(result.kept, 1);
  assert.equal(result.removed, 1);
  assert.deepEqual(handlers.removedLayers, [abLayer]);
  assert.equal(cache.size(), 1);
});

test('a→b and b→a are distinct cache entries (direction matters)', () => {
  const cache = createNeighborLineCache();
  const handlers = makeHandlers();
  const result = cache.sync([seg('!a', '!b', 'sig1'), seg('!b', '!a', 'sig1')], handlers);
  assert.equal(result.created, 2);
  assert.equal(cache.size(), 2);
});

test('sync tolerates a non-array segments argument and null entries within it', () => {
  const cache = createNeighborLineCache();
  const handlers = makeHandlers();
  assert.doesNotThrow(() => cache.sync(null, handlers));
  assert.equal(cache.size(), 0);
  const result = cache.sync([null, seg('!a', '!b', 'sig1'), undefined], handlers);
  assert.equal(result.created, 1);
  assert.equal(cache.size(), 1);
});

test('an empty segment list on a populated cache removes everything', () => {
  const cache = createNeighborLineCache();
  const handlers = makeHandlers();
  cache.sync([seg('!a', '!b', 'sig1'), seg('!c', '!d', 'sig2')], handlers);
  const result = cache.sync([], handlers);
  assert.equal(result.removed, 2);
  assert.equal(cache.size(), 0);
});

test('clear() empties the cache bookkeeping without calling remove', () => {
  const cache = createNeighborLineCache();
  const handlers = makeHandlers();
  cache.sync([seg('!a', '!b', 'sig1')], handlers);
  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(handlers.removedLayers.length, 0, 'clear() does not call remove — the caller already tore the layer down');
  // A subsequent sync starts completely fresh (no stale kept-state).
  const result = cache.sync([seg('!a', '!b', 'sig1')], handlers);
  assert.equal(result.created, 1);
  assert.equal(result.kept, 0);
});
