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
 * Render-stage routing for the dashboard refresh pipeline (issue: frontend
 * perf regression).
 *
 * A single SSE-driven `refresh()` used to re-run the entire pipeline — full
 * node-derived-state rebuild, node table, map (markers + every neighbor/trace
 * polyline), and every chat tab — regardless of which collection the delta
 * actually touched. A `messages`-only ping re-cleared and redrew the whole
 * map; a `neighbors`-only ping re-hydrated every chat message.
 *
 * This module holds the pure mapping from "which collections changed" to
 * "which render stages need to run". It has no knowledge of `main.js`'s
 * mutable state — the caller computes `changed` from the actual delta rows
 * (`want(name) && incoming<name>.length > 0`) and passes it in.
 *
 * @module main/render-stages
 */

/**
 * Collections that feed each render stage. A stage runs when at least one of
 * its trigger collections is in the `changed` set (or, for `chatChannels`,
 * when a node's display fields changed even with no new message rows — a
 * renamed sender must still relabel their existing chat entries).
 *
 * `log` and `stats` are handled outside this table: `log` triggers on any
 * change at all (the mixed Log tab mixes every collection), and `stats` uses
 * the same `nodes` trigger as `table`/`markers` but is additionally rate
 * limited by the caller (SPEC PS-perf: no busier than once per ~10s).
 *
 * @type {Readonly<Object<string, ReadonlyArray<string>>>}
 */
const STAGE_TRIGGERS = Object.freeze({
  derive: Object.freeze(['nodes', 'positions', 'telemetry']),
  table: Object.freeze(['nodes', 'positions', 'telemetry']),
  markers: Object.freeze(['nodes', 'positions', 'telemetry']),
  neighborLines: Object.freeze(['neighbors', 'nodes', 'positions']),
  traceLines: Object.freeze(['traces', 'nodes', 'positions']),
  waypoints: Object.freeze(['waypoints', 'nodes']),
  chatChannels: Object.freeze(['messages']),
  stats: Object.freeze(['nodes']),
});

/**
 * Render stages that must run for a full (non-delta) refresh: the initial
 * cold load, a resync, or any other path that does not know which
 * collections actually changed. Every stage is unconditionally true.
 *
 * @type {Readonly<{derive: boolean, table: boolean, markers: boolean, neighborLines: boolean, traceLines: boolean, waypoints: boolean, chatChannels: boolean, log: boolean, stats: boolean}>}
 */
export const ALL_RENDER_STAGES = Object.freeze({
  derive: true,
  table: true,
  markers: true,
  neighborLines: true,
  traceLines: true,
  waypoints: true,
  chatChannels: true,
  log: true,
  stats: true,
});

/**
 * Map a set of changed collections to the render stages that must run.
 *
 * @param {Set<string>} changed Collections whose delta fetch returned at
 *   least one row this tick (see module doc for how the caller computes it).
 *   A non-Set or empty value is treated as "nothing changed" — every stage
 *   resolves false (`chatChannels` still honours `nodeDisplayChanged`).
 * @param {{ nodeDisplayChanged?: boolean }} [options] `nodeDisplayChanged`:
 *   true when an incoming node row changed a display field
 *   (`short_name`/`long_name`/`role`/`protocol`) for a node already known —
 *   forces `chatChannels` on even with no new message rows, so already-shown
 *   chat entries relabel.
 * @returns {{
 *   derive: boolean, table: boolean, markers: boolean, neighborLines: boolean,
 *   traceLines: boolean, waypoints: boolean, chatChannels: boolean,
 *   log: boolean, stats: boolean,
 * }} Which render stages need to run this tick.
 */
export function stagesForChanges(changed, { nodeDisplayChanged = false } = {}) {
  const hasChange = changed instanceof Set && changed.size > 0;
  const has = name => hasChange && changed.has(name);
  const anyOf = names => names.some(has);
  const stages = {};
  for (const [stage, triggers] of Object.entries(STAGE_TRIGGERS)) {
    stages[stage] = anyOf(triggers);
  }
  stages.chatChannels = stages.chatChannels || Boolean(nodeDisplayChanged);
  stages.log = hasChange;
  return stages;
}

/** Node fields a chat entry's rendered sender label/badge depends on. */
const DISPLAY_FIELDS = Object.freeze(['short_name', 'long_name', 'role', 'protocol']);

/**
 * Detect whether any incoming node row changes a display field
 * (`short_name`/`long_name`/`role`/`protocol`) for a node already known, or
 * introduces a node not yet seen. Compares against the node index as it
 * stood *before* this tick's merge — call before `nodesById` is rebuilt.
 *
 * Feeds `stagesForChanges`'s `nodeDisplayChanged` option: a `messages`-only
 * delta skips `chatChannels`, but a renamed/re-roled sender must still
 * relabel their already-rendered chat entries even with zero new message
 * rows this tick.
 *
 * @param {Array<Object>} incomingNodes Delta node rows from this refresh.
 * @param {Map<string, Object>} nodesById Node index from *before* this tick's
 *   merge (the previous tick's rebuilt state).
 * @returns {boolean} True when a display-relevant field changed or a node id
 *   in the delta was not previously known.
 */
export function hasNodeDisplayChange(incomingNodes, nodesById) {
  if (!Array.isArray(incomingNodes) || incomingNodes.length === 0) return false;
  const index = nodesById instanceof Map ? nodesById : null;
  for (const row of incomingNodes) {
    if (!row || typeof row !== 'object') continue;
    const id = row.node_id;
    if (id == null) continue;
    const existing = index ? index.get(id) : null;
    if (!existing) return true;
    for (const field of DISPLAY_FIELDS) {
      if (existing[field] !== row[field]) return true;
    }
  }
  return false;
}
