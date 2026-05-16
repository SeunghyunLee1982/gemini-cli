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
  ToolConfirmationOutcome,
} from '../tools/tools.js';
import {
  type AgentInputs,
  type AnthropicAgentDefinition,
  type SubagentProgress,
  SubagentState,
  DEFAULT_ANTHROPIC_MAX_TURNS,
  SUBAGENT_REJECTED_ERROR_PREFIX,
} from './types.js';
import { type AgentLoopContext } from '../config/agent-loop-context.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import type { ToolCallRequestInfo } from '../scheduler/types.js';
import { scheduleAgentTools } from './agent-scheduler.js';
import { getToolCallContext } from '../utils/toolCallContext.js';
import {
  convertToAnthropicTools,
  responsePartsToToolResultContent,
  truncateToolOutput,
} from './anthropic-tools.js';
import { debugLogger } from '../utils/debugLogger.js';

const DEFAULT_MAX_TOKENS = 4096;

const SOFT_REJECT_SUFFIX =
  '\n\nIf a tool call is rejected by the user, acknowledge the rejection, ' +
  'rethink your strategy, and try a different approach. Do not repeatedly ' +
  'attempt the same rejected operation.';

/**
 * Coerces an unknown JSON-ish value (Anthropic's `ToolUseBlock.input`) into
 * a `Record<string, unknown>` suitable for the scheduler's `args` bag.
 * Non-object inputs become `{}` rather than throwing.
 */
function toArgsRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = v;
  }
  return out;
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
 * Joins the trailing assistant turn's text blocks. Returns `''` if no
 * assistant turn or no text blocks (Anthropic occasionally returns `[]` for
 * refusals — we don't want to throw).
 */
function finalAssistantText(messages: Anthropic.MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const content = m.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter(
        (b): b is Anthropic.TextBlockParam =>
          typeof b === 'object' && b !== null && b.type === 'text',
      )
      .map((b) => b.text)
      .join('\n');
  }
  return '';
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
      return this.handleTopLevelError(error, signal, updateOutput);
    }
  }

  /**
   * v1 tool-use loop. Isolates a per-invocation tool registry against a
   * derived message bus, runs up to `max_turns` round-trips with Anthropic,
   * and back-propagates tool results keyed by `tool_use_id`.
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
    system += SOFT_REJECT_SUFFIX;

    // -- 5. Loop.
    const client = new Anthropic({ apiKey });
    const maxTurns = this.definition.max_turns ?? DEFAULT_ANTHROPIC_MAX_TURNS;
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: prompt },
    ];

    try {
      for (let turnIdx = 0; turnIdx < maxTurns; turnIdx++) {
        if (signal.aborted) {
          return this.handleTopLevelError(
            new Error('Aborted'),
            signal,
            updateOutput,
          );
        }

        const resp = await client.messages.create(
          {
            model: this.definition.model,
            max_tokens: this.definition.max_tokens ?? DEFAULT_MAX_TOKENS,
            temperature: this.definition.temperature,
            system,
            tools: anthropicTools,
            messages,
          },
          { signal },
        );

        // Always push assistant content unchanged: tool_use blocks must live
        // on the assistant turn that the next tool_result references.
        messages.push({ role: 'assistant', content: resp.content });

        switch (resp.stop_reason) {
          case 'end_turn':
          case 'stop_sequence':
          case 'refusal':
            return this.finish(finalAssistantText(messages), updateOutput);
          case 'max_tokens': {
            const text = finalAssistantText(messages);
            return this.finish(
              text + '\n\n[Note: response truncated by max_tokens.]',
              updateOutput,
            );
          }
          case 'tool_use': {
            const toolUses = resp.content.filter(
              (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
            );
            // Defensive: Anthropic's spec doesn't guarantee tool_use blocks
            // when stop_reason is 'tool_use', and the next-turn user message
            // would be empty content which Anthropic rejects. Treat as end.
            if (toolUses.length === 0) {
              return this.finish(finalAssistantText(messages), updateOutput);
            }
            const resultBlocks = await this.executeToolUses(
              toolUses,
              agentToolRegistry,
              allowSet,
              turnIdx,
              parentCallId,
              signal,
            );
            // Multi-tool-use turn => single user message with N tool_result
            // blocks, each keyed by the matching `tool_use.id`.
            messages.push({ role: 'user', content: resultBlocks });
            continue;
          }
          case 'pause_turn':
          default:
            return this.finish(finalAssistantText(messages), updateOutput);
        }
      }

      // Loop drained without resolution. Return whatever the model last said
      // plus a note so it isn't silently lost.
      return this.finish(
        finalAssistantText(messages) + `\n\n[Note: hit max_turns=${maxTurns}.]`,
        updateOutput,
      );
    } catch (error) {
      return this.handleTopLevelError(error, signal, updateOutput);
    }
  }

  private async executeToolUses(
    toolUses: Anthropic.ToolUseBlock[],
    agentToolRegistry: ToolRegistry,
    allowSet: Set<string>,
    turnIdx: number,
    parentCallId: string | undefined,
    signal: AbortSignal,
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    const promptId = `${this.context.promptId}#anthropic-${turnIdx}`;
    const results = new Array<Anthropic.ToolResultBlockParam | undefined>(
      toolUses.length,
    );

    // Synthesize unauthorized-tool results in-line (no scheduler trip needed).
    const scheduled: Array<{ idx: number; req: ToolCallRequestInfo }> = [];
    for (let i = 0; i < toolUses.length; i++) {
      const block = toolUses[i];
      if (
        !allowSet.has(block.name) ||
        agentToolRegistry.getTool(block.name) === undefined
      ) {
        results[i] = {
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content: `Tool '${block.name}' is not available.`,
        };
        continue;
      }
      // `block.input` is typed `unknown` by the SDK. Anthropic always emits
      // a JSON object here; coerce defensively. The scheduler expects a
      // `Record<string, unknown>` args bag.
      const input = toArgsRecord(block.input);
      scheduled.push({
        idx: i,
        req: {
          callId: block.id,
          name: block.name,
          args: input,
          isClientInitiated: false,
          prompt_id: promptId,
        },
      });
    }

    if (scheduled.length > 0) {
      const completed = await scheduleAgentTools(
        this.context.config,
        scheduled.map((s) => s.req),
        {
          schedulerId: promptId,
          subagent: this.definition.name,
          parentCallId,
          toolRegistry: agentToolRegistry,
          signal,
        },
      );

      // Map by callId for stable ordering — scheduler does not guarantee
      // input/output array alignment for parallel batches.
      const byCallId = new Map<string, (typeof completed)[number]>();
      for (const c of completed) byCallId.set(c.request.callId, c);

      for (const { idx, req } of scheduled) {
        const call = byCallId.get(req.callId);
        if (!call) {
          results[idx] = {
            type: 'tool_result',
            tool_use_id: req.callId,
            is_error: true,
            content: 'Scheduler did not return a result for this tool call.',
          };
          continue;
        }

        if (call.status === 'success') {
          const raw = responsePartsToToolResultContent(
            call.response.responseParts,
          );
          results[idx] = {
            type: 'tool_result',
            tool_use_id: req.callId,
            content: truncateToolOutput(raw) || '(no output)',
          };
          continue;
        }

        if (call.status === 'error') {
          const msg =
            call.response.error?.message ??
            (call.response.error
              ? String(call.response.error)
              : 'Tool failed.');
          results[idx] = {
            type: 'tool_result',
            tool_use_id: req.callId,
            is_error: true,
            content: truncateToolOutput(msg),
          };
          continue;
        }

        // status === 'cancelled'
        if (call.outcome === ToolConfirmationOutcome.Cancel) {
          // Soft reject: feed an error tool_result back and continue.
          results[idx] = {
            type: 'tool_result',
            tool_use_id: req.callId,
            is_error: true,
            content:
              `${SUBAGENT_REJECTED_ERROR_PREFIX} Acknowledge and try a ` +
              `different approach.`,
          };
          continue;
        }

        // Hard abort (Ctrl+C). Propagate so the outer catch returns CANCELLED.
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
    }

    // Every slot is filled by the time we reach here (unauthorized synthesis
    // covers skipped scheduling, success/error/cancel covers everything that
    // went through the scheduler, and hard-abort throws above).
    return results.filter(
      (r): r is Anthropic.ToolResultBlockParam => r !== undefined,
    );
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
