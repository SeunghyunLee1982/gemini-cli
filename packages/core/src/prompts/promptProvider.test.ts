/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PromptProvider } from './promptProvider.js';
import type { Config } from '../config/config.js';
import { makeRelative } from '../utils/paths.js';
import {
  getAllGeminiMdFilenames,
  DEFAULT_CONTEXT_FILENAME,
} from '../tools/memoryTool.js';
import {
  PREVIEW_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL,
} from '../config/models.js';
import { ApprovalMode } from '../policy/types.js';
import { DiscoveredMCPTool } from '../tools/mcp-tool.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { UPDATE_TOPIC_TOOL_NAME } from '../tools/tool-names.js';
import { SWARM_TOOL_NAME } from '../agents/swarm/swarm-tool.js';
import { SWARM_STATUS_TOOL_NAME } from '../agents/swarm/types.js';
import { TopicState } from '../config/topicState.js';
import type { CallableTool } from '@google/genai';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { SkillDefinition } from '../skills/skillManager.js';
import { renderSwarmInline } from './snippets.js';

vi.mock('../tools/memoryTool.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    getAllGeminiMdFilenames: vi.fn(),
  };
});

vi.mock('../utils/gitUtils', () => ({
  isGitRepository: vi.fn().mockReturnValue(false),
}));

