# Scenario: swarm-review

Paste this prompt verbatim into the interactive `gemini-fork` session (launched
from the sandbox cwd).

---

**Tools available to you (registered in your tool list — do NOT invoke these via
`run_shell_command`; they are first-class tools):**

- `swarm` — discriminated action tool. Use
  `action: 'spawn' | 'message' | 'release' | 'list' | 'amend_policy'`.
- `swarm_status` — read-only snapshot of the live swarm (agents, roles, shared
  workspace dir, recent events). Takes no args.

If you find yourself about to write `gemini swarm ...` or
`gemini-fork swarm ...` in a shell, stop — that's wrong. Call the `swarm` tool
directly with the right `action`.

---

I want you to review `user-service.ts` using a 2-agent swarm.

1. **Spawn the first reviewer** by calling the `swarm` tool:

   ```
   action: 'spawn'
   model: 'sonnet'
   role: 'correctness-reviewer'
   charter: 'Find correctness and reliability bugs'
   system_prompt: 'You are a correctness-focused code reviewer in a
     multi-agent swarm. Read user-service.ts, identify correctness and
     reliability bugs, then call `swarm_status` to learn the shared
     workspace_dir and write your findings to <workspace_dir>/correctness.md
     using write_file. Return a one-line summary when done.'
   ```

   The tool will return an `agent_id` (probably `sonnet-1`).

2. **Send the first reviewer a turn** by calling `swarm` again with
   `action: 'message'`, the agent_id from step 1, and a prompt asking it to do
   the review.

3. **Spawn the second reviewer** the same way with `model: 'opus'`,
   `role: 'security-reviewer'`, charter "Find security and resource-leak bugs".
   Its system prompt should tell it to read both `user-service.ts` AND
   `<workspace_dir>/correctness.md` (so it doesn't double-report) and write its
   own findings to `<workspace_dir>/security.md`.

4. **Send the second reviewer a turn** the same way.

5. **Ask me to audit.** Slash commands like `/audit` are user-typed, not
   orchestrator tool calls — you can't emit them. Instead, pause and tell me
   which agent ID to audit (use whatever `swarm` returned in step 1, or call
   `swarm_status` if you've lost it) and what to look for in the output. I'll
   type `/audit <agent_id>` myself and paste the result back to you before you
   continue.

6. **Read both artifact files** using `read_file` and produce a synthesized
   final report with severity-ordered findings (don't just paste the agent
   outputs back).

7. **Release both agents** by calling `swarm` with `action: 'release'` for each
   agent_id.

Don't pre-prime the reviewers with my list of issues — let them find what they
find.
