# Working in this fork

This is a personal fork of `google-gemini/gemini-cli`. It carries Claude
Code–style ergonomics on top of upstream and is used as a Claude outage
fallback + tinkering workspace. Apache 2.0; do not introduce GPL/etc.

## Branch strategy (Pattern B: split mirror and personal)

Three logical roles. **Mixing them = pain.**

| Branch                                           | Purpose                                                                                                    | Modify?                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `main` (local) → `origin/main` → `upstream/main` | Pristine upstream mirror. Always fast-forwards from upstream/main.                                         | **NO**. Never commit. Never merge. Only `git pull --ff-only upstream main`. |
| `personal`                                       | Daily driver. All fork-only customizations live here. Rebased onto `main` periodically.                    | YES. This is the default working branch.                                    |
| `fix/<topic>`, `feat/<topic>`                    | Branches intended for an upstream PR. **Always cut from `main` (= upstream/main), never from `personal`.** | YES, but keep the diff minimal and free of personal-branch baggage.         |

### Day-to-day

```bash
git checkout personal           # default working branch
# ... do work ...
git commit ...
git push origin personal
```

### Absorb upstream changes

```bash
git fetch upstream
git checkout main
git pull --ff-only upstream main      # fast-forward only; should never conflict
git push origin main
git checkout personal
git rebase main                        # conflicts (if any) resolved here only
git push --force-with-lease origin personal
```

### Submit an upstream PR

```bash
git fetch upstream
git checkout -b fix/<topic> upstream/main   # KEY: cut from upstream/main, not personal
# ... make changes ...
git push -u origin fix/<topic>
gh pr create -R google-gemini/gemini-cli \
  --base main \
  --head SeunghyunLee1982:fix/<topic> \
  --title "..." --body "..."
```

**Safety check before opening a PR:** `git log main..HEAD --oneline` should show
**only** the commits intended for the PR. If anything from `personal` shows up,
the base is wrong — recreate from `upstream/main`.

### After an upstream PR is merged

```bash
git fetch upstream
git checkout main && git pull --ff-only upstream main && git push origin main
git checkout personal && git rebase main    # cherry-picked duplicate auto-drops
```

### Useful alias

```bash
git config --global alias.pr-branch \
  '!f() { git fetch upstream && git checkout -b "$1" upstream/main; }; f'
# usage: git pr-branch fix/something
```

## What lives on `personal` (current)

1. `feat: add Claude Code-style ergonomics` —
   `--system-prompt`/`--system-prompt-file` CLI flags, vendor-agnostic fallback
   chain (`.agents/` → `.claude/` → `.gemini/`, `AGENTS.md` → `CLAUDE.md` →
   `GEMINI.md`)
2. `test: cover .claude/ fallback in skills and agent registry; fix precedence`
   — adjusts skill precedence to match the stated chain, adds tests
3. `feat(hooks): accept Claude Code hook aliases UserPromptSubmit and Stop` —
   alias normalization at config-load time
4. `fix(cli): make --skip-trust actually load workspace settings` — also pushed
   upstream as PR #27137. Will become a no-op on `personal` once upstream merges
   and we rebase.
5. `feat(agents): add anthropic agent kind` — adds `kind: anthropic` to the
   agent registry so `.claude/agents/*.md` can declare Claude-backed sub-agents.
   The `model:` field accepts the aliases `sonnet` and `opus` (haiku-class
   intentionally excluded on `personal`); the bridge resolves the alias to a
   concrete Anthropic model ID at invocation time so definitions never pin a
   version. Backed by `@anthropic-ai/sdk` in-process. Single-shot path (no
   `tools` field) is the v0 baseline; the `tools` / `max_turns` fields enable
   v1's tool-use loop. ToS-clean: `ANTHROPIC_API_KEY` only, no Google OAuth
   involved.

### Anthropic sub-agent example

`~/.claude/agents/my-helper.md` (single-shot, v0 back-compat):

```markdown
---
kind: anthropic
name: my-helper
description: A Claude-backed helper. Use for X.
model: sonnet
max_tokens: 2048
temperature: 0.7
---

You are a helpful assistant. Reply with...
```

`~/.claude/agents/my-investigator.md` (v1 with tool use):

