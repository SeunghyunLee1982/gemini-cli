# Swarm primitive — north star architecture

**Status:** LOCKED — 5-round multi-model debate (R1–R5) + 사용자 결정. 모든 후속
변경은 이 문서를 reference. Phase 5 (commit `ab572fa3c`) 가 v1.0 baseline.

**Source documents (chronological):**

- `swarm-design.md` (initial primitive design, pre-Phase 5)
- `swarm-model-r1{-briefing,-opus,-gemini}.md` — stateful collaborator vs
  process pool
- `swarm-model-r2-{briefing,opus,gemini}.md` — archetype vs free-form role
- `swarm-model-r3-{briefing,opus,gemini}.md` — pull-model self-discovery
- `swarm-model-r4-{briefing,opus,gemini}.md` — capability requests (R4 partially
  superseded by R5)
- `swarm-model-r5-{briefing,opus,gemini}.md` — north-star authority model

## 사용자가 표명한 비전

1. **사람 / 외부 시스템** — 천장 (ceiling) 설정 + 경계 (boundary) 승인 포인트.
2. **이후, 천장 안에서** — orchestrator + 런타임 이 "sub-agent 가 무엇을 하고,
   무엇을 할 수 있고, 어떻게 행동해야 하는지" 의 모든 책임 보유.
3. **결정론적으로 동작할 수 있는 부분 = 결정론적 장치**. LLM 판단이나 정책
   평가에 의존할 필요 없는 행동 규약은 코드로 enforce.

## 핵심 원칙

### 권한 위계 (5-tier policy bands)

| Tier            | Source                                   | Mutable by   | 의미                             |
| --------------- | ---------------------------------------- | ------------ | -------------------------------- |
| **5 admin**     | host machine                             | nobody       | 시스템 레벨 강제                 |
| **4 user**      | `~/.gemini/policies/*.toml`              | user only    | **이게 천장.** 그 누구도 못 넘음 |
| **3 workspace** | repo-pinned (`<repo>/.gemini/policies/`) | repo owner   | 팀/프로젝트 규칙                 |
| **2 session**   | orchestrator 가 spawn / amend 시 발행    | orchestrator | 천장 안 sub-agent 정책           |
| **1 default**   | 빌트인 (`plan.toml`, `agents.toml`, …)   | shipped      | 폴백                             |

**수학적 천장 dominance:** tier 5 > 4 > 3 > 2 > 1. 같은 (toolName, argsPattern)
의 충돌은 항상 더 높은 tier 가 승. orchestrator 가 tier 4 거부 항목을 tier 2
ALLOW 로 emit 해도 정책 엔진이 insert-time 에 거부 (fail fast,
`policy_rejected: [proposed, ceiling_rule]` 반환).

### 책임 분할 (3 loci)

1. **사용자** — tier 4 정책 작성. ASK_USER 모달 응답 (천장 외 일회성 허용).
2. **Orchestrator (LLM)** — tier 2 정책 발행 (spawn / amend). 시멘틱 판단: "이
   sub-agent 에 어떤 권한 부여할까", "delegate 할까 grant 할까".
3. **Runtime (`PolicyEngine` + behavior monitor)** — 모든 sub-agent `tool_use`
   가 `engine.check(toolCall, mode, subagent=agent_id)` 통과. **orchestrator
   결정 ≠ 런타임 허용** — runtime 이 최종 게이트. behavior contract 도 runtime
   이 모니터링.

### Capability = PolicyRule[] (N1, Opus 안)

```ts
type SubAgentCapability =
  | { kind: 'template'; name: string; bindings?: Record<string, string> }
  | { kind: 'rules'; rules: PolicyRule[] };

type CapabilityTemplate = {
  name: string; // "reviewer", "doc-writer", "refactorer"
  expands: PolicyRule[]; // subagent=<bound at spawn>
};
```

`PolicyRule` 은 기존 타입 그대로 (`toolName`, `argsPattern`, `toolAnnotations`,
`modes`, `interactive`, `decision`, `priority`, `subagent`). 새 타입 없음.

