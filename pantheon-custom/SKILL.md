---
name: pantheon-custom
description: >-
  A skill that runs a hard, testable coding task through a multi-agent harness (configurable variant:
  the user PICKS which AI model runs the adversarial verification — including non-Anthropic models like
  DeepSeek, Qwen, Kimi, or a local Ollama/LM Studio model). Same plan → parallel variants (test-driven
  self-correction) → adversarial verification → synthesis pipeline as the pantheon base, but the
  verifier is chosen per run via a `verifier` argument. Use when the user says "pantheon custom",
  "verify with deepseek/qwen", "use DeepSeek as the grader", "have a local model break it", "외부
  모델로 검증", "딥시크로 채점", "큐원으로 검증", "오픈클로처럼 채점자 모델 골라서", "로컬 모델로
  검증". If no model is given it defaults to Claude (same as the pantheon base). For the fixed presets
  use pantheon (Claude) / pantheon-x (GPT-5.6 Sol). To REVIEW an existing project rather than generate
  code, use pantheon-gap-custom. Don't use for easy one-shot work (cost is high).
---

# Pantheon harness (configurable · user-selectable verifier model)

Same `plan → parallel variants → test-driven self-correction → adversarial verification → synthesis`
pipeline as the `pantheon` base, but **the user picks which AI model runs the adversarial-verify step
per run** instead of it being fixed. `pantheon` always uses Claude; `pantheon-x` always uses GPT-5.6 Sol.
This skill lets you point the verifier at **any model the `codex` CLI can reach** — DeepSeek, Qwen,
Kimi, a local Ollama/LM Studio model, or your own configured provider — as well as the Claude tiers.

Anthropic's Workflow `agent()` can only run a Claude model or an installed plugin agent, so a true
"pick any vendor" dropdown isn't built in. This skill bridges that by driving **`codex exec`** (codex
is a multi-provider router) from a thin driver agent: the external model does the breaking, Claude only
relays its verdict.

Configure the model once with **`/pantheon-model`** (it saves your pick to `~/.pantheon/config.json`,
OpenClaw-style, and handles API keys), or name one inline per run. The verifier is selected with the
**`verifier`** argument, in OpenClaw-style `provider/model-id` form or a friendly alias:

| `verifier` value | adversarial verify runs on | setup needed |
|------------------|----------------------------|--------------|
| omitted / `claude` | Claude (session model) — same as the base | none |
| `opus` / `sonnet` / `haiku` / `fable` | that Claude tier | none |
| `codex` / `gpt` | GPT-5.6 Sol, via a shell-out to the Codex plugin's `codex-companion.mjs` | Codex plugin + `codex` login |
| `deepseek` | DeepSeek (`deepseek-chat`) | `DEEPSEEK_API_KEY` |
| `qwen` | Qwen2.5-Coder via Alibaba DashScope | `DASHSCOPE_API_KEY` |
| `kimi` | Kimi / Moonshot | `MOONSHOT_API_KEY` |
| `ollama:<model>` / `lmstudio:<model>` | a **local** model (e.g. `ollama:qwen2.5-coder`) | `codex` CLI + Ollama/LM Studio running, model pulled |
| `profile:<name>` | a profile from your `~/.codex/config.toml` (any provider) | `codex` CLI + that profile |
| `model:<name>` or a bare model id | that codex model id | `codex` CLI configured for it |

## Requirements
- **Workflow orchestration** — a paid plan (Pro/Max/Team/Enterprise, v2.1.154+); on Pro enable
  `/config` → Dynamic workflows. Same as `pantheon`. Not on the Free tier.
- **Claude-tier verifiers (`opus`/`sonnet`/`haiku`/`fable`) need nothing extra.**
- **External / local verifiers need the `codex` CLI on PATH** — it's the router this skill drives via
  `codex exec`. Note this is the codex **binary**; the plugin's `codex-companion.mjs`
  is only needed for `verifier: codex`/`gpt`. Per choice:
  - `deepseek` / `qwen` / `kimi` → the matching API-key env var must be set (`DEEPSEEK_API_KEY`,
    `DASHSCOPE_API_KEY`, `MOONSHOT_API_KEY`).
  - `ollama:` / `lmstudio:` → that local server running with the model pulled (no API key, fully local).
  - `profile:` / bare model id → the provider/model defined in `~/.codex/config.toml`.
- **If the chosen verifier can't actually run** (codex missing, key unset, model unreachable), the
  driver returns a verdict marked `unavailable: true` instead of fabricating one. The harness counts
  it as an ABSTENTION (excluded from the vote), and a variant with zero real verdicts is flagged
  `unverified` — and an unverified variant CANNOT win: if too few reviewers actually returned a
  verdict to reach quorum, the run ends with `insufficient_verifier_quorum` and no winner rather than
  crowning something nobody checked. When reporting, say so plainly. Check
  availability first (step 2); if you can't, fall back to the `pantheon` base or a Claude tier.

