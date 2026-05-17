/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview `SwarmManager` — singleton holding the `agent_id -> SwarmSession`
 * map for the lifetime of the parent Gemini CLI process.
 *
 * ## Contract (locked by `design-loop/swarm-design.md` final synthesis)
 *
 * - **Singleton.** Instantiated once per `Config` (process-scoped). Access
 *   via `SwarmManager.getInstance(config)`. Calling `getInstance` with a
 *   *different* `Config` throws (Phase 1 review Opus #3).
 * - **In-memory map only.** v1.0 has no disk persistence. Sessions die
 *   with the process; cross-CLI persistence is v1.1+.
 * - **Global lifecycle binding.** On construction, the manager subscribes
 *   to `Config.getAppAbortSignal()`. When the signal fires, the manager
 *   iterates active sessions and aborts each.
 * - **Idle TTL sweep.** Background timer that releases sessions whose
 *   `lastActiveAt` is older than the TTL. `running` sessions exceeding
 *   `2 * TTL` are forcibly transitioned to `error` and released — guards
 *   against a stuck Anthropic call holding a session forever (Phase 1
 *   review Gemini point about TTL consistency).
 * - **No parallel messages on same session.** `message(args)` returns
 *   `AGENT_BUSY` if the target session is already `running`.
 */

import * as fs from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../../config/config.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { Kind } from '../../tools/tools.js';
import { convertToAnthropicTools } from '../anthropic-tools.js';
import { debugLogger } from '../../utils/debugLogger.js';
import { SwarmSession } from './swarm-session.js';
import {
  type SwarmAction,
  type SwarmResult,
  type SwarmSessionSummary,
  type SwarmStatusAgentEntry,
  type SwarmStatusEventEntry,
  type SwarmStatusSnapshot,
  SwarmSessionStatus,
  SwarmErrorCode,
  SwarmActionSchema,
  DEFAULT_SWARM_MAX_TURNS,
  DEFAULT_SWARM_IDLE_TTL_MS,
  SWARM_STATUS_EVENT_RING_SIZE,
  SWARM_STATUS_TOOL_NAME,
} from './types.js';
import type { AnthropicModelAlias } from '../types.js';
import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from '../../tools/definitions/base-declarations.js';

/**
 * Telemetry event emitted on the global app bus for spawn/message/release.
 * Mirrors the shape of `SubagentActivityEvent` but lives under its own
 * event name so consumers can subscribe specifically.
 */
export interface SwarmActivityEvent {
  isSwarmActivityEvent: true;
  action: 'spawn' | 'message' | 'release';
  agentId: string;
  model?: AnthropicModelAlias;
  turnCount?: number;
  durationMs?: number;
  error?: string;
}

export const SWARM_ACTIVITY_EVENT_NAME = 'swarm-activity';

/**
 * Sweep interval = TTL / 6 (5 minutes by default). Short enough that
 * idle-aged sessions get noticed within a reasonable window of their TTL;
 * long enough that the timer isn't a meaningful CPU cost.
 */
const SWEEP_INTERVAL_DIVISOR = 6;

/**
 * Tools sub-agents never receive, regardless of whether the parent
 * registry advertises them. Mode-control state (Plan Mode) is host-CLI
 * state — letting a sub-agent toggle it would either confuse the
 * orchestrator's mode (sub-agent flips it during a turn) or have no
 * effect at all (the sub-agent's "mode" doesn't propagate back), so we
 * just filter them out at spawn. Phase 5 addition.
 *
 * Names come directly from the source-of-truth tool-name constants so a
 * rename of `enter_plan_mode` / `exit_plan_mode` propagates here without
 * a separate edit (post-review drift guard).
 */
const SWARM_BLOCKED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
]);

/**
 * Singleton manager of all live `SwarmSession` instances.
 */
export class SwarmManager {
  private static instance: SwarmManager | undefined;

  /**
   * agent_id -> SwarmSession. Insertion order is preserved by `Map`, which
   * makes `list()` output stable and human-readable.
   */
  private readonly sessions = new Map<string, SwarmSession>();

  /**
   * Monotonic counter per model alias, used to mint slug-style agent ids
   * (`sonnet-1`, `opus-2`, ...).
   */
  private readonly idCounters = new Map<string, number>();

  /** Reference to the owning Config (for global bus + telemetry + abort signal). */
  private readonly config: Config;

  /** Idle TTL in ms; configurable for tests. */
  private readonly idleTtlMs: number;

  /** Background sweep timer handle. */
  private sweepTimer: NodeJS.Timeout | undefined;

