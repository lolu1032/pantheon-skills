// =============================================================================
// pantheon — SHARED HARNESS LOGIC (single source of truth)
//
// The Workflow tool runs each `*-class.js` as a SELF-CONTAINED script: no imports,
// no filesystem, no Date.now()/Math.random(). So this logic cannot be imported by
// the workflows — it is INLINED into them by `node scripts/inline.js`, which copies
// the regions between the PANTHEON:* markers below into the matching markers in each
// workflow file. CI runs `scripts/inline.js --check` and fails on drift.
//
// EDIT HERE, NEVER IN THE WORKFLOW FILES. Then run `npm run inline`.
// Unit tests import this module directly (test/gates.test.js).
// =============================================================================

// <<< PANTHEON:CODEX
// --- GENERATED:CODEX from providers.json by scripts/inline.js — DO NOT HAND-EDIT ---
const CODEX_MODEL = "gpt-5.6-sol"
const CODEX_LABEL = "GPT-5.6 Sol (Codex)"
// --- END GENERATED:CODEX ---

// ---- cross-model verification, for real this time -------------------------
//
// DO NOT route the adversarial step through `agentType: 'codex:codex-rescue'`. That agent is a thin
// forwarding wrapper (model: sonnet, "forward the request, do nothing else") — but these harnesses
// pass a `schema`, and the StructuredOutput instruction the Workflow tool injects BEATS the
// forwarding instruction. The wrapper then reviews the finding with its own sonnet model and never
// invokes codex at all. It fails SILENTLY: verdicts come back plausible and non-empty, `unavailable`
// is never set, and the run reports itself as cross-verified when it was Claude judging Claude — with
// a WEAKER model than the base skill, which inherits the main-loop model. A real run measured 1 of 84
// confirm agents actually reaching codex.
//
// So: shell out to the codex companion explicitly, and make the agent a TRANSCRIBER that may not form
// its own opinion. Then AUDIT it — every genuine verdict carries a `[codex:<threadId>]` stamp, and a
// verdict without one does not count as cross-model no matter how confident it sounds.

// Matching the full UUID shape (not just the "[codex:" prefix) means a transcriber cannot satisfy the
// audit by inventing the marker without ever running the command.
const CODEX_MARK = /\[codex:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]/i
function fromCodex(v) {
  if (!v) return false
  return CODEX_MARK.test(v.reason ?? '') || CODEX_MARK.test(v.description ?? '')
}

// Builds the transcriber prompt. `core` is the review prompt handed to codex VERBATIM; `verdictJson`
// is the exact JSON shape we want back; `markField` is the field that must carry the provenance stamp.
function codexTranscriber({ core, verdictJson, cwd, effort = 'medium', markField = 'reason', unavailableJson }) {
  return (
    `You are a TRANSCRIBER in a Pantheon harness. You are NOT the reviewer. Do NOT form your own ` +
    `opinion about what follows — ${CODEX_LABEL} decides, you only relay its verdict.\n\n` +
    `Steps:\n` +
    `1. Locate the codex companion:\n` +
    `   COMPANION=$(ls -d "$HOME"/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | tail -1)\n` +
    `2. Write the REVIEW PROMPT below to a temp file VERBATIM, using a QUOTED heredoc ` +
    `(cat > "$TMP" <<'PROMPT_EOF' ... PROMPT_EOF) so no shell expansion mangles it.\n` +
    `3. Run it read-only (NEVER pass --write), pinning the model:\n` +
    `   cd ${JSON.stringify(cwd)} && node "$COMPANION" task --fresh --json --model ${CODEX_MODEL} --effort ${effort} --prompt-file "$TMP"\n` +
    `4. It prints {"status":0,"threadId":"...","rawOutput":"<the model's answer>"}. Parse rawOutput as the verdict JSON.\n` +
    `5. Call StructuredOutput with EXACTLY what it decided — copy the values, do not adjust them. ` +
    `The \`${markField}\` field MUST begin with "[codex:<threadId>] " using the REAL threadId from step 4, ` +
    `followed by the model's own reasoning.\n` +
    `6. If the command errors, times out, returns status!=0, or rawOutput holds no parsable verdict: ` +
    `return ${unavailableJson}. NEVER substitute your own judgment — an honest abstention is required, ` +
    `and the harness counts it as one. A verdict you invented is worse than no verdict, because it ` +
    `looks like cross-model verification and is not.\n\n` +
    `The verdict JSON shape codex must return:\n${verdictJson}\n\n` +
    `REVIEW PROMPT (pass verbatim to codex):\n---\n${core}\n---`
  )
}

