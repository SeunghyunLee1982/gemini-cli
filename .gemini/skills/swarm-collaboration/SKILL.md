---
name: swarm-collaboration
description:
  Use this skill when orchestrating the experimental `swarm` tool (multiple
  long-lived Claude sub-agents in one CLI session). It codifies the
  paste-verbatim cross-pollination rule, the shared-workspace pattern, and
  the anti-patterns that turn the orchestrator into a glorified secretary.
  Trigger on phrases like "spawn a swarm", "swarm agents", "orchestrate
  multiple sub-agents", or whenever the `swarm` tool is in play.
---

# Swarm Collaboration

This skill governs how the Gemini orchestrator manages a swarm of Claude
sub-agents (spawned via the `swarm` tool, see `CLAUDE.md` "Swarm v1.0").

The swarm primitive is intentionally narrow — sub-agents are **isolated by
default**: they share the global `MessageBus`, but each session has its own
`messages` array, its own tool registry clone, and no direct access to the
others' state. Cross-pollination requires the orchestrator (you) to act as
a deliberate router.

## Two communication patterns — pick the right one

### Pattern A: paste-verbatim handoff (for SHORT artifacts)

When sub-agent A produces a small, self-contained result that sub-agent B
needs to react to, copy A's output **literally** into B's prompt. Do not
summarize, paraphrase, or compress.

```
swarm action=message agent_id=sonnet-1 prompt="Audit the imports in foo.ts"
  → response: "Found 3 unused imports: a, b, c."

swarm action=message agent_id=sonnet-2 prompt="Another agent reported the
  following finding verbatim: <<<Found 3 unused imports: a, b, c.>>>
  Confirm or refute by running the linter."
```

**Why verbatim?** Summarization at the orchestrator layer is the #1 source of
hallucination cascades. The receiving agent must see what was actually said,
not your gloss. If A's response is so long that verbatim quoting balloons the
context, switch to Pattern B.

### Pattern B: shared workspace (for LONG artifacts)

The `SwarmManager` automatically creates a shared scratch directory at
`<project>/.gemini/tmp/<session-id>/swarm/` on first spawn. **All sub-agents
in the current session see the same directory** through their standard file
tools (`write_file`, `read_file`, `grep_search`, etc.).

Use the workspace when:

1. A sub-agent's output is more than ~500 tokens.
2. Multiple sub-agents need to compare findings against the same artifact.
3. You want a durable audit trail of who said what.

```
swarm action=spawn model=sonnet system_prompt="..."  → sonnet-1
swarm action=message agent_id=sonnet-1 prompt="Analyze packages/core/src/X.
  Write your full findings to <swarm_dir>/sonnet-1-analysis.md. Reply here
  with only the file path."

swarm action=spawn model=sonnet system_prompt="..."  → sonnet-2
swarm action=message agent_id=sonnet-2 prompt="Read
  <swarm_dir>/sonnet-1-analysis.md. Propose 3 alternative refactors. Write
  full proposals to <swarm_dir>/sonnet-2-proposals.md."

# Orchestrator (you) reads <swarm_dir>/sonnet-2-proposals.md directly when
# composing the final synthesis. No need to feed it back through any
# sub-agent.
```

**Naming convention.** `<agent_id>-<topic>.md` so files are
self-attributing. Multiple files per agent are fine.

**Plan Mode compatibility.** Plan Mode's policy whitelist explicitly allows
`write_file`/`replace` inside the swarm dir. It is the **only** writable
area available to sub-agents while the orchestrator is in Plan Mode — use
it instead of trying to write source files.

## Anti-patterns to avoid

### 1. Orchestrator-as-secretary

```
# BAD
swarm message sonnet-1 → "give me your full analysis"
  → 2000-token response
orchestrator: forwards full 2000 tokens to sonnet-2 in next prompt
  → another 2000-token response
orchestrator: forwards both to sonnet-3 ...
```

The orchestrator's context becomes a paste-buffer. After 3 hops the context
window is half-full and the orchestrator's own reasoning suffers. **Fix:** use
the shared workspace for long outputs (Pattern B).

### 2. Summarization at the orchestrator layer

```
# BAD
sonnet-1 says "The function has 3 bugs at lines 42, 87, and 113."
orchestrator paraphrases to sonnet-2: "sonnet-1 found some bugs."
```

The receiving agent now has no way to act on the original signal. **Fix:**
quote verbatim (Pattern A) or hand off via file (Pattern B).

### 3. "Previous turn" references

```
# BAD
swarm message sonnet-1 → "What did you find?"
swarm message sonnet-2 → "Compare your findings to what the previous agent
  found."
```

sonnet-2 has no shared turn history with sonnet-1. **Fix:** quote sonnet-1's
response verbatim, or point sonnet-2 at a file sonnet-1 wrote.

### 4. Asking sub-agents to coordinate among themselves

Sub-agents cannot directly message each other — only the orchestrator can
`swarm message <agent_id>`. Do not write prompts that assume otherwise
("Ask the other agent if it agrees" — wrong; you ask, and you relay).

## Lifecycle hygiene

- **Release agents when done.** `swarm action=release agent_id=<id>` frees
  the session immediately. Idle TTL is 30 minutes, but explicit release is
  cheaper.
- **Don't spawn parallel agents for the same task.** v1.0 is synchronous —
  spawning N agents only helps if they have different prompts/roles.
- **Check `swarm action=list` between turns** if you've lost track. The
  display name field on `spawn` (if set) makes the list more readable.

## Interaction with the `async-pr-review` skill

`async-pr-review` (in this fork's `.gemini/skills/`) uses a **different
asynchrony model**: it spawns out-of-process `gemini -p` headless workers
inside git worktrees. It does NOT use the in-process `swarm` tool. The two
are complementary: use `async-pr-review` for long-running CI-style background
jobs, and `swarm` for fast in-context collaboration during a single
interactive session.

Specifically: never invoke the `swarm` tool from inside an `async-pr-review`
worker. The worker is itself a short-lived headless agent; spinning up a
nested swarm inside it pays the cost twice without the interactive benefits.

## Self-discovery via `swarm_status`

Each spawned agent has a `swarm_status` tool that returns:
- `agents[]`: every live swarm session with `role`, `charter`, `status`, `turn_count`, `seconds_since_active`
- `workspace_dir`: path to the shared scratchpad
- `recent_events[]`: up to 50 newest-first spawn/message/release events

Use it at the start of any non-trivial task to understand the team context.
Sub-agents should NOT assume their last-turn observations are current — the
world may have moved while they were idle.

## Shared narrative log: `state.md`

The shared workspace `<workspace_dir>` (look up via `swarm_status()`) contains:
- `<agent_id>.md` — per-agent artifact files (free-form, written by each agent)
- `state.md` — append-only narrative log. After substantive work, append one
  line prefixed with `[<agent_id> @ <iso-timestamp>]` summarizing what you did.

## Release on role-exhaustion

Orchestrators: `release` a swarm agent when its **role** is exhausted, not
when a single task is complete. A reviewer that completed one review may
still be needed for follow-ups. Idle TTL (30 min) sweeps forgotten sessions
on its own; manual release is for explicit role-end transitions.

## Cap handling

When `message` returns `status: 'message_turn_cap_reached'`, the session is
still alive. Decide explicitly: send a `"continue"` message to resume, or
release if the work isn't worth continuing. Never assume cap = failure.
