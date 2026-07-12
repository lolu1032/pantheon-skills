---
name: pantheon-gap-x
description: >-
  A skill that runs a GAP ANALYSIS & feedback review of an existing project through a multi-agent
  harness (enhanced variant: GPT-5.6 Sol cross-model adversarial confirmation). It maps the project,
  fans out one probe agent per dimension (completeness, correctness, tests, security, docs,
  architecture, DX, performance, ops) to hunt for what's MISSING or weak with file-level evidence, then
  has **GPT-5.6 Sol (Codex) skeptical reviewers** try to DISMISS each finding so false positives are
  dropped, and finally a judge prioritizes a report (top gaps, quick wins, the next fix). Because a
  *different* model judges each finding, it strips same-model confirmation bias harder
  than the base (pantheon-gap). Requires a Codex CLI login. Use when the user says "pantheon gap x",
  "cross-model gap analysis", "GPT-5.6 review my project", "코덱스로 갭 분석", "크로스 검증 프로젝트
  점검". If Codex isn't available, use pantheon-gap instead. To GENERATE code (not review), use
  pantheon / pantheon-x. Don't use for a quick single-file glance.
---

# Pantheon gap-analysis harness (enhanced · GPT-5.6 Sol cross-verify)

The review/audit twin of `pantheon-x`. Same `map → probe (×N dimensions) → adversarial confirm →
synthesize` pipeline as the `pantheon-gap` base, but the **adversarial confirm step is run by GPT-5.6 Sol
(Codex)** (via an explicit shell-out to the Codex plugin's `codex-companion.mjs`). Because a *different* model tries to dismiss each
finding, it doesn't share the Claude probe's "I found a gap" confirmation bias — so the false
positives a same-model review keeps get stripped harder.

## Requirements
- **Workflow orchestration** — a paid plan (Pro/Max/Team/Enterprise, v2.1.154+); on Pro enable
  `/config` → Dynamic workflows. Same as `pantheon-gap`. Not on the Free tier.
- **The Codex plugin + a logged-in `codex` CLI.** The harness invokes the plugin's `codex-companion.mjs`
  directly.
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

  Install the plugin:
  ```
  /plugin marketplace add openai/codex-plugin-cc
  /plugin install codex@openai-codex
  ```
  plus a ChatGPT subscription (or `OPENAI_API_KEY`) and the `codex` CLI on PATH. On a headless server,
  `codex login --device-auth`.
- **Check codex is reachable before running.** If it isn't, the confirm calls all come
  back `unavailable`, and the harness will keep every finding but mark it `unconfirmed` and report it
  in its own bucket (never as `confirmed`) — so you won't get a report full of laundered false
  positives, you'll get a report that says nothing was actually cross-checked. That's a wasted run.
  Fall back to `pantheon-gap`.

## When to use
- A real project/repo you want an evidence-backed, *cross-checked* gap list for — before a launch,
  after an MVP, inheriting a codebase — where a second vendor's model filtering the findings is worth
  the extra cost.
- Don't use it to *write* code — that's `pantheon` / `pantheon-x`. Don't use it for a trivial one-file
  look. Each run costs real tokens (Codex round-trips included).

## Procedure (when this skill triggers)
1. **Check cross-verify availability.** Run `codex login status` and locate the companion:
   `ls -d ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs`. What matters is the
   companion script actually running — without it nothing gets confirmed and the whole run is wasted. If it's missing, tell the user and offer to switch
   to the `pantheon-gap` base (Claude's own adversarial confirm).
2. **Pin the target.** Which project/path is being reviewed, and is there a focus (e.g. "security and
   tests only")? If unclear, ask 1 short question.
3. **Decide the parameters:**
   - `target`: an **absolute path** to the project root to audit.
   - `dimensions` (optional): an explicit list to audit; omit to let the scout pick the most relevant.
   - `focus` (optional): a dimension or area to emphasize.
   - `maxDimensions`: how many dimensions to probe (default 6).
   - `verifiers`: skeptical GPT-5.6 Sol reviewers per finding (default 2; bump to 3 to be stricter — a
     finding is kept only if a majority confirm it).
4. **Run the Workflow** — **Read `pantheon-gap-class.js` in this same directory**, then pass its
   contents inline as the Workflow `script` argument. **Fix `crossModelVerify: true`:**
   ```
   Workflow({
     script: <contents of pantheon-gap-class.js>,
     args: { target, dimensions, focus, maxDimensions, verifiers, crossModelVerify: true }
   })
   ```
   (This skill's instruction is itself the approval to call Workflow.)
5. **It runs in the background.** When the completion notice arrives, report: which dimensions were
   probed, how many gaps were found vs. confirmed by GPT-5.6 Sol (survived adversarial dismissal), the top
   prioritized gaps, the quick wins, and the single highest-leverage fix.

## Pipeline (what the script does)
- **Map** — one scout reads the README/structure/manifests/tests/CI, names the project's stated
  purpose and maturity, and picks the dimensions worth auditing for THIS project.
- **Probe** — one Claude agent per dimension hunts for gaps (missing/incomplete/weak), each citing
  file-level evidence; high-signal findings over a long noisy list.
- **Confirm** — for each candidate gap, V **GPT-5.6 Sol (Codex) skeptics** try to DISMISS it (already
  handled? out of scope? false positive?); a gap is kept only if a majority confirm it.
- **Synthesize** — a judge (Claude) dedups and prioritizes by impact × effort: top gaps, quick wins,
  and the highest-leverage next fix.

## Notes
- **Not a resident process.** One-shot per call, then exits — zero cost when idle.
- It **reports** gaps; it does not fix them. Hand the report to `pantheon` (or plain Opus) to act on.
- The cross-model *confirm* step is the point: a different vendor's model is maximally independent from
  the Claude probe, so it kills the plausible-but-false findings a same-model review ships.
- Does not work without Codex installed → fall back to `pantheon-gap`.
- Coding/agentic productivity only. Not for bypassing safety gates.
