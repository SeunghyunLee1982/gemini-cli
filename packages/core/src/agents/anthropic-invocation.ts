/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  BaseToolInvocation,
  type ToolResult,
  type ToolCallConfirmationDetails,
  type ExecuteOptions,
} from '../tools/tools.js';
import {
  type AgentInputs,
  type AnthropicAgentDefinition,
  type SubagentProgress,
  SubagentState,
} from './types.js';
import { type AgentLoopContext } from '../config/agent-loop-context.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Resolves the user-provided prompt from the loose input record. The agent-tool
 * smart-mapper passes either a single-property object (e.g. `{ prompt: '...' }`
 * or `{ query: '...' }`) or the raw `{ prompt }` fallback. Accept either shape.
 */
function extractPrompt(params: AgentInputs): string {
  const keys = Object.keys(params);
  if (keys.length === 1) {
    const v = params[keys[0]];
    if (typeof v === 'string') return v;
  }
  const fallback = params['prompt'];
  if (typeof fallback === 'string') return fallback;
  throw new Error(
    'Anthropic agent requires a string input (single-property object or { prompt: string }).',
  );
}

/**
 * Tool invocation that proxies to Anthropic's Messages API. Bypasses the local
 * Gemini agent loop entirely: the Claude model is invoked once with the
 * definition's system prompt and the caller's prompt, and the response text
 * becomes the tool result.
 *
 * v0 scope: single-turn, text-only, no tool use within the sub-agent.
 * Streaming is consumed internally but surfaced to `updateOutput` only as
 * progress events (not partial text) so that the result shape matches the
 * other subagent invocations.
 */
export class AnthropicAgentInvocation extends BaseToolInvocation<
  AgentInputs,
  ToolResult
> {
  constructor(
    private readonly definition: AnthropicAgentDefinition,
    _context: AgentLoopContext,
    params: AgentInputs,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(
      params,
      messageBus,
      _toolName ?? definition.name,
      _toolDisplayName ?? definition.displayName,
    );
  }

  getDescription(): string {
    return `Delegating to Anthropic sub-agent '${this.definition.name}' (model: ${this.definition.model})`;
  }

  override async shouldConfirmExecute(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    // v0: no per-call confirmation. The sub-agent only emits text — no local
    // tool execution within the Claude call — so the policy surface is just
    // "is the user OK with this prompt being sent to Anthropic".
    return false;
  }

  async execute(options: ExecuteOptions): Promise<ToolResult> {
    const { abortSignal: signal, updateOutput } = options;

    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      return {
        llmContent: `Error: Anthropic sub-agent '${this.definition.name}' requires ANTHROPIC_API_KEY in the environment.`,
        returnDisplay: `ANTHROPIC_API_KEY not set; cannot invoke '${this.definition.name}'.`,
        error: { message: 'ANTHROPIC_API_KEY not set' },
      };
    }

    const prompt = extractPrompt(this.params);

    if (updateOutput) {
      const initial: SubagentProgress = {
        isSubagentProgress: true,
        agentName: this.definition.name,
        recentActivity: [],
        state: SubagentState.RUNNING,
      };
      updateOutput(initial);
    }

    const client = new Anthropic({ apiKey });

    try {
      const response = await client.messages.create(
        {
          model: this.definition.model,
          max_tokens: this.definition.max_tokens ?? DEFAULT_MAX_TOKENS,
          temperature: this.definition.temperature,
          system: this.definition.system_prompt,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal },
      );

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      if (updateOutput) {
        const done: SubagentProgress = {
          isSubagentProgress: true,
          agentName: this.definition.name,
          recentActivity: [],
          state: SubagentState.COMPLETED,
        };
        updateOutput(done);
      }

      return {
        llmContent: text,
        returnDisplay: text,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = signal?.aborted ?? false;

      if (updateOutput) {
        const endState: SubagentProgress = {
          isSubagentProgress: true,
          agentName: this.definition.name,
          recentActivity: [],
          state: cancelled ? SubagentState.CANCELLED : SubagentState.ERROR,
        };
        updateOutput(endState);
      }

      return {
        llmContent: `Error invoking Anthropic sub-agent '${this.definition.name}': ${message}`,
        returnDisplay: `Anthropic sub-agent error: ${message}`,
        error: { message },
      };
    }
  }
}