```markdown
---
kind: anthropic
name: my-investigator
description: A read-only Claude investigator.
model: sonnet
tools:
  - read_file
  - grep_search
  - glob
  - list_directory
  - read_many_files
max_turns: 5
---

You are a read-only investigator. Use the available tools to find what the user
asked for, then summarise your findings.
```

Anthropic-agent fields:

- `tools` — whitelist of Gemini tool names the sub-agent may call. Each entry
  must be a known built-in or MCP tool name; wildcards are not allowed. Omit for
  v0 single-shot behavior. Recommended starter set is read-only: `read_file`,
  `grep_search`, `glob`, `list_directory`, `read_many_files`.
- `max_turns` — caps the Anthropic message-loop turns when `tools` is non-empty.
  Default 5, max 50. No effect when `tools` is empty/omitted.
- `kind: anthropic` is **required** when using any anthropic-only field; the
  loader will not infer the kind from `tools` / `max_turns` alone.

Then the Gemini main agent can delegate via the `agent` tool with
`agent_name: 'my-helper'`. Requires `ANTHROPIC_API_KEY` in env (loaded
automatically from `.env` at or above the workspace).

## Swarm v1.0 (experimental)

> **North star (LOCKED 2026-05-17):** see `design-loop/swarm-north-star.md`.
> 모든 후속 변경은 그 문서를 reference. 권한 모델 = `PolicyRule[]` capability
>
> - 5-tier policy bands (user ceiling 수학적으로 dominant) + `BehaviorConfig`
>   결정론적 runtime monitor + v3 에서 `agent.spawn` 으로 통합. 이 섹션은 v1.0
>   (= Phase 5, commit `ab572fa3c`) 의 **현재 shipped 상태** 설명.

Persistent agent swarms let the main Gemini agent spawn long-lived Claude
sub-agent instances, send them multiple messages across orchestrator turns
(retaining session state), and release them. Unlike `kind: anthropic` sub-agents
(one-shot delegation), a swarm session keeps its `messages` array and tool
registry alive between calls.

### Enabling

Off by default. Turn on in `~/.gemini/settings.json` (or workspace equivalent):

```json
{
  "experimental": {
    "swarm": true
  }
}
```

When enabled, the orchestrator gains a single `swarm` tool with a discriminated
`action` field.

### Actions

| Action    | Required fields      | Effect                                        |
| --------- | -------------------- | --------------------------------------------- |
| `spawn`   | `system_prompt`      | Creates a session, returns `agent_id` slug    |
| `message` | `agent_id`, `prompt` | Sends one turn to a session, returns response |
| `release` | `agent_id`           | Aborts and removes the session                |
| `list`    | —                    | Snapshot of all live sessions                 |

`spawn` also accepts optional `model` (`sonnet` / `opus`, default `sonnet`),
`tools` (defaults to the read-only whitelist), `max_turns` (default 5),
`display_name`, and (Phase 5) `role` (≤80 chars) / `charter` (≤200 chars) —
short self-descriptive labels that show up in `list` / `swarm_status` and are
woven into the session's system prompt so the sub-agent knows what hat it's
wearing.

The `message` result has two status fields (Phase 5 split):

- `status: 'ok' | 'message_turn_cap_reached'` — message-outcome status.
  Cap-reached means the loop hit its `max_turns` budget without an `end_turn`;
  the session is **still alive** and the orchestrator can send a `"continue"`
  message or release it.
- `session_status: 'idle' | 'running' | 'released' | 'error'` — session
  lifecycle status (always `idle` after a normal return, including cap).

### Read-only companion tool: `swarm_status`

In addition to the action-discriminated `swarm` tool, the orchestrator and every
spawned sub-agent get a read-only `swarm_status` tool that returns a snapshot:
live `agents[]` (with `role`, `charter`, `status`, `turn_count`,
`seconds_since_active`), the shared `workspace_dir`, and `recent_events[]` (up
to 50, newest first). Use it at the start of any non-trivial sub-agent turn to
see who else is on the team. The tool is `Kind.Other` (not `Kind.Agent`), so
sub-agents inherit it through the swarm-manager's per-tool filter without being
granted the full spawn/message/release surface.

### Defaults

