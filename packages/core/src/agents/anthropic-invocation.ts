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
  Kind,
} from '../tools/tools.js';
import {
  type AgentInputs,
  type AnthropicAgentDefinition,
  type AnthropicModelAlias,
  type SubagentProgress,
  SubagentState,
  DEFAULT_ANTHROPIC_MAX_TURNS,
} from './types.js';
import { type AgentLoopContext } from '../config/agent-loop-context.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { getToolCallContext } from '../utils/toolCallContext.js';
import { convertToAnthropicTools } from './anthropic-tools.js';
import { debugLogger } from '../utils/debugLogger.js';
import {
  runAnthropicMessageLoop,
  ANTHROPIC_LOOP_SOFT_REJECT_SUFFIX,
} from './anthropic-loop.js';

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Resolves an agent's `model` alias to a concrete Anthropic model ID. The
 * alias surface (`sonnet` / `opus`) is intentionally narrow so that agent
 * definitions never pin a specific model version.
 *
 * **Maintenance policy:** bump these constants whenever Anthropic ships a new
 * sonnet- or opus-tier release. As of 2026-05, the latest models are sonnet
 * 4.6 and opus 4.7. We deliberately do NOT set the `anthropic-beta: context-1m-*`
 * header — matches the Claude Code CLI default behavior, which exposes opus
 * 4.7's 1M context window on the standard endpoint without an opt-in header.
 */
const ANTHROPIC_MODEL_ALIASES: Record<AnthropicModelAlias, string> = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
};

