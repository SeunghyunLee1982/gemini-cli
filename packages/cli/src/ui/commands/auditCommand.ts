/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview `/audit <agent_id>` slash command — renders the effective
 * tier-2 / tier-3 policy + recent activity for one live swarm sub-agent.
 *
 * Phase 6 of the experimental swarm primitive. See
 * `design-loop/swarm-north-star.md` for the v1.x scope and
 * `design-loop/phase6-impl-brief.md` for the implementation contract.
 */

import { SwarmManager, type PolicyRule } from '@google/gemini-cli-core';
import type { CommandContext, SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';

/** Tag that prefixes every rule line in the rendered output. */
const RULE_PREFIX = '  -';
/** Tag that prefixes every event line in the rendered output. */
const EVENT_PREFIX = '  *';
/** Max number of recent events surfaced per audit. */
const RECENT_EVENT_LIMIT = 20;

function formatRule(rule: PolicyRule): string {
  const pieces: string[] = [
    rule.decision.toUpperCase(),
    `tool=${rule.toolName}`,
  ];
  if (rule.subagent) pieces.push(`subagent=${rule.subagent}`);
  if (rule.argsPattern) pieces.push(`args=${rule.argsPattern.source}`);
  if (rule.priority !== undefined) pieces.push(`prio=${rule.priority}`);
  if (rule.source) pieces.push(`src=${rule.source}`);
  if (rule.name) pieces.push(`name=${rule.name}`);
  return `${RULE_PREFIX} ${pieces.join(' ')}`;
}

export const auditCommand: SlashCommand = {
  name: 'audit',
  description:
    'Render the effective policy + recent activity for one swarm sub-agent. Usage: /audit <agent_id>',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: (context: CommandContext, args: string) => {
    const config = context.services.agentContext?.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not loaded.',
      };
    }

    if (!config.isSwarmEnabled()) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'The experimental swarm primitive is not enabled. Set `experimental.swarm = true` in settings.json.',
      };
    }

    const agentId = args.trim();
    if (!agentId) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Usage: /audit <agent_id>',
      };
    }

    const manager = SwarmManager.getInstance(config);
    const session = manager.getSessionById(agentId);
    if (!session) {
      return {
        type: 'message',
        messageType: 'error',
        content: `No swarm agent named '${agentId}'. Use \`/audit\` after spawning, or check \`swarm list\` for live agent ids.`,
      };
    }

    // Effective policy: rules whose `subagent` matches `agentId` or the
    // workspace-tier wildcard `'*'`. Engine already keeps rules sorted by
    // priority desc, but we re-sort defensively.
    const allRules = config.getPolicyEngine().getRules();
    const scoped: PolicyRule[] = [];
    for (const rule of allRules) {
      if (rule.subagent === agentId || rule.subagent === '*') {
        scoped.push(rule);
      }
    }
    scoped.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    // Recent activity filtered to this agent_id. `getRecentEvents()` already
    // returns the ring buffer reversed (newest-first), so the filter+slice
    // here preserves that ordering — no second reverse needed.
    const events = manager
      .getRecentEvents()
      .filter((e) => e.agent_id === agentId)
      .slice(0, RECENT_EVENT_LIMIT);

    const lines: string[] = [];
    lines.push(`Audit for swarm agent '${agentId}':`);
    lines.push(
      `  status=${session.status} role=${session.role ?? '<none>'} model=${session.model} turns=${session.turnCount}`,
    );
    lines.push('');
    lines.push(`Effective policy (${scoped.length} rule(s)):`);
    if (scoped.length === 0) {
      lines.push('  <no scoped rules; default engine decision applies>');
    } else {
      for (const rule of scoped) {
        lines.push(formatRule(rule));
      }
    }
    lines.push('');
    lines.push(`Recent activity (${events.length} event(s)):`);
    if (events.length === 0) {
      lines.push('  <no recent events>');
    } else {
      for (const event of events) {
        const ts = new Date(event.ts).toISOString();
        const parts = [`${event.action}@${ts}`];
        if (event.turn_count !== undefined) {
          parts.push(`turns=${event.turn_count}`);
        }
        if (event.duration_ms !== undefined) {
          parts.push(`duration_ms=${event.duration_ms}`);
        }
        if (event.error) parts.push(`error=${event.error}`);
        lines.push(`${EVENT_PREFIX} ${parts.join(' ')}`);
      }
    }

    context.ui.addItem(
      { type: MessageType.INFO, text: lines.join('\n') },
      Date.now(),
    );
    return;
  },
};
