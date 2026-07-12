# pantheon-skills

Claude Code skills that run a hard coding task through a multi-agent harness instead of a single model pass: **plan → N parallel implementations → adversarial verification → judge**. The point isn't a smarter model — it's that a second (and third) implementation, plus an independent reviewer whose job is to *break* the result, catches bugs a single pass ships green. A second pair — **`pantheon-gap`** and its cross-model twin **`pantheon-gap-x`** — turns the same shape into a reviewer: it points the harness at an *existing* project and reports what's missing. Each side also has a **configurable** variant — **`pantheon-custom`** / **`pantheon-gap-custom`** — that lets you pick which model runs the adversarial step — a Claude tier, GPT-5.6 Sol, or a cross-vendor/local model (DeepSeek, Qwen, Kimi, a local Ollama model …) routed through the `codex` CLI. A **third** trio — **`pantheon-fix`** (+ `-x` / `-custom`) — closes the loop: it takes a known defect and *applies* a regression-safe patch in an isolated git worktree, diff-only until you approve.

It's a packaging of well-worn techniques — best-of-N sampling, tool-integrated self-correction, and LLM-as-judge / adversarial verification — wired into one `/pantheon` command so you don't reassemble them by hand each time. This is scaffolding *around* the model, not a change *to* it: it won't rescue a task the model fundamentally can't reason about, but it reliably tightens correctness on coding work whose answer you can express as tests.

The harness runs a deterministic pipeline:

```
Plan ──▶ Implement (×N parallel) ──▶ Verify (adversarial ×V) ──▶ Synthesize
 │            │ each self-corrects            │ try to BREAK each      │ judge picks winner
 1 planner    │ against its own tests (T1)    │ green build            │ + grafts best ideas
              N builders                       reviewers
```

- **Plan** — derive a tight spec, a test plan that *defines* correctness, and N distinct strategies (before any code).
- **Implement** — N builders implement different strategies in parallel; each runs its own tests and self-corrects on failure (tool-integrated self-verification, up to 5 iterations).
- **Verify** — independent adversarial reviewers try to *break* each green build; a build refuted by a majority is dropped.
- **Synthesize** — a judge picks the winner and lists superior ideas worth grafting from the runners-up.

The value: a build can pass its *own* tests yet still be wrong. The adversarial layer catches defects the self-written tests miss, instead of rubber-stamping a green build.

## The three generation skills

| Skill | Adversarial verifier | Requirements |
|-------|----------------------|--------------|
| **`pantheon`** | Claude itself (independent agents) | Paid Claude Code plan + Workflows (see below) |
| **`pantheon-x`** | **GPT-5.6 Sol via Codex plugin** (cross-model) | Above **+** OpenAI Codex plugin (its `codex-companion.mjs`) + a logged-in `codex` CLI |
| **`pantheon-custom`** | **whatever you pass** — `verifier`: a Claude tier, `codex`/GPT-5.6 Sol, or an external/local model (`deepseek`, `qwen`, `kimi`, `ollama:<m>`, `profile:<name>` …) | Workflows; pick the model with `/pantheon-model` — **cloud = just an API key** (direct call), local = `codex` CLI + Ollama/LM Studio |

`pantheon-x` is the stronger setting: the implementation written by Claude is attacked by a *different* model, which shrinks single-model blind spots (the same mistake slipping past a same-model verifier). If you don't have Codex/GPT-5.6 Sol, use `pantheon`.

All three share the same harness (`pantheon-class.js`); they differ only in which model runs the adversarial verify — `pantheon` fixes it to Claude, `pantheon-x` to GPT-5.6 Sol, and **`pantheon-custom`** lets you choose per run with a `verifier` arg. Because Claude Code's `agent()` only runs a Claude model or a plugin agent, `pantheon-custom` reaches other vendors out-of-band — a Claude tier natively, GPT-5.6 Sol via the Codex plugin, local models via `codex --oss`, and **cloud providers by calling their `/chat/completions` directly**. You pick the model OpenClaw-style with **`/pantheon-model`** (saved to `~/.pantheon/config.json`); see [Picking the verifier model](#picking-the-verifier-model--pantheon-model) below for the catalog, how each model is reached, and key handling.

