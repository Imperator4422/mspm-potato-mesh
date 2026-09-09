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
 * PS-A5 — SSE live updates replace the 60s primary poll. Drives main.js over a
 * fake EventSource + stub fetch and asserts: a per-collection ping triggers a
 * targeted delta fetch; a (re)connect triggers a full resync; the cadence is the
 * slow safety poll while live, and the legacy poll when SSE is unavailable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runLiveApp } from './sse-app-harness.js';

test('live updates active: SSE stream opens and the cadence is the slow safety poll', async () => {
  await runLiveApp({}, async ({ testUtils, FakeEventSource }) => {
    assert.equal(testUtils.isLiveActive(), true);
    assert.equal(testUtils.getAutoRefreshIntervalMs(), 300_000); // safety poll, not 60s
    assert.equal(FakeEventSource.instances.length, 1);
    assert.equal(FakeEventSource.instances[0].url, '/api/events');
  });
});

test('a messages ping triggers a targeted delta fetch, not a full refresh', async () => {
  await runLiveApp({}, async ({ calls, testUtils, FakeEventSource }) => {
    const before = calls.length;
    FakeEventSource.instances[0].dispatch('change', {
      data: JSON.stringify({ collection: 'messages' }),
    });
    await testUtils.flushLiveRefresh();
    const after = calls.slice(before);
    assert.ok(
      after.some((c) => c.url.startsWith('/api/messages?') && c.url.includes('since=')),
      `messages delta should be fetched: ${after.map((c) => c.url).join(', ')}`,
    );
    assert.ok(
      !after.some((c) => c.url.startsWith('/api/nodes?')),
      `nodes must NOT be refetched on a messages-only ping: ${after.map((c) => c.url).join(', ')}`,
    );
  });
});

test('a burst of pings coalesces into one refresh of just the dirty collections', async () => {
  await runLiveApp({}, async ({ calls, testUtils, FakeEventSource }) => {
    const es = FakeEventSource.instances[0];
    const before = calls.length;
    es.dispatch('change', { data: JSON.stringify({ collection: 'messages' }) });
    es.dispatch('change', { data: JSON.stringify({ collection: 'messages' }) });
    es.dispatch('change', { data: JSON.stringify({ collection: 'positions' }) });
    await testUtils.flushLiveRefresh();
    const after = calls.slice(before);
    assert.ok(after.some((c) => c.url.startsWith('/api/messages?')), 'messages fetched');
    assert.ok(after.some((c) => c.url.startsWith('/api/positions?')), 'positions fetched');
    assert.ok(!after.some((c) => c.url.startsWith('/api/nodes?')), 'nodes not fetched (clean)');
  });
});

test('a (re)connect triggers a full resync, clearing any pending targeted fetch', async () => {
  await runLiveApp({}, async ({ calls, testUtils, FakeEventSource }) => {
    const es = FakeEventSource.instances[0];
    const before = calls.length;
    es.dispatch('change', { data: JSON.stringify({ collection: 'messages' }) }); // arms a pending fetch
    es.dispatch('open', {}); // resync supersedes it with a full refresh
    await testUtils.flushLiveRefresh();
    const after = calls.slice(before);
    assert.ok(after.some((c) => c.url.startsWith('/api/nodes?')), 'nodes refetched on resync');
    assert.ok(after.some((c) => c.url.startsWith('/api/messages?')), 'messages refetched on resync');
  });
});

test('a stream error is swallowed (never load-bearing)', async () => {
  const originalDebug = console.debug;
  let reported = false;
  console.debug = () => {
    reported = true;
  };
  try {
    await runLiveApp({}, async ({ FakeEventSource }) => {
      assert.doesNotThrow(() => FakeEventSource.instances[0].dispatch('error', {}));
    });
  } finally {
    console.debug = originalDebug;
  }
  assert.equal(reported, true);
});

test('restartAutoRefresh reuses the existing stream rather than opening a second', async () => {
  await runLiveApp({}, async ({ testUtils, FakeEventSource }) => {
    testUtils.restartAutoRefresh();
    assert.equal(FakeEventSource.instances.length, 1);
    assert.equal(testUtils.isLiveActive(), true);
  });
});

test('no EventSource support falls back to the legacy poll cadence', async () => {
  await runLiveApp({ withEventSource: false }, async ({ testUtils }) => {
    assert.equal(testUtils.isLiveActive(), false);
    assert.equal(testUtils.getAutoRefreshIntervalMs(), 60_000); // REFRESH_MS fallback
  });
});

test('a ping arriving mid-fetch does not start a second refresh before the first settles, then runs once more with the union', async () => {
  await runLiveApp({}, async ({ testUtils, FakeEventSource, calls }) => {
    const es = FakeEventSource.instances[0];
    const wrappedFetch = globalThis.fetch;
    let releaseMessages;
    const gate = new Promise((resolve) => {
      releaseMessages = resolve;
    });
    // Gate only the /api/messages response so the first (messages-only) run
    // stays in flight while a second, different-collection ping arrives.
    globalThis.fetch = (url, ...rest) => {
      if (url.startsWith('/api/messages')) {
        return gate.then(() => wrappedFetch(url, ...rest));
      }
      return wrappedFetch(url, ...rest);
    };
    try {
      const before = calls.length;
      es.dispatch('change', { data: JSON.stringify({ collection: 'messages' }) });
      const flushPromise = testUtils.flushLiveRefresh();
      // The mid-flight ping: the scheduler must record it, not fetch it yet.
      es.dispatch('change', { data: JSON.stringify({ collection: 'positions' }) });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.ok(
        !calls.slice(before).some((c) => c.url.startsWith('/api/positions?')),
        'positions must not be fetched while the messages run is still in flight',
      );
      releaseMessages();
      await flushPromise;
      const after = calls.slice(before);
      // The messages collection issues two requests per run (plain + encrypted,
      // see fetchMessages call sites in refresh()); both belong to the first
      // (messages-ping) run, none to the follow-up.
      assert.equal(
        after.filter((c) => c.url.startsWith('/api/messages?')).length,
        2,
        'messages fetched by the first run only (plain + encrypted)',
      );
      assert.equal(
        after.filter((c) => c.url.startsWith('/api/positions?')).length,
        1,
        'positions fetched exactly once, by the follow-up run launched on settle',
      );
    } finally {
      globalThis.fetch = wrappedFetch;
    }
  });
});

test('EVENTS disabled by config opens no stream and uses the legacy poll', async () => {
  await runLiveApp(
    { configOverrides: { liveUpdatesEnabled: false } },
    async ({ testUtils, FakeEventSource }) => {
      assert.equal(testUtils.isLiveActive(), false);
      assert.equal(testUtils.getAutoRefreshIntervalMs(), 60_000);
      assert.equal(FakeEventSource.instances.length, 0); // stream never created
    },
  );
});
