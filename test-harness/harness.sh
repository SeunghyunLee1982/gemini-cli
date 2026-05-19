#!/usr/bin/env bash
# test-harness/harness.sh — driver for out-of-workspace swarm tests.
#
# Invoke either via the in-repo path (`./test-harness/harness.sh`) or via
# the global launcher `gemini-fork-harness` (lives at
# `~/.local/bin/gemini-fork-harness`, mirrors the `gemini-fork` pattern)
# which just `exec`s this script. Use the global one from sandbox
# directories where the repo isn't on the path.
#
# Subcommands:
#   gemini-fork-harness new <scenario>     Create a fresh sandbox under
#                                          ~/gemini-fork/sandboxes/<scenario>-<ts>/,
#                                          seed it, print the invocation
#                                          + prompt.
#   gemini-fork-harness analyze <run_dir>  Walk the latest gemini chat
#                                          record for that sandbox and
#                                          dump swarm tool calls + results.
#                                          Use `latest` as run_dir to pick
#                                          the most recent sandbox.
#   gemini-fork-harness list               Show past sandbox runs.
#
# All scenarios live in test-harness/scenarios/<scenario>/.
# Each has: SEED/ (copied into the sandbox), PROMPT.md (paste into the
# interactive session), EXPECTED.md (what to look for in the chat record).
#
# The orchestrator runs interactively (OAuth path). After the session ends
# the user runs `gemini-fork-harness analyze latest` to post-mortem the
# chat record.

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORK_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"
RUNS_ROOT="${SWARM_TEST_ROOT:-$HOME/gemini-fork/sandboxes}"
SCENARIO_ROOT="$HARNESS_DIR/scenarios"

# ---------------------------------------------------------------------------

