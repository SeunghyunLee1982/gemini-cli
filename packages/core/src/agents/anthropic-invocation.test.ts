/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicAgentInvocation } from './anthropic-invocation.js';
import type { AnthropicAgentDefinition } from './types.js';
import { ANTHROPIC_TOOL_RESULT_MAX_CHARS } from './types.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { ToolConfirmationOutcome, Kind } from '../tools/tools.js';
import { scheduleAgentTools } from './agent-scheduler.js';
import { runWithToolCallContext } from '../utils/toolCallContext.js';

// ---- Module mocks --------------------------------------------------------
// All shared state for mock factories MUST go through vi.hoisted() because
// vi.mock() calls are hoisted to the top of the module above any other
// `const`/`let` declarations.

type FakeTool = {
  name: string;
  description?: string;
  kind: string;
  schema: {
    name: string;
    description?: string;
    parametersJsonSchema?: unknown;
  };
  clone: (bus: unknown) => FakeTool;
};

type FakeToolRegistryInstance = {
  tools: Map<string, FakeTool>;
  messageBus: unknown;
};

const hoisted = vi.hoisted(() => ({
  registryInstances: [] as FakeToolRegistryInstance[],
  messagesCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    // Wrap the mock with a snapshot layer: `messages` is mutated in place by
    // the SUT, so naively recording the argument keeps a live reference and
    // reads at end-of-test see post-mutation state. Deep-snapshot at call
    // time so each recorded call captures the exact payload sent.
    messages = {
      create: (params: { messages: unknown[] }, options?: unknown) => {
        const snapshotted = {
          ...params,
          messages: JSON.parse(JSON.stringify(params.messages)) as unknown[],
        };
        return hoisted.messagesCreate(snapshotted, options);
      },
    };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

vi.mock('./agent-scheduler.js', () => ({
  scheduleAgentTools: vi.fn(),
}));

vi.mock('../utils/debugLogger.js', () => ({
  debugLogger: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../tools/tool-registry.js', () => {
  class FakeToolRegistry {
    readonly tools = new Map<string, FakeTool>();
    readonly messageBus: unknown;
    constructor(_config: unknown, messageBus: unknown) {
      this.messageBus = messageBus;
      hoisted.registryInstances.push(this);
    }
    registerTool(tool: FakeTool | undefined): void {
      if (!tool) return;
      this.tools.set(tool.name, tool);
    }
    getTool(name: string): FakeTool | undefined {
      return this.tools.get(name);
    }
    getFunctionDeclarationsFiltered(names: string[]): unknown[] {
      return names
        .map((n) => this.tools.get(n)?.schema)
        .filter((s) => s !== undefined);
    }
    sortTools(): void {}
  }
  return { ToolRegistry: FakeToolRegistry };
});

const messagesCreate = hoisted.messagesCreate;
const registryInstances = hoisted.registryInstances;
const mockedSchedule = vi.mocked(scheduleAgentTools);

// ---- Helpers --------------------------------------------------------------

const baseDefinition: AnthropicAgentDefinition = {
  kind: 'anthropic',
  name: 'tester',
  displayName: 'Tester',
  description: 'A test anthropic agent.',
  model: 'claude-haiku-4-5',
  system_prompt: 'You are a tester.',
  inputConfig: { inputSchema: { type: 'object', properties: {} } },
};

function makeContext(
  parentTools: Array<{
    name: string;
    description?: string;
    kind?: Kind;
    schema?: Record<string, unknown>;
  }>,
): AgentLoopContext {
  const parentBus = {
    derive: vi.fn(
      (name: string) =>
        // Return a new bus object so isolation can be asserted.
        ({ derived: true, name }) as unknown as MessageBus,
    ),
  } as unknown as MessageBus;

  const toolMap = new Map<
    string,
    {
      name: string;
      description?: string;
      kind: Kind;
      clone: (bus: MessageBus) => unknown;
      schema: {
        name: string;
        description?: string;
        parametersJsonSchema?: unknown;
      };
    }
  >();
  for (const t of parentTools) {
    const schemaObj = {
      name: t.name,
      description: t.description,
      parametersJsonSchema: t.schema ?? {
        type: 'object',
        properties: {},
      },
    };
    toolMap.set(t.name, {
      name: t.name,
      description: t.description,
      kind: t.kind ?? Kind.Read,
      schema: schemaObj,
      clone: (_bus: MessageBus) => ({
        name: t.name,
        description: t.description,
        kind: t.kind ?? Kind.Read,
        schema: schemaObj,
        clone: () => ({}),
      }),
    });
  }
  const parentRegistry = {
    getTool: (n: string) => toolMap.get(n),
  } as unknown as ToolRegistry;

  return {
    config: {} as unknown as AgentLoopContext['config'],
    promptId: 'parent-prompt-id',
    toolRegistry: parentRegistry,
    promptRegistry: {} as unknown as AgentLoopContext['promptRegistry'],
    resourceRegistry: {} as unknown as AgentLoopContext['resourceRegistry'],
    messageBus: parentBus,
    geminiClient: {} as unknown as AgentLoopContext['geminiClient'],
    sandboxManager: {} as unknown as AgentLoopContext['sandboxManager'],
  };
}

function makeBus(): MessageBus {
  return { derive: vi.fn() } as unknown as MessageBus;
}

function ac(): AbortController {
  return new AbortController();
}

// ---- Tests ----------------------------------------------------------------

describe('AnthropicAgentInvocation', () => {
  let prevKey: string | undefined;

  beforeEach(() => {
    prevKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    messagesCreate.mockReset();
    mockedSchedule.mockReset();
    registryInstances.length = 0;
  });

  afterEach(() => {
    if (prevKey === undefined) {
      delete process.env['ANTHROPIC_API_KEY'];
    } else {
      process.env['ANTHROPIC_API_KEY'] = prevKey;
    }
  });

  it('returns an error result when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const inv = new AnthropicAgentInvocation(
      baseDefinition,
      makeContext([]),
      { prompt: 'hi' },
      makeBus(),
    );
    const r = await inv.execute({ abortSignal: ac().signal });
    expect(r.error?.message).toMatch(/ANTHROPIC_API_KEY/);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  describe('single-shot (back-compat, no tools)', () => {
    it('returns Claude text on success and does NOT pass tools', async () => {
      messagesCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'pong' }],
        stop_reason: 'end_turn',
      });
      const inv = new AnthropicAgentInvocation(
        baseDefinition,
        makeContext([]),
        { prompt: 'ping' },
        makeBus(),
      );
      const r = await inv.execute({ abortSignal: ac().signal });
      expect(r.llmContent).toBe('pong');
      expect(messagesCreate).toHaveBeenCalledTimes(1);
      const call = messagesCreate.mock.calls[0][0];
      expect(call).not.toHaveProperty('tools');
      expect(call['system']).toBe('You are a tester.');
    });
  });

  describe('tool-use loop', () => {
    const definitionWithTools: AnthropicAgentDefinition = {
      ...baseDefinition,
      tools: ['read_file', 'grep_search'],
    };

    it('isolates ToolRegistry via derived bus and registers only whitelisted, non-Agent clones', async () => {
      messagesCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      });

      const ctx = makeContext([
        { name: 'read_file', description: 'reads' },
        { name: 'grep_search', description: 'greps' },
        { name: 'agent', description: 'invokes', kind: Kind.Agent },
        { name: 'other_tool', description: 'other' },
      ]);
      const inv = new AnthropicAgentInvocation(
        {
          ...definitionWithTools,
          tools: ['read_file', 'grep_search', 'agent'],
        },
        ctx,
        { prompt: 'go' },
        makeBus(),
      );
      await inv.execute({ abortSignal: ac().signal });

      expect(registryInstances).toHaveLength(1);
      const reg = registryInstances[0];
      // `agent` (Kind.Agent) was skipped; only the two read-class tools landed.
      expect(Array.from(reg.tools.keys()).sort()).toEqual([
        'grep_search',
        'read_file',
      ]);
      // The bus on the isolated registry is NOT the parent's. Our fake
      // `derive` tags its return with `{ derived: true }` so we can probe.
      const bus = reg.messageBus as { derived?: boolean };
      expect(bus.derived).toBe(true);
      // Parent bus.derive() was called with the agent's name.
      const deriveSpy = vi.mocked(ctx.messageBus.derive);
      expect(deriveSpy.mock.calls[0]).toEqual(['tester']);
    });

    it('round-trips a tool_use turn: schedules with block.id as callId, back-propagates tool_result keyed by tool_use_id', async () => {
      messagesCreate
        .mockResolvedValueOnce({
          content: [
            { type: 'text', text: 'thinking...' },
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'read_file',
              input: { absolute_path: '/tmp/x' },
            },
          ],
          stop_reason: 'tool_use',
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'finished' }],
          stop_reason: 'end_turn',
        });

      mockedSchedule.mockResolvedValueOnce([
        {
          status: 'success',
          request: {
            callId: 'tu_1',
            name: 'read_file',
            args: { absolute_path: '/tmp/x' },
            isClientInitiated: false,
            prompt_id: 'parent-prompt-id#anthropic-0',
          },
          response: {
            callId: 'tu_1',
            responseParts: [
              {
                functionResponse: {
                  id: 'tu_1',
                  name: 'read_file',
                  response: { output: 'hello world' },
                },
              },
            ],
            resultDisplay: 'hello world',
            error: undefined,
            errorType: undefined,
          },
          tool: {} as never,
          invocation: {} as never,
        },
      ] as never);

      const ctx = makeContext([{ name: 'read_file' }, { name: 'grep_search' }]);
      const inv = new AnthropicAgentInvocation(
        definitionWithTools,
        ctx,
        { prompt: 'read /tmp/x' },
        makeBus(),
      );
      const r = await inv.execute({ abortSignal: ac().signal });

      expect(r.llmContent).toBe('finished');
      // The 2nd request to Anthropic must contain the assistant turn from
      // turn 1 (including the tool_use block) and a user turn with a
      // tool_result keyed by `tu_1`.
      const secondCall = messagesCreate.mock.calls[1][0] as {
        messages: Anthropic.MessageParam[];
      };
      const userTurns = secondCall.messages.filter((m) => m.role === 'user');
      const last = userTurns[userTurns.length - 1];
      expect(Array.isArray(last.content)).toBe(true);
      const block = (last.content as Anthropic.ToolResultBlockParam[])[0];
      expect(block.type).toBe('tool_result');
      expect(block.tool_use_id).toBe('tu_1');
      expect(block.content).toBe('hello world');
      // The scheduled request used the block id as the callId.
      const opts = mockedSchedule.mock.calls[0][2];
      expect(opts.parentCallId).toBeUndefined();
      expect(opts.subagent).toBe('tester');
      expect(opts.schedulerId).toBe('parent-prompt-id#anthropic-0');
      const requests = mockedSchedule.mock.calls[0][1];
      expect(requests).toHaveLength(1);
      expect(requests[0].callId).toBe('tu_1');
      expect(requests[0].name).toBe('read_file');
    });

    it('forwards parentCallId from getToolCallContext()', async () => {
      messagesCreate
        .mockResolvedValueOnce({
          content: [
            {
              type: 'tool_use',
              id: 'tu_p',
              name: 'read_file',
              input: {},
            },
          ],
          stop_reason: 'tool_use',
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'k' }],
          stop_reason: 'end_turn',
        });

      mockedSchedule.mockResolvedValueOnce([
        {
          status: 'success',
          request: {
            callId: 'tu_p',
            name: 'read_file',
            args: {},
            isClientInitiated: false,
            prompt_id: 'p',
          },
          response: {
            callId: 'tu_p',
            responseParts: [
              {
                functionResponse: {
                  id: 'tu_p',
                  name: 'read_file',
                  response: { output: 'ok' },
                },
              },
            ],
            resultDisplay: 'ok',
            error: undefined,
            errorType: undefined,
          },
          tool: {} as never,
          invocation: {} as never,
        },
      ] as never);

      const ctx = makeContext([{ name: 'read_file' }]);
      const inv = new AnthropicAgentInvocation(
        definitionWithTools,
        ctx,
        { prompt: 'p' },
        makeBus(),
      );

      await runWithToolCallContext(
        { callId: 'parent-call-id', schedulerId: 'sched' },
        () => inv.execute({ abortSignal: ac().signal }),
      );

      expect(mockedSchedule.mock.calls[0][2].parentCallId).toBe(
        'parent-call-id',
      );
    });

    it('schedules parallel tool_uses in a single batch and back-propagates a single user message with N tool_result blocks', async () => {
      messagesCreate
        .mockResolvedValueOnce({
          content: [
            {
              type: 'tool_use',
              id: 'a',
              name: 'read_file',
              input: { absolute_path: '/a' },
            },
            {
              type: 'tool_use',
              id: 'b',
              name: 'read_file',
              input: { absolute_path: '/b' },
            },
          ],
          stop_reason: 'tool_use',
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
        });

      mockedSchedule.mockResolvedValueOnce([
        // Note: scheduler returns out of input order on purpose to test the
        // by-callId map.
        {
          status: 'success',
          request: {
            callId: 'b',
            name: 'read_file',
            args: {},
            isClientInitiated: false,
            prompt_id: 'p',
          },
          response: {
            callId: 'b',
            responseParts: [
              {
                functionResponse: {
                  id: 'b',
                  name: 'read_file',
                  response: { output: 'BB' },
                },
              },
            ],
            resultDisplay: 'BB',
            error: undefined,
            errorType: undefined,
          },
          tool: {} as never,
          invocation: {} as never,
        },
        {
          status: 'success',
          request: {
            callId: 'a',
            name: 'read_file',
            args: {},
            isClientInitiated: false,
            prompt_id: 'p',
          },
          response: {
            callId: 'a',
            responseParts: [
              {
                functionResponse: {
                  id: 'a',
                  name: 'read_file',
                  response: { output: 'AA' },
                },
              },
            ],
            resultDisplay: 'AA',
            error: undefined,
            errorType: undefined,
          },
          tool: {} as never,
          invocation: {} as never,
        },
      ] as never);

      const ctx = makeContext([{ name: 'read_file' }]);
      const inv = new AnthropicAgentInvocation(
        { ...baseDefinition, tools: ['read_file'] },
        ctx,
        { prompt: 'parallel' },
        makeBus(),
      );
      await inv.execute({ abortSignal: ac().signal });

      // One scheduler invocation with both requests.
      expect(mockedSchedule).toHaveBeenCalledTimes(1);
      // scheduleAgentTools signature: (config, requests, options).
      const requests = mockedSchedule.mock.calls[0][1];
      expect(requests).toHaveLength(2);
      expect(requests.map((r) => r.callId).sort()).toEqual(['a', 'b']);

      // Second create call: assistant turn (tool_use blocks) followed by a
      // single user turn with two tool_result blocks, each keyed by the
      // matching tool_use id and ordered to match the assistant's tool_use
      // order, NOT the scheduler return order.
      const secondCall = messagesCreate.mock.calls[1][0] as {
        messages: Anthropic.MessageParam[];
      };
      const userTurns = secondCall.messages.filter((m) => m.role === 'user');
      const last = userTurns[userTurns.length - 1];
      const blocks = last.content as Anthropic.ToolResultBlockParam[];
      expect(blocks).toHaveLength(2);
      expect(blocks[0].tool_use_id).toBe('a');
      expect(blocks[0].content).toBe('AA');
      expect(blocks[1].tool_use_id).toBe('b');
      expect(blocks[1].content).toBe('BB');
    });

    it('synthesizes an is_error tool_result for unauthorized tool calls without invoking the scheduler', async () => {
      messagesCreate
        .mockResolvedValueOnce({
          content: [
            {
              type: 'tool_use',
              id: 'tu_evil',
              name: 'run_shell_command',
              input: { command: 'rm -rf /' },
            },
          ],
          stop_reason: 'tool_use',
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
        });

      const ctx = makeContext([{ name: 'read_file' }]);
      const inv = new AnthropicAgentInvocation(
        { ...baseDefinition, tools: ['read_file'] },
        ctx,
        { prompt: 'try evil' },
        makeBus(),
      );
      await inv.execute({ abortSignal: ac().signal });

      // No scheduler trip — fully synthesized.
      expect(mockedSchedule).not.toHaveBeenCalled();
      // The second model call carries the tool_result back. Find the LAST
      // user turn whose content is a tool_result array (not the original
      // string prompt).
      const secondCall = messagesCreate.mock.calls[1][0] as {
        messages: Anthropic.MessageParam[];
      };
      const toolResultTurn = secondCall.messages
        .filter((m) => m.role === 'user' && Array.isArray(m.content))
        .pop();
      const block = (
        toolResultTurn!.content as Anthropic.ToolResultBlockParam[]
      )[0];
      expect(block.is_error).toBe(true);
      expect(block.content).toMatch(/not available/);
      expect(block.tool_use_id).toBe('tu_evil');
    });

    it('soft-rejects (Cancel outcome) feed an is_error tool_result and the loop continues', async () => {
      messagesCreate
        .mockResolvedValueOnce({
          content: [
            { type: 'tool_use', id: 'tu_r', name: 'read_file', input: {} },
          ],
          stop_reason: 'tool_use',
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'I will not retry.' }],
          stop_reason: 'end_turn',
        });

      mockedSchedule.mockResolvedValueOnce([
        {
          status: 'cancelled',
          outcome: ToolConfirmationOutcome.Cancel,
          request: {
            callId: 'tu_r',
            name: 'read_file',
            args: {},
            isClientInitiated: false,
            prompt_id: 'p',
          },
          response: {
            callId: 'tu_r',
            responseParts: [],
            resultDisplay: undefined,
            error: undefined,
            errorType: undefined,
          },
          tool: {} as never,
          invocation: {} as never,
        },
      ] as never);

      const ctx = makeContext([{ name: 'read_file' }]);
      const inv = new AnthropicAgentInvocation(
        { ...baseDefinition, tools: ['read_file'] },
        ctx,
        { prompt: 'p' },
        makeBus(),
      );
      const r = await inv.execute({ abortSignal: ac().signal });

      expect(r.llmContent).toBe('I will not retry.');
      // Soft-reject suffix was appended to the system prompt.
      const firstCall = messagesCreate.mock.calls[0][0] as {
        system: string;
      };
      expect(firstCall.system).toMatch(
        /If a tool call is rejected by the user/,
      );
      const secondCall = messagesCreate.mock.calls[1][0] as {
        messages: Anthropic.MessageParam[];
      };
      const last = secondCall.messages[secondCall.messages.length - 1];
      const block = (last.content as Anthropic.ToolResultBlockParam[])[0];
      expect(block.is_error).toBe(true);
      expect(block.content).toMatch(/User rejected/);
    });

    it('hard abort propagates and returns an error result', async () => {
      messagesCreate.mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_x', name: 'read_file', input: {} },
        ],
        stop_reason: 'tool_use',
      });

      mockedSchedule.mockResolvedValueOnce([
        {
          status: 'cancelled',
          // No outcome === Cancel: hard abort path.
          request: {
            callId: 'tu_x',
            name: 'read_file',
            args: {},
            isClientInitiated: false,
            prompt_id: 'p',
          },
          response: {
            callId: 'tu_x',
            responseParts: [],
            resultDisplay: undefined,
            error: undefined,
            errorType: undefined,
          },
          tool: {} as never,
          invocation: {} as never,
        },
      ] as never);

      const ctx = makeContext([{ name: 'read_file' }]);
      const inv = new AnthropicAgentInvocation(
        { ...baseDefinition, tools: ['read_file'] },
        ctx,
        { prompt: 'p' },
        makeBus(),
      );
      const r = await inv.execute({ abortSignal: ac().signal });
      expect(r.error).toBeDefined();
    });

    it('returns last text + truncation note on stop_reason: max_tokens (no retry)', async () => {
      messagesCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'partial answer' }],
        stop_reason: 'max_tokens',
      });

      const inv = new AnthropicAgentInvocation(
        { ...baseDefinition, tools: ['read_file'] },
        makeContext([{ name: 'read_file' }]),
        { prompt: 'p' },
        makeBus(),
      );
      const r = await inv.execute({ abortSignal: ac().signal });
      expect(r.llmContent).toMatch(/partial answer/);
      expect(r.llmContent).toMatch(/truncated by max_tokens/);
      expect(messagesCreate).toHaveBeenCalledTimes(1);
    });

    it('returns empty string (no throw) when stop_reason: end_turn with empty content', async () => {
      messagesCreate.mockResolvedValueOnce({
        content: [],
        stop_reason: 'end_turn',
      });
      const inv = new AnthropicAgentInvocation(
        { ...baseDefinition, tools: ['read_file'] },
        makeContext([{ name: 'read_file' }]),
        { prompt: 'p' },
        makeBus(),
      );
      const r = await inv.execute({ abortSignal: ac().signal });
      expect(r.llmContent).toBe('');
      expect(r.error).toBeUndefined();
    });

    it('returns last text + max_turns note when the loop drains', async () => {
      // Two consecutive tool_use turns, then we hit max_turns=2.
      messagesCreate.mockResolvedValue({
        content: [
          { type: 'text', text: 'still thinking' },
          { type: 'tool_use', id: 'tu', name: 'read_file', input: {} },
        ],
        stop_reason: 'tool_use',
      });

      mockedSchedule.mockResolvedValue([
        {
          status: 'success',
          request: {
            callId: 'tu',
            name: 'read_file',
            args: {},
            isClientInitiated: false,
            prompt_id: 'p',
          },
          response: {
            callId: 'tu',
            responseParts: [
              {
                functionResponse: {
                  id: 'tu',
                  name: 'read_file',
                  response: { output: 'data' },
                },
              },
            ],
            resultDisplay: 'data',
            error: undefined,
            errorType: undefined,
          },
          tool: {} as never,
          invocation: {} as never,
        },
      ] as never);

      const inv = new AnthropicAgentInvocation(
        { ...baseDefinition, tools: ['read_file'], max_turns: 2 },
        makeContext([{ name: 'read_file' }]),
        { prompt: 'never ends' },
        makeBus(),
      );
      const r = await inv.execute({ abortSignal: ac().signal });
      expect(r.llmContent).toMatch(/hit max_turns=2/);
      // Two turns -> two model calls.
      expect(messagesCreate).toHaveBeenCalledTimes(2);
    });

    it('truncates oversize tool_result content with a refine hint', async () => {
      const huge = 'x'.repeat(ANTHROPIC_TOOL_RESULT_MAX_CHARS + 5000);
      messagesCreate
        .mockResolvedValueOnce({
          content: [
            { type: 'tool_use', id: 'tu_big', name: 'read_file', input: {} },
          ],
          stop_reason: 'tool_use',
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'noted' }],
          stop_reason: 'end_turn',
        });

      mockedSchedule.mockResolvedValueOnce([
        {
          status: 'success',
          request: {
            callId: 'tu_big',
            name: 'read_file',
            args: {},
            isClientInitiated: false,
            prompt_id: 'p',
          },
          response: {
            callId: 'tu_big',
            responseParts: [
              {
                functionResponse: {
                  id: 'tu_big',
                  name: 'read_file',
                  response: { output: huge },
                },
              },
            ],
            resultDisplay: 'huge',
            error: undefined,
            errorType: undefined,
          },
          tool: {} as never,
          invocation: {} as never,
        },
      ] as never);

      const inv = new AnthropicAgentInvocation(
        { ...baseDefinition, tools: ['read_file'] },
        makeContext([{ name: 'read_file' }]),
        { prompt: 'big' },
        makeBus(),
      );
      await inv.execute({ abortSignal: ac().signal });
      const second = messagesCreate.mock.calls[1][0] as {
        messages: Anthropic.MessageParam[];
      };
      const last = second.messages[second.messages.length - 1];
      const block = (last.content as Anthropic.ToolResultBlockParam[])[0];
      const content = block.content as string;
      expect(content.length).toBeLessThan(huge.length);
      expect(content).toMatch(/Refine your call/);
    });

    it('renders a binary read_file Part as a [Image: ...] placeholder', async () => {
      messagesCreate
        .mockResolvedValueOnce({
          content: [
            { type: 'tool_use', id: 'tu_img', name: 'read_file', input: {} },
          ],
          stop_reason: 'tool_use',
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'k' }],
          stop_reason: 'end_turn',
        });

      mockedSchedule.mockResolvedValueOnce([
        {
          status: 'success',
          request: {
            callId: 'tu_img',
            name: 'read_file',
            args: {},
            isClientInitiated: false,
            prompt_id: 'p',
          },
          response: {
            callId: 'tu_img',
            responseParts: [
              {
                functionResponse: {
                  id: 'tu_img',
                  name: 'read_file',
                  response: {
                    output: 'Binary content (image/png) read successfully.',
                  },
                },
              },
              {
                inlineData: { mimeType: 'image/png', data: 'AAAA' },
              },
            ],
            resultDisplay: 'png',
            error: undefined,
            errorType: undefined,
          },
          tool: {} as never,
          invocation: {} as never,
        },
      ] as never);

      const inv = new AnthropicAgentInvocation(
        { ...baseDefinition, tools: ['read_file'] },
        makeContext([{ name: 'read_file' }]),
        { prompt: 'png' },
        makeBus(),
      );
      await inv.execute({ abortSignal: ac().signal });
      const second = messagesCreate.mock.calls[1][0] as {
        messages: Anthropic.MessageParam[];
      };
      const last = second.messages[second.messages.length - 1];
      const block = (last.content as Anthropic.ToolResultBlockParam[])[0];
      expect(block.content).toMatch(/\[Image: image\/png/);
    });

    it('schema pass-through identity for read_file', async () => {
      messagesCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      });

      const realSchema = {
        type: 'object',
        properties: {
          absolute_path: { description: 'p', type: 'string' },
          start_line: { description: 's', type: 'integer', minimum: 1 },
          end_line: { description: 'e', type: 'integer', minimum: 1 },
        },
        required: ['absolute_path'],
      };
      const ctx = makeContext([
        {
          name: 'read_file',
          description: 'reads a file',
          schema: realSchema,
        },
      ]);
      const inv = new AnthropicAgentInvocation(
        { ...baseDefinition, tools: ['read_file'] },
        ctx,
        { prompt: 'q' },
        makeBus(),
      );
      await inv.execute({ abortSignal: ac().signal });

      const sent = messagesCreate.mock.calls[0][0] as {
        tools: Anthropic.Tool[];
      };
      expect(sent.tools).toHaveLength(1);
      expect(sent.tools[0].name).toBe('read_file');
      expect(sent.tools[0].input_schema).toEqual(realSchema);
    });
  });
});
