/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview `SwarmStatusTool` — read-only swarm self-discovery tool
 * available to both the orchestrator and spawned sub-agents. Returns the
 * snapshot built by {@link SwarmManager.getSwarmStatusSnapshot}: live
 * sessions (with `role` / `charter`), the shared workspace path, and the
 * most recent spawn/message/release events.
 *
 * Phase 5 of the swarm work. The tool is deliberately
 * {@link Kind.Other} (NOT {@link Kind.Agent}) because spawned sub-agents
 * must be able to see it — the swarm-manager's per-tool filter at
 * `swarm-manager.ts` strips `Kind.Agent` tools to prevent recursive spawn,
 * so a `Kind.Agent` swarm_status would be invisible to sub-agents and
 * defeat the whole point.
 *
 * ## Why a separate tool from `swarm action=list`
 *
 * `swarm action=list` exposes the same `agents[]` data and is gated under
 * `Kind.Agent` (orchestrator-only). Sub-agents need a read-only window
 * into peer state without being granted the spawn/message/release verbs
 * — exposing the full `swarm` tool to sub-agents would re-enable
 * recursion. A dedicated read-only tool keeps the verb surface narrow.
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
import { SwarmManager } from './swarm-manager.js';
import { SWARM_STATUS_TOOL_NAME } from './types.js';

/**
 * The constant is defined in `./types.js` (dependency root) so the manager
 * can reference it without a circular import. Re-exported here for callers
 * that import from the tool module.
 */
export { SWARM_STATUS_TOOL_NAME };
export const SWARM_STATUS_TOOL_DISPLAY_NAME = 'Swarm Status';

// Phase 8 — prefix the orchestrator-side usage hint ("Read-only. Call at
// the start of any non-trivial swarm task.") so the model gets the
// when-to-use signal directly in the tool description.
export const SWARM_STATUS_TOOL_DESCRIPTION =
  'Read-only. Call at the start of any non-trivial swarm task. ' +
  'Returns a snapshot of the current swarm: every live sub-agent ' +
  '(with role/charter), the shared workspace directory path, and ' +
  'up to 50 most-recent spawn/message/release events (newest ' +
  'first). Sub-agents should also call this at the start of any ' +
  'non-trivial task so they know who else is on the team.';

/**
 * Empty JSON schema — `swarm_status` takes no arguments. We keep the
 * `type: 'object'` wrapper (rather than declaring `null`) so the LLM's
 * tool-use formatter has a valid shape to render.
 */
const SWARM_STATUS_JSON_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

/**
 * The `swarm_status` declarative tool. Read-only, no confirmation, no
 * args. Available to both the orchestrator and any spawned sub-agent
 * whose tool whitelist includes `'swarm_status'` (the default).
 */
export class SwarmStatusTool extends BaseDeclarativeTool<
  Record<string, never>,
  ToolResult
> {
  static readonly Name = SWARM_STATUS_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      SWARM_STATUS_TOOL_NAME,
      SWARM_STATUS_TOOL_DISPLAY_NAME,
      SWARM_STATUS_TOOL_DESCRIPTION,
      // NOT Kind.Agent — see file header. Read-only inspection.
      Kind.Other,
      SWARM_STATUS_JSON_SCHEMA,
      messageBus,
      /* isOutputMarkdown */ true,
      /* canUpdateOutput */ false,
    );
  }

  protected override createInvocation(
    params: Record<string, never>,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<Record<string, never>, ToolResult> {
    return new SwarmStatusInvocation(
      params,
      messageBus,
      this.config,
      toolName ?? SWARM_STATUS_TOOL_NAME,
      toolDisplayName ?? SWARM_STATUS_TOOL_DISPLAY_NAME,
    );
  }
}

/**
 * Per-call invocation. Delegates the heavy lifting to
 * {@link SwarmManager.getSwarmStatusSnapshot}; this class only handles
 * tool-result formatting.
 */
export class SwarmStatusInvocation extends BaseToolInvocation<
  Record<string, never>,
  ToolResult
> {
  constructor(
    params: Record<string, never>,
    messageBus: MessageBus,
    private readonly config: Config,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  override getDescription(): string {
    return 'Inspect the current swarm: agents, workspace dir, recent events';
  }

  override async shouldConfirmExecute(
    _signal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    // Pure read-only inspection of in-memory state. No confirmation needed.
    return false;
  }

  override async execute(_options: ExecuteOptions): Promise<ToolResult> {
    // v1.0: we don't pass a `callerAgentId`. The brief allows this
    // fallback ("orchestrator-side calls will have undefined which is
    // fine") and the `MessageBus` doesn't expose its derived name as a
    // public property, so reliably recovering the caller's identity
    // from this side of the seam isn't possible without a wider API
    // change. A future hop (when v1.1 wires `agentId` onto a
    // session-scoped invocation context) can fill this in.
    const manager = SwarmManager.getInstance(this.config);
    const snapshot = manager.getSwarmStatusSnapshot();

    // Compact human display: one line per agent + a trailer summarizing
    // the event ring. The full JSON goes into `llmContent` so the model
    // has the structured payload.
    const agentLines = snapshot.agents.length
      ? snapshot.agents
          .map((a) => {
            const tag = a.role ? ` [${a.role}]` : '';
            return `- ${a.agent_id}${tag} (${a.model}, ${a.status}, turns=${a.turn_count}, idle=${a.seconds_since_active}s)`;
          })
          .join('\n')
      : '- (no active swarm agents)';
    const display =
      `Swarm status\nworkspace: ${snapshot.workspace_dir}\n` +
      `${agentLines}\nrecent events: ${snapshot.recent_events.length}`;

    return {
      llmContent: JSON.stringify(snapshot),
      returnDisplay: display,
    };
  }
}