## When to use
- A hard implementation/refactor/migration whose **correctness is testable**, where you want a specific
  model to attack it — a cross-vendor model (DeepSeek/Qwen/Kimi) to break single-model blind spots, a
  free local model to save cost, or a particular Claude tier.
- Don't use it to *review* an existing project — that's `pantheon-gap-custom`. Don't use for trivial
  one-shot work. Each run costs real tokens (external API/local round-trips included).

## Procedure (when this skill triggers)
1. **Resolve the verifier (the model is configured separately by `/pantheon-model`):**
   1. If the user named a model inline ("verify with deepseek", "ollama/qwen2.5:7b로 검증"), use that —
      just this run; it doesn't change the saved default.
   2. Else **Read `~/.pantheon/config.json`** and use its `verifier`. If it also has a `providers` block,
      keep it to pass along (step 5).
   3. If there's **no config yet**, tell the user to run **`/pantheon-model`** once to pick a model (it
      lists what's available and sets up any API key), then either wait or proceed with the Claude
      default (`= the pantheon base`) for this run. Don't onboard here — picking the model is
      `/pantheon-model`'s job.
   Formats: OpenClaw-style `provider/model-id` (`ollama/qwen2.5:7b`, `deepseek/deepseek-chat`, …) or an
   alias (`deepseek`, `qwen`, `kimi`, `codex`, `ollama:<m>`, `profile:<name>`).
2. **Sanity-check the verifier can run:**
   - Claude tier → nothing to check.
   - `codex`/`gpt` → the Codex plugin's `codex-companion.mjs` exists and `codex login status` is OK.
   - Local (`ollama/…`, `lmstudio/…`) → `codex` CLI on PATH and the local server up with the model pulled.
   - Cloud (deepseek, qwen, gemini, …) → `codex` CLI on PATH and the provider's key available
     (`printenv <ENVKEY>`, or in `~/.pantheon/env` which the harness sources before codex). **If the key
     isn't set up, send the user to `/pantheon-model`** — it does the secure key setup (key goes in a
     file, never the chat). Don't collect keys here.
   If it can't run, offer a Claude tier or the `pantheon` base instead of a fake verification.
3. **Pin the task.** Extract the requirement; if unclear ask 1–2 short questions — *what tests define
   correctness* is the key.
4. **Decide the parameters:**
   - `task`: one-paragraph precise requirement + acceptance criteria (expressible as tests).
   - `workdir`: an **absolute path**. A real repo's path, or `/tmp/pantheon-<short-name>` for a check.
   - `lang`: language + the **exact test command**, e.g. `"TypeScript, vitest — \`pnpm test\`"`.
   - `variants`: usually 3, up to 5.
   - `verifiers`: usually 2, up to 3.
   - `verifier`: the model that runs the adversarial verify (see the table above). Omit for Claude.
5. **Run the Workflow** — **Read `pantheon-class.js` in this same directory** and pass its contents
   inline as the `script` argument. **Pass the chosen `verifier`:**
   ```
   Workflow({
     script: <contents of pantheon-class.js>,
     args: { task, workdir, lang, variants, verifiers, verifier, providers }
   })
   ```
   (`providers` = the `providers` block from `~/.pantheon/config.json` if present — `/pantheon-model`
   writes it for custom cloud providers; omit it and the built-in ~15-provider catalog still routes.
   This skill's instruction is itself the approval to call Workflow.)
6. **It runs in the background.** When the completion notice arrives, report: per-variant test status,
   who the chosen verifier broke vs. who survived, and the final winner's path, rationale, and grafting
   ideas. **State which model did the verifying** (the script logs it).

## Pipeline (what the script does)
- **Plan** — spec + test plan + N distinct strategies.
- **Implement** — parallel builders per strategy; each runs tests and loops fix→re-run up to 5 times (T1).
- **Verify** — for each green variant, V adversarial reviewers **on the chosen `verifier` model** "break
  it". For external/local models a driver runs `codex exec` (sandbox: workspace-write, ephemeral) and
  relays the model's structured verdict; dropped on majority defect.
- **Synthesize** — a Claude judge picks the winner and grafts the good ideas.

## Notes
- **Not a resident process.** One-shot per call, then exits — zero cost when idle.
- The external model does the actual judging; Claude only transports its verdict, so cross-vendor
  independence holds. Built-in `deepseek`/`qwen`/`kimi` aliases are conveniences — for full control set
  up a `profile:` in `~/.codex/config.toml`.
- Coding/agentic productivity only. Not for bypassing safety gates.