  /** Disposer for the app-abort-signal subscription. */
  private appAbortDisposer: (() => void) | undefined;

  /**
   * Cached shared-workspace directory. Created lazily by
   * {@link ensureWorkspaceDir} on first `spawn`. Tracked so we don't pay
   * the `fs.existsSync + mkdirSync` cost on every spawn — the directory
   * lives for the entire CLI session.
   */
  private workspaceDirPath: string | undefined;

  /**
   * In-memory ring buffer of recent spawn/message/release events for the
   * `swarm_status` snapshot. Oldest-to-newest insertion order; trimmed to
   * {@link SWARM_STATUS_EVENT_RING_SIZE} on every push. v1.0 deliberately
   * has no on-disk persistence (rejected — see brief's "Out of scope").
   */
  private readonly recentEvents: SwarmStatusEventEntry[] = [];

  constructor(
    config: Config,
    options: { idleTtlMs?: number; startSweep?: boolean } = {},
  ) {
    this.config = config;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_SWARM_IDLE_TTL_MS;

    // Subscribe to the global app lifecycle signal. When it fires (SIGINT /
    // beforeExit), abort every active session so Ctrl+C doesn't leave
    // background Anthropic loops spinning.
    const appSignal = this.config.getAppAbortSignal();
    const onAppAbort = () => this.handleAppAbort();
    if (appSignal.aborted) {
      // Edge case: signal already fired before the manager was constructed.
      queueMicrotask(onAppAbort);
    } else {
      appSignal.addEventListener('abort', onAppAbort, { once: true });
      this.appAbortDisposer = () =>
        appSignal.removeEventListener('abort', onAppAbort);
    }

    // Start the idle-TTL sweep by default; tests can opt out via
    // `{ startSweep: false }` to avoid leaking timers.
    if (options.startSweep !== false) {
      this.startSweep();
    }
  }

  /**
   * Singleton accessor. The first call binds the manager to the given
   * `Config`. Subsequent calls with the *same* `Config` return the cached
   * instance; calls with a *different* `Config` throw, because the manager
   * holds a long-lived reference to the global bus / abort signal and
   * silently swapping configs would orphan in-flight sessions.
   *
   * Test code that needs to swap configs must call `resetForTests()` first.
   */
  static getInstance(config: Config): SwarmManager {
    if (!SwarmManager.instance) {
      SwarmManager.instance = new SwarmManager(config);
    } else if (SwarmManager.instance.config !== config) {
      throw new Error(
        'SwarmManager.getInstance: called with a different Config than the ' +
          'singleton was bound to. The manager is process-scoped — call ' +
          'SwarmManager.resetForTests() before reassigning.',
      );
    }
    return SwarmManager.instance;
  }

  /**
   * Test-only: clear the singleton and release any retained timers / signal
   * subscriptions on the existing instance. Not exported via `index.ts`.
   */
  static resetForTests(): void {
    if (SwarmManager.instance) {
      SwarmManager.instance.shutdownForTests();
    }
    SwarmManager.instance = undefined;
  }

  /**
   * Test-only: tear down the existing instance's timers + subscriptions
   * without clearing the static slot. Used by `resetForTests`.
   */
  shutdownForTests(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    if (this.appAbortDisposer) {
      this.appAbortDisposer();
      this.appAbortDisposer = undefined;
    }
    // Best-effort release of any remaining sessions so their abort
    // controllers fire and they don't leak into the next test.
    for (const session of this.sessions.values()) session.release();
    this.sessions.clear();
    this.idCounters.clear();
  }

