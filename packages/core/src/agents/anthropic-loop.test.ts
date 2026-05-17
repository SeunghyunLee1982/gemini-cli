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
} from './anthropic-loop.js';
import type { Config } from '../config/config.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

const hoisted = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
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

describe('runAnthropicMessageLoop (smoke)', () => {
  beforeEach(() => {
    hoisted.messagesCreate.mockReset();
  });

  it('returns the assistant text on stop_reason=end_turn and pushes the assistant turn into messages', async () => {
    hoisted.messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'hello world' }],
      stop_reason: 'end_turn',
    });
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'hi' },
    ];
    const text = await runAnthropicMessageLoop({
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
    expect(text).toBe('hello world');
    // The loop appends the assistant turn to `messages` so callers can
    // observe post-call state.
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('assistant');
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
