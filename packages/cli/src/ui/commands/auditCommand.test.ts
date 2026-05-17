/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Tests for `/audit <agent_id>` slash command (Phase 6).
 *
 * The command renders the effective policy + recent activity for one live
 * swarm sub-agent. These tests verify two behaviors:
 *   1. Auditing a non-existent agent surfaces a user-facing error.
 *   2. Auditing a live agent emits an INFO history item whose text contains
 *      both the matching policy rule and at least one recent activity line.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { auditCommand } from './auditCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { Config } from '@google/gemini-cli-core';
import { MessageType } from '../types.js';

// Mock the SwarmManager singleton at the module boundary so we can stage
// arbitrary `getSessionById` / `getRecentEvents` / engine results without
// spinning up the real manager (which would need a Config, abort signal,
// storage, etc.).
const mockManager = {
  getSessionById: vi.fn(),
  getRecentEvents: vi.fn(),
  computeEffectivePolicySummary: vi.fn(),
};
const mockPolicyEngine = {
  getRules: vi.fn(),
};

vi.mock('@google/gemini-cli-core', async () => {
  const actual = await vi.importActual<
    typeof import('@google/gemini-cli-core')
  >('@google/gemini-cli-core');
  return {
    ...actual,
    SwarmManager: {
      getInstance: () => mockManager,
    },
  };
});

function makeConfig(): Config {
  return {
    isSwarmEnabled: () => true,
    getPolicyEngine: () => mockPolicyEngine,
  } as unknown as Config;
}

function makeContext(config: Config | null = makeConfig()) {
  return createMockCommandContext({
    services: {
      agentContext:
        config === null ? null : ({ config } as unknown as { config: Config }),
    },
  });
}

describe('auditCommand (Phase 6)', () => {
  beforeEach(() => {
    mockManager.getSessionById.mockReset();
    mockManager.getRecentEvents.mockReset();
    mockManager.computeEffectivePolicySummary.mockReset();
    mockPolicyEngine.getRules.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns an error when no agent_id is supplied', async () => {
    const ctx = makeContext();
    const result = await auditCommand.action!(ctx, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Usage: /audit <agent_id>',
    });
  });

  it('returns an error when the agent_id does not match any live session', async () => {
    mockManager.getSessionById.mockReturnValue(undefined);
    const ctx = makeContext();
    const result = await auditCommand.action!(ctx, 'ghost');
    expect(result).toBeDefined();
    if (!result || result.type !== 'message') throw new Error('expected msg');
    expect(result.messageType).toBe('error');
    expect(result.content).toContain("No swarm agent named 'ghost'");
  });

  it('renders policy rules + recent events for a live agent_id', async () => {
    const agentId = 'sonnet-1';
    mockManager.getSessionById.mockReturnValue({
      agentId,
      status: 'idle',
      model: 'sonnet',
      turnCount: 2,
      role: 'reviewer',
    });
    mockPolicyEngine.getRules.mockReturnValue([
      {
        toolName: 'shell',
        decision: 'deny',
        subagent: agentId,
        priority: 2.0,
        source: `swarm:${agentId}:spawn`,
        denyMessage: 'no shell here',
      },
      {
        toolName: 'glob',
        decision: 'allow',
        subagent: '*',
        priority: 3.0,
        source: 'Workspace: swarm-policy.toml',
      },
      // This rule is for a DIFFERENT agent — must be filtered out.
      {
        toolName: 'read_file',
        decision: 'allow',
        subagent: 'opus-1',
        priority: 2.0,
        source: 'swarm:opus-1:spawn',
      },
    ]);
    mockManager.getRecentEvents.mockReturnValue([
      {
        ts: Date.UTC(2026, 4, 17, 12, 0, 0),
        action: 'spawn',
        agent_id: agentId,
      },
      {
        ts: Date.UTC(2026, 4, 17, 12, 5, 0),
        action: 'message',
        agent_id: agentId,
        turn_count: 1,
        duration_ms: 1234,
      },
      // Unrelated agent — must be filtered out.
      {
        ts: Date.UTC(2026, 4, 17, 12, 6, 0),
        action: 'message',
        agent_id: 'opus-1',
        turn_count: 4,
      },
    ]);

    const ctx = makeContext();
    await auditCommand.action!(ctx, agentId);

    expect(ctx.ui.addItem).toHaveBeenCalledTimes(1);
    const call = (ctx.ui.addItem as ReturnType<typeof vi.fn>).mock.calls[0];
    const item = call[0] as { type: MessageType; text: string };
    expect(item.type).toBe(MessageType.INFO);
    expect(item.text).toContain(`Audit for swarm agent '${agentId}'`);
    // Effective policy: 2 scoped rules (this agent + wildcard), NOT 3.
    expect(item.text).toContain('Effective policy (2 rule(s))');
    expect(item.text).toContain('shell');
    expect(item.text).toContain('glob');
    expect(item.text).not.toContain('opus-1');
    // Recent activity: 2 events (filtered).
    expect(item.text).toContain('Recent activity (2 event(s))');
    expect(item.text).toContain('spawn@');
    expect(item.text).toContain('message@');
  });
});