describe('PromptProvider', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('GEMINI_SYSTEM_MD', '');
    vi.stubEnv('GEMINI_WRITE_SYSTEM_MD', '');

    const mockToolRegistry = {
      getAllToolNames: vi.fn().mockReturnValue([]),
      getAllTools: vi.fn().mockReturnValue([]),
    };
    mockConfig = {
      get config() {
        return this as unknown as Config;
      },
      get toolRegistry() {
        return (
          this as { getToolRegistry: () => ToolRegistry }
        ).getToolRegistry?.() as unknown as ToolRegistry;
      },
      getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
      getProjectRoot: vi.fn().mockReturnValue('/tmp/project-temp'),
      topicState: new TopicState(),
      getEnableShellOutputEfficiency: vi.fn().mockReturnValue(true),
      getSandboxEnabled: vi.fn().mockReturnValue(false),
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue('/tmp/project-temp'),
        getPlansDir: vi.fn().mockReturnValue('/tmp/project-temp/plans'),
        getProjectMemoryDir: vi
          .fn()
          .mockReturnValue('/tmp/project-temp/memory'),
        getProjectTempTrackerDir: vi
          .fn()
          .mockReturnValue('/tmp/project-temp/tracker'),
      },
      isInteractive: vi.fn().mockReturnValue(true),
      isInteractiveShellEnabled: vi.fn().mockReturnValue(true),
      isTopicUpdateNarrationEnabled: vi.fn().mockReturnValue(false),
      getSkillManager: vi.fn().mockReturnValue({
        getSkills: vi.fn().mockReturnValue([]),
      }),
      getActiveModel: vi.fn().mockReturnValue(PREVIEW_GEMINI_MODEL),
      getAgentRegistry: vi.fn().mockReturnValue({
        getAllDefinitions: vi.fn().mockReturnValue([]),
        getDefinition: vi.fn().mockReturnValue(undefined),
      }),
      getApprovedPlanPath: vi.fn().mockReturnValue(undefined),
      getApprovalMode: vi.fn(),
      isTrackerEnabled: vi.fn().mockReturnValue(false),
      getHasAccessToPreviewModel: vi.fn().mockReturnValue(true),
      getGemini31LaunchedSync: vi.fn().mockReturnValue(true),
    } as unknown as Config;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should handle multiple context filenames in the system prompt', () => {
    vi.mocked(getAllGeminiMdFilenames).mockReturnValue([
      DEFAULT_CONTEXT_FILENAME,
      'CUSTOM.md',
      'ANOTHER.md',
    ]);

    const provider = new PromptProvider();
    const prompt = provider.getCoreSystemPrompt(mockConfig);

    // Verify renderCoreMandates usage
    expect(prompt).toContain(
      `Instructions found in \`${DEFAULT_CONTEXT_FILENAME}\`, \`CUSTOM.md\` or \`ANOTHER.md\` files are foundational mandates.`,
    );
  });

  it('should include the task tracker storage location in the system prompt', () => {
    vi.mocked(mockConfig.isTrackerEnabled).mockReturnValue(true);
    const mockTrackerDir = '/mock/tracker/path';
    vi.mocked(mockConfig.storage.getProjectTempTrackerDir).mockReturnValue(
      mockTrackerDir,
    );

    const provider = new PromptProvider();
    const prompt = provider.getCoreSystemPrompt(mockConfig);

    expect(prompt).toContain('# TASK MANAGEMENT PROTOCOL');
    expect(prompt).toContain(`located at \`${mockTrackerDir}\``);
  });

  it('should sanitize the task tracker storage location in the system prompt', () => {
    vi.mocked(mockConfig.isTrackerEnabled).mockReturnValue(true);
    const mockTrackerDir = '/mock/tracker/path\nwith-newline]and-bracket';
    vi.mocked(mockConfig.storage.getProjectTempTrackerDir).mockReturnValue(
      mockTrackerDir,
    );

    const provider = new PromptProvider();
    const prompt = provider.getCoreSystemPrompt(mockConfig);

    expect(prompt).toContain('# TASK MANAGEMENT PROTOCOL');
    expect(prompt).toContain(
      'located at `/mock/tracker/path with-newlineand-bracket`',
    );
  });

  it('should handle multiple context filenames in user memory section', () => {
    vi.mocked(getAllGeminiMdFilenames).mockReturnValue([
      DEFAULT_CONTEXT_FILENAME,
      'CUSTOM.md',
    ]);

    const provider = new PromptProvider();
    const prompt = provider.getCoreSystemPrompt(
      mockConfig,
      'Some memory content',
    );

    // Verify renderUserMemory usage
    expect(prompt).toContain(
      `# Contextual Instructions (${DEFAULT_CONTEXT_FILENAME}, CUSTOM.md)`,
    );
  });

  describe('plan mode prompt', () => {
    const mockMessageBus = {
      publish: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    } as unknown as MessageBus;

    beforeEach(() => {
      vi.mocked(getAllGeminiMdFilenames).mockReturnValue([
        DEFAULT_CONTEXT_FILENAME,
      ]);
      (mockConfig.getApprovalMode as ReturnType<typeof vi.fn>).mockReturnValue(
        ApprovalMode.PLAN,
      );
    });

    it('should list all active tools from ToolRegistry in plan mode prompt', () => {
      const mockTools = [
        new MockTool({ name: 'glob', displayName: 'Glob' }),
        new MockTool({ name: 'read_file', displayName: 'ReadFile' }),
        new MockTool({ name: 'write_file', displayName: 'WriteFile' }),
        new MockTool({ name: 'replace', displayName: 'Replace' }),
      ];
      (mockConfig.getToolRegistry as ReturnType<typeof vi.fn>).mockReturnValue({
        getAllToolNames: vi.fn().mockReturnValue(mockTools.map((t) => t.name)),
        getAllTools: vi.fn().mockReturnValue(mockTools),
      });

      const provider = new PromptProvider();
      const prompt = provider.getCoreSystemPrompt(mockConfig);

      expect(prompt).toContain('`glob`');
      expect(prompt).toContain('`read_file`');
      expect(prompt).toContain('`write_file`');
      expect(prompt).toContain('`replace`');
    });

    it('should show server name for MCP tools in plan mode prompt', () => {
      const mcpTool = new DiscoveredMCPTool(
        {} as CallableTool,
        'my-mcp-server',
        'mcp_read',
        'An MCP read tool',
        {},
        mockMessageBus,
        undefined,
        true,
      );
      const mockTools = [
        new MockTool({ name: 'glob', displayName: 'Glob' }),
        mcpTool,
      ];
      (mockConfig.getToolRegistry as ReturnType<typeof vi.fn>).mockReturnValue({
        getAllToolNames: vi.fn().mockReturnValue(mockTools.map((t) => t.name)),
        getAllTools: vi.fn().mockReturnValue(mockTools),
      });

      const provider = new PromptProvider();
      const prompt = provider.getCoreSystemPrompt(mockConfig);

      expect(prompt).toContain('`mcp_my-mcp-server_mcp_read` (my-mcp-server)');
    });

    it('should include write constraint message in plan mode prompt', () => {
      const mockTools = [
        new MockTool({ name: 'glob', displayName: 'Glob' }),
        new MockTool({ name: 'write_file', displayName: 'WriteFile' }),
        new MockTool({ name: 'replace', displayName: 'Replace' }),
      ];
      (mockConfig.getToolRegistry as ReturnType<typeof vi.fn>).mockReturnValue({
        getAllToolNames: vi.fn().mockReturnValue(mockTools.map((t) => t.name)),
        getAllTools: vi.fn().mockReturnValue(mockTools),
      });

      const provider = new PromptProvider();
      const prompt = provider.getCoreSystemPrompt(mockConfig);

      expect(prompt).toContain(
        '`write_file` and `replace` may ONLY be used to write .md plan files',
      );

      const expectedRelativePath = makeRelative(
        mockConfig.storage.getPlansDir(),
        mockConfig.getProjectRoot(),
      ).replaceAll('\\', '/');
      expect(prompt).toContain(
        `write .md plan files to \`${expectedRelativePath}/\``,
      );
    });
  });

  describe('getCompressionPrompt', () => {
    it('should include plan preservation instructions when an approved plan path is provided', () => {
      const planPath = '/path/to/plan.md';
      (
        mockConfig.getApprovedPlanPath as ReturnType<typeof vi.fn>
      ).mockReturnValue(planPath);

      const provider = new PromptProvider();
      const prompt = provider.getCompressionPrompt(mockConfig);

      expect(prompt).toContain('### APPROVED PLAN PRESERVATION');
      expect(prompt).toContain(planPath);

      // Verify it's BEFORE the structure example
      const structureMarker = 'The structure MUST be as follows:';
      const planPreservationMarker = '### APPROVED PLAN PRESERVATION';

      const structureIndex = prompt.indexOf(structureMarker);
      const planPreservationIndex = prompt.indexOf(planPreservationMarker);

      expect(planPreservationIndex).toBeGreaterThan(-1);
      expect(structureIndex).toBeGreaterThan(-1);
      expect(planPreservationIndex).toBeLessThan(structureIndex);
    });

    it('should NOT include plan preservation instructions when no approved plan path is provided', () => {
      (
        mockConfig.getApprovedPlanPath as ReturnType<typeof vi.fn>
      ).mockReturnValue(undefined);

      const provider = new PromptProvider();
      const prompt = provider.getCompressionPrompt(mockConfig);

      expect(prompt).not.toContain('### APPROVED PLAN PRESERVATION');
    });
  });

  describe('topicUpdateNarrationOverride', () => {
    let provider: PromptProvider;

    beforeEach(() => {
      provider = new PromptProvider();
      mockConfig.topicState.reset();
      (mockConfig.getToolRegistry as ReturnType<typeof vi.fn>).mockReturnValue({
        getAllToolNames: vi.fn().mockReturnValue([UPDATE_TOPIC_TOOL_NAME]),
      });
      (mockConfig.getAgentRegistry as ReturnType<typeof vi.fn>).mockReturnValue(
        {
          getAllDefinitions: vi.fn().mockReturnValue([]),
          getDefinition: vi.fn().mockReturnValue(undefined),
        },
      );
    });

    it('should disable topic update narration when override is false, even if config is true', () => {
      vi.mocked(mockConfig.isTopicUpdateNarrationEnabled).mockReturnValue(true);

      const prompt = provider.getCoreSystemPrompt(
        mockConfig as unknown as Config,
        /*userMemory=*/ undefined,
        /*interactiveOverride=*/ undefined,
        /*topicUpdateNarrationOverride=*/ false,
      );

      expect(prompt).not.toContain(
        `As you work, the user follows along by reading topic updates that you publish with ${UPDATE_TOPIC_TOOL_NAME}.`,
      );
    });

    it('should enable topic update narration when override is true, even if config is false', () => {
      vi.mocked(mockConfig.isTopicUpdateNarrationEnabled).mockReturnValue(
        false,
      );

      const prompt = provider.getCoreSystemPrompt(
        mockConfig as unknown as Config,
        /*userMemory=*/ undefined,
        /*interactiveOverride=*/ undefined,
        /*topicUpdateNarrationOverride=*/ true,
      );

      expect(prompt).toContain(
        `As you work, the user follows along by reading topic updates that you publish with ${UPDATE_TOPIC_TOOL_NAME}.`,
      );
    });
  });

  describe('Topic & Update Narration', () => {
    beforeEach(() => {
      mockConfig.topicState.reset();
      vi.mocked(mockConfig.isTopicUpdateNarrationEnabled).mockReturnValue(true);
      (mockConfig.getToolRegistry as ReturnType<typeof vi.fn>).mockReturnValue({
        getAllToolNames: vi.fn().mockReturnValue([UPDATE_TOPIC_TOOL_NAME]),
        getAllTools: vi.fn().mockReturnValue([
          new MockTool({
            name: UPDATE_TOPIC_TOOL_NAME,
            displayName: 'Topic',
          }),
        ]),
      });
      vi.mocked(mockConfig.getHasAccessToPreviewModel).mockReturnValue(true);
      vi.mocked(mockConfig.getGemini31LaunchedSync).mockReturnValue(true);
    });

    it('should include active topic context when narration is enabled', () => {
      mockConfig.topicState.setTopic('Active Chapter');
      const provider = new PromptProvider();
      const prompt = provider.getCoreSystemPrompt(mockConfig);

      expect(prompt).toContain('[Active Topic: Active Chapter]');
    });

    it('should NOT include active topic context when narration is disabled', () => {
      vi.mocked(mockConfig.isTopicUpdateNarrationEnabled).mockReturnValue(
        false,
      );
      mockConfig.topicState.setTopic('Active Chapter');
      const provider = new PromptProvider();
      const prompt = provider.getCoreSystemPrompt(mockConfig);

      expect(prompt).not.toContain('[Active Topic: Active Chapter]');
    });

    it('should filter out update_topic tool when narration is disabled', () => {
      vi.mocked(mockConfig.getApprovalMode).mockReturnValue(ApprovalMode.PLAN);
      vi.mocked(mockConfig.isTopicUpdateNarrationEnabled).mockReturnValue(
        false,
      );
      // Simulate registry behavior where it filters out update_topic
      vi.mocked(mockConfig.getToolRegistry().getAllToolNames).mockReturnValue(
        [],
      );
      vi.mocked(mockConfig.getToolRegistry().getAllTools).mockReturnValue([]);

      const provider = new PromptProvider();

      const prompt = provider.getCoreSystemPrompt(mockConfig);
      expect(prompt).not.toContain(UPDATE_TOPIC_TOOL_NAME);
    });

    it('should NOT filter out update_topic tool when narration is enabled', () => {
      vi.mocked(mockConfig.getApprovalMode).mockReturnValue(ApprovalMode.PLAN);
      vi.mocked(mockConfig.isTopicUpdateNarrationEnabled).mockReturnValue(true);
      const provider = new PromptProvider();
      const prompt = provider.getCoreSystemPrompt(mockConfig);

      expect(prompt).toContain(`<tool>\`${UPDATE_TOPIC_TOOL_NAME}\`</tool>`);
    });

    it('should include topic update instructions in legacy model prompt when enabled', () => {
      vi.mocked(mockConfig.getActiveModel).mockReturnValue(
        DEFAULT_GEMINI_MODEL,
      );
      vi.mocked(mockConfig.isTopicUpdateNarrationEnabled).mockReturnValue(true);

      const provider = new PromptProvider();
      const prompt = provider.getCoreSystemPrompt(mockConfig);

      expect(prompt).toContain('## Topic Updates');
      expect(prompt).toContain(UPDATE_TOPIC_TOOL_NAME);
      expect(prompt).toContain('No Chitchat');
      expect(prompt).toContain('Topic Model');
    });
  });

  // Phase 8 — orchestrator disposition + swarm-collaboration auto-inline.
  // See `design-loop/swarm-orchestrator-disposition.md`. The two layers
  // share the same gate: `Config.isSwarmEnabled()` AND a registered swarm
  // tool. When the gate fires:
  //   * `renderSwarmDisposition` block appears in the system prompt
  //   * the `swarm-collaboration` skill body is auto-inlined and the
  //     skill is dropped from the regular `<available_skills>` manifest.
  describe('Phase 8 — orchestrator disposition + swarm skill auto-inline', () => {
    // Tiny SKILL.md body sentinel. Keeping it short — long enough to be
    // recognizable in the output, short enough not to bloat assertions.
    const SWARM_SKILL_BODY = 'SWARM-PROTOCOL-BODY-SENTINEL-Phase8-test';
    const swarmCollab: SkillDefinition = {
      name: 'swarm-collaboration',
      description: 'Codifies the swarm cross-pollination protocol.',
      location: '/fake/.gemini/skills/swarm-collaboration/SKILL.md',
      body: SWARM_SKILL_BODY,
    };
    const otherSkill: SkillDefinition = {
      name: 'unrelated-skill',
      description: 'Has nothing to do with swarm.',
      location: '/fake/.gemini/skills/unrelated-skill/SKILL.md',
      body: 'unrelated body',
    };

    function setupSwarmEnabled(enabled: boolean): void {
      // Inject the swarm tool name into the registered-tools set so the
      // `swarmToolRegistered` predicate in `PromptProvider` fires (or
      // doesn't, when we want the negative case).
      (mockConfig.getToolRegistry as ReturnType<typeof vi.fn>).mockReturnValue({
        getAllToolNames: vi
          .fn()
          .mockReturnValue(enabled ? [SWARM_TOOL_NAME] : []),
        getAllTools: vi.fn().mockReturnValue([]),
      });
      (mockConfig.getSkillManager as ReturnType<typeof vi.fn>).mockReturnValue({
        getSkills: vi.fn().mockReturnValue([swarmCollab, otherSkill]),
      });
      // `isSwarmEnabled` is the second half of the AND-gate.
      (
        mockConfig as unknown as { isSwarmEnabled: () => boolean }
      ).isSwarmEnabled = vi.fn().mockReturnValue(enabled);
    }

    it('Phase 8 — renderSwarmDisposition included when swarm enabled', () => {
      setupSwarmEnabled(true);
      const provider = new PromptProvider();
      const prompt = provider.getCoreSystemPrompt(mockConfig);

      // Header phrase from the locked block.
      expect(prompt).toContain('# Swarm (experimental, enabled)');
      // Core anti-pattern phrasing (matches the locked text).
      expect(prompt).toContain('no CLI verb');
      // The worked example must be there (single inline `<example>` per
      // the LOCKED design Q3).
      expect(prompt).toContain('<example>');
    });

    it('Phase 8 — renderSwarmDisposition excluded when swarm disabled', () => {
      setupSwarmEnabled(false);
      const provider = new PromptProvider();
      const prompt = provider.getCoreSystemPrompt(mockConfig);

      expect(prompt).not.toContain('# Swarm (experimental, enabled)');
    });

    it('Phase 8 — swarm-collaboration auto-inlined when swarm enabled', () => {
      setupSwarmEnabled(true);
      const provider = new PromptProvider();
      const prompt = provider.getCoreSystemPrompt(mockConfig);

      // Inline heading + body sentinel must appear in the body of the
      // prompt.
      expect(prompt).toContain('# Skill — swarm-collaboration (auto-loaded)');
      expect(prompt).toContain(SWARM_SKILL_BODY);

      // And the same skill must NOT also appear in the regular
      // `<available_skills>` manifest, or the orchestrator would see it
      // twice. The unrelated skill should still appear in the manifest.
      const manifestMatches = prompt.match(
        /<skill>\s*<name>swarm-collaboration<\/name>/g,
      );
      expect(manifestMatches).toBeNull();
      expect(prompt).toContain('<name>unrelated-skill</name>');
    });

    it('Phase 8 — swarm-collaboration appears in manifest when swarm disabled', () => {
      setupSwarmEnabled(false);
      const provider = new PromptProvider();
      const prompt = provider.getCoreSystemPrompt(mockConfig);

      // No auto-inline.
      expect(prompt).not.toContain(
        '# Skill — swarm-collaboration (auto-loaded)',
      );
      // Lives in the regular manifest instead.
      expect(prompt).toContain('<name>swarm-collaboration</name>');
    });

    // Phase 8 review (Gemini angle 3): renderSwarmInline must not emit a
    // dangling `# Skill — <name> (auto-loaded)` header when the skill body
    // is empty or whitespace-only. Guards against future skill loaders
    // returning empty `body` (deleted file, parse failure, etc.) silently
    // bloating the prompt with a header and nothing beneath it.
    it('Phase 8 — renderSwarmInline returns empty string for whitespace-only body', () => {
      expect(renderSwarmInline({ name: 'swarm-collaboration', body: '' })).toBe(
        '',
      );
      expect(
        renderSwarmInline({ name: 'swarm-collaboration', body: '   \n\n  ' }),
      ).toBe('');
      // Non-empty body still renders.
      expect(
        renderSwarmInline({
          name: 'swarm-collaboration',
          body: 'real content',
        }),
      ).toContain('# Skill — swarm-collaboration (auto-loaded)');
    });

    // Phase 8 review (Opus angle 3): the registered-tool predicate is the OR
    // of `SWARM_TOOL_NAME` ∨ `SWARM_STATUS_TOOL_NAME`. The earlier tests
    // only cover the `swarm`-registered branch. This case pins the
    // asymmetric "only `swarm_status` registered, not `swarm`" branch — the
    // disposition + inline must still fire because sub-agents themselves
    // get `swarm_status` registered without `swarm` (recursion guard,
    // `swarm-manager.ts` filter).
    it('Phase 8 — disposition fires when only swarm_status is registered', () => {
      (mockConfig.getToolRegistry as ReturnType<typeof vi.fn>).mockReturnValue({
        getAllToolNames: vi.fn().mockReturnValue([SWARM_STATUS_TOOL_NAME]),
        getAllTools: vi.fn().mockReturnValue([]),
      });
      (mockConfig.getSkillManager as ReturnType<typeof vi.fn>).mockReturnValue({
        getSkills: vi.fn().mockReturnValue([swarmCollab, otherSkill]),
      });
      (
        mockConfig as unknown as { isSwarmEnabled: () => boolean }
      ).isSwarmEnabled = vi.fn().mockReturnValue(true);
      const provider = new PromptProvider();
      const prompt = provider.getCoreSystemPrompt(mockConfig);

      expect(prompt).toContain('# Swarm (experimental, enabled)');
      expect(prompt).toContain('# Skill — swarm-collaboration (auto-loaded)');
    });
  });
});
