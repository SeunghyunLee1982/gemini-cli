# test-harness

Out-of-workspace test harness for the personal fork's experimental swarm
primitive. Lets you spin up a clean sandbox (separate from this repo), launch
`gemini-fork` interactively against it, then post-mortem the chat record.

## Prerequisites (one-time)

1. **Launcher.** `~/.local/bin/gemini-fork` exists and runs the latest
   `bundle/gemini.js` from this repo. If missing, see the launcher script at
   `~/.local/bin/gemini-fork`. (PATH must include `~/.local/bin`.)
2. **Build.** Run `npm run build` once after pulling new commits, or prepend
   `GEMINI_FORK_BUILD=1` to a single `gemini-fork` invocation to rebuild on
   launch.
3. **API key.** The fork looks for a `.env` in the sandbox first.
   `harness.sh new` copies `ANTHROPIC_API_KEY` from the fork's own `.env` (one
   level above this repo) into each sandbox. If your key lives elsewhere,
   override by editing the sandbox's `.env` before launching.
4. **Orchestrator auth.** Interactive OAuth (the fork's default). First launch
   will prompt for browser auth; subsequent launches reuse the cached token.

## Usage

```bash
# 1. List available scenarios
ls test-harness/scenarios/

# 2. Spin up a fresh sandbox for one scenario
test-harness/harness.sh new swarm-review

# 3. Run the interactive session from the sandbox dir
cd ~/gemini-fork/sandboxes/swarm-review-<timestamp>/
gemini-fork
# (paste prompt from PROMPT.md, work through scenario, exit)

# 4. Post-mortem the chat record
~/gemini-fork/gemini-cli/test-harness/harness.sh analyze latest
```

`analyze latest` walks the most recent gemini chat record under
`~/.gemini/tmp/*/chats/` matching the sandbox name. It prints:

- total record count
- tool call frequency (with swarm/swarm_status highlighted)
- per-swarm-action summary (spawn / message / release IDs, role, policy-rule
  count)
- swarm result OK/error per call
- last orchestrator message (truncated to 1000 chars)

## Scenarios

- **`swarm-review`** — 2-agent code review (sonnet + opus) of an
  intentionally-buggy `user-service.ts`. Exercises Phase 5 spawn / message /
  release, Phase 5 shared workspace + `state.md` pattern, Phase 6 `/audit`
  command.
- **`policy-scope`** — 1-agent doc-writer with explicit `policy: PolicyRule[]`
  at spawn (allow `.md` writes, deny shell, deny non-md writes). Tests Phase 6
  policy field round-trip, engine enforcement at runtime, `/audit` showing
  tier-2 rules.

Each scenario directory has `SEED/` (copied into sandbox), `PROMPT.md` (verbatim
instruction for the orchestrator), and `EXPECTED.md` (what to look for in the
analysis output).

## Adding a new scenario

```bash
mkdir -p test-harness/scenarios/<name>/SEED
# Put any seed files under SEED/ that you want copied verbatim into the
# sandbox.
# Write PROMPT.md (what to paste into gemini-fork)
# Write EXPECTED.md (what to look for in chat record / filesystem after)
```

## Sandbox layout

Each `harness.sh new <scenario>` creates:

```
~/gemini-fork/sandboxes/<scenario>-<YYYYMMDD-HHMMSS>/
├── .gemini/
│   └── settings.json          # experimental.swarm=true, OAuth
├── .env                       # ANTHROPIC_API_KEY (for swarm sub-agents)
├── PROMPT.md                  # copy of the scenario prompt
├── EXPECTED.md                # copy of what to verify
└── <seed files>               # whatever was in scenarios/<x>/SEED/
```

Sandboxes are persistent (not auto-deleted) so you can poke at the post-run
filesystem (`README.md` for policy-scope, etc.). Clean up manually when desired:

```bash
rm -rf ~/gemini-fork/sandboxes/*-<old-pattern>/
```
