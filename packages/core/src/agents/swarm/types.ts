/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Type definitions for the persistent agent swarm primitive.
 *
 * Mirrors the synthesis's tool schema section in `design-loop/swarm-design.md`.
 * Phase 1 (this file): pure types, no runtime behavior.
 *
 * The swarm exposes a single `swarm` tool with a discriminated union on
 * `action`. Each spawned agent is a long-lived `SwarmSession` (see
 * `swarm-session.ts`) tracked by the singleton `SwarmManager`
 * (see `swarm-manager.ts`).
 */

import { z } from 'zod';
import {
  type AnthropicModelAlias,
  ANTHROPIC_MODEL_ALIAS_VALUES,
} from '../types.js';

/**
 * v1.0 only supports `anthropic`-kind sub-agents. `gemini` / `local` are
 * reserved for v1.1+. The field is optional in the schema and defaults
 * to `'anthropic'` at validation time.
 */
export type SwarmKind = 'anthropic';

/**
 * Status of a `SwarmSession` from the manager's perspective.
 *
 * - `idle`: session exists and is ready to accept the next `message`.
 * - `running`: session is currently inside an Anthropic message loop;
 *   parallel `message` calls on the same session are rejected in v1.
 * - `released`: session has been explicitly released (or hit its abort
 *   signal) and will be removed from the manager's map.
 * - `error`: session's last turn ended in error; still allows another
 *   `message` attempt unless explicitly released.
 */
export enum SwarmSessionStatus {
  IDLE = 'idle',
  RUNNING = 'running',
  RELEASED = 'released',
  ERROR = 'error',
}

/**
 * Lightweight snapshot of a session for the `list` action. Excludes the
 * `messages` array (potentially large) and any non-serializable handles.
 */
export interface SwarmSessionSummary {
  /** Short slug identifier (e.g. `sonnet-1`, `opus-2`). */
  agentId: string;
  /** Sub-agent kind. v1: always `'anthropic'`. */
  kind: SwarmKind;
  /** Resolved model alias. */
  model: AnthropicModelAlias;
  /** Optional human-readable display name. */
  displayName?: string;
  /**
   * Optional short role label (e.g. `'reviewer'`, `'planner'`). Phase 5:
   * surfaced through `list()` / `swarm_status` so peer agents can decide
   * who to coordinate with without re-reading the orchestrator's prompt.
   */
  role?: string;
  /**
   * Optional one-line charter describing the agent's purpose. Phase 5:
   * companion to `role` for sub-agent self-discovery.
   */
  charter?: string;
  /** Current lifecycle status. */
  status: SwarmSessionStatus;
  /** Wall-clock ms timestamp of session creation. */
  createdAt: number;
  /** Wall-clock ms timestamp of last user/assistant exchange. */
  lastActiveAt: number;
  /** Number of completed turns (one `message` = one turn). */
  turnCount: number;
}

/**
 * Zod discriminated union for the `swarm` tool parameters. Single source of
 * truth for the action shapes — the hand-written-vs-Zod drift flagged in
 * the Phase 1 review (Opus #2) is resolved by deriving `SwarmAction` below
 * via `z.infer`.
 *
 * The JSON-schema declaration in `swarm-tool.ts` is hand-mirrored from this
 * schema for the LLM's tool listing; the Zod parse in `SwarmTool.execute`
 * narrows the validated params back into `SwarmAction` for the manager.
 */
export const SwarmActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('spawn'),
    kind: z.literal('anthropic').optional(),
    // Derived from `ANTHROPIC_MODEL_ALIASES` so adding a new alias in
    // `../types.ts` immediately surfaces here without a separate edit
    // (Phase 4 invariant-locality fix).
    model: z.enum(ANTHROPIC_MODEL_ALIAS_VALUES).optional(),
    system_prompt: z.string().min(1),
    tools: z.array(z.string()).optional(),
    max_turns: z.number().int().positive().optional(),
    display_name: z.string().optional(),
    // Phase 5: optional short role label + one-line charter. Length-capped
    // so they stay terse enough for the LLM-rendered `swarm_status` payload.
    role: z.string().max(80).optional(),
    charter: z.string().max(200).optional(),
  }),
  z.object({
    action: z.literal('message'),
    agent_id: z.string().min(1),
    prompt: z.string().min(1),
  }),
  z.object({
    action: z.literal('release'),
    agent_id: z.string().min(1),
  }),
  z.object({
    action: z.literal('list'),
  }),
]);

/**
 * Discriminated union of swarm tool actions, inferred from
 * {@link SwarmActionSchema}. This is the single canonical type; consumers
 * should NOT redeclare the shape elsewhere.
 *
 * `model` in the spawn variant narrows to `AnthropicModelAlias` because the
 * Zod enum is built from `ANTHROPIC_MODEL_ALIAS_VALUES` (the single
 * source-of-truth tuple in `../types.ts`). Adding an alias there propagates
 * automatically — no drift across types/Zod/JSON-schema/manager.
 */
export type SwarmAction = z.infer<typeof SwarmActionSchema>;

// Sanity assertion: the Zod enum and the static type must agree on the set
// of accepted aliases. Drift here is a compile-time error, not a runtime
// surprise. Phase 4 invariant-locality fix.
type _SwarmSpawnAction = Extract<SwarmAction, { action: 'spawn' }>;
type _SwarmModelField = NonNullable<_SwarmSpawnAction['model']>;
type _AssertModelAliasMatches = _SwarmModelField extends AnthropicModelAlias
  ? AnthropicModelAlias extends _SwarmModelField
    ? true
    : never
  : never;
