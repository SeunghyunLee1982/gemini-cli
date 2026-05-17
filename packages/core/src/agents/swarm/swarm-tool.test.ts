/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Unit tests for `SwarmInvocation` progress streaming.
 *
 * Phase 5.1 (Bug 2): the TUI's `SubagentGroupDisplay` shows `Starting...`
 * until the tool calls `updateOutput` with a `SubagentProgress`. The regular
 * `AnthropicAgentInvocation` does this in `executeWithTools`; the swarm tool
 * used to skip it, leaving the spinner wedged on `Starting...` for the
 * entire `message` round-trip. These tests pin the new behavior:
 *   - `message` pushes RUNNING then COMPLETED/ERROR.
 *   - `spawn`/`release`/`list` never call `updateOutput` (fast path).
 *
 * The Anthropic loop is mocked at the module boundary so we exercise the
 * tool layer without lighting up a real Anthropic client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SwarmTool, SWARM_TOOL_NAME } from './swarm-tool.js';
import { SwarmManager } from './swarm-manager.js';
import { SubagentState, type SubagentProgress } from '../types.js';
import { Kind } from '../../tools/tools.js';
import type { Config } from '../../config/config.js';
import type { MessageBus } from '../../confirmation-bus/message-bus.js';

// ---- mocks ---------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  runLoop:
    vi.fn<() => Promise<string | { text: string; capReached: boolean }>>(),
}));

vi.mock('../anthropic-loop.js', async () => {
  const actual = await vi.importActual<typeof import('../anthropic-loop.js')>(
    '../anthropic-loop.js',
  );
  return {
    ...actual,
    runAnthropicMessageLoop: async () => {
      const raw = await hoisted.runLoop();
      if (typeof raw === 'string') return { text: raw, capReached: false };
      return raw;
    },
  };
});