  /**
   * `spawn` action: validate, allocate `agent_id`, build the isolated tool
   * registry + long-lived message bus + chained abort controller, construct
   * a `SwarmSession`, register it in the map, return the id.
   */
  async spawn(
    args: Extract<SwarmAction, { action: 'spawn' }>,
  ): Promise<SwarmResult> {
    // Re-parse via Zod for the tightest possible per-variant narrowing.
    const parsed = SwarmActionSchema.safeParse(args);
    if (!parsed.success || parsed.data.action !== 'spawn') {
      return {
        ok: false,
        error: `Invalid spawn args: ${parsed.success ? 'wrong discriminator' : parsed.error.message}`,
        code: SwarmErrorCode.INVALID_ARGS,
      };
    }
    const validated = parsed.data;

    const model: AnthropicModelAlias = validated.model ?? 'sonnet';
    const kind = validated.kind ?? 'anthropic';
    const maxTurns = validated.max_turns ?? DEFAULT_SWARM_MAX_TURNS;

    // Pull the parent registry once. By the time `spawn` runs, the global
    // registry has already been built and registered on the Config.
    const parentRegistry = this.config.getToolRegistry();

    // Default: inherit all of the orchestrator's currently-registered tools.
    // Mirrors Claude Code's Task tool semantics (sub-agents see the same
    // toolset as the orchestrator). The per-tool clone below already excludes
    // Agent-kind tools for recursion safety. Concurrent-write "stomping"
    // (Turn 1 concern) is not a real risk in v1.0 because `message` is
    // strictly synchronous — only one agent runs at a time. v1.1 (async)
    // must revisit this default before allowing concurrent execution.
    // Users can still narrow the set per-spawn via `tools: [...]`;
    // `DEFAULT_SWARM_TOOLS` remains exported as a read-only preset.
    //
    // Phase 5: on the inherit-all path (no explicit `tools` field), make
    // sure `swarm_status` is in the requested list so peer self-discovery
    // works out of the box. When the user explicitly passes a `tools`
    // array, respect their choice — they may have deliberately omitted it.
    const inheritAll = validated.tools === undefined;
    const baseRequested =
      validated.tools ?? parentRegistry.getAllTools().map((t) => t.name);
    const requestedTools = inheritAll
      ? baseRequested.includes(SWARM_STATUS_TOOL_NAME)
        ? baseRequested
        : [...baseRequested, SWARM_STATUS_TOOL_NAME]
      : baseRequested;

    // Phase 4: ensure the shared swarm workspace exists before the first
    // session spawns so agents can `write_file`/`read_file` into it
    // without races. Idempotent — `ensureWorkspaceDir` caches its work.
    this.ensureWorkspaceDir();

    // Mint the id.
    const agentId = this.mintAgentId(model);

    // Build the long-lived session bus derived from the global app bus.
    // The bus name uses the agent id so TUI consumers can attribute events.
    const sessionBusName = validated.display_name ?? agentId;
    const globalBus = this.config.getGlobalAppBus();
    const sessionBus = globalBus.derive(sessionBusName);

    // Build the isolated tool registry. Mirrors `local-executor.ts:164-205`.
    // Phase 5: also drops any tool in `SWARM_BLOCKED_TOOL_NAMES` (plan-mode
    // controls) regardless of how it arrived in `requestedTools`.
    const sessionToolRegistry = new ToolRegistry(this.config, sessionBus);
    const allowSet = new Set<string>();
    for (const name of requestedTools) {
      const tool = parentRegistry.getTool(name);
      if (!tool || tool.kind === Kind.Agent) continue;
      if (SWARM_BLOCKED_TOOL_NAMES.has(tool.name)) continue;
      sessionToolRegistry.registerTool(tool.clone(sessionBus));
      allowSet.add(name);
    }
    sessionToolRegistry.sortTools();

    // Build the Anthropic-shaped tool decls once.
    const decls = sessionToolRegistry.getFunctionDeclarationsFiltered(
      Array.from(allowSet),
      undefined,
    );
    const anthropicTools: Anthropic.Tool[] = convertToAnthropicTools(decls);

    // Chain the per-session abort controller to the global app signal. We
    // already subscribed to `appSignal` in the constructor for the manager
    // itself; the session's own controller exists separately so it can be
    // aborted by `release()` without firing the manager-level handler.
    //
    // Phase 3 fix (Opus review #2): track the listener so we can remove it
    // in `release()` and avoid an unbounded listener accumulation on the
    // global signal across many spawn/release cycles.
    const sessionAbort = new AbortController();
    const appSignal = this.config.getAppAbortSignal();
    let detachAppAbort: (() => void) | undefined;
    if (appSignal.aborted) {
      sessionAbort.abort('app-signal-already-aborted');
    } else {
      const onAbort = () => sessionAbort.abort('app-signal');
      appSignal.addEventListener('abort', onAbort, { once: true });
      detachAppAbort = () => appSignal.removeEventListener('abort', onAbort);
    }

    const session = new SwarmSession({
      agentId,
      kind,
      model,
      systemPrompt: validated.system_prompt,
      displayName: validated.display_name,
      // Phase 5: pull-through role/charter so they're visible on
      // `swarm_status`, baked into the session's system prompt, and
      // surfaced by `list()`.
      role: validated.role,
      charter: validated.charter,
      allowedTools: Array.from(allowSet),
      maxTurns,
      config: this.config,
      messageBus: sessionBus,
      toolRegistry: sessionToolRegistry,
      abortController: sessionAbort,
      // The shared workspace dir is fixed at spawn — `getWorkspaceDir()`
      // is idempotent (cached) and the directory's identity doesn't
      // change across the CLI session.
      workspaceDir: this.getWorkspaceDir(),
      anthropicTools,
      allowSet,
      detachAppAbort,
    });

    this.sessions.set(agentId, session);
    this.publishActivity({ action: 'spawn', agentId, model });

    return { ok: true, action: 'spawn', agent_id: agentId };
  }