- **Tools.** Inherits the orchestrator's currently-registered toolset by default
  (mirrors Claude Code's Task tool). Agent-kind tools are filtered out to
  prevent recursive spawn, and `enter_plan_mode` / `exit_plan_mode` are filtered
  out unconditionally (Phase 5 — mode-control state belongs to the host CLI).
  Wildcards are not allowed. Pass an explicit `tools: [...]` array on `spawn` to
  narrow the set — for example, the read-only preset is
  `['read_file', 'grep_search', 'glob', 'list_directory', 'read_many_files', 'swarm_status']`
  (exported as `DEFAULT_SWARM_TOOLS`; Phase 5 added `swarm_status`). Note: this
  default relies on v1.0's strictly synchronous `message` (only one agent runs
  at a time) to avoid concurrent-write races; v1.1 (async) must revisit before
  shipping parallel execution.
- **Idle TTL.** 30 minutes since last activity. Stale sessions are swept on a
  background timer. Sessions wedged in `running` past `2 * TTL` are aborted,
  marked `error`, and left in `list()` for debugging — the user must call
  `release` to remove them.
- **Abort.** Sessions are bound to the global app lifecycle (SIGINT / process
  exit / `release`), NOT to the orchestrator turn's signal — ending an
  orchestrator turn does not kill a swarm session.

### v1.0 scope

Sync only: `message` blocks until the session's turn completes. In-memory only:
sessions die with the parent CLI process. Single discriminated tool. No async or
budget caps in v1 — those are v1.1+. A **shared workspace directory** is created
automatically (see below).

### Shared workspace directory (Phase 4) + `state.md` convention (Phase 5)

`SwarmManager` lazily creates a per-session shared scratch directory at
`<project>/.gemini/tmp/<session-id>/swarm/` on first `spawn`. The directory is
the sibling of `plans/` (same lifecycle, same tier in the tempfile tree). All
spawned agents in the current CLI session see the same directory through their
standard file tools (`write_file`, `read_file`, etc.).

Phase 5 introduces a lightweight convention on top of the directory:

- `<agent_id>.md` — per-agent artifact files (free-form, written by each agent).
- `state.md` — append-only narrative log. After substantive work, an agent
  should append a one-line entry prefixed with `[<agent_id> @ <iso-timestamp>]`
  summarizing what it did. This is taught to each session via the auto-appended
  swarm-protocol block in its system prompt.

The protocol block also tells sub-agents to call `swarm_status()` to
self-discover peers rather than relying on the orchestrator to re-inject context
each turn.

**Plan Mode compatibility.** Plan Mode's policy whitelist explicitly allows
`write_file` and `replace` inside the swarm dir (mirrors the existing plans-dir
allowance). This is the only writable area available to swarm sub-agents while
the orchestrator is in Plan Mode.

**Recommended pattern.** To avoid the "orchestrator-as-secretary" anti-pattern
(orchestrator copy-pasting JSON blobs between sub-agents), have each spawned
agent write its analysis to `<dir>/<its-name>.md` and have downstream agents
`read_file` instead. The orchestrator's job becomes routing instructions, not
relaying multi-kB payloads. Example:

```
swarm spawn sonnet-1 → "Analyze packages/core/src/agents/anthropic-loop.ts and write your findings to <swarm_dir>/sonnet-1.md"
swarm spawn sonnet-2 → "Read <swarm_dir>/sonnet-1.md and propose 3 alternative refactors. Write to <swarm_dir>/sonnet-2.md"
orchestrator: read_file <swarm_dir>/sonnet-2.md → final synthesis
```