vi.mock('../../tools/tool-registry.js', () => {
  class FakeToolRegistry {
    readonly tools = new Map<string, unknown>();
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

function makeFakeConfig(): {
  config: Config;
  bus: MessageBus;
} {
  const appController = new AbortController();
  const tools = [makeTool('read_file'), makeTool('grep_search')];
  const toolMap = new Map(tools.map((t) => [t.name, t]));

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

  // Phase 6 — SwarmManager.spawn/release/getSwarmStatusSnapshot now touch
  // the policy engine; stub it so the tool tests don't need real rules.
  const policyEngine = {
    addRule: vi.fn(),
    removeRulesBySource: vi.fn(),
    getRules: () => [],
  };

  const config = {
    getAppAbortSignal: () => appController.signal,
    getGlobalAppBus: () => bus,
    getToolRegistry: () => parentRegistry,
    getPolicyEngine: () => policyEngine,
    storage: {
      getProjectTempSwarmDir: () =>
        `${process.cwd()}/.gemini/tmp/test-session/swarm`,
    },
  } as unknown as Config;
  return { config, bus: bus as unknown as MessageBus };
}

async function buildInvocation(
  config: Config,
  bus: MessageBus,
  params: Record<string, unknown>,
): Promise<{
  execute: (opts: {
    abortSignal: AbortSignal;
    updateOutput?: (p: unknown) => void;
  }) => Promise<unknown>;
}> {
  const tool = new SwarmTool(config, bus);
  const inv = tool.build(params as never);
  return inv as unknown as {
    execute: (opts: {
      abortSignal: AbortSignal;
      updateOutput?: (p: unknown) => void;
    }) => Promise<unknown>;
  };
}

// ---- tests ---------------------------------------------------------------

describe('SwarmInvocation — Phase 5.1 progress streaming', () => {
  beforeEach(() => {
    hoisted.runLoop.mockReset();
    SwarmManager.resetForTests();
  });

  afterEach(() => {
    SwarmManager.resetForTests();
  });

  it('message action pushes RUNNING then COMPLETED progress on success', async () => {
    const { config, bus } = makeFakeConfig();
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    hoisted.runLoop.mockResolvedValueOnce('hello back');

    // Pre-spawn so the message has a real agent to talk to.
    const spawnInv = await buildInvocation(config, bus, {
      action: 'spawn',
      system_prompt: 'p',
    });
    const spawnRes = (await spawnInv.execute({
      abortSignal: new AbortController().signal,
    })) as { llmContent: string };
    const parsed = JSON.parse(spawnRes.llmContent) as {
      ok: true;
      action: 'spawn';
      agent_id: string;
    };
    const agentId = parsed.agent_id;

    const captured: SubagentProgress[] = [];
    const msgInv = await buildInvocation(config, bus, {
      action: 'message',
      agent_id: agentId,
      prompt: 'hi',
    });
    await msgInv.execute({
      abortSignal: new AbortController().signal,
      updateOutput: (p) => captured.push(p as SubagentProgress),
    });

    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({
      isSubagentProgress: true,
      agentName: agentId,
      state: SubagentState.RUNNING,
    });
    expect(captured[1]).toMatchObject({
      isSubagentProgress: true,
      agentName: agentId,
      state: SubagentState.COMPLETED,
    });
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('message action pushes ERROR progress when the underlying loop fails', async () => {
    const { config, bus } = makeFakeConfig();
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    hoisted.runLoop.mockRejectedValueOnce(new Error('boom'));

    const spawnInv = await buildInvocation(config, bus, {
      action: 'spawn',
      system_prompt: 'p',
    });
    const spawnRes = (await spawnInv.execute({
      abortSignal: new AbortController().signal,
    })) as { llmContent: string };
    const agentId = (
      JSON.parse(spawnRes.llmContent) as {
        ok: true;
        action: 'spawn';
        agent_id: string;
      }
    ).agent_id;

    const captured: SubagentProgress[] = [];
    const msgInv = await buildInvocation(config, bus, {
      action: 'message',
      agent_id: agentId,
      prompt: 'hi',
    });
    await msgInv.execute({
      abortSignal: new AbortController().signal,
      updateOutput: (p) => captured.push(p as SubagentProgress),
    });

    expect(captured).toHaveLength(2);
    expect(captured[0].state).toBe(SubagentState.RUNNING);
    expect(captured[1].state).toBe(SubagentState.ERROR);
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('spawn / release / list actions do NOT call updateOutput (fast path)', async () => {
    const { config, bus } = makeFakeConfig();

    const updateOutput = vi.fn();
    const abortSignal = new AbortController().signal;

    // spawn
    const spawnInv = await buildInvocation(config, bus, {
      action: 'spawn',
      system_prompt: 'p',
    });
    const spawnRes = (await spawnInv.execute({
      abortSignal,
      updateOutput,
    })) as { llmContent: string };
    const agentId = (
      JSON.parse(spawnRes.llmContent) as {
        ok: true;
        action: 'spawn';
        agent_id: string;
      }
    ).agent_id;
    expect(updateOutput).not.toHaveBeenCalled();

    // list
    const listInv = await buildInvocation(config, bus, { action: 'list' });
    await listInv.execute({ abortSignal, updateOutput });
    expect(updateOutput).not.toHaveBeenCalled();

    // release
    const relInv = await buildInvocation(config, bus, {
      action: 'release',
      agent_id: agentId,
    });
    await relInv.execute({ abortSignal, updateOutput });
    expect(updateOutput).not.toHaveBeenCalled();
  });

  // Belt-and-suspenders: confirm the tool is still registered under the
  // expected name so the orchestrator can find it. Catches accidental name
  // drift when the import surface is refactored.
  it('tool registers under the canonical "swarm" name', () => {
    const { config, bus } = makeFakeConfig();
    const tool = new SwarmTool(config, bus);
    expect(tool.name).toBe(SWARM_TOOL_NAME);
    expect(SWARM_TOOL_NAME).toBe('swarm');
  });
});