// Force the assertion to be evaluated (otherwise TS would elide the alias).
const _swarmModelAliasInvariant: _AssertModelAliasMatches = true;
void _swarmModelAliasInvariant;

/**
 * Status of a single `message` action outcome. Distinct from the session's
 * lifecycle status because cap-reached is a normal turn ending — the session
 * stays `idle` and can accept more messages. Phase 5: introduced when
 * `message_turn_cap_reached` stopped being signaled via a `[Note: ...]`
 * suffix on the response text.
 */
export type SwarmMessageStatus = 'ok' | 'message_turn_cap_reached';

/**
 * Discriminated result of a swarm tool invocation. The shape varies by
 * which action was issued; consumers should narrow on `ok` first, then
 * (if `ok`) on the presence of the action-specific field.
 */
export type SwarmResult =
  | { ok: true; action: 'spawn'; agent_id: string }
  | {
      ok: true;
      action: 'message';
      response: string;
      // Phase 5: split the single `status` field into two — `status` now
      // describes the message OUTCOME (ok vs. turn-cap-reached) while
      // `session_status` continues to describe the session's lifecycle
      // (idle/running/released/error). Cap-reached is NOT an error: the
      // session lives on at `idle` so the orchestrator can decide whether
      // to send a `"continue"` follow-up.
      status: SwarmMessageStatus;
      session_status: SwarmSessionStatus;
    }
  | { ok: true; action: 'release'; released: boolean }
  | { ok: true; action: 'list'; agents: SwarmSessionSummary[] }
  | { ok: false; error: string; code?: string };

/**
 * Error codes surfaced via `SwarmResult`. Stable string identifiers so the
 * orchestrator LLM can branch on them; the human-readable `error` field
 * may evolve.
 */
export enum SwarmErrorCode {
  AGENT_NOT_FOUND = 'AGENT_NOT_FOUND',
  AGENT_BUSY = 'AGENT_BUSY',
  AGENT_RELEASED = 'AGENT_RELEASED',
  INVALID_ARGS = 'INVALID_ARGS',
  UNIMPLEMENTED = 'UNIMPLEMENTED',
  INTERNAL = 'INTERNAL',
}

/**
 * Stable name of the `swarm_status` companion tool. Hoisted here (rather
 * than only living in `swarm-status-tool.ts`) so `SwarmManager` can use it
 * for the auto-include logic without importing the tool module — that
 * would create a cycle, since the tool itself imports the manager
 * singleton. Phase 5 (post-review): single source of truth for the name.
 */
export const SWARM_STATUS_TOOL_NAME = 'swarm_status';

/**
 * Default whitelist of Gemini tool names sub-agents may call when the
 * `tools` field is omitted on `spawn`. Matches the anthropic v1 default.
 *
 * Phase 5: `swarm_status` is included so spawned agents can always
 * self-discover peers and read the shared event ring without the
 * orchestrator having to remember to add it.
 */
export const DEFAULT_SWARM_TOOLS: readonly string[] = [
  'read_file',
  'grep_search',
  'glob',
  'list_directory',
  'read_many_files',
  SWARM_STATUS_TOOL_NAME,
] as const;

/** Default cap on Anthropic message-loop turns per `message`. */
export const DEFAULT_SWARM_MAX_TURNS = 5;

/** Default idle TTL in ms (30 minutes) — session is released after this many ms of inactivity. */
export const DEFAULT_SWARM_IDLE_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Phase 5 — swarm_status snapshot types
// ---------------------------------------------------------------------------

/**
 * Per-agent entry rendered by `swarm_status`. Mirrors `SwarmSessionSummary`
 * but flattens to the snake_case keys the LLM expects and adds derived
 * fields (`seconds_since_active`) so the sub-agent doesn't have to do clock
 * math itself.
 */
export interface SwarmStatusAgentEntry {
  agent_id: string;
  role?: string;
  charter?: string;
  status: SwarmSessionStatus;
  model: AnthropicModelAlias;
  turn_count: number;
  last_active_at: number;
  seconds_since_active: number;
}

/**
 * Single recent-activity event in the manager's in-memory ring buffer.
 * The same `action` discriminator as `SwarmActivityEvent` but with the
 * snake_case shape the LLM-facing snapshot uses.
 */
export interface SwarmStatusEventEntry {
  ts: number;
  action: 'spawn' | 'message' | 'release';
  agent_id: string;
  turn_count?: number;
  duration_ms?: number;
  error?: string;
}

/**
 * The full payload returned by `SwarmManager.getSwarmStatusSnapshot()`.
 * Rendered as JSON by the `swarm_status` tool so the calling sub-agent can
 * branch on team composition without needing the orchestrator to forward it.
 */
export interface SwarmStatusSnapshot {
  /** Caller's own agent id, if it could be resolved from the bus name. */
  self_agent_id?: string;
  /** All live sessions (insertion-ordered). */
  agents: SwarmStatusAgentEntry[];
  /** Path to the shared scratch directory. */
  workspace_dir: string;
  /** Up to {@link SWARM_STATUS_EVENT_RING_SIZE} most-recent events, newest first. */
  recent_events: SwarmStatusEventEntry[];
}

/**
 * Maximum number of events retained in the manager's in-memory ring buffer.
 * Bounded so a long-running CLI session can't accumulate unbounded memory
 * via swarm activity.
 */
export const SWARM_STATUS_EVENT_RING_SIZE = 50;
