# Scenario: policy-scope

Tests Phase 6's spawn-time `policy: PolicyRule[]` field — sub-agent gets a
narrow scope (write only `*.md`, deny shell), runtime enforces.

Paste verbatim into the interactive `gemini-fork` session.

---

**Tools available to you (registered in your tool list — do NOT invoke these via
`run_shell_command`; they are first-class tools):**

- `swarm` — discriminated action tool. Use
  `action: 'spawn' | 'message' | 'release' | 'list' | 'amend_policy'`.
- `swarm_status` — read-only snapshot of the live swarm. No args.

If you find yourself about to write `gemini swarm ...` in a shell, stop — that's
wrong. Call the `swarm` tool directly.

---

I want to test the swarm's policy-scoping feature with a doc-writer sub-agent.

1. **Spawn the agent.** Call the `swarm` tool with:

   ```
   action: 'spawn'
   model: 'sonnet'
   role: 'doc-writer'
   charter: 'Regenerate README.md to match calc.ts.'
   system_prompt: 'You are a doc-writer in a multi-agent swarm. Read
     the local source files (calc.ts) and regenerate README.md to
     accurately describe the API. Do NOT run shell. Do NOT write any
     non-Markdown files.'
   policy: [
     { toolName: 'write_file', argsPattern: '.*\\.md$', decision: 'allow' },
     { toolName: 'write_file', decision: 'deny',
       denyMessage: 'doc-writer can only write Markdown files' },
     { toolName: 'run_shell_command', decision: 'deny',
       denyMessage: 'doc-writer does not run shell' }
   ]
   ```

   The tool will return an `agent_id` (probably `sonnet-1`).

2. **Send a turn** — call `swarm` with `action: 'message'`, the agent_id from
   step 1, and a prompt asking the agent to update `README.md` based on
   `calc.ts`. The agent should: read `calc.ts` (allowed), write `README.md`
   (allowed by the `.md$` rule), and succeed.

3. **Audit the policy.** Run the `/audit <agent_id>` slash command (not a tool —
   type it on its own line). I want to verify all three of my rules appear with
   `subagent` matching this agent.

4. **Try to force a write_file violation.** Send the agent another `swarm`
   message asking it to also write a small `bench.ts` (NOT `.md`). The runtime
   should **deny** this call (`write_file` non-md falls through to the second
   rule). Confirm you see the deny message in the tool_result.

5. **Try to force a shell violation.** Send the agent a message asking it to run
   `ls` via shell. This should also **deny** with the "does not run shell"
   message.

6. **Verify** by reading the actual `README.md` on disk (use `read_file`) that
   step 2 wrote a sensible doc derived from `calc.ts`.

7. **Release the agent** by calling `swarm` with `action: 'release'`.
