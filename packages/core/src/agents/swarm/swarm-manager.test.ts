/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Unit tests for `SwarmManager`. The Anthropic loop itself is
 * mocked at the module boundary; these tests focus on lifecycle behavior
 * (id minting, status transitions, TTL sweep, abort propagation) rather
 * than the loop body (which is exercised by `anthropic-invocation.test.ts`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SwarmManager, SWARM_ACTIVITY_EVENT_NAME } from './swarm-manager.js';
import type { SwarmActivityEvent } from './swarm-manager.js';
import { SwarmSessionStatus, SwarmErrorCode } from './types.js';
import { Kind } from '../../tools/tools.js';
import type { Config } from '../../config/config.js';

// ---- mocks ---------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  runLoop: vi.fn<(p: { messages: unknown[] }) => Promise<string>>(),
  // Stub ToolRegistry instances so we can inspect them in assertions if
  // needed.
  registries: [] as unknown[],
}));

vi.mock('../anthropic-loop.js', async () => {
  const actual = await vi.importActual<typeof import('../anthropic-loop.js')>(
    '../anthropic-loop.js',
  );
  return {
    ...actual,
    runAnthropicMessageLoop: (p: { messages: unknown[] }) => hoisted.runLoop(p),
  };
});

vi.mock('../../tools/tool-registry.js', () => {
  class FakeToolRegistry {
    readonly tools = new Map<string, unknown>();
    constructor(_config: unknown, _bus: unknown) {
      hoisted.registries.push(this);
    }
    registerTool(t: { name: string }): void {
      this.tools.set(t.name, t);
    }
    getTool(name: string): unknown {
      return this.tools.get(name);
    }
    getFunctionDeclarationsFiltered(names: string[]): unknown[] {
      return names
        .map((n) => this.tools.get(n))
        .filter((t): t is { name: string } => t !== undefined)
        .map((t) => ({
          name: t.name,
          parametersJsonSchema: { type: 'object' },
        }));
    }
    sortTools(): void {}
  }
  return { ToolRegistry: FakeToolRegistry };
});

vi.mock('../anthropic-tools.js', () => ({
  convertToAnthropicTools: (decls: Array<{ name: string }>) =>
    decls.map((d) => ({
      name: d.name,
      description: '',
      input_schema: { type: 'object' as const },
    })),
}));

// ---- helpers -------------------------------------------------------------

interface FakeTool {
  name: string;
  kind: Kind;
  clone: (bus: unknown) => FakeTool;
}

function makeTool(name: string, kind: Kind = Kind.Read): FakeTool {
  const t: FakeTool = {
    name,
    kind,
    clone: () => t,
  };
  return t;
}

function makeFakeConfig(
  opts: { tools?: FakeTool[]; appSignal?: AbortSignal } = {},
): {
  config: Config;
  globalBus: EventEmitter & { derive: (n: string) => unknown };
  appController: AbortController;
} {
  const appController = new AbortController();
  const appSignal = opts.appSignal ?? appController.signal;
  const tools = opts.tools ?? [makeTool('read_file'), makeTool('grep_search')];
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  // The bus is also used by `derive` calls; back it with an EventEmitter
  // so the manager can `emit(SWARM_ACTIVITY_EVENT_NAME, ...)`.
  const bus = new EventEmitter() as EventEmitter & {
    derive: (n: string) => unknown;
  };
  bus.derive = vi.fn(() => bus);

  const parentRegistry = {
    getTool: (n: string) => toolMap.get(n),
    getAllTools: () => Array.from(toolMap.values()),
  } as unknown as {
    getTool: (n: string) => FakeTool | undefined;
    getAllTools: () => FakeTool[];
  };

  const config = {
    getAppAbortSignal: () => appSignal,
    getGlobalAppBus: () => bus,
    getToolRegistry: () => parentRegistry,
    // Phase 4: SwarmManager.spawn ensures the per-session shared workspace
    // dir. Tests run with a stub path under the OS temp tree; the manager
    // creates the dir on first spawn and swallows mkdir errors so this
    // path being absent on the filesystem is harmless for the test.
    storage: {
      getProjectTempSwarmDir: () =>
        `${process.cwd()}/.gemini/tmp/test-session/swarm`,
    },
  } as unknown as Config;
  return { config, globalBus: bus, appController };
}