Sub-agent 의 mental model: "내가 가진 도구 + 각 도구의 args 모양." Orchestrator
자기 정책 보는 시선과 동일.

### Behavior contract = BehaviorConfig (N5, Gemini 안)

```ts
interface BehaviorConfig {
  max_turns: number; // 한 message 당 hard turn 캡
  max_files_modified: number; // 누적 modification 캡
  idle_ttl_minutes: number; // 자동 release
  context_ceiling_pct: number; // context window 도달 시 자동 release
}
```

**결정론적 enum/scalar 구조체.** Policy rule 평가 사이클에 끼지 않음. Runtime 의
행동 모니터가 직접 측정 + 위반 시 즉시 session 종료. orchestrator 가 깜빡해도
시스템이 스스로 막음.

이유 (사용자 표명): "결정론적으로 동작할 수 있는 부분은 결정론적 장치에 맡기는
것이 빠르고 확실한 방법임." LLM-loop 안에서 평가해야 하는 정책 vs runtime 이
측정 가능한 숫자 사이의 분리.

### spawn 의 재정의 (N6)

```ts
SpawnAction = {
  action: 'spawn',
  identity: { role: string; charter: string; display_name?: string },
  capability: SubAgentCapability,   // N1 (PolicyRule[] 또는 template)
  behavior?: BehaviorConfig,        // N5 (결정론 enum/scalar)
  model?: 'sonnet' | 'opus',
};
```

`tools: string[]` (Phase 5) 폐기. Toolset 은 capability 의 projection — engine
이 "이 도구 호출 가능?" 답하므로 명시적 allowlist 가 dead weight.

### Amend (런타임 정책 변경, N3 Opus 안)

```ts
SwarmAction =
  | ... (기존)
  | {
      action: 'amend_policy',
      agent_id: string,
      add?: PolicyRule[],
      remove?: { rule_id: string }[],
      reason?: string,
    };
```

매 emit 된 rule 에 `source = "swarm:orchestrator-decision:<turn-id>"` + `reason`
(자유 텍스트). 천장 위반 시 insert 거부 + 즉시 `policy_rejected` 반환.
`/audit <agent_id>` 명령으로 effective policy + 결정 출처 렌더.

R4 의 `request_capability` 도구는 v2 에서 부활 — 단순히 "orchestrator 에게 내
정책 amend 해달라" 의 LLM-friendly sugar. `amend_policy` 와 같은 코드 경로.

### Runtime 감사 / 사용자 가시성

- `swarm_status()` 응답 확장: `effective_policy_summary`, `recent_denies[]`.
- 새 `/audit <agent_id>` 명령: 효과적 정책 (모든 tier 머지된 결과) + 결정 출처 +
  마지막 N 개 tool 호출 + 위반 기록.
- 모든 amend / capability event 는 `swarm_status.recent_events[]` 에 기록 (Phase
  5 ring buffer 확장).

### ASK_USER 흐름

천장 (tier 4) 의 ASK_USER 규칙은 **orchestrator 경유 X**. 사용자가 천장
주인이므로 직접 응답. orchestrator 는 자기 ALLOW (tier 2) 를 좁게 가져갈 권한은
있지만 ASK_USER 권한은 없음.

## Phase 5 → north-star delta

### 보존 (north star 에서도 right shape)

- `role` / `charter` — sub-agent identity
- `swarm_status()` — self-discovery 도구
- 공유 디렉토리 + `state.md` 컨벤션
- Idle TTL, lifecycle abort, app-signal 체이닝
- `PolicyEngine` 자체 + `subagent` 필드
- `message` 의 `status: 'ok' | 'message_turn_cap_reached'` 분리 (Phase 5)
- `session_status: SwarmSessionStatus` (Phase 5)

### 폐기

- `tools: string[]` on spawn (capability 가 대체)
- `DEFAULT_SWARM_TOOLS` / inherit-all 부트스트랩 (정책이 결정)
- Phase 5 의 하드코딩된 `Kind.Agent` / `SWARM_BLOCKED_TOOL_NAMES` 필터 (tier 1
  deny rule 로 흡수)
