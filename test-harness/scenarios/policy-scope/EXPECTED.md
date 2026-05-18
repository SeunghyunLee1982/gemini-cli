# Expected behavior — policy-scope

This scenario specifically exercises Phase 6's policy field + engine
enforcement. Run `harness.sh analyze latest` after the session ends.

## Swarm tool calls (expected sequence)

1. `swarm` spawn × 1 with **`policy` field present** (3 rules). Analyze output
   should show `[policy.rules=3]` on the spawn call.
2. `swarm` message × N (write README, attempt bench.ts, attempt shell).
3. `swarm` list (before `/audit`).
4. `swarm` release × 1.

## `/audit doc-writer-1` (manually verified)

Effective policy should contain:

- `write_file` allow with `argsPattern` matching `.md$` (highest of the 3
  per-rule priorities — 2.02)
- `write_file` deny (priority 2.01)
- `run_shell_command` deny (priority 2.00)
- Plus any inherited workspace/sidecar/user rules.

All three orchestrator-authored rules should have `subagent: doc-writer-1` and
`source: swarm:doc-writer-1:spawn` (rendered in the audit output).

## Sandbox filesystem after run

- `README.md` should be rewritten (sensible content derived from `calc.ts`)
- NO `bench.ts` should exist
- NO files outside `.md` extension created by the sub-agent

## Engine denials surfaced to orchestrator

The orchestrator should see, in its tool_result for the policy-blocked calls:

- `write_file bench.ts` → deny message "doc-writer can only write Markdown
  files" (the second rule's `denyMessage`)
- `run_shell_command ls` → deny message "doc-writer does not run shell"

## Bugs to look out for

- Sub-agent inheriting `tools` and bypassing policy → would mean the engine
  wiring is broken (Phase 6 Area 2). Don't expect this.
- Orchestrator forced into a `request_capability` flow → would mean v2 code
  leaked into v1.x (not implemented yet — expect this NOT to happen).
- `/audit` showing only the inherited rules (none of the spawn-time policy) →
  would mean tier 2 insertion broken or `removeRulesBySource` firing too
  eagerly. Should not happen.
