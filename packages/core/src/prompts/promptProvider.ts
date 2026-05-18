/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { HierarchicalMemory } from '../config/memory.js';
import { GEMINI_DIR, makeRelative } from '../utils/paths.js';
import { ApprovalMode } from '../policy/types.js';
import * as snippets from './snippets.js';
import * as legacySnippets from './snippets.legacy.js';
import {
  resolvePathFromEnv,
  applySubstitutions,
  isSectionEnabled,
  type ResolvedPath,
} from './utils.js';
import { CodebaseInvestigatorAgent } from '../agents/codebase-investigator.js';
import { isGitRepository } from '../utils/gitUtils.js';
import {
  WRITE_TODOS_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  AGENT_TOOL_NAME,
} from '../tools/tool-names.js';
// Phase 8 — orchestrator-disposition gating. `SWARM_TOOL_NAME` is the
// stable name; `SWARM_STATUS_TOOL_NAME` lives on the types module
// (single SoT, see Phase 5 post-review).
import { SWARM_TOOL_NAME } from '../agents/swarm/swarm-tool.js';
import { SWARM_STATUS_TOOL_NAME } from '../agents/swarm/types.js';
import { resolveModel, supportsModernFeatures } from '../config/models.js';
import { DiscoveredMCPTool } from '../tools/mcp-tool.js';
import {
  getAllGeminiMdFilenames,
  getGlobalMemoryFilePath,
  getProjectMemoryIndexFilePath,
} from '../tools/memoryTool.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';

/**
 * Orchestrates prompt generation by gathering context and building options.
 */
export class PromptProvider {
  /**
   * Generates the core system prompt.
   */
  getCoreSystemPrompt(
    context: AgentLoopContext,
    userMemory?: string | HierarchicalMemory,
    interactiveOverride?: boolean,
    topicUpdateNarrationOverride?: boolean,
  ): string {
    const systemMdResolution = resolvePathFromEnv(
      process.env['GEMINI_SYSTEM_MD'],
    );

    const interactiveMode =
      interactiveOverride ?? context.config.isInteractive();
    const approvalMode =
      context.config.getApprovalMode?.() ?? ApprovalMode.DEFAULT;
    const isPlanMode = approvalMode === ApprovalMode.PLAN;
    const isYoloMode = approvalMode === ApprovalMode.YOLO;
    const allDiscoveredSkills = context.config.getSkillManager().getSkills();
    const toolNames = context.toolRegistry.getAllToolNames();
    const isTopicUpdateNarrationEnabled =
      topicUpdateNarrationOverride ??
      context.config.isTopicUpdateNarrationEnabled();

    const enabledToolNames = new Set(toolNames);

    // Phase 8 — orchestrator disposition + skill auto-inline gating.
    // The two layers share a single gate: the swarm tool (or its status
    // companion) must be registered AND `experimental.swarm` must be on.
    // When both hold, pull the `swarm-collaboration` skill out of the
    // generic skills manifest and inline its SKILL.md body via
    // `renderSwarmInline`. See
    // `design-loop/swarm-orchestrator-disposition.md` Q2/Q3.
    const swarmToolRegistered =
      enabledToolNames.has(SWARM_TOOL_NAME) ||
      enabledToolNames.has(SWARM_STATUS_TOOL_NAME);
    const swarmDispositionEnabled =
      swarmToolRegistered && context.config.isSwarmEnabled();
    const swarmInlineSkill = swarmDispositionEnabled
      ? allDiscoveredSkills.find((s) => s.name === 'swarm-collaboration')
      : undefined;
    // Skills shown in the generic manifest (`renderAgentSkills`). When
    // we auto-inline `swarm-collaboration`, also filter it out of the
    // manifest so the orchestrator doesn't see the same skill twice
    // (once inline, once as a list entry).
    const skills = swarmInlineSkill
      ? allDiscoveredSkills.filter((s) => s.name !== 'swarm-collaboration')
      : allDiscoveredSkills;

    const approvedPlanPath = context.config.getApprovedPlanPath();

    const desiredModel = resolveModel(
      context.config.getActiveModel(),
      context.config.getGemini31LaunchedSync?.() ?? false,
      context.config.getGemini31FlashLiteLaunchedSync?.() ?? false,
      false,
      context.config.getHasAccessToPreviewModel?.() ?? true,
      context.config,
    );
    const isModernModel = supportsModernFeatures(desiredModel);
    const activeSnippets = isModernModel ? snippets : legacySnippets;
    const contextFilenames = getAllGeminiMdFilenames();

    let trackerDir = context.config.isTrackerEnabled()
      ? context.config.storage.getProjectTempTrackerDir()
      : undefined;

    if (trackerDir) {
      // Sanitize path to prevent prompt injection
      trackerDir = trackerDir.replace(/\n/g, ' ').replace(/\]/g, '');
    }