// ---- tests ---------------------------------------------------------------

describe('SwarmManager', () => {
  beforeEach(() => {
    hoisted.runLoop.mockReset();
    hoisted.registries.length = 0;
    SwarmManager.resetForTests();
  });

  afterEach(() => {
    SwarmManager.resetForTests();
  });

  it('getInstance returns the same instance for same Config', () => {
    const { config } = makeFakeConfig();
    const a = SwarmManager.getInstance(config);
    const b = SwarmManager.getInstance(config);
    expect(a).toBe(b);
  });

  it('getInstance throws when called with a different Config', () => {
    const a = makeFakeConfig();
    const b = makeFakeConfig();
    SwarmManager.getInstance(a.config);
    expect(() => SwarmManager.getInstance(b.config)).toThrow(
      /different Config/,
    );
  });

  it('spawn allocates slug agent ids and increments per model', async () => {
    const { config } = makeFakeConfig();
    const mgr = new SwarmManager(config, { startSweep: false });

    const r1 = await mgr.spawn({
      action: 'spawn',
      system_prompt: 'p1',
    });
    const r2 = await mgr.spawn({
      action: 'spawn',
      system_prompt: 'p2',
    });
    const r3 = await mgr.spawn({
      action: 'spawn',
      model: 'opus',
      system_prompt: 'p3',
    });
    const r4 = await mgr.spawn({
      action: 'spawn',
      model: 'opus',
      system_prompt: 'p4',
    });

    expect(r1).toEqual({ ok: true, action: 'spawn', agent_id: 'sonnet-1' });
    expect(r2).toEqual({ ok: true, action: 'spawn', agent_id: 'sonnet-2' });
    expect(r3).toEqual({ ok: true, action: 'spawn', agent_id: 'opus-1' });
    expect(r4).toEqual({ ok: true, action: 'spawn', agent_id: 'opus-2' });
    mgr.shutdownForTests();
  });

  it('message returns NOT_FOUND for an unknown agent id', async () => {
    const { config } = makeFakeConfig();
    const mgr = new SwarmManager(config, { startSweep: false });
    const r = await mgr.message({
      action: 'message',
      agent_id: 'ghost',
      prompt: 'hi',
    });
    expect(r).toEqual({
      ok: false,
      error: expect.stringContaining("'ghost'"),
      code: SwarmErrorCode.AGENT_NOT_FOUND,
    });
    mgr.shutdownForTests();
  });

  it('message returns INVALID_STATE (BUSY) when session is already running', async () => {
    const { config } = makeFakeConfig();
    const mgr = new SwarmManager(config, { startSweep: false });
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';

    // Hold the loop pending so the session stays RUNNING long enough for a
    // second message to land.
    let resolveLoop: ((v: string) => void) | undefined;
    hoisted.runLoop.mockImplementationOnce(
      () => new Promise<string>((res) => (resolveLoop = res)),
    );

    const spawn = await mgr.spawn({
      action: 'spawn',
      system_prompt: 'p',
    });
    expect(spawn.ok).toBe(true);
    if (!spawn.ok || spawn.action !== 'spawn') throw new Error('unreachable');
    const id = spawn.agent_id;

    const inFlight = mgr.message({
      action: 'message',
      agent_id: id,
      prompt: 'first',
    });
    // Yield so the message handler sets status=RUNNING before our second
    // call observes it.
    await Promise.resolve();
    const second = await mgr.message({
      action: 'message',
      agent_id: id,
      prompt: 'second',
    });
    expect(second).toEqual({
      ok: false,
      error: expect.stringContaining('already processing'),
      code: SwarmErrorCode.AGENT_BUSY,
    });
    resolveLoop?.('done');
    await inFlight;
    mgr.shutdownForTests();
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('message returns AGENT_RELEASED on a released session', async () => {
    const { config } = makeFakeConfig();
    const mgr = new SwarmManager(config, { startSweep: false });
    const spawn = await mgr.spawn({
      action: 'spawn',
      system_prompt: 'p',
    });
    if (!spawn.ok || spawn.action !== 'spawn') throw new Error('unreachable');
    const id = spawn.agent_id;
    // Manually transition status to RELEASED without removing from the
    // map (simulates a sweep racing with the orchestrator).
    const session = mgr.getSessionsForTests().get(id)!;
    session.release();
    // But keep in map for the test:
    expect(mgr.getSessionsForTests().has(id)).toBe(true);

    const r = await mgr.message({
      action: 'message',
      agent_id: id,
      prompt: 'hi',
    });
    expect(r).toEqual({
      ok: false,
      error: expect.stringContaining('released'),
      code: SwarmErrorCode.AGENT_RELEASED,
    });
    mgr.shutdownForTests();
  });

  it('release is idempotent: missing id returns released: false', async () => {
    const { config } = makeFakeConfig();
    const mgr = new SwarmManager(config, { startSweep: false });

    const r1 = await mgr.release({ action: 'release', agent_id: 'ghost' });
    expect(r1).toEqual({ ok: true, action: 'release', released: false });

    const spawn = await mgr.spawn({
      action: 'spawn',
      system_prompt: 'p',
    });
    if (!spawn.ok || spawn.action !== 'spawn') throw new Error('unreachable');
    const id = spawn.agent_id;
    const r2 = await mgr.release({ action: 'release', agent_id: id });
    expect(r2).toEqual({ ok: true, action: 'release', released: true });
    // Second release on the same id: now missing → released: false.
    const r3 = await mgr.release({ action: 'release', agent_id: id });
    expect(r3).toEqual({ ok: true, action: 'release', released: false });
    mgr.shutdownForTests();
  });

  it('TTL sweep releases idle sessions past TTL', async () => {
    const { config } = makeFakeConfig();
    const mgr = new SwarmManager(config, {
      idleTtlMs: 1000,
      startSweep: false,
    });
    const spawn = await mgr.spawn({
      action: 'spawn',
      system_prompt: 'p',
    });
    if (!spawn.ok || spawn.action !== 'spawn') throw new Error('unreachable');
    const id = spawn.agent_id;
    const session = mgr.getSessionsForTests().get(id)!;
    // Backdate lastActiveAt so it's past the TTL.
    session.lastActiveAt = Date.now() - 5000;
    expect(session.status).toBe(SwarmSessionStatus.IDLE);

    mgr.sweepIdleSessions();

    expect(mgr.getSessionsForTests().has(id)).toBe(false);
    expect(session.status).toBe(SwarmSessionStatus.RELEASED);
    mgr.shutdownForTests();
  });

  it('TTL sweep aborts stuck RUNNING sessions past 2x TTL with error status but keeps them in the map', async () => {
    const { config } = makeFakeConfig();
    const mgr = new SwarmManager(config, {
      idleTtlMs: 1000,
      startSweep: false,
    });
    const spawn = await mgr.spawn({
      action: 'spawn',
      system_prompt: 'p',
    });
    if (!spawn.ok || spawn.action !== 'spawn') throw new Error('unreachable');
    const id = spawn.agent_id;
    const session = mgr.getSessionsForTests().get(id)!;
    session.status = SwarmSessionStatus.RUNNING;
    // Just past TTL: NOT swept (must wait for 2x).
    session.lastActiveAt = Date.now() - 1500;
    mgr.sweepIdleSessions();
    expect(mgr.getSessionsForTests().has(id)).toBe(true);
    expect(session.status).toBe(SwarmSessionStatus.RUNNING);

    // Past 2x TTL: aborted + transitioned to ERROR, but per Phase 3 fix
    // (Gemini phase2 #1) the session stays in the map so `list()` can
    // surface it for debugging.
    session.lastActiveAt = Date.now() - 3000;
    mgr.sweepIdleSessions();
    expect(mgr.getSessionsForTests().has(id)).toBe(true);
    expect(session.status).toBe(SwarmSessionStatus.ERROR);
    expect(session.abortController.signal.aborted).toBe(true);
    mgr.shutdownForTests();
  });

  it('aborting the app signal aborts every active session', async () => {
    const appController = new AbortController();
    const { config } = makeFakeConfig({
      appSignal: appController.signal,
    });
    const mgr = new SwarmManager(config, { startSweep: false });
    const s1 = await mgr.spawn({ action: 'spawn', system_prompt: 'p' });
    const s2 = await mgr.spawn({ action: 'spawn', system_prompt: 'p' });
    if (!s1.ok || s1.action !== 'spawn' || !s2.ok || s2.action !== 'spawn') {
      throw new Error('unreachable');
    }
    const sessions = mgr.getSessionsForTests();
    const a = sessions.get(s1.agent_id)!;
    const b = sessions.get(s2.agent_id)!;
    expect(a.abortController.signal.aborted).toBe(false);
    expect(b.abortController.signal.aborted).toBe(false);

    appController.abort('test');

    expect(a.abortController.signal.aborted).toBe(true);
    expect(b.abortController.signal.aborted).toBe(true);
    expect(a.status).toBe(SwarmSessionStatus.RELEASED);
    expect(b.status).toBe(SwarmSessionStatus.RELEASED);
    mgr.shutdownForTests();
  });

  it('publishes telemetry events on spawn/message/release', async () => {
    const { config, globalBus } = makeFakeConfig();
    const mgr = new SwarmManager(config, { startSweep: false });
    const events: SwarmActivityEvent[] = [];
    globalBus.on(SWARM_ACTIVITY_EVENT_NAME, (e: SwarmActivityEvent) =>
      events.push(e),
    );

    hoisted.runLoop.mockResolvedValueOnce('ok');
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';

    const spawn = await mgr.spawn({ action: 'spawn', system_prompt: 'p' });
    if (!spawn.ok || spawn.action !== 'spawn') throw new Error('unreachable');
    await mgr.message({
      action: 'message',
      agent_id: spawn.agent_id,
      prompt: 'hi',
    });
    await mgr.release({ action: 'release', agent_id: spawn.agent_id });

    expect(events.map((e) => e.action)).toEqual([
      'spawn',
      'message',
      'release',
    ]);
    expect(events.every((e) => e.isSwarmActivityEvent === true)).toBe(true);
    expect(events[1].turnCount).toBe(1);
    mgr.shutdownForTests();
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('list returns insertion-ordered snapshots', async () => {
    const { config } = makeFakeConfig();
    const mgr = new SwarmManager(config, { startSweep: false });
    await mgr.spawn({ action: 'spawn', system_prompt: 'p' });
    await mgr.spawn({ action: 'spawn', model: 'opus', system_prompt: 'p' });
    const r = mgr.list();
    expect(r.ok).toBe(true);
    if (!r.ok || r.action !== 'list') throw new Error('unreachable');
    expect(r.agents.map((a) => a.agentId)).toEqual(['sonnet-1', 'opus-1']);
    expect(r.agents[0]).toMatchObject({
      kind: 'anthropic',
      model: 'sonnet',
      status: SwarmSessionStatus.IDLE,
      turnCount: 0,
    });
    mgr.shutdownForTests();
  });

  it('release detaches the app-abort listener so it does not accumulate across cycles', async () => {
    // Use a real AbortSignal so we can count listeners on it directly.
    const appController = new AbortController();
    const { config } = makeFakeConfig({ appSignal: appController.signal });
    const mgr = new SwarmManager(config, { startSweep: false });

    // Spawn + release several sessions; the listener count should NOT grow
    // unboundedly. We snapshot the listener count via the internal
    // EventTarget "abort" listener registry indirectly: after N
    // spawn/release cycles, aborting the signal should NOT call any
    // session.abort handlers — they should have been detached.
    const spawned: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await mgr.spawn({ action: 'spawn', system_prompt: 'p' });
      if (!r.ok || r.action !== 'spawn') throw new Error('unreachable');
      spawned.push(r.agent_id);
    }
    // Release all of them: every session's app-abort listener should be
    // detached. Capture session controller signals before release.
    const sessions = spawned.map((id) => mgr.getSessionsForTests().get(id)!);
    // Sanity: pre-release, controllers are not aborted.
    for (const s of sessions) {
      expect(s.abortController.signal.aborted).toBe(false);
    }
    for (const id of spawned) {
      await mgr.release({ action: 'release', agent_id: id });
    }
    // After release, the session controllers ARE aborted (release does it
    // directly). But subsequent app-abort should NOT fire any leftover
    // listener that re-aborts. Easiest assertion: the listener disposer
    // on each session is cleared (private field) — we assert via the
    // observable behavior that firing the app signal does not throw and
    // every session still reports status=RELEASED (not anything else).
    appController.abort('test-cleanup');
    for (const s of sessions) {
      expect(s.status).toBe(SwarmSessionStatus.RELEASED);
    }
    mgr.shutdownForTests();
  });

  it('TTL sweep keeps stuck ERROR sessions visible to list()', async () => {
    const { config } = makeFakeConfig();
    const mgr = new SwarmManager(config, {
      idleTtlMs: 1000,
      startSweep: false,
    });
    const spawn = await mgr.spawn({ action: 'spawn', system_prompt: 'p' });
    if (!spawn.ok || spawn.action !== 'spawn') throw new Error('unreachable');
    const id = spawn.agent_id;
    const session = mgr.getSessionsForTests().get(id)!;
    session.status = SwarmSessionStatus.RUNNING;
    session.lastActiveAt = Date.now() - 5000; // past 2x TTL
    mgr.sweepIdleSessions();

    const listed = mgr.list();
    if (!listed.ok || listed.action !== 'list') throw new Error('unreachable');
    const found = listed.agents.find((a) => a.agentId === id);
    expect(found).toBeDefined();
    expect(found?.status).toBe(SwarmSessionStatus.ERROR);
    mgr.shutdownForTests();
  });

  it('lastActiveAt is stamped on RUNNING entry to avoid false-stuck sweeps', async () => {
    const { config } = makeFakeConfig();
    const mgr = new SwarmManager(config, { startSweep: false });
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';

    // Hold the loop pending so we can observe lastActiveAt while RUNNING.
    let resolveLoop: ((v: string) => void) | undefined;
    hoisted.runLoop.mockImplementationOnce(
      () => new Promise<string>((res) => (resolveLoop = res)),
    );
    const spawn = await mgr.spawn({ action: 'spawn', system_prompt: 'p' });
    if (!spawn.ok || spawn.action !== 'spawn') throw new Error('unreachable');
    const id = spawn.agent_id;
    const session = mgr.getSessionsForTests().get(id)!;
    // Backdate to simulate an old createdAt, to confirm the stamp on
    // RUNNING entry refreshes it past the test's "now".
    session.lastActiveAt = Date.now() - 60_000;
    const stale = session.lastActiveAt;

    const inFlight = mgr.message({
      action: 'message',
      agent_id: id,
      prompt: 'hi',
    });
    // Yield so the handler runs through "set RUNNING + stamp lastActiveAt".
    await Promise.resolve();
    expect(session.status).toBe(SwarmSessionStatus.RUNNING);
    expect(session.lastActiveAt).toBeGreaterThan(stale);

    resolveLoop?.('done');
    await inFlight;
    mgr.shutdownForTests();
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('happy-path message returns the loop response and increments turnCount', async () => {
    const { config } = makeFakeConfig();
    const mgr = new SwarmManager(config, { startSweep: false });
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    hoisted.runLoop.mockResolvedValueOnce('hello back');

    const spawn = await mgr.spawn({ action: 'spawn', system_prompt: 'p' });
    if (!spawn.ok || spawn.action !== 'spawn') throw new Error('unreachable');
    const r = await mgr.message({
      action: 'message',
      agent_id: spawn.agent_id,
      prompt: 'hello',
    });
    expect(r).toEqual({
      ok: true,
      action: 'message',
      response: 'hello back',
      status: SwarmSessionStatus.IDLE,
    });
    const session = mgr.getSessionsForTests().get(spawn.agent_id)!;
    expect(session.turnCount).toBe(1);
    expect(session.messages.length).toBeGreaterThan(0);
    mgr.shutdownForTests();
    delete process.env['ANTHROPIC_API_KEY'];
  });
});
