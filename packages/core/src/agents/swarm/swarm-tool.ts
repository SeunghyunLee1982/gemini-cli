/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview `SwarmTool` — the single declarative tool the orchestrator
 * LLM uses to manage the swarm. Discriminated on `action`.
 *
 * Phase 1: tool class shell + Zod discriminated union schema. The
 * invocation's `execute` throws `unimplemented`. Phase 2 wires the action
 * dispatch into `SwarmManager`.
 *
 * ## Why a single tool with `action`
 *
 * The synthesis chose a single `swarm` tool with a discriminated `action`
 * over three separate tools (spawn / message / release). Rationale captured
 * in `design-loop/swarm-design.md` Turn 1 + Turn 2: tighter logical
 * grouping, less per-tool description overhead, schema can statically
 * surface per-action required fields to the LLM via the discriminated
 * union.
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ExecuteOptions,
  type ToolCallConfirmationDetails,
  type ToolInvocation,
  type ToolResult,
} from '../../tools/tools.js';
import type { MessageBus } from '../../confirmation-bus/message-bus.js';
import type { Config } from '../../config/config.js';
import {
  SwarmActionSchema,
  SwarmErrorCode,
  type SwarmAction,
  type SwarmResult,
} from './types.js';
import { SwarmManager } from './swarm-manager.js';

/**
 * Stable tool name used by the registry, telemetry, and policy rules.
 * Kept distinct from `invoke_agent` so the existing `AgentTool` path is
 * untouched.
 */
export const SWARM_TOOL_NAME = 'swarm';
export const SWARM_TOOL_DISPLAY_NAME = 'Swarm';

/**
 * @deprecated Use `SwarmAction` from `./types.js`. Kept only for downstream
 * import-path stability; identical to {@link SwarmAction}. The duplicate
 * hand-written type that previously lived here was deleted in Phase 2 (see
 * `design-loop/phase1-review-opus.md` #2).
 */
export type SwarmActionParams = SwarmAction;

/**
 * JSON-schema representation of the discriminated union for the LLM tool
 * declaration. Hand-mirrored from `SwarmActionSchema` rather than generated
 * to keep dependencies light and the schema human-readable in PR diffs.
 */
const SWARM_JSON_SCHEMA = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      required: ['action', 'system_prompt'],
      properties: {
        action: { type: 'string', const: 'spawn' },
        kind: { type: 'string', enum: ['anthropic'] },
        model: { type: 'string', enum: ['sonnet', 'opus'] },
        system_prompt: { type: 'string' },
        tools: { type: 'array', items: { type: 'string' } },
        max_turns: { type: 'integer', minimum: 1 },
        display_name: { type: 'string' },
      },
    },
    {
      type: 'object',
      required: ['action', 'agent_id', 'prompt'],
      properties: {
        action: { type: 'string', const: 'message' },
        agent_id: { type: 'string' },
        prompt: { type: 'string' },
      },
    },
    {
      type: 'object',
      required: ['action', 'agent_id'],
      properties: {
        action: { type: 'string', const: 'release' },
        agent_id: { type: 'string' },
      },
    },
    {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', const: 'list' },
      },
    },
  ],
} as const;

const SWARM_TOOL_DESCRIPTION =
  'Manage a persistent swarm of long-lived Claude sub-agents. Use ' +
  '`action: "spawn"` to create a new session (returns an agent_id), ' +
  '`action: "message"` to send a prompt to an existing session (session ' +
  'state is retained across calls), `action: "release"` to terminate a ' +
  'session, and `action: "list"` to enumerate live sessions. Sessions are ' +
  'in-memory and bound to the parent CLI process lifetime.';

/**
 * The `swarm` declarative tool. Phase 1: validates params and returns a
 * `SwarmInvocation` whose `execute()` throws unimplemented. Phase 2 will
 * dispatch through `SwarmManager`.
 */
export class SwarmTool extends BaseDeclarativeTool<
  SwarmActionParams,
  ToolResult
> {
  static readonly Name = SWARM_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      SWARM_TOOL_NAME,
      SWARM_TOOL_DISPLAY_NAME,
      SWARM_TOOL_DESCRIPTION,
      Kind.Agent,
      SWARM_JSON_SCHEMA,
      messageBus,
      /* isOutputMarkdown */ true,
      /* canUpdateOutput */ true,
    );
  }

  protected override createInvocation(
    params: SwarmActionParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<SwarmActionParams, ToolResult> {
    // Phase 1: trust BaseDeclarativeTool's JSON-schema validation. Phase 2
    // will additionally run `SwarmActionSchema.parse(params)` here to get
    // the per-variant narrowing inside the invocation.
    return new SwarmInvocation(
      params,
      messageBus,
      this.config,
      toolName ?? SWARM_TOOL_NAME,
      toolDisplayName ?? SWARM_TOOL_DISPLAY_NAME,
    );
  }
}