    // --- Context Gathering ---
    let planModeToolsList = '';
    if (isPlanMode) {
      const allTools = context.toolRegistry.getAllTools();
      planModeToolsList = allTools
        .map((t) => {
          if (t instanceof DiscoveredMCPTool) {
            return `  <tool>\`${t.name}\` (${t.serverName})</tool>`;
          }
          return `  <tool>\`${t.name}\`</tool>`;
        })
        .join('\n');
    }

    let basePrompt: string;

    // --- Template File Override ---
    if (systemMdResolution.value && !systemMdResolution.isDisabled) {
      let systemMdPath = path.resolve(path.join(GEMINI_DIR, 'system.md'));
      if (!systemMdResolution.isSwitch) {
        systemMdPath = systemMdResolution.value;
      }
      if (!fs.existsSync(systemMdPath)) {
        throw new Error(`missing system prompt file '${systemMdPath}'`);
      }
      basePrompt = fs.readFileSync(systemMdPath, 'utf8');
      const skillsPrompt = activeSnippets.renderAgentSkills(
        skills.map((s) => ({
          name: s.name,
          description: s.description,
          location: s.location,
        })),
      );
      basePrompt = applySubstitutions(
        basePrompt,
        context.config,
        skillsPrompt,
        isModernModel,
      );
    } else {
      // --- Standard Composition ---
      const hasHierarchicalMemory =
        typeof userMemory === 'object' &&
        userMemory !== null &&
        (!!userMemory.global?.trim() ||
          !!userMemory.extension?.trim() ||
          !!userMemory.project?.trim());

      const options: snippets.SystemPromptOptions = {
        preamble: this.withSection('preamble', () => ({
          interactive: interactiveMode,
          approvalMode,
        })),
        coreMandates: this.withSection('coreMandates', () => ({
          interactive: interactiveMode,
          hasSkills: skills.length > 0,
          hasHierarchicalMemory,
          contextFilenames,
          topicUpdateNarration: isTopicUpdateNarrationEnabled,
        })),
        subAgents: this.withSection(
          'agentContexts',
          () =>
            context.config
              .getAgentRegistry()
              .getAllDefinitions()
              .map((d) => ({
                name: d.name,
                description: d.description,
              })),
          enabledToolNames.has(AGENT_TOOL_NAME),
        ),
        // Phase 8 — orchestrator disposition layer. Both fields are
        // populated only when swarm is enabled AND a swarm tool is
        // registered (see the `swarmDispositionEnabled` computation
        // upstream). `swarmInline` carries the SKILL.md body for the
        // auto-inlined `swarm-collaboration` skill; the same skill is
        // simultaneously removed from `agentSkills` to avoid double-
        // listing.
        swarmDisposition: { enabled: swarmDispositionEnabled },
        swarmInline: swarmInlineSkill
          ? {
              name: swarmInlineSkill.name,
              body: swarmInlineSkill.body,
            }
          : undefined,
        agentSkills: this.withSection(
          'agentSkills',
          () =>
            skills.map((s) => ({
              name: s.name,
              description: s.description,
              location: s.location,
            })),
          skills.length > 0,
        ),
        taskTracker: trackerDir,
        hookContext: isSectionEnabled('hookContext') || undefined,
        primaryWorkflows: this.withSection(
          'primaryWorkflows',
          () => {
            const agentRegistry = context.config.getAgentRegistry();
            return {
              interactive: interactiveMode,
              enableCodebaseInvestigator:
                agentRegistry.getDefinition(CodebaseInvestigatorAgent.name) !==
                undefined,
              enableWriteTodosTool: enabledToolNames.has(WRITE_TODOS_TOOL_NAME),
              enableEnterPlanModeTool: enabledToolNames.has(
                ENTER_PLAN_MODE_TOOL_NAME,
              ),
              enableGrep: enabledToolNames.has(GREP_TOOL_NAME),
              enableGlob: enabledToolNames.has(GLOB_TOOL_NAME),
              approvedPlan: approvedPlanPath
                ? { path: approvedPlanPath }
                : undefined,
              taskTracker: trackerDir,
              topicUpdateNarration: isTopicUpdateNarrationEnabled,
            };
          },
          !isPlanMode,
        ),
        planningWorkflow: this.withSection(
          'planningWorkflow',
          () => ({
            interactive: interactiveMode,
            planModeToolsList,
            plansDir: makeRelative(
              context.config.storage.getPlansDir(),
              context.config.getProjectRoot(),
            ).replaceAll('\\', '/'),
            approvedPlanPath: (() => {
              const approvedPath = context.config.getApprovedPlanPath();
              return approvedPath
                ? makeRelative(
                    approvedPath,
                    context.config.getProjectRoot(),
                  ).replaceAll('\\', '/')
                : undefined;
            })(),
          }),
          isPlanMode,
        ),
        operationalGuidelines: this.withSection(
          'operationalGuidelines',
          () => ({
            interactive: interactiveMode,
            enableShellEfficiency:
              context.config.getEnableShellOutputEfficiency(),
            interactiveShellEnabled: context.config.isInteractiveShellEnabled(),
            topicUpdateNarration: isTopicUpdateNarrationEnabled,
            userProjectMemoryPath: normalizePromptPath(
              getProjectMemoryIndexFilePath(context.config.storage),
            ),
            globalMemoryPath: normalizePromptPath(getGlobalMemoryFilePath()),
          }),
        ),
        sandbox: this.withSection('sandbox', () => ({
          mode: getSandboxMode(),
          toolSandboxingEnabled: context.config.getSandboxEnabled(),
        })),
        interactiveYoloMode: this.withSection(
          'interactiveYoloMode',
          () => true,
          isYoloMode && interactiveMode,
        ),
        gitRepo: this.withSection(
          'git',
          () => ({ interactive: interactiveMode }),
          isGitRepository(process.cwd()) ? true : false,
        ),
        finalReminder: isModernModel
          ? undefined
          : this.withSection('finalReminder', () => ({
              readFileToolName: READ_FILE_TOOL_NAME,
            })),
      } as snippets.SystemPromptOptions;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const getCoreSystemPrompt = activeSnippets.getCoreSystemPrompt as (
        options: snippets.SystemPromptOptions,
      ) => string;
      basePrompt = getCoreSystemPrompt(options);
    }

