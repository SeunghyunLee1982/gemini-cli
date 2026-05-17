/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Shared Anthropic message-loop primitive.
 *
 * Phase 2 of the swarm work extracts the tool-use loop body out of
 * `AnthropicAgentInvocation.executeWithTools` so that long-lived
 * `SwarmSession` instances can drive an Anthropic conversation turn-by-turn
 * **without rebuilding state**. The single-shot v0 path remains in
 * `AnthropicAgentInvocation`; only the v1 tool-use loop is shared.
 *
 * The function is intentionally:
 * - **Stateless across calls.** State (messages, system prompt, tools, etc.)
 *   is passed in. Callers reuse the same `messages` array across turns to
 *   preserve session memory; the loop mutates it in place.
 * - **Free of `AgentLoopContext`.** Swarm sessions do not have an
 *   `AgentLoopContext` (they outlive the orchestrator turn that spawned
 *   them). The loop takes the minimal explicit dependencies (`config`,
 *   `toolRegistry`, `messageBus`) so both callers can satisfy it.
 *
 * The behavior must remain bit-identical to the original loop body. The
 * single-shot path (`AnthropicAgentInvocation.executeSingleShot`) is NOT
 * routed through here.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config/config.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import type { ToolCallRequestInfo } from '../scheduler/types.js';
import { scheduleAgentTools } from './agent-scheduler.js';
import {
  responsePartsToToolResultContent,
  truncateToolOutput,
} from './anthropic-tools.js';
import { SUBAGENT_REJECTED_ERROR_PREFIX } from './types.js';

/**
 * Suffix appended to the system prompt to instruct the model to handle
 * rejected tool calls gracefully. Mirrors `anthropic-invocation.ts`.
 */
export const ANTHROPIC_LOOP_SOFT_REJECT_SUFFIX =
  '\n\nIf a tool call is rejected by the user, acknowledge the rejection, ' +
  'rethink your strategy, and try a different approach. Do not repeatedly ' +
  'attempt the same rejected operation.';