- R4 의 독립 `request_capability` 도구 (v2 에서 `amend_policy` sugar 로 부활)

### 신설

- Tier 2 "session policy" band 추가 + `subagent=<id>` 매핑
- `CapabilityTemplate` registry (`~/.gemini/swarm-templates/*.toml`)
- `swarm.amend_policy` 액션
- `BehaviorConfig` runtime monitor (별도 시스템, policy engine 과 분리)
- `/audit` 명령
- `swarm_status.effective_policy_summary`, `recent_denies[]`

## 로드맵 (3 milestones)

### v1.x — Scope Bridge (다음 커밋 범위)

- `swarm spawn` 이 `policy: PolicyRule[]` 받음 (`tools: string[]` 과 공존, 양쪽
  허용 — back-compat)
- 매 sub-agent `tool_use` 가 `PolicyEngine.check()` 통과 (subagent 필드 활용)
- 사이드카 `swarm-policy.toml` (tier 2 기본값, `subagent=*`)
- `/audit <agent_id>` 명령 ship
- `swarm_status.effective_policy_summary` 확장

### v2 — north-star spine

- `tools: string[]` 폐기, `capability: SubAgentCapability` 만 받음 (breaking
  change)
- `CapabilityTemplate` registry + 빌트인 템플릿 (reviewer, refactorer,
  doc-writer, researcher)
- `swarm.amend_policy` 액션
- `request_capability` 도구를 amend_policy sugar 로 재도입
- `BehaviorConfig` runtime monitor (context %, file-modify count 측정)
- 자동 release on behavior breach

### v3 — agent unification (가장 공격적)

- `swarm` 도구 자체 **삭제**
- `agent.spawn { persistent: true, capability_template: 'reviewer' }` 가 swarm
  의 자리 차지
- 단일 agent registry (현재 `kind: anthropic` / `kind: gemini` 와 swarm 분리
  종결)
- 사용자가 "agent vs swarm" 차이를 알 필요 없음 — 둘 다 같은 primitive 의 설정
  차이

## 핵심 긴장 처리

### orchestrator vs runtime disagreement

- orchestrator: "이 sub-agent 는 shell 써도 됨"
- runtime: "그건 사용자 천장 위반"
- 결과: runtime 이 거부, orchestrator 의 결정은 천장 안에서만 유효.
- orchestrator 는 `policy_rejected` 응답을 받고 자기 정책 재조정 (또는 ASK_USER
  로 사용자 호출).

### behavior monitor 가 권한 outside?

- 권한 (capability) = "할 수 있는가?" — policy engine 이 답.
- 행동 (behavior) = "얼마나 / 얼마나 자주 할 수 있는가?" — runtime monitor 가
  측정.
- 둘은 직교. `read_file` 이 capability 차원에서 ALLOW 이고 단일 호출은 통과.
  하지만 monitor 가 "지금 5개 동시 열림" 측정 시 즉시 차단 또는 release.

### v1.x → v2 migration

- v1.x 에 `tools: string[]` 과 `policy: PolicyRule[]` 공존 (양쪽 받음).
- v2 에서 `tools` 거부 + 경고 메시지로 변경 안내.
- v3 에서 `swarm` 도구 자체 deprecation + `agent` 통합.

## 명시적 제외 (북극성 외 영역)

- **agent-memory MCP 통합** — v1.2+ 별개 트랙. north star 의 권한 모델과 직교.
- **async swarm execution** — v1.1 의 별도 안건. 현재 sync 모델 그대로.
- **cross-CLI session persistence** — v1.1+ 별개.

## 변경 절차

이 문서를 수정하려면:

1. 변경 reason 을 design-loop/ 하위에 새 R 라운드 문서로 기록.
2. 적어도 2개 model (opus + gemini) 의견 받기.
3. 사용자 명시 승인.
4. 이 문서 갱신 + `Status: LOCKED` 갱신 일자 명시.

LOCKED 상태에서 사용자 승인 없이 이 문서 본문 수정 금지.
