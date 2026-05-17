/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The locked v1.0 stateful-continuity E2E test for the swarm
 * primitive. Specified in `design-loop/swarm-design.md` (Final Synthesis ->
 * v1.0 acceptance test) and explicitly demanded by both reviewers in their
 * Phase 2 reviews.
 *
 * What this test proves: a `SwarmSession`'s `messages` array genuinely
 * carries conversation state ACROSS orchestrator turns. Without that, the
 * swarm gives nothing over the existing one-shot `AgentTool`. The critical
 * assertion captures the `messages` arg passed to Anthropic on Agent A's
 * SECOND message call and confirms it contains both:
 *  - the user turn from A's first message, and
 *  - the assistant turn from A's first message,
 * preceding the new user turn.
 *
 * If session statelessness regresses (e.g. someone wires `messages = []`
 * back into the loop start), this test will fail.
 *
 * Mocking strategy: copy the hoisted-mock pattern from
 * `anthropic-invocation.test.ts`, intercepting `@anthropic-ai/sdk` at the
 * module boundary. We deep-snapshot every `client.messages.create` payload
 * because the SUT mutates the `messages` array in place across turns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { EventEmitter } from 'node:events';
import { SwarmManager } from './swarm-manager.js';
import { SwarmSessionStatus } from './types.js';
import { Kind } from '../../tools/tools.js';
import type { Config } from '../../config/config.js';

// ---- Module mocks --------------------------------------------------------

interface MessagesCreateCall {
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: unknown;
}

