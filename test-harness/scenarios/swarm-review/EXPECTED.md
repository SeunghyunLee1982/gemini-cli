# Expected behavior — swarm-review

Use `harness.sh analyze latest` after the session ends. Look for:

## Swarm tool calls (expected sequence)

1. `swarm` spawn × 2 (sonnet, opus). Each call should carry `role` and `charter`
   fields. v1.x: no `policy` field needed here (this scenario tests default
   behavior; `swarm-policy` scenario covers the policy path).
2. `swarm_status` calls (likely from sub-agents at message start, to discover
   `<swarm_dir>` and peer agent metadata).
3. `swarm` message × N (one per turn delegated to each agent).
4. `swarm` list (orchestrator confirming agent IDs before audit).
5. `swarm` release × 2.

## Audit output (manually verified in TUI)

`/audit <agent_id>` should render:

- Session metadata (status, role, model, turn count)
- "Effective policy" section. v1.x: when no `policy` field was passed at spawn,
  this should show only inherited rules (workspace + sidecar). If no
  `.gemini/swarm-policy.toml` is present, only the always-on rules appear (e.g.,
  `enter_plan_mode`/`exit_plan_mode` filtered).
- Recent events filtered to that agent.

## Found bugs (seed code has 4 intentional issues)

Severity-ordered final synthesis should mention:

- **SECURITY** unparameterized SQL in `findUserByEmail` (string concat `email`)
- **LEAK** `subscribe()` registers listener but never removes on `disconnect()`
- **CORRECTNESS** `lookupUser` swallows DB errors → callers can't distinguish
  "no user" from "DB down"
- **PERFORMANCE** `usersInGroup` pulls all users then filters in JS

Bonus: reviewers should avoid double-reporting (opus reads correctness.md first
per the prompt).

## Bugs to look out for

- "Starting..." stuck in TUI → Phase 5.1 fix in place; should NOT happen
- `invalid_request_error` on continue → Phase 5.1 drain in place
- 9th swarm spawn rejected with MAX_SWARM_SESSIONS=8 → not exercised here (only
  2 agents)
- TUI shows "Requested by sub-agent ..." on any tool confirmation (Phase 4
  attribution)
