/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview `SwarmSession` — the per-instance state of one long-lived
 * Anthropic sub-agent within the swarm.
 *
 * ## Contract (locked by `design-loop/swarm-design.md` final synthesis)
 *
 * A session owns:
 *
 * - `messages: Anthropic.MessageParam[]` — the full conversation history,
 *   retained across orchestrator turns. One `runTurn()` call appends one
 *   user-then-assistant exchange (plus any intermediate tool_use /
 *   tool_result blocks).
 * - An **isolated `ToolRegistry`** — built once at construction from the
 *   spawn-time tool whitelist, cloned against the session's long-lived
 *   message bus. Avoids leaking tool-call-scoped state across sessions.
 * - A **long-lived `MessageBus`** — derived from the *global app bus*
 *   (`Config.getGlobalAppBus()`), NOT from the per-tool-call bus that
 *   spawned the session. This is the critical seam: orchestrator turn
 *   completion must not tear down session state.
 * - An **`AbortController`** chained to the global application lifecycle
 *   signal (SIGINT / process exit / explicit cancellation). The
 *   orchestrator's per-turn signal is *intentionally not* propagated here —
 *   releasing a turn must not kill the swarm; killing the swarm must not
 *   break the turn. Ownership: the **manager constructs** the controller and
 *   wires the app-signal subscription; the **session owns it thereafter**
 *   (calls `abort()` from `release()`).
 * - `lastActiveAt: number` — wall-clock ms, refreshed on each successful
 *   `runTurn()`. Used by the manager's idle-TTL sweep.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { MessageBus } from '../../confirmation-bus/message-bus.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import type { Config } from '../../config/config.js';
import type { AnthropicModelAlias } from '../types.js';
import { resolveAnthropicModel } from '../anthropic-invocation.js';
import {
  runAnthropicMessageLoop,
  ANTHROPIC_LOOP_SOFT_REJECT_SUFFIX,
} from '../anthropic-loop.js';
import {
  type SwarmKind,
  type SwarmSessionSummary,
  SwarmSessionStatus,
} from './types.js';

const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

/**
 * Constructor parameters for a `SwarmSession`. Built and validated by
 * `SwarmManager.spawn`; the session itself does not re-validate.
 */
export interface SwarmSessionParams {
  /** Short slug identifier allocated by the manager. */
  agentId: string;
  /** Sub-agent kind. v1: always `'anthropic'`. */
  kind: SwarmKind;
  /** Resolved model alias. */
  model: AnthropicModelAlias;
  /** Initial system prompt (post-template, post-augmentation). */
  systemPrompt: string;
  /** Optional display name surfaced in UI. */
  displayName?: string;
  /** Resolved tool whitelist (defaults already applied). */
  allowedTools: readonly string[];
  /** Hard cap on Anthropic message-loop turns per `runTurn()`. */
  maxTurns: number;
  /**
   * Global app config. The session pulls the global-lifetime message bus
   * via `config.getGlobalAppBus()` and reads telemetry/feature toggles
   * from here. Holding a reference is fine: `Config` is process-singleton.
   */
  config: Config;
  /**
   * Long-lived message bus for this session. Derived from the global app
   * bus, not from a tool-call bus. Owned/freed by the session.
   */
  messageBus: MessageBus;
  /**
   * Isolated tool registry pre-populated with the allowed tools cloned
   * against `messageBus`. Owned by the session.
   */
  toolRegistry: ToolRegistry;
  /**
   * Abort controller chained to the global app lifecycle signal. Aborting
   * this controller terminates any in-flight Anthropic call and prevents
   * future `runTurn()` invocations from starting.
   */
  abortController: AbortController;
  /**
   * Pre-built Anthropic-shaped tool declarations. The manager builds these
   * once at spawn time so each turn doesn't re-walk the registry.
   */
  anthropicTools: Anthropic.Tool[];
  /**
   * Pre-built set of advertised tool names (matches `anthropicTools`). The
   * shared loop uses this to synthesize unauthorized-tool rejections
   * without a scheduler trip.
   */
  allowSet: ReadonlySet<string>;
  /**
   * Disposer returned from registering the app-abort listener that chains
   * the global signal into this session's controller. Phase 3 fix (Opus
   * review #2): the session calls this disposer in `release()` so listeners
   * don't accumulate across spawn/release cycles in a long-running process.
   * `undefined` means the app signal was already aborted at spawn time
   * (the constructor short-circuits and there is nothing to detach).
   */
  detachAppAbort?: () => void;
}

/**
 * One long-lived Anthropic sub-agent instance.
 */
export class SwarmSession {
  readonly agentId: string;
  readonly kind: SwarmKind;
  readonly model: AnthropicModelAlias;
  readonly displayName?: string;
  readonly systemPrompt: string;
  readonly allowedTools: readonly string[];
  readonly maxTurns: number;
  readonly config: Config;
  readonly messageBus: MessageBus;
  readonly toolRegistry: ToolRegistry;
  readonly abortController: AbortController;

  /** Conversation history, mutated in place by `runTurn()`. */
  readonly messages: Anthropic.MessageParam[] = [];

  /** ms since epoch; refreshed on each successful turn. */
  lastActiveAt: number;
  readonly createdAt: number;

  /** Lifecycle status. */
  status: SwarmSessionStatus = SwarmSessionStatus.IDLE;

  /** Number of completed turns. */
  turnCount = 0;

  /** Composed system prompt (user prompt + tool advertisement + soft-reject suffix). */
  private readonly composedSystemPrompt: string;

  private readonly anthropicTools: Anthropic.Tool[];
  private readonly allowSet: ReadonlySet<string>;