// Did the cross-model verification the user ASKED for actually happen? Counted over every real verdict
// in the run, and reported in the result so a degraded run can never pass itself off as a clean one.
function crossModelAudit(tallies, crossVerify) {
  const total = tallies.reduce((s, t) => s + (t.realCount ?? 0), 0)
  const fromCodexCount = tallies.reduce((s, t) => s + (t.codexCount ?? 0), 0)
  return {
    total,
    fromCodex: fromCodexCount,
    verified: Boolean(crossVerify) && total > 0 && fromCodexCount === total,
    pct: total ? Math.round((fromCodexCount / total) * 100) : 0,
  }
}
// >>> PANTHEON:CODEX

// <<< PANTHEON:GATES
// ---- adversarial vote ------------------------------------------------------
//
// An `unavailable` verdict is an ABSTENTION, not a pass: a reviewer that could not run
// (dead agent, missing API key, non-200 from an external provider) is excluded from the
// vote entirely rather than counted as "found no defect".
//
// QUORUM: at least floor(V/2)+1 of the V reviewers must return a REAL verdict before the
// vote is trusted at all. Below quorum the candidate is `unverified` — NOT refuted, but
// also NOT eligible to win. Without this, V=3 with two dead reviewers lets a single agent
// decide the whole run, and a fully-dead verifier fleet (e.g. a broken Codex CLI) silently
// green-lights everything.
function verifierQuorum(V) {
  return Math.max(1, Math.floor(V / 2) + 1)
}

// REFUTE-direction tally — pantheon (generation) and pantheon-fix.
// The reviewers try to BREAK the candidate, so a TIE REFUTES: with 2 real verdicts, one
// confirmed defect is enough to kill it. This asymmetry is deliberate and load-bearing —
// for an admission gate the tie must break AGAINST the thing being admitted. Raising this
// to a strict majority would make a lone reviewer's genuine defect report get outvoted by
// a single "looks fine", which is exactly the failure this harness exists to prevent.
// `requireCodex` (set when the caller asked for cross-model verification): a verdict that did NOT come
// from codex is treated as an ABSTENTION, however confident it reads. That is what makes the silent
// codex-rescue failure fail CLOSED — with no real verdicts, quorum cannot be met, and the run ends in
// `insufficient_verifier_quorum` with no winner instead of shipping a Claude-judged-Claude result
// wearing an `-x` label.
function tallyRefutation(rawVerdicts, V, requireCodex = false) {
  const verdicts = rawVerdicts.filter(Boolean)
  const answered = verdicts.filter((v) => !v.unavailable)
  const real = requireCodex ? answered.filter(fromCodex) : answered
  const quorum = verifierQuorum(V)
  const hasQuorum = real.length >= quorum
  const refutations = real.filter((v) => v.defectFound && v.severity !== 'low')
  return {
    verdicts,
    refutations,
    realCount: real.length,
    codexCount: answered.filter(fromCodex).length,
    quorum,
    refuted: hasQuorum && refutations.length >= Math.ceil(real.length / 2),
    unverified: !hasQuorum,
    unavailableVerdicts: V - real.length,
  }
}