const hoisted = vi.hoisted(() => ({
  // Sequenced mock replies. The continuity test queues four replies, each
  // resolved by the next `client.messages.create` call.
  messagesCreate: vi.fn<
    (params: MessagesCreateCall) => Promise<{
      content: Array<{ type: 'text'; text: string }>;
      stop_reason: 'end_turn';
    }>
  >(),
  // Captured (deep-cloned) payloads, in call order, so per-call assertions
  // can read state without racing the in-place mutation that the swarm
  // loop performs on the `messages` array.
  calls: [] as MessagesCreateCall[],
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = {
      create: (params: MessagesCreateCall, _opts?: unknown) => {
        // Deep-snapshot the payload. The shared loop mutates `messages` in
        // place across turns; recording the live ref would let later turns
        // mutate earlier captures.
        const snap: MessagesCreateCall = {
          model: params.model,
          system: params.system,
          tools: params.tools,
          messages: JSON.parse(
            JSON.stringify(params.messages),
          ) as Anthropic.MessageParam[],
        };
        hoisted.calls.push(snap);
        return hoisted.messagesCreate(snap);
      },
    };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

vi.mock('../../tools/tool-registry.js', () => {
  class FakeToolRegistry {
    readonly tools = new Map<string, unknown>();
    constructor(_config: unknown, _bus: unknown) {}
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

// ---- Helpers -------------------------------------------------------------

interface FakeTool {
  name: string;
  kind: Kind;
  clone: (bus: unknown) => FakeTool;
}

function makeTool(name: string, kind: Kind = Kind.Read): FakeTool {
  const t: FakeTool = { name, kind, clone: () => t };
  return t;
}

function makeFakeConfig(): { config: Config; appController: AbortController } {
  const appController = new AbortController();
  const tools: FakeTool[] = [
    makeTool('read_file'),
    makeTool('grep_search'),
    makeTool('glob'),
    makeTool('list_directory'),
    makeTool('read_many_files'),
  ];
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

  const config = {
    getAppAbortSignal: () => appController.signal,
    getGlobalAppBus: () => bus,
    getToolRegistry: () => parentRegistry,
  } as unknown as Config;
  return { config, appController };
}

function textReply(text: string): {
  content: Array<{ type: 'text'; text: string }>;
  stop_reason: 'end_turn';
} {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  };
}

// ---- The locked acceptance E2E -----------------------------------------

describe('Swarm stateful continuity E2E (swarm-design.md acceptance gate)', () => {
  let prevKey: string | undefined;

  beforeEach(() => {
    prevKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    hoisted.messagesCreate.mockReset();
    hoisted.calls.length = 0;
    SwarmManager.resetForTests();
  });

  afterEach(() => {
    SwarmManager.resetForTests();
    if (prevKey === undefined) {
      delete process.env['ANTHROPIC_API_KEY'];
    } else {
      process.env['ANTHROPIC_API_KEY'] = prevKey;
    }
  });

  it("preserves a session's prior user+assistant turns across orchestrator turns", async () => {
    const { config } = makeFakeConfig();
    const mgr = new SwarmManager(config, { startSweep: false });

    const aFirstReply = 'I noted three functions: foo/bar/baz.';
    const bFirstReply = 'In Y I see qux/quux/corge.';
    const aSecondReply =
      'Comparing my foo/bar/baz to your qux/quux/corge: no overlap.';

    // Four mocked Anthropic round-trips, in scenario order.
    hoisted.messagesCreate
      .mockResolvedValueOnce(textReply(aFirstReply)) // A turn 1
      .mockResolvedValueOnce(textReply(bFirstReply)) // B turn 1
      .mockResolvedValueOnce(textReply(aSecondReply)); // A turn 2

    // 1. Spawn A.
    const spawnA = await mgr.spawn({
      action: 'spawn',
      model: 'sonnet',
      system_prompt: 'You summarize functions concisely.',
      display_name: 'agent-A',
    });
    if (!spawnA.ok || spawnA.action !== 'spawn') {
      throw new Error('spawnA failed');
    }
    const agentIdA = spawnA.agent_id;
    expect(agentIdA).toBe('sonnet-1');

    // 2. Message A: prompt 1.
    const aPrompt1 =
      'Read packages/core/src/agents/agent-tool.ts and list the 3 main functions.';
    const msgA1 = await mgr.message({
      action: 'message',
      agent_id: agentIdA,
      prompt: aPrompt1,
    });
    expect(msgA1.ok).toBe(true);
    if (!msgA1.ok || msgA1.action !== 'message') throw new Error('msgA1');
    expect(msgA1.response).toBe(aFirstReply);
    expect(msgA1.status).toBe(SwarmSessionStatus.IDLE);

    // 3. Spawn B.
    const spawnB = await mgr.spawn({
      action: 'spawn',
      model: 'sonnet',
      system_prompt: 'You summarize functions concisely.',
      display_name: 'agent-B',
    });
    if (!spawnB.ok || spawnB.action !== 'spawn') throw new Error('spawnB');
    const agentIdB = spawnB.agent_id;
    expect(agentIdB).toBe('sonnet-2');

    // 4. Message B: prompt 2.
    const bPrompt1 =
      'Read packages/core/src/agents/local-invocation.ts and list its 3 main functions.';
    const msgB1 = await mgr.message({
      action: 'message',
      agent_id: agentIdB,
      prompt: bPrompt1,
    });
    expect(msgB1.ok).toBe(true);
    if (!msgB1.ok || msgB1.action !== 'message') throw new Error('msgB1');
    expect(msgB1.response).toBe(bFirstReply);

    // Sanity: B's messages array should NOT contain anything from A.
    const sessions = mgr.getSessionsForTests();
    const sessionB = sessions.get(agentIdB)!;
    expect(
      sessionB.messages.some(
        (m) => typeof m.content === 'string' && m.content.includes(aPrompt1),
      ),
    ).toBe(false);

    // 5. Message A again — this is the KEY ASSERTION.
    const aPrompt2 = `Compare your 3 functions to these from another agent: ${bFirstReply}. Find overlap.`;
    const msgA2 = await mgr.message({
      action: 'message',
      agent_id: agentIdA,
      prompt: aPrompt2,
    });
    expect(msgA2.ok).toBe(true);
    if (!msgA2.ok || msgA2.action !== 'message') throw new Error('msgA2');
    expect(msgA2.response).toBe(aSecondReply);

    // -------- Key assertion: session continuity --------
    // The third call to `messages.create` (calls[2]) is A's second turn.
    // Its `messages` argument MUST include A's prior user+assistant turns
    // BEFORE the new user prompt. If session statelessness regressed
    // (messages reset to []), only the new prompt would be present.
    expect(hoisted.calls).toHaveLength(3);
    const aSecondCall = hoisted.calls[2];

    // The captured `messages` snapshot is what the SDK saw at call time.
    // After the call, the loop pushes the assistant reply; the snapshot
    // captures state BEFORE that push, i.e. the pre-call view of A.
    expect(aSecondCall.messages.length).toBe(3);
    // [0] = user from turn 1 (prompt 1).
    expect(aSecondCall.messages[0].role).toBe('user');
    expect(aSecondCall.messages[0].content).toBe(aPrompt1);
    // [1] = assistant reply from turn 1 (A's first response).
    expect(aSecondCall.messages[1].role).toBe('assistant');
    // Content can be a string or an array of content blocks; both shapes
    // must carry the prior reply text somewhere.
    const assistantContent = aSecondCall.messages[1].content;
    if (typeof assistantContent === 'string') {
      expect(assistantContent).toContain('foo/bar/baz');
    } else if (Array.isArray(assistantContent)) {
      const textBlocks = assistantContent
        .filter(
          (b): b is { type: 'text'; text: string } =>
            (b as { type?: string }).type === 'text',
        )
        .map((b) => b.text)
        .join('\n');
      expect(textBlocks).toContain('foo/bar/baz');
    } else {
      throw new Error(
        `Unexpected assistant content shape: ${typeof assistantContent}`,
      );
    }
    // [2] = the new user prompt from turn 2.
    expect(aSecondCall.messages[2].role).toBe('user');
    expect(aSecondCall.messages[2].content).toBe(aPrompt2);

    // Sanity: B's call (calls[1]) only saw its own prompt, no cross-talk.
    const bFirstCall = hoisted.calls[1];
    expect(bFirstCall.messages.length).toBe(1);
    expect(bFirstCall.messages[0].role).toBe('user');
    expect(bFirstCall.messages[0].content).toBe(bPrompt1);

    // 6/7. Release both agents.
    const relA = await mgr.release({
      action: 'release',
      agent_id: agentIdA,
    });
    expect(relA).toEqual({ ok: true, action: 'release', released: true });
    const relB = await mgr.release({
      action: 'release',
      agent_id: agentIdB,
    });
    expect(relB).toEqual({ ok: true, action: 'release', released: true });

    // 8. List returns empty.
    const listed = mgr.list();
    expect(listed).toEqual({ ok: true, action: 'list', agents: [] });

    mgr.shutdownForTests();
  });

  it('confirms turnCount and lastActiveAt are bookkept across the multi-turn dance', async () => {
    // Lightweight follow-up: assert SwarmSession.turnCount climbs and
    // lastActiveAt monotonically advances. Catches a regression where
    // turn bookkeeping silently breaks.
    const { config } = makeFakeConfig();
    const mgr = new SwarmManager(config, { startSweep: false });

    hoisted.messagesCreate
      .mockResolvedValueOnce(textReply('1'))
      .mockResolvedValueOnce(textReply('2'));

    const spawn = await mgr.spawn({
      action: 'spawn',
      system_prompt: 'p',
    });
    if (!spawn.ok || spawn.action !== 'spawn') throw new Error('spawn');
    const id = spawn.agent_id;

    const tBefore = mgr.getSessionsForTests().get(id)!.lastActiveAt;
    await mgr.message({ action: 'message', agent_id: id, prompt: 'a' });
    const tMid = mgr.getSessionsForTests().get(id)!.lastActiveAt;
    expect(mgr.getSessionsForTests().get(id)!.turnCount).toBe(1);
    expect(tMid).toBeGreaterThanOrEqual(tBefore);

    await new Promise((r) => setTimeout(r, 5));
    await mgr.message({ action: 'message', agent_id: id, prompt: 'b' });
    const tEnd = mgr.getSessionsForTests().get(id)!.lastActiveAt;
    expect(mgr.getSessionsForTests().get(id)!.turnCount).toBe(2);
    expect(tEnd).toBeGreaterThanOrEqual(tMid);

    mgr.shutdownForTests();
  });
});