  /**
   * Disposer for the app-abort listener registered by `SwarmManager.spawn`.
   * Cleared once `release()` (or `detachAppAbortListener`) is invoked so
   * the listener is removed exactly once and can't fire on an
   * already-released session.
   */
  private detachAppAbort: (() => void) | undefined;

  constructor(params: SwarmSessionParams) {
    this.agentId = params.agentId;
    this.kind = params.kind;
    this.model = params.model;
    this.displayName = params.displayName;
    this.systemPrompt = params.systemPrompt;
    this.allowedTools = params.allowedTools;
    this.maxTurns = params.maxTurns;
    this.config = params.config;
    this.messageBus = params.messageBus;
    this.toolRegistry = params.toolRegistry;
    this.abortController = params.abortController;
    this.anthropicTools = params.anthropicTools;
    this.allowSet = params.allowSet;
    this.detachAppAbort = params.detachAppAbort;
    this.createdAt = Date.now();
    this.lastActiveAt = this.createdAt;

    // Pre-compose the system prompt to mirror anthropic-invocation.ts:
    // base prompt + tool advertisement + soft-reject suffix. Stable across
    // turns because the tool set is fixed at spawn.
    let system = this.systemPrompt;
    const advertised = Array.from(this.allowSet);
    if (advertised.length > 0) {
      system +=
        `\n\nYou have access to the following tools: ` +
        `${advertised.join(', ')}. Use them as needed.`;
    }
    system += ANTHROPIC_LOOP_SOFT_REJECT_SUFFIX;
    this.composedSystemPrompt = system;
  }

  /**
   * Run one turn against this session: append the user prompt to
   * `messages`, drive the Anthropic message loop (with tool use) up to
   * `maxTurns` round trips, and return the final assistant text.
   *
   * Mutates `messages`, `lastActiveAt`, `turnCount`.
   *
   * Status transitions are managed by `SwarmManager.message`, not here —
   * the session does not know about `running` vs `idle` from the manager's
   * perspective, only that it can be invoked.
   *
   * Throws if the session has been released (aborted controller) or if the
   * Anthropic call errors. The manager's `message()` wraps this with the
   * status transitions and the `SwarmResult` shape.
   */
  async runTurn(userPrompt: string): Promise<string> {
    if (this.status === SwarmSessionStatus.RELEASED) {
      throw new Error(
        `SwarmSession '${this.agentId}' has been released and cannot accept new messages.`,
      );
    }
    if (this.abortController.signal.aborted) {
      throw new Error(
        `SwarmSession '${this.agentId}' is aborted and cannot accept new messages.`,
      );
    }

    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new Error(
        `SwarmSession '${this.agentId}' requires ANTHROPIC_API_KEY in the environment.`,
      );
    }

    this.messages.push({ role: 'user', content: userPrompt });

    // The shared loop mutates `this.messages` in place: that's the
    // statefulness guarantee. We pass our long-lived signal (NOT an
    // orchestrator turn signal) so cancellation correctly follows the app
    // lifecycle.
    const text = await runAnthropicMessageLoop({
      apiKey,
      model: resolveAnthropicModel(this.model),
      system: this.composedSystemPrompt,
      maxTokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
      anthropicTools: this.anthropicTools,
      messages: this.messages,
      toolRegistry: this.toolRegistry,
      // The shared loop expects a mutable Set; widen the readonly view.
      allowSet: new Set(this.allowSet),
      config: this.config,
      maxTurns: this.maxTurns,
      signal: this.abortController.signal,
      // Bookkeeping id: unique per turn so scheduler logs stay distinct
      // across turns on the same session.
      schedulerPromptId: `swarm-${this.agentId}-turn-${this.turnCount}`,
      subagentName: this.displayName ?? this.agentId,
      // No parent call id — the swarm session is not nested inside a tool
      // call's approval thread.
    });

    this.turnCount += 1;
    this.lastActiveAt = Date.now();
    return text;
  }

  /**
   * Aborts the session's controller and marks status `released`. Idempotent:
   * a second call is a no-op. Called by `SwarmManager.release` and by the
   * global lifecycle hook.
   *
   * Phase 3 fix (Opus review #2): also detaches the app-abort listener so
   * the global `AbortSignal` doesn't accumulate listeners across many
   * spawn/release cycles in long-running processes.
   */
  release(): void {
    if (this.status === SwarmSessionStatus.RELEASED) return;
    this.status = SwarmSessionStatus.RELEASED;
    if (!this.abortController.signal.aborted) {
      this.abortController.abort('swarm-session-released');
    }
    this.detachAppAbortListener();
  }

  /**
   * Removes the per-session app-abort listener registered by the manager
   * and nulls out the disposer so it can't be invoked twice. Safe to call
   * multiple times — second and subsequent calls are no-ops.
   *
   * Separate from `release()` because the TTL-stuck sweep transitions the
   * session into ERROR (which intentionally is NOT a release per Gemini's
   * phase2 review #1) but still wants to drop the listener.
   */
  detachAppAbortListener(): void {
    if (this.detachAppAbort) {
      try {
        this.detachAppAbort();
      } catch {
        // Disposer is just a removeEventListener call; if it throws, the
        // listener is already gone and we don't care.
      }
      this.detachAppAbort = undefined;
    }
  }

  /**
   * Snapshot for the `list` action. Excludes the `messages` array and any
   * non-serializable handles.
   */
  toSummary(): SwarmSessionSummary {
    return {
      agentId: this.agentId,
      kind: this.kind,
      model: this.model,
      displayName: this.displayName,
      status: this.status,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      turnCount: this.turnCount,
    };
  }
}
