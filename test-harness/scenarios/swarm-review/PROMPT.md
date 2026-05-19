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

5. **STOP and ask me to run `/audit`.** Slash commands are typed by me, not by
   you. Emitting `/audit sonnet-1` as text in your own response does NOT execute
   it (it just shows up as a literal string on my screen). You must literally
   pause: end your turn with a single question to me, like:

   > "The sub-agents are still alive. Could you run `/audit sonnet-1` and paste
   > the output? I'd like to see the effective policy and recent events before
   > we proceed to step 6."

   Then DO NOT call any more tools and DO NOT continue to step 6 until I reply.
   In particular, the sub-agents must still be alive when I run `/audit`, so do
   NOT release them before I answer.

6. **Read both artifact files** using `read_file` and produce a synthesized
   final report with severity-ordered findings (don't just paste the agent
   outputs back).

7. **Release both agents** by calling `swarm` with `action: 'release'` for each
   agent_id.

Don't pre-prime the reviewers with my list of issues — let them find what they
find.
