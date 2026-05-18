# Scenario: swarm-review

Paste this prompt verbatim into the interactive `gemini-fork` session (launched
from the sandbox cwd).

---

I want you to review `user-service.ts` using a 2-agent swarm.

1. Spawn a **sonnet** agent with `role: "correctness-reviewer"`,
   `charter: "Find correctness and reliability bugs"`. Tell it to read
   `user-service.ts` and write its findings to `<swarm_dir>/correctness.md`
   (look up `<swarm_dir>` via `swarm_status()`).
2. Spawn an **opus** agent with `role: "security-reviewer"`,
   `charter: "Find security and resource-leak bugs"`. Tell it to read
   `user-service.ts` PLUS `<swarm_dir>/correctness.md` (to avoid double
   reporting) and write its own findings to `<swarm_dir>/security.md`.
3. Run `/audit correctness-reviewer` (or whatever the first agent's ID is —
   confirm via `swarm list`) so I can see the effective policy.
4. Read both `<swarm_dir>/correctness.md` and `<swarm_dir>/security.md` yourself
   and produce a synthesized final report with severity-ordered findings.
5. Release both agents when done.

Don't pre-prime them with my list of issues; let them find what they find.