  /**
   * `message` action: look up the session, refuse if released or running,
   * delegate to `session.runTurn(prompt)`, return the assistant text.
   */
  async message(
    args: Extract<SwarmAction, { action: 'message' }>,
  ): Promise<SwarmResult> {
    const session = this.sessions.get(args.agent_id);
    if (!session) {
      return {
        ok: false,
        error: `No swarm agent with id '${args.agent_id}'.`,
        code: SwarmErrorCode.AGENT_NOT_FOUND,
      };
    }
    if (session.status === SwarmSessionStatus.RELEASED) {
      return {
        ok: false,
        error: `Swarm agent '${args.agent_id}' has been released.`,
        code: SwarmErrorCode.AGENT_RELEASED,
      };
    }
    if (session.status === SwarmSessionStatus.RUNNING) {
      return {
        ok: false,
        error: `Swarm agent '${args.agent_id}' is already processing a message.`,
        code: SwarmErrorCode.AGENT_BUSY,
      };
    }

    const startedAt = Date.now();
    session.status = SwarmSessionStatus.RUNNING;
    // Phase 3 fix (Opus review #4): stamp `lastActiveAt` on RUNNING entry
    // so a legitimately long-running turn (e.g. 35 min) isn't misjudged
    // "stuck" by the 2 * TTL sweep. The shared loop also bumps it on
    // successful exit; the manager stamps on both error and idle exits
    // below so the timestamp always reflects "agent did something
    // recently" rather than only "last successful turn finished".
    session.lastActiveAt = startedAt;
    try {
      // Phase 5: runTurn now returns `{ text, capReached }`. Cap-reached
      // is a normal end-of-turn (session stays alive at `idle`), surfaced
      // to the orchestrator via the message-outcome `status` field.
      // Telemetry stays unchanged — `error` is reserved for genuine errors.
      const { text, capReached } = await session.runTurn(args.prompt);
      session.status = SwarmSessionStatus.IDLE;
      session.lastActiveAt = Date.now();
      this.publishActivity({
        action: 'message',
        agentId: session.agentId,
        model: session.model,
        turnCount: session.turnCount,
        durationMs: Date.now() - startedAt,
      });
      return {
        ok: true,
        action: 'message',
        response: text,
        status: capReached ? 'message_turn_cap_reached' : 'ok',
        session_status: session.status,
      };
    } catch (err) {
      session.status = SwarmSessionStatus.ERROR;
      session.lastActiveAt = Date.now();
      const msg = err instanceof Error ? err.message : String(err);
      this.publishActivity({
        action: 'message',
        agentId: session.agentId,
        model: session.model,
        turnCount: session.turnCount,
        durationMs: Date.now() - startedAt,
        error: msg,
      });
      return {
        ok: false,
        error: msg,
        code: SwarmErrorCode.INTERNAL,
      };
    }
  }

  /**
   * `release` action: abort the session's controller, remove from map,
   * mark status `released`. Idempotent: releasing a missing or
   * already-released id returns `{ released: false }` rather than throwing.
   */
  async release(
    args: Extract<SwarmAction, { action: 'release' }>,
  ): Promise<SwarmResult> {
    const session = this.sessions.get(args.agent_id);
    if (!session) {
      return { ok: true, action: 'release', released: false };
    }
    session.release();
    this.sessions.delete(args.agent_id);
    this.publishActivity({
      action: 'release',
      agentId: session.agentId,
      model: session.model,
      turnCount: session.turnCount,
    });
    return { ok: true, action: 'release', released: true };
  }

  /**
   * `list` action: snapshot of all live session summaries. Excludes the
   * `messages` array per `SwarmSessionSummary` contract.
   */
  list(): SwarmResult {
    const agents: SwarmSessionSummary[] = [];
    for (const session of this.sessions.values()) {
      agents.push(session.toSummary());
    }
    return { ok: true, action: 'list', agents };
  }