const DEFAULT_MAX_TOKENS = 4096;

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
 * Joins the trailing assistant turn's text blocks. Returns `''` if no
 * assistant turn or no text blocks (Anthropic occasionally returns `[]` for
 * refusals — we don't want to throw).
 */
export function finalAssistantText(messages: Anthropic.MessageParam[]): string {
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
 * Parameters for {@link runAnthropicMessageLoop}.
 *
 * The caller owns the `messages` array; the loop mutates it in place so the
 * caller's reference reflects the post-turn state. This is the seam that
 * lets `SwarmSession` retain conversation history across turns.
 */
export interface AnthropicLoopParams {
  /** API key used to instantiate the Anthropic client. */
  apiKey: string;
  /** Concrete Anthropic model ID (already resolved from alias). */
  model: string;
  /** Assembled system prompt (caller is responsible for any suffixes). */
  system: string;
  /** Optional temperature. */
  temperature?: number;
  /** Optional max_tokens; defaults to 4096. */
  maxTokens?: number;
  /** Anthropic-formatted tool declarations the model may call. */
  anthropicTools: Anthropic.Tool[];
  /**
   * Mutable conversation history. The loop appends assistant + tool_result
   * messages here. Caller pre-seeds with the user's turn.
   */
  messages: Anthropic.MessageParam[];
  /** Isolated tool registry the scheduler will dispatch into. */
  toolRegistry: ToolRegistry;
  /** Set of advertised tool names; calls outside the set are synthesized rejects. */
  allowSet: Set<string>;
  /** Global config (for scheduler). */
  config: Config;
  /** Turn cap. */
  maxTurns: number;
  /** Abort signal for the Anthropic call and scheduler. */
  signal: AbortSignal;
  /** Stable id used as `prompt_id` prefix for scheduler bookkeeping. */
  schedulerPromptId: string;
  /** Subagent display name passed to the scheduler. */
  subagentName: string;
  /** Optional parent call id for approval-thread linking. */
  parentCallId?: string;
}

/**
 * Result of one {@link runAnthropicMessageLoop} call.
 *
 * Phase 5: previously the loop returned a bare `string` and signaled
 * "max_turns hit" by appending a `[Note: hit max_turns=N.]` suffix to the
 * text. That suffix was load-bearing — the swarm manager needed to know cap
 * was reached so the orchestrator could decide whether to send a follow-up
 * `"continue"` message — but baking it into the user-visible text was both
 * brittle (callers had to substring-match) and noisy (the assistant text
 * always included the marker). The cap signal now lives on the structured
 * `capReached` flag; the suffix is gone for cap, but the `max_tokens`
 * truncation note stays because that one IS user-facing context.
 */
export interface AnthropicLoopResult {
  /** Final assistant text. May still include the max_tokens truncation note. */
  text: string;
  /** True iff the loop exited because it hit `maxTurns` (turn cap). */
  capReached: boolean;
}

/**
 * Drives the Anthropic tool-use loop. Returns the final assistant text plus
 * a structured `capReached` flag.
 *
 * - Mutates `params.messages` in place (caller observes post-turn state).
 * - On `max_turns` exhaustion, returns `{ capReached: true }` so callers
 *   can decide policy (e.g. swarm: surface as `message_turn_cap_reached`
 *   without dirtying the response text). The single-shot Anthropic
 *   invocation simply consumes `.text` and ignores the flag.
 * - On hard abort, throws (caller's try/catch decides how to surface it).
 */
export async function runAnthropicMessageLoop(
  params: AnthropicLoopParams,
): Promise<AnthropicLoopResult> {
  const {
    apiKey,
    model,
    system,
    temperature,
    maxTokens,
    anthropicTools,
    messages,
    toolRegistry,
    allowSet,
    config,
    maxTurns,
    signal,
    schedulerPromptId,
    subagentName,
    parentCallId,
  } = params;

  const client = new Anthropic({ apiKey });

  for (let turnIdx = 0; turnIdx < maxTurns; turnIdx++) {
    if (signal.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }

    const resp = await client.messages.create(
      {
        model,
        max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature,
        system,
        tools: anthropicTools,
        messages,
      },
      { signal },
    );

    // Always push assistant content unchanged: tool_use blocks must live on
    // the assistant turn that the next tool_result references.
    messages.push({ role: 'assistant', content: resp.content });

    switch (resp.stop_reason) {
      case 'end_turn':
      case 'stop_sequence':
      case 'refusal':
        return { text: finalAssistantText(messages), capReached: false };
      case 'max_tokens': {
        const text = finalAssistantText(messages);
        // The max_tokens note is still inline because it really IS part of
        // the assistant's truncated reply — there's nothing else for the
        // user/caller to do with that information at the message-action
        // level. `capReached` only fires for the loop-turn cap.
        return {
          text: text + '\n\n[Note: response truncated by max_tokens.]',
          capReached: false,
        };
      }
      case 'tool_use': {
        const toolUses = resp.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        // Defensive: Anthropic's spec doesn't guarantee tool_use blocks when
        // stop_reason is 'tool_use', and the next-turn user message would
        // be empty content which Anthropic rejects. Treat as end.
        if (toolUses.length === 0) {
          return { text: finalAssistantText(messages), capReached: false };
        }
        const resultBlocks = await executeToolUses({
          toolUses,
          agentToolRegistry: toolRegistry,
          allowSet,
          turnIdx,
          parentCallId,
          signal,
          config,
          subagentName,
          schedulerPromptId,
        });
        messages.push({ role: 'user', content: resultBlocks });
        continue;
      }
      case 'pause_turn':
      default:
        return { text: finalAssistantText(messages), capReached: false };
    }
  }

  // Loop exited because we hit `maxTurns`. The bare assistant text is
  // returned with no suffix; callers can render the cap state from the
  // structured flag (e.g. swarm: `message_turn_cap_reached`).
  return { text: finalAssistantText(messages), capReached: true };
}

interface ExecuteToolUsesParams {
  toolUses: Anthropic.ToolUseBlock[];
  agentToolRegistry: ToolRegistry;
  allowSet: Set<string>;
  turnIdx: number;
  parentCallId: string | undefined;
  signal: AbortSignal;
  config: Config;
  subagentName: string;
  schedulerPromptId: string;
}

/**
 * Schedules a batch of `tool_use` blocks from the model and returns the
 * matching `tool_result` blocks for the next user turn.
 *
 * Behavior mirrors `AnthropicAgentInvocation.executeToolUses` (rev 88972e347):
 * unauthorized tools synthesized in-line, rest scheduled in parallel, each
 * mapped back to its `tool_use_id` so Anthropic's pairing invariant holds.
 */
async function executeToolUses(
  params: ExecuteToolUsesParams,
): Promise<Anthropic.ToolResultBlockParam[]> {
  const {
    toolUses,
    agentToolRegistry,
    allowSet,
    turnIdx,
    parentCallId,
    signal,
    config,
    subagentName,
    schedulerPromptId,
  } = params;

  const promptId = `${schedulerPromptId}#anthropic-${turnIdx}`;
  const results = new Array<Anthropic.ToolResultBlockParam | undefined>(
    toolUses.length,
  );

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
      config,
      scheduled.map((s) => s.req),
      {
        schedulerId: promptId,
        subagent: subagentName,
        parentCallId,
        toolRegistry: agentToolRegistry,
        signal,
      },
    );

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
          (call.response.error ? String(call.response.error) : 'Tool failed.');
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

  return results.filter(
    (r): r is Anthropic.ToolResultBlockParam => r !== undefined,
  );
}