    // --- Finalization (Shell) ---
    const finalPrompt = activeSnippets.renderFinalShell(
      basePrompt,
      userMemory,
      contextFilenames,
    );

    // Sanitize erratic newlines from composition
    let sanitizedPrompt = finalPrompt.replace(/\n{3,}/g, '\n\n');

    // Context Reinjection (Active Topic)
    if (isTopicUpdateNarrationEnabled) {
      const activeTopic = context.config.topicState.getTopic();
      if (activeTopic) {
        const sanitizedTopic = activeTopic
          .replace(/\n/g, ' ')
          .replace(/\]/g, '');
        sanitizedPrompt += `\n\n[Active Topic: ${sanitizedTopic}]`;
      }
    }

    // Write back to file if requested
    this.maybeWriteSystemMd(
      sanitizedPrompt,
      systemMdResolution,
      path.resolve(path.join(GEMINI_DIR, 'system.md')),
    );

    return sanitizedPrompt;
  }

  getCompressionPrompt(context: AgentLoopContext): string {
    const desiredModel = resolveModel(
      context.config.getActiveModel(),
      context.config.getGemini31LaunchedSync?.() ?? false,
      context.config.getGemini31FlashLiteLaunchedSync?.() ?? false,
      false,
      context.config.getHasAccessToPreviewModel?.() ?? true,
      context.config,
    );
    const isModernModel = supportsModernFeatures(desiredModel);
    const activeSnippets = isModernModel ? snippets : legacySnippets;
    return activeSnippets.getCompressionPrompt(
      context.config.getApprovedPlanPath(),
    );
  }

  private withSection<T>(
    key: string,
    factory: () => T,
    guard: boolean = true,
  ): T | undefined {
    return guard && isSectionEnabled(key) ? factory() : undefined;
  }

  private maybeWriteSystemMd(
    basePrompt: string,
    resolution: ResolvedPath,
    defaultPath: string,
  ): void {
    const writeSystemMdResolution = resolvePathFromEnv(
      process.env['GEMINI_WRITE_SYSTEM_MD'],
    );
    if (writeSystemMdResolution.value && !writeSystemMdResolution.isDisabled) {
      const writePath = writeSystemMdResolution.isSwitch
        ? defaultPath
        : writeSystemMdResolution.value;
      fs.mkdirSync(path.dirname(writePath), { recursive: true });
      fs.writeFileSync(writePath, basePrompt);
    }
  }
}

function normalizePromptPath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

// --- Internal Context Helpers ---

function getSandboxMode(): snippets.SandboxMode {
  if (process.env['SANDBOX'] === 'sandbox-exec') return 'macos-seatbelt';
  if (process.env['SANDBOX']) return 'generic';
  return 'outside';
}
