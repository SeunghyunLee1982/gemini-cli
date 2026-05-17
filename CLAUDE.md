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
`tools` (defaults to the read-only whitelist), `max_turns` (default 5), and
`display_name`.

### Defaults

- **Tools.** Inherits the orchestrator's currently-registered toolset by default
  (mirrors Claude Code's Task tool). Agent-kind tools are filtered out to
  prevent recursive spawn. Wildcards are not allowed. Pass an explicit
  `tools: [...]` array on `spawn` to narrow the set — for example, the original
  read-only preset is
  `['read_file', 'grep_search', 'glob', 'list_directory', 'read_many_files']`
  (exported as `DEFAULT_SWARM_TOOLS`). Note: this default relies on v1.0's
  strictly synchronous `message` (only one agent runs at a time) to avoid
  concurrent-write races; v1.1 (async) must revisit before shipping parallel
  execution.
- **Idle TTL.** 30 minutes since last activity. Stale sessions are swept on a
  background timer. Sessions wedged in `running` past `2 * TTL` are aborted,
  marked `error`, and left in `list()` for debugging — the user must call
  `release` to remove them.
- **Abort.** Sessions are bound to the global app lifecycle (SIGINT / process
  exit / `release`), NOT to the orchestrator turn's signal — ending an
  orchestrator turn does not kill a swarm session.

### v1.0 scope

Sync only: `message` blocks until the session's turn completes. In-memory only:
sessions die with the parent CLI process. Single discriminated tool. No async /
shared workspace / budget caps in v1 — those are v1.1+.

The full design discussion and locked acceptance test live in
`/home/shawnlee/gemini-fork/design-loop/swarm-design.md`. The continuity gate
(`packages/core/src/agents/swarm/swarm-continuity.test.ts`) proves that prior
turns persist into the next `message` call.

## Auth / ToS reminders

Never use the OAuth path for automation. Code Assist telemetry hardcodes
`isAgentic: true` and Google's own ToS at
[geminicli.com](https://geminicli.com/docs/resources/tos-privacy/) explicitly
forbids third-party tools accessing Code Assist via Gemini CLI OAuth. For any
swarm/headless workload, use `GEMINI_API_KEY` (paid) or Vertex AI.

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
