---
name: pantheon
description: >-
  A skill that runs a hard, testable coding task through a multi-agent harness instead of a single
  model pass (base variant, no external model needed). It takes implementations, large refactors, or
  migrations whose correctness can be expressed as tests and runs them through plan → parallel
  variants (with a test-driven self-correction loop) → adversarial verification (Claude itself) →
  synthesis, raising correctness over a single pass. Works on Claude Code's Workflow orchestration
  alone. Use when the user says "pantheon", "run it through pantheon", "build several variants, gate
  on tests, then adversarially verify", "really hammer this implementation", or wants to solve a hard
  coding/agentic task with multiple agents. For cross-model (GPT-5.5) adversarial verification, use
  the pantheon-x skill instead. Don't use for easy one-shot questions or trivial edits (cost is high).
---

# Pantheon harness (base)

A harness that wraps a coding task in multiple agents instead of a single pass. It does not change
model weights; via `plan → parallel variants → test-driven self-correction → adversarial
verification → synthesis` it raises correctness on work whose answer you can express as tests. It's
proven techniques (best-of-N, self-correction, adversarial verification) bundled into one command —
not a change to the model's single-shot reasoning.

**This base variant runs on Claude Code alone, no external model.** For the stronger variant that
hands adversarial verification to GPT-5.5 (Codex), use the `pantheon-x` skill.

## Requirements
- **Claude Code's Workflow orchestration is required.** It only runs on a paid plan
  (Pro/Max/Team/Enterprise, v2.1.154+); it is **not on the Free tier**. On Pro, enable it once in
  `/config` → **Dynamic workflows**. Without the Workflow tool this skill does not run.
- No external model or plugin needed — Claude itself does the adversarial verification. (For
  cross-model verification, use `pantheon-x`.)

## When to use
- Hard implementations / refactors / migrations, or any coding task whose **correctness can be
  defined as tests**.
- Don't use for easy one-shot questions or trivial fixes — just answer directly. Each run costs real
  tokens (route only the hardest 10–20% here).

## Procedure (when this skill triggers)
1. **Pin the task.** Extract the implementation requirement from the user's message. If unclear, ask
   1–2 short questions — especially *what tests define correctness*.
2. **Decide the parameters:**
   - `task`: a one-paragraph precise requirement + acceptance criteria (expressible as tests).
   - `workdir`: an **absolute path**. A real repo's path, or `/tmp/pantheon-<short-name>` for a
     throwaway check.
   - `lang`: the language + the **exact test command**, e.g. `"TypeScript, vitest — run with \`pnpm test\`"`,
     `"pure Python 3, \`python3 -m unittest\`"`. Check the project's real test runner first.
   - `variants`: usually 3, up to 5 for hard problems.
   - `verifiers`: usually 2, up to 3 to be stricter (a build is dropped if a majority finds a real defect).
3. **Run the Workflow** — **Read `pantheon-class.js` in this same directory**, then pass its contents
   inline as the Workflow `script` argument:
   ```
   Workflow({
     script: <contents of pantheon-class.js>,
     args: { task, workdir, lang, variants, verifiers, crossModelVerify: false }
   })
   ```
   (This skill's instruction is itself the approval to call Workflow. `crossModelVerify` is always
   `false` for the base variant.)
4. **It runs in the background.** When the completion notice arrives, report: per-variant test status,
   who was broken vs. who survived adversarial verification, and the final winner's path, rationale,
   and ideas worth grafting.

## Pipeline (what the script does)
- **Plan** — spec + test plan + N distinct strategies (fix the "definition of correct" before any code).
- **Implement** — parallel builders, one per strategy. Each **actually runs the tests** and loops
  fix → re-run up to 5 times (T1 tool-integrated self-verification).
- **Verify** — for each green variant, V adversarial reviewers "don't praise it, break it"; dropped if
  a majority proves a real defect.
- **Synthesize** — a judge picks the winner and suggests the better ideas worth grafting from the rest.

## Notes
- **Not a resident process.** One-shot per call, then exits — zero cost when idle.
- Coding/agentic productivity only. Not for bypassing safety gates (cyber/bio capability restrictions).
