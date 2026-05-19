# Fork guide

A guide for a new collaborator joining this fork of `google-gemini/gemini-cli`.
Pairs with the deeper docs:

- [`CLAUDE.md`](./CLAUDE.md) — branch strategy, fork-only additions
  (line-by-line summary), shipped phases, auth/ToS rules. Read this before
  touching the swarm code.
- [`TESTING.md`](./TESTING.md) — how to drive live tests from outside the repo
  via the test harness.
- [`design-loop/swarm-north-star.md`](./design-loop/swarm-north-star.md) — the
  LOCKED long-term architecture (5-tier policy bands, `PolicyRule[]` capability,
  `BehaviorConfig`, v2/v3 roadmap).
- [`design-loop/swarm-orchestrator-disposition.md`](./design-loop/swarm-orchestrator-disposition.md)
  — the LOCKED Phase 8 design (tool descriptions, system-prompt disposition
  block, auto-inlined skill, tier-1 deny rule).

GitHub Issues on this repo track outstanding work — see the issue list at the
project page.

## What this fork is

A personal fork of `google-gemini/gemini-cli` carrying Claude Code–style
ergonomics on top of upstream. Two reasons to exist:

1. **Claude outage fallback.** When `claude` is unreliable, this fork's
   `anthropic-agent` kind + the `swarm` primitive let a Gemini orchestrator
   drive long-lived Claude sub-agents in-process via the Anthropic SDK.
2. **Tinkering surface.** Vendor-agnostic skill/agent discovery (`.agents/` →
   `.claude/` → `.gemini/`), CLI ergonomics (`--system-prompt`,
   `--system-prompt-file`), hook-name normalization, etc.

Apache 2.0; no GPL/other-license code introduced.

## Branch strategy at a glance

| Branch                         | Role                                                                                     | Modify?                 |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------- |
| `main` → `upstream/main`       | Pristine upstream mirror. Always FF.                                                     | **NO**                  |
| `personal`                     | Daily driver. All fork-only changes live here.                                           | YES                     |
| `fix/<topic>` / `feat/<topic>` | Branches intended for an upstream PR. **Always cut from `main`, never from `personal`.** | YES (minimal diff only) |

See `CLAUDE.md` "Branch strategy" section for the full details + worked git
commands.

## What's already on `personal` (high-level)

Roughly in commit order, most recent last:

- `feat: add Claude Code-style ergonomics` — CLI flags (`--system-prompt`,
  etc.), vendor-agnostic discovery (`.claude/` ↔ `.gemini/` fallback,
  `AGENTS.md` ↔ `CLAUDE.md` ↔ `GEMINI.md` fallback).
- `feat(agents): add anthropic agent kind` — `kind: anthropic` agent loader,
  `@anthropic-ai/sdk` bridge, `sonnet` / `opus` aliases (haiku intentionally
  excluded on `personal`).
- `feat(agents): swarm phase 4–8` — the experimental swarm primitive. Persistent
  multi-agent sessions, role/charter, `swarm_status`, shared workspace dir +
  `state.md` convention, Phase 4 authority attribution, Phase 5.1 cap-drain,
  Phase 6 `policy: PolicyRule[]` + `/audit` slash command + P1 caps
  (`max_turns ≤ 50`, `MAX_SWARM_SESSIONS = 8`), Phase 8 orchestrator disposition
  block + auto-inlined SKILL.md + tier-1 recursive-`gemini` deny rule.
- `docs(swarm): lock north-star architecture` — `design-loop/` LOCKED design
  docs (R1–R5 multi-model debates settled).
- `test-harness: ...` — out-of-workspace sandbox runner + 2 built- in
  scenarios + `gemini-fork-harness analyze` chat-record post-mortem with Phase
  fingerprint + anti-pattern detectors.
- `fix(cli): make --skip-trust actually load workspace settings` — also filed
  upstream as `google-gemini/gemini-cli#27137`. Will become a no-op on
  `personal` once upstream merges and we rebase.

## Onboarding a new collaborator

### 0. Clone

```bash
git clone git@github.com:SeunghyunLee1982/gemini-cli.git
cd gemini-cli
git remote add upstream https://github.com/google-gemini/gemini-cli.git
git fetch upstream
git checkout personal
```

### 1. Install + build

```bash
npm install
npm run bundle           # ← writes bundle/gemini.js (the executable)
# NOT `npm run build` — that only writes packages/*/dist/.
# See TESTING.md "Build the executable bundle" callout.
```

### 2. Set up the personal launchers

These two shims are personal to each machine (not tracked in git). Recreate them
on a fresh machine:

```bash
# 1) gemini-fork — runs the fork's bundle instead of upstream gemini.
cat > ~/.local/bin/gemini-fork <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
GEMINI_FORK_ROOT="${GEMINI_FORK_ROOT:-$HOME/path/to/gemini-cli}"
BUNDLE="$GEMINI_FORK_ROOT/bundle/gemini.js"
[[ "${GEMINI_FORK_BUILD:-0}" == "1" ]] && \
  (cd "$GEMINI_FORK_ROOT" && npm run bundle) >&2
[[ -x "$BUNDLE" ]] || { echo "bundle missing; run npm run bundle"; exit 1; }
if [[ "${GEMINI_FORK_NO_CHECK:-0}" != "1" ]]; then
  b=$(stat -c '%Y' "$BUNDLE" 2>/dev/null || echo 0)
  s=$(find "$GEMINI_FORK_ROOT/packages/core/src" \
            "$GEMINI_FORK_ROOT/packages/cli/src" \
            -type f \( -name '*.ts' -o -name '*.tsx' \) \
            -printf '%T@\n' 2>/dev/null \
        | sort -n | tail -1 | cut -d. -f1)
  [[ -n "$s" && "$s" -gt "$b" ]] && \
    echo "[gemini-fork] WARNING: bundle is stale; run npm run bundle" >&2
fi
exec node "$BUNDLE" "$@"
WRAPPER
chmod +x ~/.local/bin/gemini-fork

# 2) gemini-fork-harness — runs the test harness from anywhere.
cat > ~/.local/bin/gemini-fork-harness <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
GEMINI_FORK_HARNESS_ROOT="${GEMINI_FORK_HARNESS_ROOT:-$HOME/path/to/gemini-cli/test-harness}"
exec "$GEMINI_FORK_HARNESS_ROOT/harness.sh" "$@"
WRAPPER
chmod +x ~/.local/bin/gemini-fork-harness
```

