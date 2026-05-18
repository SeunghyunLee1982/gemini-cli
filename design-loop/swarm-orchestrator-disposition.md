# Phase 8 — Swarm orchestrator-disposition architecture

**Status:** LOCKED 2026-05-19 — R1/R2 multi-model debate + user decision. v1.x
scope. Sits on top of `swarm-north-star.md` (LOCKED 2026-05-17); must not
violate the v2/v3 reservations there.

## 풀려는 문제

사용자 라이브 테스트로 확인된 UX 갭: orchestrator (Gemini 모델) 가 `swarm`
도구가 등록되어 있어도 자연스럽게 안 잡고, "use swarm" 명시 지시 에도
`run_shell_command` 로 `gemini swarm ...` 재귀 invocation 시도. R1/R2 에서 4겹
갭으로 분해:

1. Gemini training prior: `swarm` 예시 0, shell 예시 ∞.
2. Tool description 의 "when to use vs shell" 부재.
3. Skill discovery 2단계 indirection (`activate_skill` 필요).
4. Orchestrator system prompt 에 swarm-specific disposition 없음.

## 해결 — 4겹 보강

| #   | 영역                                      | 메커니즘                                                                                                                         | 비용                 |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1   | Tool description rewrite                  | "when/not + no `gemini swarm` verb" 명시. `swarm-tool.ts:154-160`, `swarm-status-tool.ts:52-57`                                  | ~+150 토큰           |
| 2   | Orchestrator disposition + worked example | `snippets.ts` 에 `renderSwarmDisposition` 신설, 본문에 single `<example>` inline. `swarm` 도구 등록 + `isSwarmEnabled()` 시 활성 | ~+300 토큰 (조건부)  |
| 3   | swarm-collaboration skill auto-inline     | `promptProvider.ts:166-175` 에서 manifest 에서 빼고 본문 inline. `isSwarmEnabled()` 시에만                                       | ~+1.6k 토큰 (조건부) |
| 4   | 런타임 deny rule                          | tier-1 PolicyRule, `argsPattern` 는 JSON-shape (stableStringify) — `/"command":"(gemini\|gemini-fork)(\s\|"\|\\\\)/`             | 0 토큰 (런타임)      |

활성화 게이트: 모두 `Config.isSwarmEnabled()`. upstream gemini 사용자 영향 0.

## 핵심 결정

### Q1 — Tool description rewrite

`SWARM_TOOL_DESCRIPTION` (현재 ~80자, "what" 만):

> "Manage a persistent swarm of long-lived Claude sub-agents. Use
> `action: spawn` ..."

→ 새 (~480자, "when + not + no-CLI 명시"):

> "Spawn and message persistent Claude sub-agents in-process. Use for
> parallel/multi-perspective work, isolating sub-tasks, or specialist roles
> (reviewer, doc-writer). DO NOT shell out to `gemini` — there is no
> `gemini swarm` verb; this in-process tool IS the swarm. Actions: spawn
> (returns agent_id), message (stateful), release, list."

`SWARM_STATUS_TOOL_DESCRIPTION` 도 동일 정신, "Read-only. Call at start of any
non-trivial swarm task." prepend.

### Q2 — Skill auto-inline 메커니즘: **hardcode**

`promptProvider.ts:166-175` 에서 `isSwarmEnabled()` 이면:

1. `swarm-collaboration` skill 을 manifest 리스트에서 제외
2. 그 body 를 새 옵션 `swarmInline` 으로 `getCoreSystemPrompt` 에 전달
3. `snippets.ts` 의 새 `renderSwarmInline` 가 본문 inline (이걸
   `renderAgentSkills` 직전에 둠)

**`SkillDefinition.metadata.inline` 같은 플래그 도입 거부.** 이유:

- v1.x inline 후보는 정확히 1개 (`swarm-collaboration`)
- R5 v2 의 `CapabilityTemplate` 가 별도 데이터 모델로 들어올 예정이라 플래그가
  v2 와 reconcile 필요해질 위험
- YAGNI — 두 번째 inline 후보 나오면 그때 metadata 로 리팩토링

### Q3 — Disposition block + worked example: **결합**

새 `renderSwarmDisposition` 함수:

- `snippets.ts:43` `SystemPromptOptions` 에
  `swarmDisposition?: SwarmDispositionOptions` 추가
- `snippets.ts:144` 의 system prompt assembly 에서 `renderSubAgents` 와
  `renderAgentSkills` **사이** 에 삽입
- `promptProvider.ts:166-175` 에서
  `enabledToolNames.has(SWARM_TOOL_NAME) && config.isSwarmEnabled()` 일 때 옵션
  set

블록 prototype (~600자):

```
# Swarm (experimental, enabled)

You have a `swarm` tool for long-lived Claude sub-agents in-process.
Use for parallel independent work, multi-perspective review, or
isolating noisy sub-tasks. Do NOT invoke `gemini`/`gemini-fork` via
`run_shell_command` — there is no CLI verb; the in-process tool IS
the mechanism. Call `swarm_status()` before non-trivial swarm work.
Skip swarm for single-target lookups (use read_file/grep directly).

<example>
user: review my diff from two angles
assistant: <thinking>The user wants multi-perspective review. Use the
swarm tool to spawn parallel reviewers.</thinking>
swarm({
  action: 'spawn', model: 'sonnet',
  role: 'correctness-reviewer',
  charter: 'verify behavior',
  system_prompt: '...'
})
</example>
```