## The review skills (`pantheon-gap` / `pantheon-gap-x` / `pantheon-gap-custom`)

`pantheon` and `pantheon-x` *generate* code. **`pantheon-gap`** runs the same multi-agent shape in the other direction — at an existing project — to answer "what's missing?":

```
Map ──▶ Probe (×N dimensions) ──▶ Confirm (adversarial) ──▶ Synthesize
 │            │ one agent per          │ skeptical reviewers      │ judge dedups,
 1 scout      │ dimension hunts        │ try to DISMISS each      │ prioritizes by
 (purpose,    │ gaps with file-        │ finding; kept only if    │ impact × effort
  stack,      │ level evidence         │ a majority confirm it    │
  maturity)   N probes                  reviewers
```

- **Map** — a scout reads the README/structure/manifests/tests/CI and picks the dimensions worth auditing for *this* project (completeness, correctness, tests, security, docs, architecture, DX, performance, ops).
- **Probe** — one agent per dimension hunts for gaps, each citing file-level evidence.
- **Confirm** — the same adversarial trick, inverted: reviewers try to *dismiss* each finding, so the false positives a single-pass review sprays get dropped.
- **Synthesize** — a judge dedups and prioritizes: top gaps, quick wins, and the single highest-leverage fix.

It **reports** gaps; it does not fix them — hand the report to **`pantheon-fix`** (which patches it safely, behind a regression gate; see below) or plain Opus to act on.

| Skill | Adversarial confirm | Requirements |
|-------|---------------------|--------------|
| **`pantheon-gap`** | Claude (skeptical agents) | Paid Claude Code plan + Workflows |
| **`pantheon-gap-x`** | **GPT-5.6 Sol via Codex plugin** (cross-model) | Above **+** OpenAI Codex plugin (its `codex-companion.mjs`) + a logged-in `codex` CLI |
| **`pantheon-gap-custom`** | **whatever you pass** — `verifier`: a Claude tier, `codex`/GPT-5.6 Sol, or an external/local model (`deepseek`, `qwen`, `kimi`, `ollama:<m>`, `profile:<name>` …) | Workflows; pick the model with `/pantheon-model` — **cloud = just an API key** (direct call), local = `codex` CLI + Ollama/LM Studio |

`pantheon-gap-x` is the review-side equivalent of `pantheon-x`: a *different* model judges each finding, so it strips the Claude probe's "I found a gap" confirmation bias harder. The three share the same harness (`pantheon-gap-class.js`); they differ only in which model runs the confirm step — `pantheon-gap` fixes it to Claude, `pantheon-gap-x` to GPT-5.6 Sol, and **`pantheon-gap-custom`** lets you choose per run with a `verifier` arg — including a cross-vendor (cloud) or local model — see [Picking the verifier model](#picking-the-verifier-model--pantheon-model); the confirm step is read-only, so it never writes into the reviewed repo. If you don't have a key / Codex / a local model, use `pantheon-gap` (or `pantheon-gap-custom` with a Claude tier).

## The fix skills (`pantheon-fix` / `pantheon-fix-x` / `pantheon-fix-custom`)

`pantheon-gap` *finds* gaps; **`pantheon-fix`** *closes* them. Same multi-agent shape, pointed at a known defect — but it edits real code, so it's wrapped in safety: every candidate fix runs in a throwaway `git worktree`, and the output is a diff you review before applying.