Replace `$HOME/path/to/gemini-cli` with the actual clone path (the original
author has it at `/home/shawnlee/gemini-fork/gemini-cli`). `~/.local/bin` must
be on `PATH`.

### 3. Auth

The fork uses two distinct credentials:

| Credential                    | Used by              | How to set                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator (Gemini)         | `gemini-fork` itself | OAuth interactive (default), `GEMINI_API_KEY` (paid), or Vertex ADC. **OAuth must not be used for headless/automation** — Code Assist telemetry hardcodes `isAgentic: true` and Google's ToS forbids it. See `CLAUDE.md` "Auth / ToS reminders". For company environments where headless is required, use Vertex AI (issue #X tracks setup docs). |
| Sub-agents (Anthropic Claude) | the swarm spawn path | `ANTHROPIC_API_KEY` env var. The fork's `findEnvFile` walks up from cwd; put the key in any `.env` along that chain.                                                                                                                                                                                                                              |

### 4. Run a live test

```bash
gemini-fork-harness new swarm-review
cd ~/gemini-fork/sandboxes/swarm-review-<ts>/
gemini-fork                                    # interactive OAuth on first launch
# paste prompt from PROMPT.md, work through, exit
gemini-fork-harness analyze latest             # post-mortem
```

See [`TESTING.md`](./TESTING.md) for the full scenario run cycle. The harness
writes sandboxes under `~/gemini-fork/sandboxes/`; chat records land in
`~/.gemini/tmp/<sandbox-name>/chats/`.

### 5. Working on the swarm code

1. Read [`design-loop/swarm-north-star.md`](./design-loop/swarm-north-star.md)
   first — it defines the v2/v3 reservations any change must not violate.
2. Read the Phase doc relevant to your change
   (`design-loop/swarm-orchestrator-disposition.md` for Phase 8, or the
   corresponding section of `CLAUDE.md` "Swarm v1.0" for Phases 4–6).
3. Multi-model design debate (Opus + Gemini) on any LOCKED change. The R1–R5
   docs under `design-loop/` are the precedent.
4. Implementation → typecheck/lint/build/test gates → ≥1 reviewer per angle
   (TS/cleancode, intent, tests/abstraction) → commit on `personal`.

## Known issues / outstanding work

Tracked as GitHub Issues on this repo. Categories:

- **Bugs & follow-ups** — Phase 5.2 drain leak, Phase 6 / 8 cleanups.
- **Observation / UX** — "thinking…" stuck reproduction, PROMPT.md
  pause-for-/audit verification.
- **Auth & automation** — Vertex / `GEMINI_API_KEY` orchestrator path for
  company environments; full-headless harness.
- **North star v2** — `CapabilityTemplate` registry + `swarm.amend_policy` +
  `BehaviorConfig` runtime monitor.
- **North star v3** — `agent.spawn` unification, delete the swarm tool.
- **Integrations** — `agent-memory` MCP RAG layer (v1.2+).

See the project Issues tab for the live list.

## Auth / ToS reminders (critical)

- **Never use OAuth for headless / automated workloads.** Code Assist's
  `isAgentic: true` telemetry plus Google's geminicli.com ToS forbid it for
  third-party tools. Headless paths must use `GEMINI_API_KEY` (paid) or Vertex
  AI. Interactive OAuth from a real human at a terminal is fine.
- **Haiku-class Claude models are intentionally excluded** on `personal` (sonnet
  / opus only for review-class work).
- **`ANTHROPIC_API_KEY` only** for swarm sub-agents; no Anthropic OAuth path.

## Layout

```
gemini-cli/
├── README.md                    # upstream README (don't modify)
├── CLAUDE.md                    # fork's branch strategy + Phase 4-8 docs (this is the orchestrator's project memory)
├── TESTING.md                   # live-test walkthrough
├── FORK-GUIDE.md                # this file
├── design-loop/
│   ├── swarm-north-star.md            # LOCKED long-term architecture
│   ├── swarm-orchestrator-disposition.md  # LOCKED Phase 8
│   └── (R-round briefings + responses are gitignored)
├── packages/
│   └── core/src/agents/swarm/   # the swarm primitive
├── test-harness/
│   ├── README.md
│   ├── harness.sh               # the analyzer
│   └── scenarios/
│       ├── swarm-review/
│       └── policy-scope/
└── .gemini/skills/
    └── swarm-collaboration/SKILL.md   # auto-inlined when swarm is enabled
```

## Getting help

The original author (`@SeunghyunLee1982` on GitHub) is the primary contact. The
design-loop docs + GitHub Issues should cover most of the "why is this like
that" questions. For deeper context, the R-round design discussions under
`design-loop/` are left local-only (gitignored) so they don't leak through PRs —
ask the author to share them directly if you need to see the rejected
alternatives behind a LOCKED decision.