/**
 * Per-call invocation of the `swarm` tool. Owns the validated params and
 * the route into `SwarmManager` (Phase 2).
 */
export class SwarmInvocation extends BaseToolInvocation<
  SwarmActionParams,
  ToolResult
> {
  constructor(
    params: SwarmActionParams,
    messageBus: MessageBus,
    private readonly config: Config,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  override getDescription(): string {
    switch (this.params.action) {
      case 'spawn':
        return `Spawn ${this.params.model ?? 'sonnet'} swarm agent`;
      case 'message':
        return `Message swarm agent '${this.params.agent_id}'`;
      case 'release':
        return `Release swarm agent '${this.params.agent_id}'`;
      case 'list':
        return 'List swarm agents';
      default: {
        // Exhaustiveness guard.
        const _exhaustive: never = this.params;
        return `Unknown swarm action: ${JSON.stringify(_exhaustive)}`;
      }
    }
  }

  override async shouldConfirmExecute(
    _signal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    // No per-call confirmation at the swarm-tool boundary. Per-tool
    // confirmations inside spawned sessions go through the standard
    // scheduler modal flow via the session's derived MessageBus, same
    // as anthropic sub-agents today.
    return false;
  }

  override async execute(_options: ExecuteOptions): Promise<ToolResult> {
    // Re-parse via Zod for tight per-variant narrowing inside the dispatch
    // (the JSON-schema check done by `BaseDeclarativeTool` is structural
    // only; Zod gives us the discriminated narrowing for free).
    const parsed = SwarmActionSchema.safeParse(this.params);
    if (!parsed.success) {
      const result: SwarmResult = {
        ok: false,
        error: `Invalid swarm tool arguments: ${parsed.error.message}`,
        code: SwarmErrorCode.INVALID_ARGS,
      };
      return swarmResultToToolResult(result);
    }
    const args = parsed.data;

    const manager = SwarmManager.getInstance(this.config);

    let result: SwarmResult;
    try {
      switch (args.action) {
        case 'spawn':
          result = await manager.spawn(args);
          break;
        case 'message':
          result = await manager.message(args);
          break;
        case 'release':
          result = await manager.release(args);
          break;
        case 'list':
          result = manager.list();
          break;
        default: {
          const _exhaustive: never = args;
          result = {
            ok: false,
            error: `Unknown swarm action: ${JSON.stringify(_exhaustive)}`,
            code: SwarmErrorCode.INVALID_ARGS,
          };
        }
      }
    } catch (err) {
      result = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: SwarmErrorCode.INTERNAL,
      };
    }

    return swarmResultToToolResult(result);
  }
}

/**
 * Renders a {@link SwarmResult} as a {@link ToolResult} suitable for return
 * to the orchestrator. `llmContent` is JSON so the LLM sees stable
 * machine-readable shape; `returnDisplay` is a brief human-friendly summary.
 */
function swarmResultToToolResult(result: SwarmResult): ToolResult {
  const llmContent = JSON.stringify(result);
  let display: string;
  if (!result.ok) {
    display = `swarm error: ${result.error}`;
  } else {
    switch (result.action) {
      case 'spawn':
        display = `Spawned swarm agent '${result.agent_id}'.`;
        break;
      case 'message':
        display = `Swarm '${result.status}': ${result.response.slice(0, 200)}`;
        break;
      case 'release':
        display = result.released
          ? `Released swarm agent.`
          : `No matching swarm agent to release.`;
        break;
      case 'list':
        display =
          result.agents.length === 0
            ? 'No active swarm agents.'
            : result.agents
                .map((a) => `${a.agentId} (${a.model}, ${a.status})`)
                .join('\n');
        break;
      default: {
        const _exhaustive: never = result;
        display = `Unknown swarm result: ${JSON.stringify(_exhaustive)}`;
      }
    }
  }
  return { llmContent, returnDisplay: display };
}

/**
 * Type-only re-exports so callers can pull both runtime + types from
 * `swarm-tool.ts` without reaching into `types.ts` directly.
 */
export type { SwarmAction, SwarmResult };
