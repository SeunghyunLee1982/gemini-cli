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
import type { AnthropicModelAlias } from '../types.js';

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
    model: z.enum(['sonnet', 'opus']).optional(),
    system_prompt: z.string().min(1),
    tools: z.array(z.string()).optional(),
    max_turns: z.number().int().positive().optional(),
    display_name: z.string().optional(),
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
 * The `_modelAlias` re-export below is solely so the public type doc above
 * still references the alias type imported at the top of the file (avoids
 * a "declared but never used" complaint for callers reading the spec).
 */
export type SwarmAction = z.infer<typeof SwarmActionSchema>;

// Re-emit `AnthropicModelAlias` indirectly so that downstream tools (and
// the manager's `spawn(args)` extraction) keep a tight binding between the
// alias surface and the Zod literal. If a future PR widens the alias to
// include `haiku`, both the type alias and the Zod `model` enum must be
// updated in lockstep; this re-export makes the dependency visible to grep.
export type _SwarmModelAlias = AnthropicModelAlias;

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
      status: SwarmSessionStatus;
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
 * Default whitelist of Gemini tool names sub-agents may call when the
 * `tools` field is omitted on `spawn`. Matches the anthropic v1 default.
 *
 * Phase 1: declared but not yet consumed.
 */
export const DEFAULT_SWARM_TOOLS: readonly string[] = [
  'read_file',
  'grep_search',
  'glob',
  'list_directory',
  'read_many_files',
] as const;

/** Default cap on Anthropic message-loop turns per `message`. */
export const DEFAULT_SWARM_MAX_TURNS = 5;

/** Default idle TTL in ms (30 minutes) — session is released after this many ms of inactivity. */
export const DEFAULT_SWARM_IDLE_TTL_MS = 30 * 60 * 1000;