  /**
   * Sweep idle sessions. Public for test access.
   *
   * Rules (per the design synthesis + Gemini's TTL-consistency point):
   * - `idle` session with `lastActiveAt` older than `idleTtlMs` → release
   *   (status=RELEASED, removed from map).
   * - `running` session with `lastActiveAt` older than `2 * idleTtlMs` →
   *   abort + mark `error`, **leave in the map** so `list()` can surface
   *   the wedged agent for the user to inspect. Phase 3 fix from Gemini's
   *   review: the previous version incorrectly deleted these.
   * - `released` sessions should not exist in the map (they're removed on
   *   release), but defensively clear any stragglers.
   * - `error` sessions stay until the user explicitly releases or replaces
   *   them; future v1.1 work may add a "purge errored sessions older than
   *   N hours" sweep.
   */
  sweepIdleSessions(now: number = Date.now()): void {
    const idleThreshold = now - this.idleTtlMs;
    const stuckThreshold = now - 2 * this.idleTtlMs;
    const toDelete: string[] = [];

    for (const [agentId, session] of this.sessions) {
      if (session.status === SwarmSessionStatus.RELEASED) {
        toDelete.push(agentId);
        continue;
      }
      if (
        session.status === SwarmSessionStatus.IDLE &&
        session.lastActiveAt < idleThreshold
      ) {
        session.release();
        toDelete.push(agentId);
        this.publishActivity({
          action: 'release',
          agentId,
          model: session.model,
          turnCount: session.turnCount,
        });
        continue;
      }
      if (
        session.status === SwarmSessionStatus.RUNNING &&
        session.lastActiveAt < stuckThreshold
      ) {
        // A `running` session whose `lastActiveAt` hasn't moved past
        // `2 * TTL` is wedged — most likely a hung Anthropic call. Abort
        // the controller and stamp ERROR status. Skip `session.release()`
        // because it would clobber the ERROR status with RELEASED.
        //
        // Phase 3 fix (Gemini phase2 #1): keep ERROR sessions in the map
        // so `list()` can surface them for debugging. The user must
        // explicitly `release` them. We still detach the session's
        // app-abort listener (via session.detachAppAbortListener()) so the
        // event-listener leak stays bounded. A future "purge errored
        // sessions older than N hours" sweep can clean them up; for v1
        // we tolerate small leakage in favor of debuggability.
        if (!session.abortController.signal.aborted) {
          session.abortController.abort('ttl-stuck');
        }
        session.status = SwarmSessionStatus.ERROR;
        session.detachAppAbortListener();
        this.publishActivity({
          action: 'release',
          agentId,
          model: session.model,
          turnCount: session.turnCount,
          error: 'session-stuck-released-by-ttl-sweep',
        });
      }
    }

    for (const agentId of toDelete) this.sessions.delete(agentId);
  }

  /**
   * Test-only accessor for the in-memory sessions map. Returning the live
   * map (not a copy) so tests can assert ordering / size without paying for
   * an extra clone.
   */
  getSessionsForTests(): ReadonlyMap<string, SwarmSession> {
    return this.sessions;
  }

  /**
   * Builds the payload returned by the `swarm_status` tool. Aggregates the
   * live sessions, the shared workspace path, and the in-memory event ring
   * into a single snake_case JSON shape the LLM can act on directly.
   *
   * `callerAgentId` echoes back the calling sub-agent's id (resolved from
   * the message-bus name in the tool invocation) so it can tell at a
   * glance which entry in `agents[]` is itself. Pass `undefined` for
   * orchestrator-side calls.
   *
   * `recent_events` is reversed so newest events come first — the most
   * likely consumer (a sub-agent skimming the top of the snapshot) cares
   * about "what just happened" more than ancient history.
   */
  getSwarmStatusSnapshot(callerAgentId?: string): SwarmStatusSnapshot {
    const now = Date.now();
    const agents: SwarmStatusAgentEntry[] = [];
    for (const s of this.sessions.values()) {
      agents.push({
        agent_id: s.agentId,
        role: s.role,
        charter: s.charter,
        status: s.status,
        model: s.model,
        turn_count: s.turnCount,
        last_active_at: s.lastActiveAt,
        // Floor to whole seconds so the JSON stays readable for the LLM
        // and so test snapshots aren't sensitive to sub-second jitter.
        seconds_since_active: Math.floor((now - s.lastActiveAt) / 1000),
      });
    }
    return {
      self_agent_id: callerAgentId,
      agents,
      workspace_dir: this.getWorkspaceDir(),
      // Ring is stored oldest-to-newest; reverse for newest-first ergonomics.
      recent_events: [...this.recentEvents].reverse(),
    };
  }