cmd_new() {
  local scenario="${1:-}"
  if [[ -z "$scenario" ]]; then
    echo "usage: gemini-fork-harness new <scenario>" >&2
    echo "available scenarios:" >&2
    ls -1 "$SCENARIO_ROOT" >&2
    exit 1
  fi
  local src="$SCENARIO_ROOT/$scenario"
  if [[ ! -d "$src" ]]; then
    echo "harness: no scenario '$scenario' under $SCENARIO_ROOT" >&2
    exit 1
  fi

  local ts="$(date +%Y%m%d-%H%M%S)"
  local run="$RUNS_ROOT/$scenario-$ts"
  mkdir -p "$run"

  # 1. Seed code
  if [[ -d "$src/SEED" ]]; then
    cp -r "$src/SEED/." "$run/"
  fi

  # 2. .gemini/settings.json — swarm enabled, plan-mode allowed for testing,
  # auto-update disabled so a sandbox launch never spawns a background
  # `npm install -g @google/gemini-cli@nightly` that would clobber the
  # PATH `gemini` binary (the upstream one, NOT the fork — but we keep
  # things from changing under the user's feet during a test run).
  # See `packages/cli/src/utils/handleAutoUpdate.ts`.
  mkdir -p "$run/.gemini/skills"
  cat > "$run/.gemini/settings.json" <<'EOF'
{
  "experimental": {
    "swarm": true
  },
  "security": {
    "auth": {
      "selectedType": "oauth-personal"
    }
  },
  "general": {
    "enableAutoUpdate": false,
    "enableAutoUpdateNotification": false
  }
}
EOF

  # 2a. Copy the swarm-collaboration SKILL.md so the orchestrator sees
  # the state.md convention, release-on-role-exhaustion rule, and the
  # paste-verbatim discipline. Skills are loaded per workspace cwd (see
  # `packages/core/src/skills/skillManager.ts:98`) — without this file the
  # swarm tool still works but the orchestrator misses the protocol
  # guidance. Always copied.
  local repo_skills="$FORK_ROOT/.gemini/skills"
  if [[ -d "$repo_skills/swarm-collaboration" ]]; then
    cp -r "$repo_skills/swarm-collaboration" "$run/.gemini/skills/"
  fi

  # 2b. Per-scenario extra skills. If the scenario ships an EXTRA_SKILLS
  # file (one skill-dir name per line, lines starting with `#` ignored),
  # copy each from <repo>/.gemini/skills/ into the sandbox so the
  # orchestrator can activate them. Useful when a scenario benefits from
  # e.g. the upstream `code-reviewer` skill — opt-in per scenario, not
  # blanket-imported.
  if [[ -f "$src/EXTRA_SKILLS" ]]; then
    while IFS= read -r skill_name; do
      [[ -z "$skill_name" || "$skill_name" == \#* ]] && continue
      if [[ -d "$repo_skills/$skill_name" ]]; then
        cp -r "$repo_skills/$skill_name" "$run/.gemini/skills/"
      else
        echo "  warn: EXTRA_SKILLS lists '$skill_name' but $repo_skills/$skill_name is missing" >&2
      fi
    done < "$src/EXTRA_SKILLS"
  fi

  # 3. .env — copy ANTHROPIC_API_KEY from fork's .env. The fork walks up to
  # find a .env; we put one directly in the sandbox so the lookup short-
  # circuits and we don't depend on filesystem layout.
  if [[ -f "$FORK_ROOT/../.env" ]]; then
    grep -E '^(ANTHROPIC_API_KEY|GEMINI_API_KEY)=' "$FORK_ROOT/../.env" \
      > "$run/.env" || true
  fi

  # 4. Drop the prompt + expected docs into the run so they're handy.
  if [[ -f "$src/PROMPT.md" ]]; then
    cp "$src/PROMPT.md" "$run/PROMPT.md"
  fi
  if [[ -f "$src/EXPECTED.md" ]]; then
    cp "$src/EXPECTED.md" "$run/EXPECTED.md"
  fi

  echo "Sandbox ready: $run"
  echo
  echo "Next steps:"
  echo "  1. cd $run"
  echo "  2. gemini-fork              # interactive OAuth at first launch"
  echo "  3. paste prompt from PROMPT.md"
  echo "  4. when done, exit and run: gemini-fork-harness analyze latest"
}

# ---------------------------------------------------------------------------

cmd_analyze() {
  local run_dir="${1:-latest}"
  if [[ "$run_dir" == "latest" ]]; then
    run_dir="$(ls -1dt "$RUNS_ROOT"/*/ 2>/dev/null | head -1 | sed 's:/$::')"
    if [[ -z "$run_dir" ]]; then
      echo "harness: no past runs under $RUNS_ROOT" >&2
      exit 1
    fi
  fi
  if [[ ! -d "$run_dir" ]]; then
    echo "harness: no sandbox at '$run_dir'" >&2
    exit 1
  fi

  # The fork writes chat records to ~/.gemini/tmp/<project-hash>/chats/<session>.jsonl
  # where <project-hash> is derived from the project root (sandbox dir).
  # Easier: just pick the most recent JSONL across all tmp dirs that
  # references this sandbox's cwd.
  local sandbox_name="$(basename "$run_dir")"
  local chats_root="$HOME/.gemini/tmp"

  # First try matching by project-tmp dir name (fork uses the basename for
  # the temp project key by default).
  local match_dir
  match_dir="$(find "$chats_root" -maxdepth 2 -type d -name "$sandbox_name" 2>/dev/null | head -1)"
  if [[ -z "$match_dir" ]]; then
    # Fallback: most recently modified chats/*.jsonl across tmp.
    local jsonl
    jsonl="$(find "$chats_root" -maxdepth 4 -name '*.jsonl' -printf '%T@\t%p\n' 2>/dev/null | sort -n | tail -1 | cut -f2-)"
    if [[ -z "$jsonl" ]]; then
      echo "harness: no chat records under $chats_root" >&2
      exit 1
    fi
    echo "fallback: most recent chat record across tmp: $jsonl"
  else
    local jsonl
    jsonl="$(ls -1t "$match_dir/chats"/*.jsonl 2>/dev/null | head -1)"
    if [[ -z "$jsonl" ]]; then
      echo "harness: no chat records under $match_dir/chats" >&2
      exit 1
    fi
    echo "sandbox project dir: $match_dir"
    echo "chat record:         $jsonl"
  fi

  python3 - "$jsonl" "$run_dir" <<'PY'
import json, sys, os
from pathlib import Path

jsonl = Path(sys.argv[1])
run_dir = Path(sys.argv[2])

print()
print(f"=== analyzing {jsonl.name} ===")
print(f"=== sandbox  {run_dir} ===")
print()

records = []
for line in jsonl.read_text().splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        records.append(json.loads(line))
    except json.JSONDecodeError:
        pass

print(f"total records: {len(records)}")

# Tally tool calls.
tool_counts = {}
swarm_calls = []
for r in records:
    tc = r.get("toolCalls") or []
    for c in tc:
        name = c.get("name", "?")
        tool_counts[name] = tool_counts.get(name, 0) + 1
        if name in ("swarm", "swarm_status"):
            swarm_calls.append(c)

if tool_counts:
    print()
    print("tool call counts:")
    for k, v in sorted(tool_counts.items(), key=lambda kv: -kv[1]):
        marker = " <- swarm" if k in ("swarm", "swarm_status") else ""
        print(f"  {v:4d}  {k}{marker}")

print()
print(f"swarm-related calls: {len(swarm_calls)}")
for i, c in enumerate(swarm_calls, 1):
    name = c.get("name", "?")
    args = c.get("args") or {}
    action = args.get("action", "")
    agent_id = args.get("agent_id", "")
    role = args.get("role", "")
    has_policy = "policy" in args
    summary = f"{action}"
    if agent_id:
        summary += f" {agent_id}"
    if role:
        summary += f" [role={role}]"
    if has_policy:
        summary += f" [policy.rules={len(args.get('policy') or [])}]"
    print(f"  {i:3d}. {name:14s} {summary}")
    result = c.get("result")
    if result and isinstance(result, list):
        for fr in result:
            if not isinstance(fr, dict):
                continue
            fr_inner = fr.get("functionResponse", {})
            resp = fr_inner.get("response", {})
            output = resp.get("output")
            if isinstance(output, str):
                # Try to parse as JSON for swarm result.
                try:
                    parsed = json.loads(output)
                    ok = parsed.get("ok")
                    if ok is False:
                        print(f"          err: {parsed.get('error','')[:120]}")
                    else:
                        # extract relevant top-level fields
                        keys = [k for k in parsed.keys() if k not in ("ok", "action")]
                        snippet = {k: parsed[k] for k in keys[:3]}
                        s = json.dumps(snippet)[:160]
                        print(f"          ok:  {s}")
                except json.JSONDecodeError:
                    print(f"          out: {output[:120]}")

# --- Phase fingerprint detection ---------------------------------------
# Search the chat record for prompt/tool/output markers that should ONLY
# appear when the corresponding Phase code is live in the running bundle.
# If a Phase's markers are absent, the bundle is likely older than that
# Phase's commit (or the gate condition failed). This is the diagnostic
# that would have caught the silent "ran against stale bundle" failure.
blob = jsonl.read_text()
phases = {
    "Phase 4 (authority attribution)":
        ["Requested by sub-agent"],
    "Phase 5 (stateful collaborator)":
        ["swarm_status", "<swarm_dir>", "SWARM_PROTOCOL"],
    "Phase 5.1 (TUI progress publishing)":
        ["isSubagentProgress"],
    "Phase 6 (v1.x scope bridge)":
        ["swarm:doc-writer", "swarm:reviewer", "effective_policy_summary",
         "swarm-recursive-guard", "/audit"],
    "Phase 8 (orchestrator disposition)":
        ["# Swarm (experimental, enabled)",
         "# Skill — swarm-collaboration (auto-loaded)",
         "no CLI verb",
         "swarm-recursive-guard"],
}
print()
print("=== Phase fingerprint ===")
for phase, markers in phases.items():
    hits = [m for m in markers if m in blob]
    if hits:
        print(f"  ✓ {phase}: {len(hits)}/{len(markers)} markers visible")
    else:
        print(f"  ✗ {phase}: NO markers visible — bundle may predate this Phase")

# --- Anti-pattern detection --------------------------------------------
# Surface specific failure modes that have cost a live-test session in
# the past. Each WARN line is one diagnostic the user (or me) would
# otherwise have to dig out by hand.
print()
print("=== anti-pattern signals ===")

# 1. Swarm tool registration failure: model tried swarm, got "not found".
swarm_not_found = sum(
    1 for r in records for c in (r.get("toolCalls") or [])
    if c.get("name") == "swarm"
    and any(
        isinstance(fr, dict)
        and isinstance(fr.get("functionResponse", {}).get("response", {}).get("error"), str)
        and 'not found' in fr["functionResponse"]["response"]["error"].lower()
        for fr in (c.get("result") or []) if isinstance(c.get("result"), list)
    )
)
if swarm_not_found:
    print(f"  ⚠  {swarm_not_found}× `swarm` tool calls returned `Tool \"swarm\" not found`.")
    print("     → likely cause: bundle predates Phase 5, OR isSwarmEnabled() returned false at registration time.")
    print("     → fix: (cd $REPO && npm run bundle), then retest from a fresh sandbox.")

# 1b. Anthropic 400 invalid_request_error — the Phase 5.1 drain only handles
# the max_turns cap path. If a swarm sub-agent's response ended via
# `max_tokens`, `pause_turn`, or another non-cap stop_reason with an
# unpaired `tool_use`, the NEXT message to that agent fails with this
# error. Each occurrence here is the same class of bug Phase 5.1 was
# supposed to prevent — Phase 5.2 needs to extend drain to all exit paths.
unpaired_tool_use = 0
for i, r in enumerate(records):
    for c in (r.get("toolCalls") or []):
        if c.get("name") != "swarm":
            continue
        for fr in (c.get("result") or []) if isinstance(c.get("result"), list) else []:
            if not isinstance(fr, dict):
                continue
            resp = fr.get("functionResponse", {}).get("response", {})
            output = resp.get("output")
            if isinstance(output, str):
                try:
                    parsed = json.loads(output)
                    err = parsed.get("error", "") if isinstance(parsed, dict) else ""
                    if isinstance(err, str) and "tool_use" in err and "tool_result" in err:
                        unpaired_tool_use += 1
                except json.JSONDecodeError:
                    pass
if unpaired_tool_use:
    print(f"  ⚠  {unpaired_tool_use}× swarm `message` calls returned 400 `tool_use ... without tool_result`.")
    print("     → Phase 5.1 drain-to-clean-state covers only the max_turns cap path.")
    print("     → other Anthropic stop_reasons (max_tokens / pause_turn / default) can")
    print("       still leave the sub-agent's `messages` history ending on an unpaired")
    print("       `tool_use` block, which makes the next `message` call fail. Phase 5.2")
    print("       extends the drain to every loop-exit branch in `anthropic-loop.ts`.")

# 2. Recursive gemini invocations: shell calls that start with `gemini`
#    or `gemini-fork`. Phase 8's tier-1 deny rule should catch these.
recursive = 0
for r in records:
    for c in (r.get("toolCalls") or []):
        if c.get("name") != "run_shell_command":
            continue
        cmd = (c.get("args") or {}).get("command", "")
        # First non-cd-prefix token in the command.
        head = ""
        for tok in cmd.split():
            if tok in ("cd", "env", "&&", "||", ";") or tok.startswith(("&&", "||")):
                continue
            head = tok
            break
        if head in ("gemini", "gemini-fork") or head.endswith("/gemini") or head.endswith("/gemini-fork"):
            recursive += 1
if recursive:
    deny_fired = blob.count("Do not invoke gemini recursively")
    if deny_fired:
        print(f"  ℹ  {recursive}× recursive `gemini` shell calls; deny rule fired {deny_fired}× (Phase 8 layer 4 working).")
    else:
        print(f"  ⚠  {recursive}× recursive `gemini` shell calls; deny rule did NOT fire.")
        print("     → likely cause: bundle predates Phase 8 OR Phase 6's PolicyEngine guard skipped.")
        print("     → fix: rebuild bundle (`npm run bundle`); verify Phase 8 markers above.")

# 3. Lots of run_shell_command vs no swarm: orchestrator went off-script.
shell_count = tool_counts.get("run_shell_command", 0)
swarm_call_count = tool_counts.get("swarm", 0) + tool_counts.get("swarm_status", 0)
if shell_count >= 10 and swarm_call_count == 0:
    print(f"  ⚠  {shell_count}× shell calls with ZERO swarm/swarm_status invocations.")
    print("     → orchestrator likely fell back to shell-based 'sequential workers' pattern.")
    print("     → check Phase 8 markers above; if absent, rebuild bundle.")
elif shell_count > swarm_call_count * 5 and swarm_call_count > 0:
    print(f"  ⚠  shell calls ({shell_count}) >> swarm calls ({swarm_call_count})  (ratio > 5×).")
    print("     → orchestrator may still prefer shell despite swarm being available.")

# 4. Long gaps between final assistant message and user re-prompt may
#    indicate UI got stuck on "thinking..." (the user observed this).
def _ts(r):
    return r.get("timestamp") or ""
import datetime as _dt
user_recs = [(i, r) for i, r in enumerate(records) if r.get("type") == "user"]
for idx, (i, r) in enumerate(user_recs):
    if idx == 0:
        continue
    # Previous gemini record.
    prev_gem = None
    for j in range(i - 1, -1, -1):
        if records[j].get("type") == "gemini":
            text = (records[j].get("content") or "")
            if isinstance(text, str) and text.strip():
                prev_gem = (j, records[j])
                break
    if not prev_gem:
        continue
    try:
        t_user = _dt.datetime.fromisoformat(_ts(r).replace("Z", "+00:00"))
        t_gem = _dt.datetime.fromisoformat(_ts(prev_gem[1]).replace("Z", "+00:00"))
        gap = (t_user - t_gem).total_seconds()
    except Exception:
        continue
    content = r.get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        # Anthropic-style content blocks. Concatenate any text blocks.
        text = " ".join(
            b.get("text", "") for b in content if isinstance(b, dict)
        )
    else:
        text = ""
    if 5 <= gap <= 120 and any(
        kw in text.lower() for kw in ("finished", "done", "are you", "still", "stuck")
    ):
        print(f"  ⚠  rec {i}: user asked a 'are-you-done' style follow-up {gap:.0f}s after the previous orchestrator message.")
        print("     → may indicate the TUI's 'Thinking…' state didn't clear after the agent loop ended.")
        print("     → investigate by inspecting `pendingHistoryItem` / `streamingState` lifecycle around rec {0}.".format(prev_gem[0]))

# --- Last orchestrator message ----------------------------------------
last_text = None
for r in reversed(records):
    if r.get("type") == "gemini":
        last_text = (r.get("content") or "").strip()
        if last_text:
            break
if last_text:
    print()
    print("--- last orchestrator message (truncated) ---")
    print(last_text[:1000])
PY
}

# ---------------------------------------------------------------------------

cmd_list() {
  if [[ ! -d "$RUNS_ROOT" ]]; then
    echo "no runs root at $RUNS_ROOT"
    return 0
  fi
  ls -1dt "$RUNS_ROOT"/*/ 2>/dev/null | sed 's:/$::' | awk '{printf "%s\n", $0}'
}

# ---------------------------------------------------------------------------

case "${1:-}" in
  new)       shift; cmd_new "$@" ;;
  analyze)   shift; cmd_analyze "$@" ;;
  list)      shift; cmd_list "$@" ;;
  ""|help|-h|--help)
    sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "harness: unknown subcommand '$1'" >&2
    exit 1
    ;;
esac
