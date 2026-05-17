/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Direct smoke test for `runAnthropicMessageLoop`. Most of
 * the loop is exercised end-to-end via `anthropic-invocation.test.ts` and
 * the swarm continuity E2E, but the Phase 2 review (Opus) flagged that a
 * direct unit test makes future refactors safer: if someone moves the
 * shared loop again, the smoke test catches structural breakage on its
 * own without depending on the v1 invocation harness.
 *
 * Kept narrow on purpose to avoid duplicating the broader invocation
 * tests. One end-turn happy path is enough to prove the loop returns the
 * assistant text and exits cleanly. Tool-use branches are covered by the
 * higher-level test files.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runAnthropicMessageLoop,
  finalAssistantText,
  type AnthropicLoopResult,
} from './anthropic-loop.js';
import type { Config } from '../config/config.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { CompletedToolCall } from '../scheduler/types.js';

const hoisted = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  scheduleAgentTools: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = {
      create: (params: unknown, opts?: unknown) =>
        hoisted.messagesCreate(params, opts),
    };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

vi.mock('./agent-scheduler.js', () => ({
  scheduleAgentTools: (...args: unknown[]) =>
    hoisted.scheduleAgentTools(...args),
}));

describe('runAnthropicMessageLoop (smoke)', () => {
  beforeEach(() => {
    hoisted.messagesCreate.mockReset();
    hoisted.scheduleAgentTools.mockReset();
  });

  it('returns { text, capReached:false } on stop_reason=end_turn and pushes the assistant turn into messages', async () => {
    hoisted.messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'hello world' }],
      stop_reason: 'end_turn',
    });
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'hi' },
    ];
    const result: AnthropicLoopResult = await runAnthropicMessageLoop({
      apiKey: 'sk-test',
      model: 'claude-sonnet-test',
      system: 'sys',
      anthropicTools: [],
      messages: messages as never,
      toolRegistry: {} as unknown as ToolRegistry,
      allowSet: new Set<string>(),
      config: {} as unknown as Config,
      maxTurns: 3,
      signal: new AbortController().signal,
      schedulerPromptId: 'smoke',
      subagentName: 'smoke',
    });
    // Phase 5: the loop now returns `{ text, capReached }`. Plain
    // end_turn exits with capReached=false.
    expect(result).toEqual({ text: 'hello world', capReached: false });
    // The loop appends the assistant turn to `messages` so callers can
    // observe post-call state.
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('assistant');
  });

  it('drives one tool_use turn through the scheduler, feeds tool_result back, and exits on end_turn', async () => {
    // First Anthropic call: model asks for one tool_use.
    hoisted.messagesCreate.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'thinking' },
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'read_file',
          input: { path: 'x.ts' },
        },
      ],
      stop_reason: 'tool_use',
    });
    // Second Anthropic call (after tool_result fed back): clean end_turn.
    hoisted.messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
    });

    // Scheduler returns a successful CompletedToolCall for tu_1.
    hoisted.scheduleAgentTools.mockResolvedValueOnce([
      {
        status: 'success',
        request: {
          callId: 'tu_1',
          name: 'read_file',
          args: { path: 'x.ts' },
          isClientInitiated: false,
          prompt_id: 'p',
        },
        response: {
          callId: 'tu_1',
          responseParts: [{ text: 'file contents' }],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
        },
      } as unknown as CompletedToolCall,
    ]);

    const fakeTool = {
      clone: () => fakeTool,
      kind: 'other',
    };
    const fakeRegistry = {
      getTool: () => fakeTool,
    } as unknown as ToolRegistry;

    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'please read x.ts' },
    ];
    const { text, capReached } = await runAnthropicMessageLoop({
      apiKey: 'sk-test',
      model: 'm',
      system: 's',
      anthropicTools: [],
      messages: messages as never,
      toolRegistry: fakeRegistry,
      allowSet: new Set<string>(['read_file']),
      config: {} as unknown as Config,
      maxTurns: 3,
      signal: new AbortController().signal,
      schedulerPromptId: 'smoke-tool',
      subagentName: 'sonnet-1',
    });

    expect(text).toBe('done');
    expect(capReached).toBe(false);
    // Sequence: user -> assistant(tool_use) -> user(tool_result) -> assistant(end_turn)
    expect(messages).toHaveLength(4);
    expect(messages[1].role).toBe('assistant');
    expect(messages[2].role).toBe('user');
    expect(messages[3].role).toBe('assistant');

    // Scheduler was called exactly once with the tool_use block routed
    // through agent-scheduler. We don't pin the full args bag — just
    // confirm the bookkeeping plumbing was exercised.
    expect(hoisted.scheduleAgentTools).toHaveBeenCalledTimes(1);
    expect(hoisted.messagesCreate).toHaveBeenCalledTimes(2);

    // The tool_result block must round-trip the tool_use id so Anthropic's
    // pairing invariant is preserved.
    const userResultTurn = messages[2] as { content: unknown };
    expect(Array.isArray(userResultTurn.content)).toBe(true);
    const blocks = userResultTurn.content as Array<{
      type: string;
      tool_use_id?: string;
    }>;
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[0].tool_use_id).toBe('tu_1');
  });

  it('returns the assistant text with a max_tokens note and does not retry', async () => {
    hoisted.messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'partial answer' }],
      stop_reason: 'max_tokens',
    });

    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'big question' },
    ];
    const { text, capReached } = await runAnthropicMessageLoop({
      apiKey: 'sk-test',
      model: 'm',
      system: 's',
      anthropicTools: [],
      messages: messages as never,
      toolRegistry: {} as unknown as ToolRegistry,
      allowSet: new Set<string>(),
      config: {} as unknown as Config,
      maxTurns: 3,
      signal: new AbortController().signal,
      schedulerPromptId: 'smoke-maxtok',
      subagentName: 'sonnet-1',
    });

    expect(text).toContain('partial answer');
    // The max_tokens truncation note IS still inline — it's user-facing
    // context about why the assistant text might be incomplete. `capReached`
    // remains false because max_tokens is a model-side budget, not the
    // loop-turn cap.
    expect(text).toContain('truncated by max_tokens');
    expect(capReached).toBe(false);
    // Exactly one Anthropic call — the loop must NOT retry on max_tokens.
    expect(hoisted.messagesCreate).toHaveBeenCalledTimes(1);
  });

  it('Phase 5 — returns { capReached: true } when the loop exits due to maxTurns; assistant text has no [Note: hit max_turns] suffix', async () => {
    // Force the loop to drain by always returning `tool_use` with one
    // tool_use block. The scheduler returns a quick success so the loop
    // can iterate without blocking on a real tool.
    hoisted.messagesCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'still working' },
        { type: 'tool_use', id: 'tu', name: 'read_file', input: {} },
      ],
      stop_reason: 'tool_use',
    });
    hoisted.scheduleAgentTools.mockResolvedValue([
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
          responseParts: [{ text: 'data' }],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
        },
      } as unknown as CompletedToolCall,
    ]);

    const fakeTool = { clone: () => fakeTool, kind: 'other' };
    const fakeRegistry = {
      getTool: () => fakeTool,
    } as unknown as ToolRegistry;

    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'go forever' },
    ];
    const { text, capReached } = await runAnthropicMessageLoop({
      apiKey: 'sk-test',
      model: 'm',
      system: 's',
      anthropicTools: [],
      messages: messages as never,
      toolRegistry: fakeRegistry,
      allowSet: new Set<string>(['read_file']),
      config: {} as unknown as Config,
      maxTurns: 2,
      signal: new AbortController().signal,
      schedulerPromptId: 'smoke-cap',
      subagentName: 'sonnet-cap',
    });

    // Cap reached: structured flag is true, the assistant text is the
    // last raw turn (no `[Note: hit max_turns=N.]` suffix).
    expect(capReached).toBe(true);
    expect(text).toBe('still working');
    expect(text).not.toMatch(/hit max_turns/);
    // Exactly maxTurns model calls before exiting.
    expect(hoisted.messagesCreate).toHaveBeenCalledTimes(2);
  });

  it('throws AbortError when the signal is already aborted before the first call', async () => {
    const c = new AbortController();
    c.abort('preempt');
    await expect(
      runAnthropicMessageLoop({
        apiKey: 'sk-test',
        model: 'm',
        system: 's',
        anthropicTools: [],
        messages: [{ role: 'user', content: 'x' }] as never,
        toolRegistry: {} as unknown as ToolRegistry,
        allowSet: new Set<string>(),
        config: {} as unknown as Config,
        maxTurns: 1,
        signal: c.signal,
        schedulerPromptId: 'smoke',
        subagentName: 'smoke',
      }),
    ).rejects.toThrow(/Aborted/);
    expect(hoisted.messagesCreate).not.toHaveBeenCalled();
  });
});

describe('finalAssistantText helper', () => {
  it('returns the last assistant turn text joined across blocks', () => {
    const text = finalAssistantText([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: 'again' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'b1' },
          { type: 'text', text: 'b2' },
        ],
      },
    ] as never);
    expect(text).toBe('b1\nb2');
  });

  it('returns empty string when no assistant turns exist', () => {
    expect(finalAssistantText([{ role: 'user', content: 'x' }] as never)).toBe(
      '',
    );
  });
});
