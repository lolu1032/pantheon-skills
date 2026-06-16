---
name: pantheon-gap
description: >-
  A skill that runs a GAP ANALYSIS & feedback review of an existing project through a multi-agent
  harness instead of a single review pass. It maps the project, fans out one probe agent per
  dimension (completeness, correctness, tests, security, docs, architecture, DX, performance, ops) to
  hunt for what's MISSING or weak with file-level evidence, then has skeptical reviewers try to
  DISMISS each finding so false positives are dropped, and finally a judge dedups and prioritizes a
  report (top gaps, quick wins, the highest-leverage next fix). Use when the user says "pantheon
  gap", "gap analysis", "what's missing in this project", "review my project", "audit this repo",
  "갭 분석", "피드백 리뷰", "뭐가 부족한지 봐줘", "프로젝트 점검". For GENERATING code through the harness
  (not reviewing an existing one), use the pantheon / pantheon-x skills instead. Don't use for a quick
  single-file glance (cost is high).
---

# Pantheon gap-analysis harness

The review/audit twin of `pantheon`. Instead of generating code, it points the same multi-agent
shape at an EXISTING project and asks "what's missing?" — `map → probe (×N dimensions) →
adversarial confirm → synthesize`. The point isn't a smarter reviewer: it's that one probe per
dimension finds more than a single sweep, and an adversarial pass that tries to *dismiss* each
finding strips the false positives a single-pass review sprays.

## Requirements
- **Claude Code's Workflow orchestration is required** — a paid plan (Pro/Max/Team/Enterprise,
  v2.1.154+); on Pro enable it once in `/config` → **Dynamic workflows**. Same as `pantheon`. Not on
  the Free tier.
- No external model needed. To route the adversarial *confirm* step to GPT-5.5, set
  `crossModelVerify: true` (needs the Codex plugin, like `pantheon-x`).

## When to use
- You have a real project/repo and want an evidence-backed list of gaps + prioritized feedback:
  before a launch, after an MVP, when inheriting a codebase, or as a periodic health pass.
- Don't use it to *write* code — that's `pantheon` / `pantheon-x`. Don't use it for a trivial
  one-file look; just read it. Each run costs real tokens — route deliberate audits here.

## Procedure (when this skill triggers)
1. **Pin the target.** Which project/path is being reviewed, and is there a focus (e.g. "security
   and tests only")? If unclear, ask 1 short question.
2. **Decide the parameters:**
   - `target`: an **absolute path** to the project root to audit.
   - `dimensions` (optional): an explicit list to audit; omit to let the scout pick the most relevant.
   - `focus` (optional): a dimension or area to emphasize.
   - `maxDimensions`: how many dimensions to probe (default 6).
   - `verifiers`: skeptical reviewers per finding (default 2; bump to 3 to be stricter — a finding is
     kept only if a majority confirm it).
   - `crossModelVerify`: `true` routes the confirm step to GPT-5.5/Codex (default `false`).
3. **Run the Workflow** — **Read `pantheon-gap-class.js` in this same directory**, then pass its
   contents inline as the Workflow `script` argument:
   ```
   Workflow({
     script: <contents of pantheon-gap-class.js>,
     args: { target, dimensions, focus, maxDimensions, verifiers, crossModelVerify }
   })
   ```
   (This skill's instruction is itself the approval to call Workflow.)
4. **It runs in the background.** When the completion notice arrives, report: which dimensions were
   probed, how many gaps were found vs. confirmed (survived adversarial review), the top prioritized
   gaps, the quick wins, and the single highest-leverage fix.

## Pipeline (what the script does)
- **Map** — one scout reads the README/structure/manifests/tests/CI, names the project's stated
  purpose and maturity, and picks the dimensions worth auditing for THIS project.
- **Probe** — one agent per dimension hunts for gaps (missing/incomplete/weak), each citing
  file-level evidence; high-signal findings over a long noisy list.
- **Confirm** — for each candidate gap, V skeptical reviewers try to DISMISS it (already handled?
  out of scope? false positive?); a gap is kept only if a majority confirm it. Optionally GPT-5.5.
- **Synthesize** — a judge dedups and prioritizes by impact × effort: top gaps, quick wins, and the
  highest-leverage next fix.

## Notes
- **Not a resident process.** One-shot per call, then exits — zero cost when idle.
- It **reports** gaps; it does not fix them. Hand the report to `pantheon` (or plain Opus) to act on.
- The adversarial *confirm* step is the point: it kills the plausible-but-false findings a
  single-pass review ships.
- Coding/agentic productivity only. Not for bypassing safety gates.