// KEEP-direction tally — pantheon-gap.
// Here the reviewers try to DISMISS a gap the probe reported, so the tie runs the other
// way: a TIE KEEPS the gap. A finding is only dropped when a real majority dismisses it,
// so the harness never silently discards a probe's work on a split vote. Below quorum the
// gap is kept but flagged `unconfirmed` — and `bucketGaps` keeps it OUT of the confirmed
// count rather than laundering it into one.
function tallyGapVerdicts(rawVerdicts, V, requireCodex = false) {
  const verdicts = rawVerdicts.filter(Boolean)
  const answered = verdicts.filter((v) => !v.unavailable)
  const real = requireCodex ? answered.filter(fromCodex) : answered
  const quorum = verifierQuorum(V)
  const hasQuorum = real.length >= quorum
  const upheld = real.filter((v) => v.valid)
  return {
    verdictCount: verdicts.length,
    realCount: real.length,
    codexCount: answered.filter(fromCodex).length,
    quorum,
    kept: hasQuorum ? upheld.length >= Math.ceil(real.length / 2) : true,
    unconfirmed: !hasQuorum,
    adjustedSeverity: upheld.map((v) => v.adjustedSeverity).filter(Boolean)[0],
  }
}

// ---- candidate gates (FAIL-CLOSED) -----------------------------------------
//
// Each gate returns { pool | candidates, outcome }. `outcome !== 'ok'` means there is NO
// winner: the caller MUST return the structured no-winner result instead of synthesizing
// one. Nothing that failed its gate is ever revived.
//
// The revival fallbacks these replace were not theoretical: benchmarks/tetmux-cross-model.md
// records a run where all three fixes were refuted and the harness crowned one anyway
// ("refuted — but best of 3").

// Generation: only a variant whose own tests all pass may be verified.
function selectBuildPool(builds) {
  const green = builds.filter((b) => b.allTestsPass)
  if (!green.length) return { pool: [], outcome: 'no_green_candidate' }
  return { pool: green, outcome: 'ok' }
}

// Fix: a candidate must not regress the suite, and when the defect is testable its repro
// test must actually pass. "Didn't regress" alone is NOT a fix — it is a no-op that happens
// to be safe.
function selectFixPool(fixes, testable) {
  const clean = fixes.filter((f) => !f.regressed && (testable ? f.reproPasses : true))
  if (clean.length) return { pool: clean, outcome: 'ok' }
  if (fixes.some((f) => !f.regressed)) return { pool: [], outcome: 'no_repro_passing_fix' }
  return { pool: [], outcome: 'no_non_regressing_fix' }
}

// Fold an independent test audit over a fixer's SELF-REPORTED result. Never gate on a number the
// fixer produced about its own work: a real run turned up six fixes that each passed the repro test
// they wrote themselves, and the adversarial reviewers broke all six. The audit re-writes the
// canonical test from the planner's copy and re-runs the suite; its observation wins. A fix whose
// audit never ran is UNAUDITED, and an unaudited fix is not a candidate — same reasoning as quorum.
function applyAudit(fix, audit) {
  if (!audit) return { ...fix, regressed: true, auditFailed: true }
  return {
    ...fix,
    reproPasses: audit.reproPasses,
    regressed: audit.regressed,
    testWasTampered: Boolean(audit.testWasTampered),
    selfReportMismatch: fix.reproPasses !== audit.reproPasses || fix.regressed !== audit.regressed,
    auditFailed: false,
  }
}

// A candidate may win only if a real adversarial vote reached quorum AND did not refute it.
function selectCandidates(verified) {
  const scored = verified.filter(Boolean)
  const survivors = scored.filter((v) => !v.refuted && !v.unverified)
  const refuted = scored.filter((v) => v.refuted)
  const unverified = scored.filter((v) => v.unverified && !v.refuted)
  if (survivors.length) return { candidates: survivors, outcome: 'ok', refuted, unverified }
  const outcome = refuted.length ? 'all_candidates_refuted' : 'insufficient_verifier_quorum'
  return { candidates: [], outcome, refuted, unverified }
}

// Gap buckets are DISJOINT by construction. The old code counted a kept-but-unconfirmed gap
// in BOTH `gapsConfirmed` and `gapsUnconfirmed`, which reported an unverified finding as
// confirmed.
function bucketGaps(allGaps) {
  return {
    confirmed: allGaps.filter((g) => g.kept && !g.unconfirmed),
    keptUnconfirmed: allGaps.filter((g) => g.kept && g.unconfirmed),
    dismissed: allGaps.filter((g) => !g.kept),
  }
}

