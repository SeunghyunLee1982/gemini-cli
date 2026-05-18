#!/usr/bin/env bash
# test-harness/harness.sh — driver for out-of-workspace swarm tests.
#
# Subcommands:
#   harness.sh new <scenario>      Create a fresh sandbox under
#                                  ~/gemini-fork/sandboxes/<scenario>-<ts>/,
#                                  seed it, print the invocation + prompt.
#   harness.sh analyze <run_dir>   Walk the latest gemini chat record for
#                                  that sandbox and dump swarm tool calls
#                                  + results. Use `latest` as run_dir to
#                                  pick the most recent sandbox.
#   harness.sh list                Show past sandbox runs.
#
# All scenarios live in test-harness/scenarios/<scenario>/.
# Each has: SEED/ (copied into the sandbox), PROMPT.md (paste into the
# interactive session), EXPECTED.md (what to look for in the chat record).
#
# The orchestrator runs interactively (OAuth path). After the session ends
# the user runs `harness.sh analyze latest` to post-mortem the chat record.

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORK_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"
RUNS_ROOT="${SWARM_TEST_ROOT:-$HOME/gemini-fork/sandboxes}"
SCENARIO_ROOT="$HARNESS_DIR/scenarios"

# ---------------------------------------------------------------------------

cmd_new() {
  local scenario="${1:-}"
  if [[ -z "$scenario" ]]; then
    echo "usage: harness.sh new <scenario>" >&2
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
  echo "  4. when done, exit and run: harness.sh analyze latest"
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

# Last assistant message (final orchestrator answer).
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
    sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "harness: unknown subcommand '$1'" >&2
    exit 1
    ;;
esac