```
Baseline ──▶ Plan ──▶ Fix (×N parallel) ──▶ Verify (adversarial ×V) ──▶ Synthesize
 │            │         │ each in its own        │ try to BREAK each      │ judge picks the
 record       restate   │ git worktree: repro    │ surviving fix          │ smallest, safest
 HEAD's       the bug,  │ test + minimal fix,    │ (still broken? new      │ patch → emit a
 green tests  pick N    │ gated: no-regression   │ regression? too broad?) │ diff (apply only
 (1 baseline) strategies N fixers + repro-green   reviewers                │ if you ask)
```

- **Baseline** — record the test command and which tests pass at HEAD, so a regression is detectable. Aborts if the target isn't a git repo (worktree isolation needs git).
- **Plan** — restate the defect, decide whether a test can reproduce it, propose N distinct fix strategies.
- **Fix** — N fixers in parallel, each in its own worktree: write a failing repro test, apply a *minimal* fix, loop fix→re-run until the repro passes **and** nothing that passed before now fails (regression gate).
- **Verify** — adversarial reviewers try to break each candidate fix: does the bug still reproduce on a nearby input, did the patch introduce a new regression the suite missed, is the change over-broad?
- **Synthesize** — a judge picks the smallest, safest surviving patch and emits a diff. **Your working tree is never touched** unless you pass `apply: true` (and even then it's not committed).

| Skill | Adversarial verifier | Requirements |
|-------|----------------------|--------------|
| **`pantheon-fix`** | Claude (skeptical agents) | Paid Claude Code plan + Workflows; the target is a git repo |
| **`pantheon-fix-x`** | **GPT-5.6 Sol via Codex plugin** (cross-model) | Above **+** OpenAI Codex plugin (its `codex-companion.mjs`) + a logged-in `codex` CLI |
| **`pantheon-fix-custom`** | **whatever you pass** — `verifier`: a Claude tier, `codex`/GPT-5.6 Sol, or an external/local model (`deepseek`, `qwen`, `kimi`, `ollama:<m>`, `profile:<name>` …) | Workflows; pick the model with `/pantheon-model` — **cloud = just an API key** (direct call), local = `codex` CLI + Ollama/LM Studio |

The three share one harness — `pantheon-fix/pantheon-fix-class.js`; `-x` and `-custom` load that *same* file with a different `verifier` (no separate copy, so they can't drift). **One defect per run** keeps each patch minimal and the diff easy to review — for several gaps, run it once each.

## Picking the verifier model — `/pantheon-model`

The `*-custom` skills don't hard-code the adversarial model — you choose it, OpenClaw-style. Run **`/pantheon-model`** once: it lists the models actually available on your machine, you pick one, it sets up any API key, and it saves the choice to `~/.pantheon/config.json`. After that `pantheon-custom` (generate), `pantheon-gap-custom` (review), and `pantheon-fix-custom` (fix) use that model without re-asking; you can still override per run by naming a model inline ("verify with deepseek").

The model id is OpenClaw-style **`provider/model-id`** (`anthropic/haiku`, `ollama/qwen2.5:7b`, `deepseek/deepseek-chat`, `openrouter/qwen/...`). The selectable catalog is **`providers.json`** (shipped inside `pantheon-model/`) — ~27 cloud providers (DeepSeek, OpenRouter, Mistral, Groq, xAI/Grok, Qwen, Gemini, Moonshot/Kimi, Together, NVIDIA, Cohere, Perplexity, Z.AI/GLM, …) plus local Ollama / LM Studio / vLLM / SGLang. To add an OpenAI-compatible provider, edit `pantheon-model/providers.json`; `/pantheon-model` then offers it and copies its routing block into `~/.pantheon/config.json` when you pick it.

**How each model is reached.** Claude Code's `agent()` can only run a Claude model or an installed plugin agent, so non-Claude models are reached out-of-band:

| Verifier | How it runs | Setup |
|----------|-------------|-------|
| Claude tier (`anthropic/haiku` …) | native `agent({model})` | none |
| GPT-5.6 Sol (`codex`) | a shell-out to the Codex plugin's `codex-companion.mjs` (never the `codex-rescue` agent — see below) | Codex plugin + ChatGPT/codex login |
| Local (`ollama/…`, `lmstudio/…`) | `codex exec --oss --local-provider …` | `codex` CLI + the local server (model pulled) |
| Cloud (`deepseek`, `qwen`, `gemini` …) | a direct `curl` to the provider's **`/chat/completions`** | the provider's API key — **no codex** |

> **Cloud goes straight to the provider, not through codex.** the codex CLI only speaks the OpenAI *Responses* wire, which chat-only vendors (DeepSeek and most others) don't implement — so the harness calls each cloud provider's OpenAI-compatible `/chat/completions` itself. The external model does the judging; a Claude driver only relays its structured verdict — and because a chat API has no file access, the driver **inlines the code under review** (implementation + tests, the cited evidence, or the patch) into the request so the external model judges the actual code, not a path string. If a model can't be reached, the run returns an `unavailable` verdict — counted as an abstention, with the variant/gap flagged `unverified`/`unconfirmed` in the result — rather than faking a pass.

**API keys never touch the chat.** For a cloud provider, `/pantheon-model` creates `~/.pantheon/env` (`chmod 600`); you paste the key into that file and the harness reads it at run time (parsed as `KEY=VALUE`, never `source`d). Only the model id in `~/.pantheon/config.json` is non-secret (safe to share/commit). The runtime routing table is **generated from `providers.json`**, so every catalogued provider actually routes — and a `baseUrl` must be HTTPS (or loopback) before a key is sent to it.

> **⚠️ Rough edges to know (it's a prototype):**
> - **Evidence containment is prompt-enforced, not harness-enforced.** When `pantheon-gap-custom` ships cited code to an external provider, the driver agent is *instructed* to `realpath`-check every path against the target and to report what it sent (`filesSent` / `filesSkipped`). A determined prompt injection in a hostile repo could still talk it out of that. Don't point the custom gap skills at a repo you don't trust.
> - **Some provider endpoints are `"unverified": true`.** Their base URLs come from docs, not from a live call with a real key. A wrong one surfaces as an `unavailable` verdict (an abstention), never a silent pass.
> - **Only put providers you trust into `providers.json` / `config.json`.** The scheme is validated; the host is whatever you wrote. Treat these as secret-adjacent config.
> - **Evidence containment is prompt-enforced, not harness-enforced** (see the note above) — the one gap where the harness asks an agent to police itself.

## Requirements

These skills drive Claude Code's **Workflow** orchestration engine, so a stock/Free setup is not enough:

- **Claude Code ≥ v2.1.154** on a **paid plan** — Pro, Max, Team, or Enterprise (also Bedrock / Vertex / Foundry). **Not available on the Free tier.**
- On **Pro**, enable it once: `/config` → turn on **Dynamic workflows**.
- **`pantheon-x` / `pantheon-gap-x` / `pantheon-fix-x` (and the `*-custom` skills *only when you pick* `codex`/`gpt`):** the cross-model reviewer is invoked by shelling out to the Codex plugin's `codex-companion.mjs`, which needs a logged-in `codex` CLI. **Do not route this through the `codex:codex-rescue` subagent** — it is a forwarding wrapper whose instruction loses to the StructuredOutput instruction a `schema` injects, so it reviews with its own sonnet and never calls codex, silently. Every verdict now carries a `[codex:<threadId>]` stamp and the run reports `crossModelVerified`; trust that field, not the skill's name. (Claude-family `verifier` choices need none of this.) Install the plugin:
  ```
  /plugin marketplace add openai/codex-plugin-cc
  /plugin install codex@openai-codex
  ```
  plus a ChatGPT subscription (or `OPENAI_API_KEY`) and **codex-cli ≥ 0.140** on PATH (older builds reject `gpt-5.6-*` with a 400). **If codex isn't reachable, use `pantheon` / `pantheon-gap` (or a Claude-family `verifier` in the `*-custom` skills) instead.** An `-x` run whose codex calls fail no longer rubber-stamps anything: unstamped verdicts count as abstentions, quorum fails, and the run ends with `insufficient_verifier_quorum` and no winner — safe, but a wasted run.
- **`pantheon-custom` / `pantheon-gap-custom` non-Claude verifiers** don't need the Codex *plugin*:
  - **Cloud** (`deepseek`, `qwen`, `gemini`, `groq`, …) is called via a **direct `/chat/completions` request** — you only need that provider's API key (set up by `/pantheon-model` into `~/.pantheon/env`). No codex involved. *(the codex CLI only speaks the OpenAI Responses wire, which chat-only vendors don't implement — so the harness calls them itself.)*
  - **Local** (`ollama/…`, `lmstudio/…`) uses `codex exec --oss`, so it needs the **`codex` CLI** on PATH and the local server running with the model pulled (no key).
  - See [Picking the verifier model](#picking-the-verifier-model--pantheon-model). If a chosen model can't be reached, the run flags the verdict "unavailable" rather than faking a pass.

Skills and subagents themselves are stock Claude Code features; no extra setup beyond the above.

## Install

Clone into your Claude Code skills directory (personal install):

```bash
git clone https://github.com/lolu1032/pantheon-skills.git
cp -R pantheon-skills/pantheon       ~/.claude/skills/pantheon
cp -R pantheon-skills/pantheon-x     ~/.claude/skills/pantheon-x
cp -R pantheon-skills/pantheon-gap   ~/.claude/skills/pantheon-gap
cp -R pantheon-skills/pantheon-gap-x ~/.claude/skills/pantheon-gap-x
cp -R pantheon-skills/pantheon-custom     ~/.claude/skills/pantheon-custom
cp -R pantheon-skills/pantheon-gap-custom ~/.claude/skills/pantheon-gap-custom
cp -R pantheon-skills/pantheon-fix        ~/.claude/skills/pantheon-fix
cp -R pantheon-skills/pantheon-fix-x      ~/.claude/skills/pantheon-fix-x
cp -R pantheon-skills/pantheon-fix-custom ~/.claude/skills/pantheon-fix-custom
cp -R pantheon-skills/pantheon-model      ~/.claude/skills/pantheon-model
```

(`pantheon-fix-x` / `pantheon-fix-custom` load the shared `pantheon-fix/pantheon-fix-class.js`, so install `pantheon-fix` alongside them.)

Or for a single project, copy into `<project>/.claude/skills/`.

## Usage

In Claude Code:

```
/pantheon     <a hard implementation task whose correctness is testable>
/pantheon-x   <same, but GPT-5.6 Sol does the adversarial verification>
/pantheon-custom <same, but YOU pick the verifier model — verifier: deepseek|qwen|kimi|ollama:<m>|opus|sonnet|codex>
/pantheon-gap   <path to an existing project>   # gap analysis / feedback review, not generation
/pantheon-gap-x <same, but GPT-5.6 Sol (Codex) does the adversarial confirm>
/pantheon-gap-custom <same, but YOU pick the confirm model — verifier: deepseek|qwen|kimi|ollama:<m>|opus|sonnet|codex>
/pantheon-fix        <repo + a defect/gap>   # patch an existing bug safely (worktree-isolated, regression-gated, diff-only)
/pantheon-fix-x      <same, but GPT-5.6 Sol (Codex) tries to break each fix>
/pantheon-fix-custom <same, but YOU pick the verifier model — verifier: deepseek|qwen|kimi|ollama:<m>|opus|sonnet|codex>
/pantheon-model      <pick/configure the verifier model the *-custom skills use (OpenClaw-style setup; handles API keys)>
```

Example:

```
/pantheon Add idempotency-key handling to the payments module so concurrent requests can't double-charge. Tests: pnpm test (vitest)
```
```
/pantheon-gap Audit /path/to/my-repo — what's missing before launch? Focus on tests and security.
```
```
/pantheon-fix Fix the shutdown deadlock in /path/to/my-repo: Write() holds the mutex across the blocking ptmx.Write, so Close() can never acquire it. Tests: go test ./...
```

Claude collects the parameters (`task`, `workdir`, `lang` + test command, `variants`, `verifiers`) and launches the harness as a background Workflow, then reports: per-variant test results, which builds the adversarial pass broke, and the final winner with its rationale and grafting suggestions.

### Parameters

| arg | default | notes |
|-----|---------|-------|
| `task` | — | one-paragraph requirement + acceptance criteria (expressible as tests) |
| `workdir` | `/tmp/pantheon-<name>` | absolute path; a real repo or a scratch dir |
| `lang` | Python/unittest | language **+ the exact test command** for your stack |
| `variants` | 3 | bump to 5 for harder problems |
| `verifiers` | 2 | bump to 3 to be stricter (majority refutation drops a build) |
| `crossModelVerify` | `false` (`pantheon`) / `true` (`pantheon-x`) | route adversarial verify to GPT-5.6 Sol/Codex |
| `verifier` | `~/.pantheon/config.json` default, else Claude (`*-custom` only) | the adversarial model: a Claude tier (`opus`/`sonnet`/`haiku`/`fable`), `codex`/`gpt` (Codex plugin), or an external/local model via the `codex` CLI — `deepseek`, `qwen`, `kimi`, `ollama:<m>`, `profile:<name>`, or **OpenClaw-style `provider/model-id`** (`ollama/qwen2.5:7b`, `deepseek/deepseek-chat`, `openrouter/qwen/...`). Set a persistent default in `~/.pantheon/config.json`; first run onboards you. |
| `repo` | — | **`pantheon-fix*` only** — absolute path to the **git** repo to patch (gen/review use `workdir` instead) |
| `gap` | — | **`pantheon-fix*` only** — the defect to fix: a precise description, or a gap pasted from `pantheon-gap` (one defect per run) |
| `testCommand` | auto-detected | **`pantheon-fix*` only** — the exact suite command (`pnpm test`, `go test ./...`, …); the Baseline agent detects it if omitted |
| `apply` | `false` | **`pantheon-fix*` only** — `false` = emit a diff only; `true` = apply the winning patch to the working tree (never committed) |

## Cost & scope

- **Not a daemon.** Each invocation runs once to completion and exits — zero cost when idle.
- A run spends real tokens. A representative run is ~11 subagents and a few hundred K to ~1M tokens end-to-end, ~6–10 min wall-clock; heavier settings (`variants=5`, `verifiers=3`, cross-model) cost more. On Pro/Max it draws from your usage quota; on metered API access, budget a few dollars per run and up. **Route only the hardest 10–20% of tasks here** — use plain Opus for the rest.
- This buys *correctness on testable work*, not raw model intelligence. If a task isn't expressible as tests, the adversarial layer has little to grip and the overhead isn't worth it.
- Coding/agentic productivity only. **Not** a tool for bypassing safety gates (cybersecurity/biology capability restrictions).

## FAQ

**Isn't this just a prompt wrapper?**
There's no model change — it's orchestration, yes. The non-trivial part is the *adversarial* step: an independent agent (a different model in `pantheon-x`) whose job is to break a build rather than confirm it. That's what catches defects the builder's own green tests rubber-stamp. The value is the harness shape, not a secret prompt.

**Do you have benchmarks vs. plain Opus?**
No formal benchmark yet — treat the description as *mechanism*, not a measured delta. The value is in the adversarial step: a build can pass its own tests and still be wrong, and an independent reviewer catches what the self-written tests rubber-stamp. There's an illustrative run in [`benchmarks/comparison.md`](./benchmarks/comparison.md) — the same task/review through three verifier models (Claude / GPT-5.6 Sol / DeepSeek). It's **not** a clean benchmark (the generation task was too easy to break, and the review runs hit a rate-limit), but pointed at its own repo the gap harness surfaced real, specific defects in *this* project — the more honest demonstration. If you run a proper head-to-head, I'd genuinely like to see the numbers.

**What does a run cost?**
A few hundred K to ~1M tokens and ~6–10 min at default settings; more for `variants=5` / `verifiers=3` / cross-model. It's meant for the hardest 10–20% of tasks, not everyday edits. See [Cost & scope](#cost--scope).

**It says "Workflow tool not found" / nothing happens.**
You're likely on the Free tier, or haven't enabled workflows. See [Requirements](#requirements) — needs a paid plan and, on Pro, `/config` → **Dynamic workflows**.

**Why route verification to GPT-5.6 Sol / another vendor's model?**
Same-model verifiers share blind spots — a mistake the builder makes, a same-model reviewer tends to miss too. A *different* model is a cheap way to break that correlation. It's optional: `pantheon` runs Claude-on-Claude and still helps.

## Cross-model verification: how `-x` actually works

The `-x` skills claim a *different vendor's* model attacks what Claude wrote. That claim is only worth
something if it's true, so the harness proves it rather than asserting it.

**Do not route the adversarial step through `agentType: 'codex:codex-rescue'`.** That agent is a thin
forwarding wrapper (`model: sonnet`, *"forward the request, do nothing else"*) — but these harnesses pass
a `schema`, and the StructuredOutput instruction the Workflow tool injects **beats** the forwarding
instruction. The wrapper then reviews the code with its own sonnet model and **never invokes codex at
all.** It fails silently: verdicts come back plausible and confident, `unavailable` is never set, and the
run reports itself as cross-verified when it was Claude judging Claude — with a *weaker* model than the
base skills, which inherit the main-loop model. A real run measured **1 of 84** reviewers actually
reaching codex. It also invalidated this repo's own
[cross-model benchmark](./benchmarks/tetmux-cross-model.md), which is now retracted.

So instead:

1. The reviewer agent is a **transcriber**, not a reviewer. It shells out to the Codex plugin's
   `codex-companion.mjs` with the model pinned, and is forbidden from forming its own opinion.
2. Every genuine verdict is stamped `[codex:<threadId>]` with the real thread id from that call. The
   audit matches the **full UUID shape**, so a transcriber can't satisfy it by inventing the marker.
3. **An unstamped verdict counts as an abstention** — however confident it reads. With no real verdicts,
   quorum can't be met, and the run ends in `insufficient_verifier_quorum` with **no winner** rather than
   shipping a same-model result wearing an `-x` label.
4. Every run reports `crossModelVerified` and `verdictProvenance: {total, fromCodex, pct}`.

**Trust that field, not the skill's name.** A healthy run looks like:

```
✅ Cross-model verified: 56/56 verdicts came from GPT-5.6 Sol (Codex).
   crossModelVerified: true,  verdictProvenance: { total: 56, fromCodex: 56, pct: 100 }
```

## Does the fail-closed gate actually matter?

It fired on its first real job. `pantheon-fix-x` was pointed at a live anti-cheat bypass in a running
app — a defect whose reviewer-suggested fix was, on paper, one word. Across two rounds it built six
candidate fixes. Every one passed its own repro test and regressed nothing. **The adversarial
reviewers broke all six**, each time with a failing case they had actually run:

| # | What broke the candidate |
|---|---|
| 1 | The naive fix bans honest runners (re-opens a false positive an earlier commit had closed) |
| 2 | Despiking deletes the very evidence the fix was preserving |
| 3 | The threshold false-positives on Android's integer-second timestamps |
| 4 | Neutralizing that re-breaks spike detection |
| 5 | The detector *sorts by timestamp*, so backward-timestamp evidence never survives to be checked |
| 6 | The threshold is per-segment, so a cheater just splits the jump in two |

The old harness would have shipped one of them — it had a fallback that crowned the "best of" a fully
refuted field, and `apply: true` would have written it to the working tree. The current one returns
`all_candidates_refuted`, offers **no patch**, and hands back a precise, empirically-verified account
of why every approach fails. That's the whole product: a harness that refuses is worth more than one
that guesses.

## No variant grades its own homework

Every skill used to let each variant write its own tests and then report whether they passed. That
sounds harmless until you watch it fail: pointed at a real anti-cheat bypass, six candidate fixes
across two rounds each wrote a repro test, each made it pass, and the adversarial reviewers broke
**all six**. Every one had written a test just weak enough to be satisfied by the fix it happened to
produce.

So the test moved out of the variants' hands, in the fix *and* generation skills:

1. **The planner owns the canonical test.** In `pantheon-fix` it writes the repro test and proves it
   fails at HEAD for the *right* reason. In the generation skills it also pins an **API contract** —
   the exact surface every variant must implement — and writes the test against it.
2. **Every variant runs that same file**, byte for byte, and may not edit, weaken, skip, rename or
   special-case it. "Green" now means the same thing across variants, so comparing them finally means
   something — and because they share one API, the winner is a drop-in for any of them.
3. **An independent auditor re-writes the canonical test from the planner's copy and re-runs it.** Its
   observation — never the variant's self-report — is what the gate sees. Tampering is detected and
   reported; a variant whose audit didn't run is `unaudited` and cannot win, for the same reason an
   unverified one can't.

The payoff shows up immediately. On a live LRU+TTL cache run, all three variants shipped a
byte-identical 27-case test and the same import surface — which let the judge fuzz all three against
each other (4,000 trials, zero behavioral divergence) and then pick on *auditability* rather than
guessing at correctness. That comparison was impossible when each variant invented its own API and its
own tests.

## How the safety gates work

The whole point of a harness is that it refuses to hand you something it couldn't verify. Three rules
make that true, and `test/gates.test.js` locks each one in:

- **Fail-closed gates.** If no variant goes green, if no fix makes its repro test pass, or if the
  reviewers break every candidate, the run returns a structured **no-winner** result and offers
  nothing. There is no "least-bad candidate" fallback. (There used to be — and
  [the benchmark](./benchmarks/tetmux-cross-model.md) caught it crowning a patch all three reviewers
  had refuted.)
- **A tie refutes.** With two reviewers, one confirmed defect is enough to drop a candidate. For an
  admission gate the tie has to break *against* the thing being admitted. Note the gap skills
  deliberately invert this — there a tie *keeps* the finding, so a split vote never silently discards
  a probe's work.
- **Quorum.** A reviewer that couldn't run (dead agent, missing key, non-200) **abstains** — it is
  never counted as "found no defect". At least `floor(V/2)+1` reviewers must return a real verdict or
  the candidate is `unverified` and cannot win. So `verifiers: 2` tolerates no failures; use
  `verifiers: 3` to survive one. A completely dead verifier fleet yields `insufficient_verifier_quorum`,
  not a silent pass.

## Contributing

The harness logic is physically duplicated into 7 self-contained workflow scripts, because the
Workflow tool runs each one with no imports. **Don't edit those copies.** The source of truth is
[`lib/gates.js`](./lib/gates.js) (gates, voting, verifier routing) and
[`providers.json`](./providers.json) (the provider catalog, which *generates* the runtime routing
tables). After changing either:

```bash
npm run inline    # propagate into the 7 workflow scripts
npm run check     # drift check + unit tests + workflow-script parse + skill-manifest lint
```

CI runs `npm run check` and fails on drift, so the copies cannot silently diverge.

## Status

Solo project, **as-is, best-effort**. Issues and PRs are welcome, but maintenance comes with no guarantees or SLA — I may not get to everything. It's MIT-licensed, so forking is a first-class option if you want to take it further.

## License

[MIT](./LICENSE)
