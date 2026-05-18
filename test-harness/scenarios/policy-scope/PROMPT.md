# Scenario: policy-scope

Tests Phase 6's spawn-time `policy: PolicyRule[]` field — sub-agent gets a
narrow scope (write only `*.md`, deny shell), runtime enforces.

Paste verbatim into the interactive `gemini-fork` session.

---

I want to test the swarm's policy-scoping feature with a doc-writer sub-agent.

1. Spawn an agent with:
   - `model: "sonnet"`
   - `role: "doc-writer"`
   - `charter: "Regenerate README.md to match calc.ts."`
   - Pass an explicit `policy` array with these rules:
     - `{ toolName: "write_file", argsPattern: ".*\\.md$", decision: "allow" }`
     - `{ toolName: "write_file", decision: "deny", denyMessage: "doc-writer can only write Markdown files" }`
     - `{ toolName: "run_shell_command", decision: "deny", denyMessage: "doc-writer does not run shell" }`
   - Pass `system_prompt` instructing the agent that it can read source code,
     regenerate `README.md`, and must NOT run shell or write non-md files.

2. Send the agent a message asking it to update `README.md` based on `calc.ts`.
   The agent should:
   - read `calc.ts` (allowed)
   - write `README.md` (allowed — `.md$` match)
   - succeed

3. Run `/audit <agent_id>` and show me the effective policy. I want to verify
   all three of my rules appear with `subagent` matching this agent.

4. Now send the agent a message asking it to also write a small `bench.ts` (NOT
   `.md`). This should be **denied** by the engine (`write_file` non-md → falls
   through to the second rule). Confirm you see the deny.

5. Send a message asking it to run `ls` via shell. This should also **deny**
   with the "does not run shell" message.

6. Verify by reading the actual `README.md` on disk that step 2 wrote a sensible
   doc.

7. Release the agent.
