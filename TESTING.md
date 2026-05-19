# Testing the fork against real coding work

This fork carries Claude Code–style ergonomics + an experimental swarm primitive
on top of upstream `google-gemini/gemini-cli`. To exercise the swarm against
actual coding work — not just `npx vitest` unit suites — the repo ships a small
**out-of-workspace test harness** at [`test-harness/`](./test-harness/).

The harness lets you launch the fork from any directory (not just inside this
repo), run scripted scenarios against a clean sandbox, and post-mortem the
resulting chat record. Upstream `gemini` 0.42 on your PATH stays untouched.

## One-time setup

1. **Launchers.** Two bash wrappers at `~/.local/bin/`:
   - `gemini-fork` — `exec`s the fork's `bundle/gemini.js`.
   - `gemini-fork-harness` — `exec`s `test-harness/harness.sh` so you can drive
     it from anywhere (e.g., from inside a freshly-created sandbox dir).

   Confirm both on PATH:

   ```bash
   which gemini-fork              # → ~/.local/bin/gemini-fork
   gemini-fork --version          # → 0.44.x-nightly... (the fork)
   which gemini                   # → some upstream-managed path (0.42)
   which gemini-fork-harness      # → ~/.local/bin/gemini-fork-harness
   ```

2. **Build at least once.** From the repo root:

   ```bash
   npm install
   npm run build
   ```

   The fork's bundle gets rebuilt by `npm run build`. Pass `GEMINI_FORK_BUILD=1`
   to `gemini-fork` to rebuild on launch.

3. **API key.** Swarm sub-agents need `ANTHROPIC_API_KEY`. The harness copies it
   from this repo's `.env` (one directory up from the repo root by default) into
   each sandbox automatically. If your key lives elsewhere, edit the sandbox's
   `.env` after `gemini-fork-harness new` and before launching.

4. **Orchestrator auth.** Currently interactive OAuth — the fork's default.
   First `gemini-fork` invocation opens a browser for Google auth, then caches
   the token for subsequent runs. Fully-headless automation will require
   switching to `GEMINI_API_KEY` or Vertex ADC; deferred.

## Scenario run cycle

```bash
# 1. Create a fresh sandbox for one scenario. (From anywhere — the
#    global launcher works from any cwd.)
gemini-fork-harness new swarm-review

#    Prints the sandbox dir, e.g.
#    ~/gemini-fork/sandboxes/swarm-review-20260519-023335/

# 2. Move into the sandbox.
cd ~/gemini-fork/sandboxes/swarm-review-20260519-023335/

# 3. Launch interactively.
gemini-fork

# 4. Paste the prompt from PROMPT.md verbatim. Work through the
#    scenario; the prompt walks the orchestrator through swarm spawn,
#    message, audit, release.

# 5. Exit the session.

# 6. Post-mortem the chat record. Still in the sandbox cwd? — the
#    global launcher resolves the harness regardless of where you are.
gemini-fork-harness analyze latest
```

`gemini-fork-harness analyze` reads the matching gemini chat record from
`~/.gemini/tmp/<project>/chats/<session>.jsonl` and prints:

- Total record count
- Tool-call frequency (with `swarm` / `swarm_status` highlighted)
- Per-swarm-action summary: action (spawn/message/release/list), agent id, role,
  policy-rule count when present, success/error
- Last orchestrator message (truncated to 1000 chars)

Cross-reference against the scenario's `EXPECTED.md` to confirm the swarm
behaved correctly.

## Built-in scenarios

| ID             | What it exercises                                                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `swarm-review` | 2-agent code review (sonnet + opus) of a small TypeScript file with 4 seeded issues. Tests Phase 5 spawn/message/release, shared workspace + `state.md` pattern, Phase 6 `/audit`.      |
| `policy-scope` | 1-agent doc-writer with explicit `policy: PolicyRule[]` at spawn (allow `.md` writes, deny shell, deny other writes). Tests Phase 6 spawn-time policy field + runtime engine denial UI. |

Each scenario directory under `test-harness/scenarios/<id>/` has:

- `SEED/` — files copied verbatim into the sandbox
- `PROMPT.md` — paste this into the orchestrator session
- `EXPECTED.md` — checklist of what to verify in the analysis output and on disk
  after the run
- `EXTRA_SKILLS` (optional) — newline-separated list of skill dirs to copy from
  `<repo>/.gemini/skills/` into the sandbox's `.gemini/skills/`. The
  `swarm-collaboration` skill is always copied; list anything else the scenario
  benefits from (e.g. `code-reviewer` for review scenarios).

## Authoring a new scenario

```bash
mkdir -p test-harness/scenarios/<name>/SEED
# ... drop seed files into SEED/ ...
# Write PROMPT.md (the orchestrator instruction)
# Write EXPECTED.md (regression checklist)
```

Re-run `gemini-fork-harness new <name>` to spin a sandbox. No code in the
harness needs to change for new scenarios.

## Sandbox layout

Each run creates:

```
~/gemini-fork/sandboxes/<scenario>-<YYYYMMDD-HHMMSS>/
├── .gemini/
│   ├── settings.json   # experimental.swarm=true + OAuth
│   └── skills/
│       ├── swarm-collaboration/    # always copied (state.md + release rules)
│       └── <extra>/                # per scenario's EXTRA_SKILLS
├── .env                # ANTHROPIC_API_KEY for swarm sub-agents
├── PROMPT.md           # copy of the scenario prompt
├── EXPECTED.md         # copy of what to verify
└── <SEED files>
```

Sandboxes are persistent (not auto-cleaned) so you can poke at the filesystem
after — e.g. the policy-scope scenario should leave a rewritten `README.md` and
**no** `bench.ts` (which the engine should have denied). Clean up manually when
desired.

## Limits of the current automation

- The orchestrator turn still requires a human (interactive OAuth + pasting the
  prompt). The harness automates **setup** (sandbox scaffolding, env, settings)
  and **post-mortem** (chat-record parsing) — the loop in between is manual for
  now.
- `EXPECTED.md` is a human checklist, not auto-asserted. Adding a pass/fail
  layer over the `analyze` output is the natural next step if/when the
  orchestrator is wired for headless invocation.

## Why a separate harness rather than `npx vitest`

The unit suites (`packages/core/src/agents/swarm/*.test.ts` etc.) mock the
Anthropic API and cover correctness of the primitive in-process. They do **not**
cover orchestrator UX, real OAuth, real chat-record persistence, real filesystem
effects, or interactive TUI behavior — for example the Phase 5.1 "Starting..."
progress fix, Phase 4 authority attribution prompts, or the `/audit` slash
command's rendering.

The harness drives the real bundle end-to-end. Each scenario doubles as an
integration regression for the matching feature commit.