export function resolveAnthropicModel(alias: AnthropicModelAlias): string {
  return ANTHROPIC_MODEL_ALIASES[alias];
}

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
 * Tool invocation that proxies to Anthropic's Messages API.
 *
 * Two paths:
 *
 * - **Single-shot (v0).** `definition.tools` is empty/omitted. One
 *   `messages.create` call, no loop, no tool use. Behavior is bit-identical
 *   to the v0 implementation (commit 252202449) — backward compatibility is
 *   load-bearing for existing markdown agent files.
 * - **Tool-use loop (v1).** `definition.tools` lists Gemini tool names the
 *   sub-agent is allowed to call. We build an isolated `ToolRegistry` with
 *   a derived `MessageBus` (so subagent activity attributes correctly to
 *   the right name in the TUI), convert the filtered declarations to
 *   Anthropic `Tool` shape, and run a turn-capped loop. On each `tool_use`
 *   stop reason, we execute the tool calls in parallel via the standard
 *   scheduler, then feed `tool_result` blocks back keyed by `tool_use_id`.
 *
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
    private readonly context: AgentLoopContext,
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
    // v0/v1: no per-call confirmation at the sub-agent boundary. Per-tool
    // confirmations inside the loop are handled by the standard scheduler
    // modal flow (via the derived MessageBus), same as local agents.
    return false;
  }

  async execute(options: ExecuteOptions): Promise<ToolResult> {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      return {
        llmContent: `Error: Anthropic sub-agent '${this.definition.name}' requires ANTHROPIC_API_KEY in the environment.`,
        returnDisplay: `ANTHROPIC_API_KEY not set; cannot invoke '${this.definition.name}'.`,
        error: { message: 'ANTHROPIC_API_KEY not set' },
      };
    }

    const tools = this.definition.tools;
    if (!tools || tools.length === 0) {
      return this.executeSingleShot(apiKey, options);
    }
    return this.executeWithTools(apiKey, tools, options);
  }

  /**
   * v0 single-shot path. Preserved verbatim from commit 252202449 so existing
   * markdown agent files (no `tools` field) keep working bit-identically.
   */
  private async executeSingleShot(
    apiKey: string,
    options: ExecuteOptions,
  ): Promise<ToolResult> {
    const { abortSignal: signal, updateOutput } = options;
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
          model: resolveAnthropicModel(this.definition.model),
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
      return this.handleTopLevelError(error, signal, updateOutput);
    }
  }

  /**
   * v1 tool-use loop. Isolates a per-invocation tool registry against a
   * derived message bus, then delegates to the shared
   * {@link runAnthropicMessageLoop} primitive so `SwarmSession` can reuse
   * the same body across persistent turns.
   */
  private async executeWithTools(
    apiKey: string,
    allowedToolNames: string[],
    options: ExecuteOptions,
  ): Promise<ToolResult> {
    const { abortSignal: signal, updateOutput } = options;
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

    // -- 1. Build the isolated tool registry. Mirrors local-executor.ts:164-205.
    const parentBus = this.context.messageBus;
    const subagentBus = parentBus.derive(this.definition.name);
    const agentToolRegistry = new ToolRegistry(
      this.context.config,
      subagentBus,
    );
    const allowSet = new Set<string>();
    for (const name of allowedToolNames) {
      const tool = this.context.toolRegistry.getTool(name);
      // Skip unknown tools and agent-as-tool entries (no nested sub-agents).
      if (!tool || tool.kind === Kind.Agent) continue;
      agentToolRegistry.registerTool(tool.clone(subagentBus));
      allowSet.add(name);
    }
    agentToolRegistry.sortTools();

    // -- 2. Build the Anthropic Tool[] from the isolated registry.
    const decls = agentToolRegistry.getFunctionDeclarationsFiltered(
      Array.from(allowSet),
      // Anthropic models don't participate in Gemini's modelId-specific
      // schema overrides; pass undefined and let tools return their base
      // declarations.
      undefined,
    );
    const anthropicTools = convertToAnthropicTools(decls);

    // -- 3. Parent call ID for approval-thread linking.
    const parentCallId = getToolCallContext()?.callId;

    // -- 4. System prompt assembly. Append-only; never replace. Advertise only
    // tools actually present in `allowSet` (filtered: known + non-Kind.Agent),
    // never the raw allowlist — otherwise Claude could try to call a tool that
    // isn't registered and waste a turn on the unauthorized-synth path.
    let system = this.definition.system_prompt;
    const advertisedTools = Array.from(allowSet);
    if (advertisedTools.length > 0) {
      system +=
        `\n\nYou have access to the following tools: ` +
        `${advertisedTools.join(', ')}. Use them as needed.`;
    }
    system += ANTHROPIC_LOOP_SOFT_REJECT_SUFFIX;

    // -- 5. Delegate to the shared loop.
    const maxTurns = this.definition.max_turns ?? DEFAULT_ANTHROPIC_MAX_TURNS;
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: prompt },
    ];

    try {
      const text = await runAnthropicMessageLoop({
        apiKey,
        model: resolveAnthropicModel(this.definition.model),
        system,
        temperature: this.definition.temperature,
        maxTokens: this.definition.max_tokens ?? DEFAULT_MAX_TOKENS,
        anthropicTools,
        messages,
        toolRegistry: agentToolRegistry,
        allowSet,
        config: this.context.config,
        maxTurns,
        signal,
        schedulerPromptId: this.context.promptId,
        subagentName: this.definition.name,
        parentCallId,
      });
      return this.finish(text, updateOutput);
    } catch (error) {
      return this.handleTopLevelError(error, signal, updateOutput);
    }
  }

  private finish(
    text: string,
    updateOutput?: (progress: SubagentProgress) => void,
  ): ToolResult {
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
  }

  private handleTopLevelError(
    error: unknown,
    signal: AbortSignal | undefined,
    updateOutput?: (progress: SubagentProgress) => void,
  ): ToolResult {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled =
      (signal?.aborted ?? false) ||
      (error instanceof Error && error.name === 'AbortError');

    if (updateOutput) {
      const endState: SubagentProgress = {
        isSubagentProgress: true,
        agentName: this.definition.name,
        recentActivity: [],
        state: cancelled ? SubagentState.CANCELLED : SubagentState.ERROR,
      };
      updateOutput(endState);
    }

    debugLogger.warn(
      `[AnthropicAgentInvocation] '${this.definition.name}' failed:`,
      error,
    );

    return {
      llmContent: `Error invoking Anthropic sub-agent '${this.definition.name}': ${message}`,
      returnDisplay: `Anthropic sub-agent error: ${message}`,
      error: { message },
    };
  }
}
