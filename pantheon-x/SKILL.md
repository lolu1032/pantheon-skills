---
name: pantheon-x
description: >-
  A skill that runs a hard, testable coding task through a multi-agent harness (enhanced variant:
  GPT-5.5 cross-model adversarial verification). It takes implementations, large refactors, or
  migrations whose correctness can be expressed as tests and runs them through plan → parallel
  variants (test-driven self-correction loop) → **GPT-5.5 (Codex) adversarial verification** →
  synthesis. Because the implementation Claude wrote is attacked by a *different* model, it's stricter
  than the base (pantheon). Requires a Codex CLI login. Use when the user says "pantheon x", "pantheon
  enhanced", "GPT-5.5 adversarial verify", "cross-model hard verification", or wants the strongest
  cross-verified pipeline. If Codex/GPT-5.5 isn't available, use the pantheon skill instead. Don't use
  for easy one-shot work (cost is high).
---

# Pantheon harness (enhanced · GPT-5.5 cross-verify)

Same `plan → parallel variants → test-driven self-correction → adversarial verification → synthesis`
pipeline as the `pantheon` base, but the **adversarial verification step is run by GPT-5.5 (Codex)**
(`agentType: 'codex:codex-rescue'`). Because a *different* model tries to break what Claude wrote, it
shrinks single-model blind spots (the same mistake a same-model verifier would miss) — the strongest setting.

## Requirements
- **Like the base, it needs Workflow orchestration** — a paid plan (Pro/Max/Team/Enterprise,
  v2.1.154+); on Pro, enable `/config` → Dynamic workflows. Not on Free.
- **The `codex:codex-rescue` agent type must be installed.** It's a subagent registered by OpenAI's
  **Codex plugin**, not stock Claude Code; a `codex` CLI login alone does NOT create it:
  ```
  /plugin marketplace add openai/codex-plugin-cc
  /plugin install codex@openai-codex
  ```
  plus a ChatGPT subscription (or `OPENAI_API_KEY`) and the `codex` CLI on PATH. On a headless server,
  `codex login --device-auth`.
- **Never run with `crossModelVerify:true` if `codex:codex-rescue` is missing.** In that case the
  adversarial calls all come back empty and every build "survives" (verification only pretended to
  happen). Fall back to the `pantheon` base instead.

## When to use
- Among hard implementations/refactors/migrations, the ones that are **expensive to get wrong** —
  payments, concurrency, migrations. Where cross-model verification pays off.
- Don't use for easy one-shot questions or trivial fixes. It costs more tokens/time than the base
  (Codex round-trips included).

## Procedure (when this skill triggers)
1. **Check cross-verify availability.** Confirm the `codex:codex-rescue` agent type is actually
   installed (e.g. the `/agents` list, or whether the Codex plugin is installed). What matters is the
   *existence of this agent type*, not just a `codex` CLI login — forcing it without the agent silently
   disables verification and every build passes. If it's missing, tell the user and offer to switch to
   the `pantheon` base (Claude's own adversarial verification).
2. **Pin the task.** Extract the requirement; if unclear ask 1–2 short questions — *what tests define
   correctness* is the key.
3. **Decide the parameters:**
   - `task`: one-paragraph precise requirement + acceptance criteria (expressible as tests).
   - `workdir`: an **absolute path**. A real repo's path, or `/tmp/pantheon-<short-name>` for a check.
   - `lang`: language + the **exact test command**, e.g. `"TypeScript, vitest — \`pnpm test\`"`,
     `"pure Python 3, \`python3 -m unittest\`"`.
   - `variants`: usually 3, up to 5.
   - `verifiers`: usually 2, up to 3.
4. **Run the Workflow** — **Read `pantheon-class.js` in this same directory** and pass its contents
   inline as the `script` argument. **Fix `crossModelVerify: true`:**
   ```
   Workflow({
     script: <contents of pantheon-class.js>,
     args: { task, workdir, lang, variants, verifiers, crossModelVerify: true }
   })
   ```
   (This skill's instruction is itself the approval to call Workflow.)
5. **It runs in the background.** When done, report: per-variant test status, who GPT-5.5's adversarial
   verification broke, and the final winner's path, rationale, and grafting ideas.

## Pipeline
- **Plan** — spec + test plan + N strategies.
- **Implement** — parallel builders per strategy; each runs tests and loops fix→re-run up to 5 times (T1).
- **Verify** — for each green variant, V **GPT-5.5 (Codex) reviewers** "break it"; dropped on majority defect.
- **Synthesize** — a judge (Claude) picks the winner and grafts the good ideas.

## Notes
- **Not a resident process.** One-shot per call, then exits.
- Coding/agentic productivity only. Not for bypassing safety gates.
- Does not work without Codex installed → fall back to `pantheon`.
