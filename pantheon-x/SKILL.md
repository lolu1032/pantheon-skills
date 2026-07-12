---
name: pantheon-x
description: >-
  A skill that runs a hard, testable coding task through a multi-agent harness (enhanced variant:
  GPT-5.6 Sol cross-model adversarial verification). It takes self-contained implementations whose correctness can be
  expressed as tests and runs them through plan → parallel
  variants (test-driven self-correction loop) → **GPT-5.6 Sol (Codex) adversarial verification** →
  synthesis. Because the implementation Claude wrote is attacked by a *different* model, it's stricter
  than the base (pantheon). Requires a Codex CLI login. Use when the user says "pantheon x", "pantheon
  enhanced", "GPT-5.6 Sol adversarial verify", "cross-model hard verification", or wants the strongest
  cross-verified pipeline. If Codex/GPT-5.6 Sol isn't available, use the pantheon skill instead. Don't use
  for easy one-shot work (cost is high).
---

# Pantheon harness (enhanced · GPT-5.6 Sol cross-verify)

Same `plan → parallel variants → test-driven self-correction → adversarial verification → synthesis`
pipeline as the `pantheon` base, but the **adversarial verification step is run by GPT-5.6 Sol (Codex)**
(via an explicit shell-out to the Codex plugin's `codex-companion.mjs`). Because a *different* model tries to break what Claude wrote, it
shrinks single-model blind spots (the same mistake a same-model verifier would miss) — the strongest setting.

## Requirements
- **Like the base, it needs Workflow orchestration** — a paid plan (Pro/Max/Team/Enterprise,
  v2.1.154+); on Pro, enable `/config` → Dynamic workflows. Not on Free.
- **The Codex plugin + a logged-in `codex` CLI.** The harness invokes the plugin's `codex-companion.mjs`
  directly and pins `gpt-5.6-sol` (needs codex-cli >= 0.140; older builds reject it with a 400).
- **NEVER route the adversarial step through `agentType: 'codex:codex-rescue'`.** That agent is a thin
  forwarding wrapper (`model: sonnet`), and because this harness passes a `schema`, the StructuredOutput
  instruction the Workflow tool injects BEATS the wrapper's "forward, do nothing else" instruction — so
  it reviews with its own sonnet and **never calls codex at all**, silently. A real run measured 1 of 84
  agents actually reaching codex, and the June 2026 benchmark in this repo was invalidated by it. The
  harness now shells out to `codex-companion.mjs` explicitly and stamps every verdict with
  `[codex:<threadId>]`.
- **Trust `crossModelVerified` in the result, not this skill's name.** Verdicts without a real codex
  stamp are counted as abstentions, so a degraded run fails quorum and returns **no winner** rather than
  passing itself off as cross-verified.
 It's a subagent registered by OpenAI's
  **Codex plugin**, not stock Claude Code; a `codex` CLI login alone does NOT create it:
  ```
  /plugin marketplace add openai/codex-plugin-cc
  /plugin install codex@openai-codex
  ```
  plus a ChatGPT subscription (or `OPENAI_API_KEY`) and the `codex` CLI on PATH. On a headless server,
  `codex login --device-auth`.
- **Check codex is reachable before running.** If it's missing, every adversarial call
  comes back `unavailable`; the harness treats those as abstentions, fails to reach quorum, and ends
  the run with `insufficient_verifier_quorum` and no winner. Nothing gets rubber-stamped — but the
  whole run is wasted. Fall back to the `pantheon` base instead.

## When to use
- Among hard, self-contained implementations, the ones that are **expensive to get wrong** —
  payments, concurrency, parsers. Where cross-model verification pays off.
- Don't use for easy one-shot questions or trivial fixes. It costs more tokens/time than the base
  (Codex round-trips included).
- **Not for changing an existing repo.** Each builder writes into a fresh `workdir/variant-i` and
  never sees your codebase, so a refactor or migration has nothing to refactor. To change code that
  already exists, use **`pantheon-fix-x`** — it clones HEAD into a git worktree per variant and gates
  on your real test suite.

## Procedure (when this skill triggers)
1. **Check cross-verify availability.** Run `codex login status` and locate the companion:
   `ls -d ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs`. What matters is the
   companion script actually running — without it no verdict can be produced, so the run ends with no winner. If it's missing, tell the user and offer to switch to
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
5. **It runs in the background.** When done, report: per-variant test status, who GPT-5.6 Sol's adversarial
   verification broke, and the final winner's path, rationale, and grafting ideas.

## Pipeline
- **Plan** — spec + test plan + N strategies.
- **Implement** — parallel builders per strategy; each runs tests and loops fix→re-run up to 5 times (T1).
- **Verify** — for each green variant, V **GPT-5.6 Sol (Codex) reviewers** "break it". A tie refutes:
  one confirmed defect out of two reviewers is enough to drop the variant. If all are dropped, nothing
  wins — the run reports `all_candidates_refuted` rather than crowning the least-bad build.
- **Synthesize** — a judge (Claude) picks the winner and grafts the good ideas.

## Notes
- **Not a resident process.** One-shot per call, then exits.
- Coding/agentic productivity only. Not for bypassing safety gates.
- Does not work without Codex installed → fall back to `pantheon`.