example 분리 거부: 단일 conceptual block 가 in-context proximity 보장.

### Q4 — Subagent archetype menu: **deferred to v2**

R5 north star v2 의 `CapabilityTemplate` 가 정식 메뉴 시스템. v1.x 에 임시 메뉴
박으면 v2 와 conflict. 단, `.gemini/skills/swarm-collaboration/SKILL.md` 본문
(Q3 inline 대상) 에 1줄 추가: "Common roles: reviewer, refactorer, doc-writer,
researcher, devil's-advocate". skill body 는 content (자유롭게 재작성 가능),
tool description 은 contract (메뉴 박으면 v2 baggage).

### Q5 — 런타임 deny rule: **tier-1 PolicyEngine, JSON-shape pattern**

`config.ts:4159` (swarm tool 등록 직후, `isSwarmEnabled()` 블록 안):

```ts
this.policyEngine.addRule({
  toolName: 'run_shell_command',
  argsPattern: /"command":"(gemini|gemini-fork)(\s|"|\\)/,
  decision: PolicyDecision.DENY,
  priority: DEFAULT_POLICY_TIER, // = 1
  source: 'swarm-recursive-guard',
  denyMessage:
    'Do not invoke gemini recursively. Use the in-process `swarm` ' +
    'tool (action: spawn).',
});
```

**Ground-truth 정정 (R2 양쪽 모두 확인):**

- `PolicyEngine.matchRule` 의 `argsPattern` 은
  `RegExp.test(stableStringify(toolCall.args))`
- `stableStringify` 가 JSON 형태로 변환 + 키 사이 null byte delimiter
  (`stable-stringify.ts:128-132`)
- R1 의 raw shell pattern `^\s*(gemini|gemini-fork)\b` 는 **절대 매치 안 함**
- 올바른 매칭: JSON-quoted form `"command":"gemini ..."` 종결문자 `\s`/`"`/`\`
  중 하나

Sub-command 분할 (`policy-engine.ts:469-475`) 가 `bash -c 'gemini foo'`,
`cd /tmp && gemini help` 등도 재귀 `check()` 로 처리해서 같은 룰에 걸림.

**shell-tool 직접 deny 거부.** 이유:

- `removeRulesByTier`, `/audit`, tier-4 user override 우회
- R5 north star 의 "런타임 = PolicyEngine" 모델과 분리
- 단순성 < 일관성

tier-4 override 보존: 사용자가 `~/.gemini/policies/*.toml` 에서 같은 패턴 ALLOW
박으면 천장이 이김.

### Q6 — Worked example: **single, inside Q3 block** (위 참조)

## 테스트 요구사항

1. **PolicyEngine pattern**: `policy-engine.test.ts` 에 case 추가 —
   `argsPattern: /"command":"gemini.../` 가 `{command:'gemini --version'}` AND
   `{command:'bash -c "gemini help"'}` 둘 다 DENY 처리. JSON-shape 매칭
   invariant lock.
2. **Tool description**: `swarm-tool.test.ts` 에서 description 에 "no
   `gemini swarm` verb" 같은 핵심 phrase 존재 확인 (drift guard).
3. **Disposition block**: `promptProvider.test.ts` 에 case — swarm enabled 시
   `renderSwarmDisposition` 출력이 시스템 프롬프트에 포함, disabled 시 불포함.
4. **Skill auto-inline**: `promptProvider.test.ts` 에 case — swarm enabled 시
   `swarm-collaboration` 이 manifest 에서 빠지고 body 가 inline 됨, disabled 시
   manifest 그대로.
5. **Recursive guard end-to-end**: `swarm-recursive-guard.test.ts` 신설 (또는
   swarm-manager.test.ts 확장) — `isSwarmEnabled()` 시 orchestrator 가
   `run_shell_command{command:'gemini ...'}` 호출하면 DENY + denyMessage.

## Out of scope

- swarm 권한 모델 (R5 north star v1.x 가 이미 처리; Phase 8 은 disposition layer
  만)
- `CapabilityTemplate` (v2)
- `amend_policy` action (v2)
- 시스템 reminder 인젝션 (Claude Code 의 Pattern F — Gemini 런타임에 동등
  surface 없음)
- 사용자-author skill 의 metadata 기반 inline (v2 이후 검토)

## Roadmap 위치

```
v1.0 baseline   (Phase 5 = ab572fa3c)
v1.0.1          (Phase 5.1 fixes = cbfa37206)
v1.x Scope Bridge (Phase 6 = c07139ea3) — PolicyRule[] capability
v1.x Disposition (Phase 8, this doc)   — orchestrator disposition + runtime guard
                ↓
v2 north-star spine (CapabilityTemplate, amend_policy, BehaviorConfig)
v3 agent unification
```

## 변경 절차

이 LOCKED 문서 수정은 swarm-north-star.md 와 동일 절차:

1. 새 R-round 문서 추가
2. 2개 model 의견
3. 사용자 명시 승인
4. LOCKED 일자 갱신