  /**
   * Returns the shared-workspace directory path for this session,
   * creating it on first call. Multiple spawned agents share the same
   * directory — they read/write artifacts like `<dir>/sonnet-1.md` via
   * the standard file tools instead of paste-passing everything through
   * the orchestrator's context. Plan Mode's policy whitelist explicitly
   * allows writes inside this directory (see
   * `packages/core/src/policy/policies/plan.toml`).
   */
  getWorkspaceDir(): string {
    this.ensureWorkspaceDir();
    // `ensureWorkspaceDir` always populates the cache on success; the
    // non-null assertion is safe because the early-return on failure
    // falls through to the path computation below.
    return (
      this.workspaceDirPath ?? this.config.storage.getProjectTempSwarmDir()
    );
  }

  /**
   * Creates the swarm workspace dir if it doesn't yet exist. Mirrors
   * `enter-plan-mode.ts`'s strategy: log-and-continue on failure so a
   * race or sandbox quirk doesn't fail the whole spawn — `write_file`
   * will surface a more actionable error if the dir genuinely can't be
   * created.
   */
  private ensureWorkspaceDir(): void {
    if (this.workspaceDirPath) return;
    const dir = this.config.storage.getProjectTempSwarmDir();
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.workspaceDirPath = dir;
    } catch (e) {
      debugLogger.warn(
        `[SwarmManager] Failed to create swarm workspace dir at ${dir}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      // Best effort: still cache the path so the orchestrator can attempt
      // writes (which will then fail with a clearer error). Without
      // caching we'd retry the mkdir on every spawn.
      this.workspaceDirPath = dir;
    }
  }

  // ---- internals ---------------------------------------------------------

  private mintAgentId(model: AnthropicModelAlias): string {
    const next = (this.idCounters.get(model) ?? 0) + 1;
    this.idCounters.set(model, next);
    return `${model}-${next}`;
  }

  private startSweep(): void {
    const interval = Math.max(
      1000,
      Math.floor(this.idleTtlMs / SWEEP_INTERVAL_DIVISOR),
    );
    this.sweepTimer = setInterval(() => this.sweepIdleSessions(), interval);
    // Don't keep the event loop alive on the sweep timer alone.
    this.sweepTimer.unref?.();
  }

  private handleAppAbort(): void {
    // App lifecycle ended — abort every active session so background
    // Anthropic calls don't keep running.
    for (const session of this.sessions.values()) session.release();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    // Phase 3 (Opus review #4): null out the disposer so it can't be
    // invoked a second time — the listener was registered `once: true`
    // and has already been removed by the time we get here.
    this.appAbortDisposer = undefined;
  }

  private publishActivity(
    partial: Omit<SwarmActivityEvent, 'isSwarmActivityEvent'>,
  ): void {
    const event: SwarmActivityEvent = {
      isSwarmActivityEvent: true,
      ...partial,
    };
    // Phase 5: also mirror into the in-memory ring so `swarm_status` can
    // surface recent activity to sub-agents. We append first so that even
    // if `emit` throws (it shouldn't), the ring stays consistent.
    this.appendEventToRing(event);
    // EventEmitter-level publish. We deliberately don't pipe this through
    // the strongly-typed `MessageBus.publish` channel because that path is
    // for tool-confirmation traffic; swarm activity is a fire-and-forget
    // notification.
    try {
      this.config.getGlobalAppBus().emit(SWARM_ACTIVITY_EVENT_NAME, event);
    } catch {
      // Telemetry must never break the manager.
    }
  }

  /**
   * Pushes the snake_case projection of a {@link SwarmActivityEvent} onto
   * the {@link recentEvents} ring, trimming the oldest entry when the ring
   * exceeds {@link SWARM_STATUS_EVENT_RING_SIZE}.
   *
   * Stored oldest-to-newest internally; `getSwarmStatusSnapshot` reverses
   * to newest-first for the LLM-facing payload.
   */
  private appendEventToRing(event: SwarmActivityEvent): void {
    const entry: SwarmStatusEventEntry = {
      ts: Date.now(),
      action: event.action,
      agent_id: event.agentId,
      turn_count: event.turnCount,
      duration_ms: event.durationMs,
      error: event.error,
    };
    this.recentEvents.push(entry);
    while (this.recentEvents.length > SWARM_STATUS_EVENT_RING_SIZE) {
      this.recentEvents.shift();
    }
  }
}