Cross-pollination remains a paste-verbatim handoff (the orchestrator must
literally re-quote artifact contents in the receiving agent's prompt) when
sub-agents need _short_ mutual context — the shared dir is the right tool for
_long_ artifacts. See `.gemini/skills/swarm-collaboration/SKILL.md` (this repo)
for the codified rules. Distinct from `async-pr-review`, which uses
out-of-process `gemini -p` workers in worktrees rather than the in-process
swarm.

The full design discussion and locked acceptance test live in
`/home/shawnlee/gemini-fork/design-loop/swarm-design.md`. The continuity gate
(`packages/core/src/agents/swarm/swarm-continuity.test.ts`) proves that prior
turns persist into the next `message` call.

### Spawn-time policy scoping (v1.x Scope Bridge)

In addition to `tools: string[]`, `spawn` accepts `policy: PolicyRule[]` (up to
50 rules per spawn) — each rule is stamped with `subagent: <agent_id>` and
inserted into the `PolicyEngine` at tier 2 (`EXTENSION_POLICY_TIER`, well below
the user ceiling at tier 4). The rules are removed when the session is released.
Use this when you want to tighten the orchestrator's general permissions for a
specific sub-agent's role. Example:

```json
{
  "action": "spawn",
  "role": "doc-writer",
  "system_prompt": "You write docs only.",
  "policy": [
    { "toolName": "write_file", "argsPattern": "\\.md$", "decision": "allow" },
    {
      "toolName": "shell",
      "decision": "deny",
      "denyMessage": "doc-writer does not run shell"
    }
  ]
}
```

A sidecar `<repo>/.gemini/swarm-policy.toml` is loaded alongside
`.gemini/policies/` at workspace startup; its rules apply to all spawned
sub-agents (any rule without an explicit `subagent` gets `subagent='*'` stamped
on it, which the engine treats as a wildcard matching every non-empty caller
subagent).

The `/audit <agent_id>` slash command renders the effective policy + recent
activity for one live swarm sub-agent.

### P1 safety caps (v1.x)

- `max_turns` on `spawn` is capped at 50.
- Up to 8 simultaneous swarm sessions per CLI process. `spawn` rejects with
  `Cannot spawn: 8 concurrent swarm sessions already running.` if you hit the
  cap; release one to free capacity.

## Auth / ToS reminders

Never use the OAuth path for automation. Code Assist telemetry hardcodes
`isAgentic: true` and Google's own ToS at
[geminicli.com](https://geminicli.com/docs/resources/tos-privacy/) explicitly
forbids third-party tools accessing Code Assist via Gemini CLI OAuth. For any
swarm/headless workload, use `GEMINI_API_KEY` (paid) or Vertex AI.

## Live testing from outside the repo

To exercise the swarm primitive against real coding work — not the in-process
vitest mocks — use the out-of-workspace test harness at
[`test-harness/`](./test-harness/). Human-facing walkthrough lives in
[`TESTING.md`](./TESTING.md). Summary:

- `~/.local/bin/gemini-fork` launcher runs this repo's `bundle/gemini.js` while
  leaving the upstream `gemini` 0.42 on PATH alone.
- `test-harness/harness.sh new <scenario>` creates a fresh sandbox at
  `~/swarm-test/runs/<scenario>-<ts>/` with seed code, `.gemini/settings.json`
  (swarm enabled, OAuth), and `.env` (`ANTHROPIC_API_KEY` copied from the fork's
  parent `.env`).
- User then `cd`s into the sandbox, runs `gemini-fork` interactively (OAuth
  orchestrator), pastes the prompt from `PROMPT.md`, exits.
- `test-harness/harness.sh analyze latest` parses the matching chat record under
  `~/.gemini/tmp/<project>/chats/` and prints tool-call frequencies,
  per-swarm-action summaries, and the final orchestrator message.

Built-in scenarios: `swarm-review` (2-agent code review of seeded buggy TS,
exercises Phase 5 spawn/message/release + Phase 6 `/audit`) and `policy-scope`
(1-agent doc-writer with explicit `policy: PolicyRule[]`, exercises Phase 6
spawn-time policy field + runtime engine denial).

**Automation gap.** Orchestrator turn still requires a human (OAuth + paste).
Harness automates setup and post-mortem only. Headless end-to-end would need
`GEMINI_API_KEY` / Vertex ADC — deferred.

## Build / test cheatsheet

```bash
npm install                                                # once
npm run build                                              # full
npm run build --workspace=packages/cli                     # cli only
npm run typecheck                                          # all workspaces
node scripts/lint.js --eslint
node scripts/lint.js --prettier
npm run test:ci                                            # full CI suite
npx vitest run packages/cli/src/<file>.test.ts             # single file
node packages/cli/dist/index.js --help                     # smoke
```

## Known gotchas

- **Project-scoped agents need TUI acknowledgment.** Headless verification of an
  agent definition must use `~/.claude/agents/` (user scope) — project-scoped
  (`<project>/.claude/agents/`) require interactive approval that `-p` mode
  cannot grant.
- **Workspace hooks need `--skip-trust`.** Without our PR #27137 (or its
  upstream successor), workspace `.gemini/settings.json` hooks silently drop.
  Our `personal` branch carries the fix so they work locally; upstream `main`
  does not yet.
- **Pre-commit hook runs prettier + eslint --fix on staged files.** This may add
  unstaged modifications to files you didn't touch; review before pushing.