// Human-readable reason for each no-winner outcome, for the structured return + the log.
function outcomeReason(outcome) {
  return {
    ok: 'a candidate survived every gate',
    no_green_candidate: 'no variant got its own test suite green, so nothing was eligible for adversarial review',
    no_repro_passing_fix: 'some fixes avoided regressions, but none made the repro test pass — none of them actually fixes the defect',
    no_non_regressing_fix: 'every fix regressed the existing suite',
    all_candidates_refuted: 'the adversarial reviewers broke every candidate',
    insufficient_verifier_quorum:
      'too few reviewers returned a real verdict to trust the vote. Quorum is floor(V/2)+1, so verifiers:2 needs BOTH to run and tolerates no failures — use verifiers:3 (quorum 2) to survive one dead reviewer.',
  }[outcome] || outcome
}
// >>> PANTHEON:GATES

// <<< PANTHEON:PROVIDERS
// ---- verifier routing ------------------------------------------------------
// '' / 'claude' -> Claude (or the Codex plugin when crossModelVerify); a Claude tier name ->
// that tier; 'codex'/'gpt' -> Codex plugin; OpenClaw-style `provider/model-id` or a bare alias
// -> direct /chat/completions for cloud providers, or `codex exec` for local/profile routes.

// --- GENERATED:TABLE from providers.json by scripts/inline.js — DO NOT HAND-EDIT ---
const PROVIDERS = {
  "deepseek": { baseUrl: "https://api.deepseek.com", envKey: "DEEPSEEK_API_KEY", wire: "chat", defModel: "deepseek-chat" },
  "openrouter": { baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY", wire: "chat", defModel: "qwen/qwen-2.5-coder-32b-instruct" },
  "google": { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", envKey: "GEMINI_API_KEY", wire: "chat", defModel: "gemini-2.5-pro" },
  "xai": { baseUrl: "https://api.x.ai/v1", envKey: "XAI_API_KEY", wire: "chat", defModel: "grok-4" },
  "mistral": { baseUrl: "https://api.mistral.ai/v1", envKey: "MISTRAL_API_KEY", wire: "chat", defModel: "mistral-large-latest" },
  "groq": { baseUrl: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY", wire: "chat", defModel: "llama-3.3-70b-versatile" },
  "together": { baseUrl: "https://api.together.xyz/v1", envKey: "TOGETHER_API_KEY", wire: "chat", defModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  "moonshot": { baseUrl: "https://api.moonshot.ai/v1", envKey: "MOONSHOT_API_KEY", wire: "chat", defModel: "kimi-k2-0711-preview" },
  "dashscope": { baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", envKey: "DASHSCOPE_API_KEY", wire: "chat", defModel: "qwen2.5-coder-32b-instruct" },
  "zai": { baseUrl: "https://api.z.ai/api/paas/v4", envKey: "ZAI_API_KEY", wire: "chat", defModel: "glm-4.6" },
  "minimax": { baseUrl: "https://api.minimax.io/v1", envKey: "MINIMAX_API_KEY", wire: "chat", defModel: "MiniMax-M2" },
  "cohere": { baseUrl: "https://api.cohere.ai/compatibility/v1", envKey: "COHERE_API_KEY", wire: "chat", defModel: "command-a-03-2025" },
  "perplexity": { baseUrl: "https://api.perplexity.ai", envKey: "PERPLEXITY_API_KEY", wire: "chat", defModel: "sonar-pro" },
  "fireworks": { baseUrl: "https://api.fireworks.ai/inference/v1", envKey: "FIREWORKS_API_KEY", wire: "chat", defModel: "accounts/fireworks/models/qwen2p5-coder-32b-instruct" },
  "cerebras": { baseUrl: "https://api.cerebras.ai/v1", envKey: "CEREBRAS_API_KEY", wire: "chat", defModel: "qwen-3-coder-480b" },
  "deepinfra": { baseUrl: "https://api.deepinfra.com/v1/openai", envKey: "DEEPINFRA_API_KEY", wire: "chat", defModel: "Qwen/Qwen2.5-Coder-32B-Instruct" },
  "siliconflow": { baseUrl: "https://api.siliconflow.cn/v1", envKey: "SILICONFLOW_API_KEY", wire: "chat", defModel: "Qwen/Qwen2.5-Coder-32B-Instruct" },
  "hyperbolic": { baseUrl: "https://api.hyperbolic.xyz/v1", envKey: "HYPERBOLIC_API_KEY", wire: "chat", defModel: "Qwen/Qwen2.5-Coder-32B-Instruct" },
  "nebius": { baseUrl: "https://api.studio.nebius.com/v1", envKey: "NEBIUS_API_KEY", wire: "chat", defModel: "Qwen/Qwen2.5-Coder-32B-Instruct" },
  "sambanova": { baseUrl: "https://api.sambanova.ai/v1", envKey: "SAMBANOVA_API_KEY", wire: "chat", defModel: "Qwen2.5-Coder-32B-Instruct" },
  "nvidia": { baseUrl: "https://integrate.api.nvidia.com/v1", envKey: "NVIDIA_API_KEY", wire: "chat", defModel: "nvidia/llama-3.3-nemotron-super-49b-v1" },
  "novita": { baseUrl: "https://api.novita.ai/openai/v1", envKey: "NOVITA_API_KEY", wire: "chat", defModel: "deepseek/deepseek-v3-0324" },
  "baseten": { baseUrl: "https://inference.baseten.co/v1", envKey: "BASETEN_API_KEY", wire: "chat", defModel: "deepseek-ai/DeepSeek-V3" },
  "huggingface": { baseUrl: "https://router.huggingface.co/v1", envKey: "HF_TOKEN", wire: "chat", defModel: "Qwen/Qwen2.5-Coder-32B-Instruct" },
  "ollama-cloud": { baseUrl: "https://ollama.com/v1", envKey: "OLLAMA_API_KEY", wire: "chat", defModel: "qwen3-coder:480b" },
  "venice": { baseUrl: "https://api.venice.ai/api/v1", envKey: "VENICE_API_KEY", wire: "chat", defModel: "qwen-2.5-coder-32b" },
  "volcengine": { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", envKey: "ARK_API_KEY", wire: "chat", defModel: "doubao-seed-1-6" },
  "vllm": { baseUrl: "http://127.0.0.1:8000/v1", envKey: "VLLM_API_KEY", wire: "chat", defModel: "" },
  "sglang": { baseUrl: "http://127.0.0.1:30000/v1", envKey: "SGLANG_API_KEY", wire: "chat", defModel: "" },
}
const ALIASES = { "qwen": "dashscope", "kimi": "moonshot", "grok": "xai", "gemini": "google", "glm": "zai" }
// --- END GENERATED:TABLE ---

// Only https:// is allowed off-box; plain http:// is permitted for loopback only, so a typo'd
// or hijacked baseUrl cannot ship source code to an external host in the clear.
function isAllowedBaseUrl(u) {
  if (typeof u !== 'string') return false
  if (u.startsWith('https://')) return true
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u)
}

// The env var NAME (never the secret) is interpolated into a shell command by the drivers,
// so constrain it to the shape a real env var can have.
function isValidEnvKey(k) {
  return typeof k === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(k)
}

function httpDesc(provId, model, providers) {
  const p = providers[provId]
  const chosen = model || p.defModel || (p.models && p.models[0]) || provId
  if (!isAllowedBaseUrl(p.baseUrl)) {
    return { mode: 'invalid', who: provId, error: `provider "${provId}" has a non-https baseUrl (${p.baseUrl}); refusing to send code to it` }
  }
  if (!isValidEnvKey(p.envKey)) {
    return { mode: 'invalid', who: provId, error: `provider "${provId}" has a malformed envKey (${p.envKey})` }
  }
  return { mode: 'http', baseUrl: p.baseUrl, envKey: p.envKey, model: chosen, who: provId + (model ? ' ' + model : '') }
}

function resolveVerifier(v, crossLegacy, extraProviders) {
  const providers = Object.assign({}, PROVIDERS, extraProviders && typeof extraProviders === 'object' ? extraProviders : {})
  const raw = typeof v === 'string' ? v.trim() : ''
  const m = raw.toLowerCase()
  const CLAUDE = ['opus', 'sonnet', 'haiku', 'fable']
  // `codex-transcribe` = shell out to the codex companion and relay its verdict. NOT an agentType —
  // routing this through codex:codex-rescue is the silent-failure trap documented above.
  const CODEX = { mode: 'codex-transcribe', model: CODEX_MODEL, who: CODEX_LABEL }
  if (!m || m === 'claude' || m === 'default') return crossLegacy ? CODEX : { mode: 'claude', who: 'Claude (default)' }
  if (CLAUDE.includes(m)) return { mode: 'claude', model: m, who: 'Claude ' + m }
  if (m === 'codex' || m === 'gpt' || m === 'openai' || m.startsWith('gpt-5') || m.startsWith('gpt5')) return CODEX
  if (raw.includes('/')) {
    const s = raw.indexOf('/')
    let prov = raw.slice(0, s).toLowerCase()
    const model = raw.slice(s + 1)
    if (prov === 'anthropic' || prov === 'claude') {
      return CLAUDE.includes(model.toLowerCase()) ? { mode: 'claude', model: model.toLowerCase(), who: 'Claude ' + model } : { mode: 'claude', who: 'Claude' }
    }
    if (prov === 'ollama' || prov === 'lmstudio') return { mode: 'codex', codexArgs: ['--oss', '--local-provider', prov, '-m', model], who: prov + ' ' + model + ' (local)' }
    if (prov === 'openai' || prov === 'gpt') return { mode: 'codex-transcribe', model, who: model }
    if (ALIASES[prov]) prov = ALIASES[prov]
    if (providers[prov] && providers[prov].baseUrl) return httpDesc(prov, model, providers)
    return { mode: 'invalid', who: raw, error: `unknown provider "${prov}" — add it to providers.json and re-run \`npm run inline\`` }
  }
  if (m.startsWith('ollama:') || m.startsWith('lmstudio:')) {
    const i = raw.indexOf(':')
    const prov = raw.slice(0, i).toLowerCase()
    const model = raw.slice(i + 1)
    return { mode: 'codex', codexArgs: ['--oss', '--local-provider', prov, '-m', model], who: prov + ' ' + model + ' (local)' }
  }
  if (m.startsWith('profile:')) {
    const name = raw.slice(raw.indexOf(':') + 1)
    return { mode: 'codex', codexArgs: ['-p', name], who: 'codex profile ' + name }
  }
  if (m.startsWith('model:')) {
    const name = raw.slice(raw.indexOf(':') + 1)
    return { mode: 'codex-transcribe', model: name, who: name }
  }
  const provId = ALIASES[m] || m
  if (providers[provId] && providers[provId].baseUrl) return httpDesc(provId, null, providers)
  return { mode: 'invalid', who: raw, error: `unrecognized verifier "${raw}" — use a Claude tier, "codex", or an OpenClaw-style provider/model-id from providers.json` }
}
// >>> PANTHEON:PROVIDERS

// Test-only surface. The inliner copies ONLY the marked regions above, so this export list
// never reaches the workflow scripts (where `export` outside a module would be a syntax error).
export {
  CODEX_MARK,
  fromCodex,
  codexTranscriber,
  crossModelAudit,
  verifierQuorum,
  tallyRefutation,
  tallyGapVerdicts,
  selectBuildPool,
  selectFixPool,
  applyAudit,
  selectCandidates,
  bucketGaps,
  outcomeReason,
  isAllowedBaseUrl,
  isValidEnvKey,
  httpDesc,
  resolveVerifier,
  PROVIDERS,
  ALIASES,
  CODEX_MODEL,
  CODEX_LABEL,
}
