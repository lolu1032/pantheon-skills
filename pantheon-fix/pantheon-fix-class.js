export const meta = {
  name: 'pantheon-fix-class',
  description:
    'Fix an existing bug/gap through a Pantheon harness: baseline -> plan -> N fix variants in isolated git worktrees (regression-gated + repro-gated) -> adversarial verify -> judge picks the minimal safe patch (diff-only unless apply:true)',
  phases: [
    { title: 'Baseline', detail: 'Confirm git repo, detect the test command, record which tests pass at HEAD' },
    { title: 'Plan', detail: 'Restate the bug, decide if it is test-reproducible, propose N fix strategies' },
    { title: 'Fix', detail: 'N variants in parallel, each in its own worktree: write repro test, fix, gate on no-regression + repro-green' },
    { title: 'Verify', detail: 'Adversarial reviewers try to break each candidate fix (incomplete fix / new regression / over-broad)' },
    { title: 'Synthesize', detail: 'Judge picks the minimal, safest patch; output the diff (apply only if asked)' },
  ],
}

// NOTE: the Workflow tool delivers `args` as a JSON STRING (not a parsed object).
// Parse defensively so this works whether args is a string, an object, or absent.
let A = {}
if (typeof args === 'string') { try { A = args ? JSON.parse(args) : {} } catch (e) { A = {} } }
else if (args && typeof args === 'object') { A = args }

const repo = A.repo ?? A.workdir ?? '.' // absolute path to the target git repo (the skill always passes one)
const gap = A.gap ?? A.task ?? A.bug ?? 'No gap/bug description was provided.'
const givenTestCmd = A.testCommand ?? A.test ?? ''
const N = A.variants ?? 3
const V = A.verifiers ?? 2
const crossVerify = A.crossModelVerify ?? false // legacy flag: true => Codex (GPT-5.6 Sol) runs the adversarial step
const confirmEffort = A.confirmEffort ?? 'medium' // codex reasoning effort
const applyRequested = A.apply ?? false // false => emit the diff only, never touch the working tree

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

const BASELINE_SCHEMA = {
  type: 'object',
  properties: {
    isGit: { type: 'boolean' },
    cleanTree: { type: 'boolean' },
    testCommand: { type: 'string' },
    workspaceRoot: { type: 'string', description: 'Absolute path of a fresh empty scratch dir (mktemp -d) that will hold the per-variant worktrees' },
    total: { type: 'number' },
    passing: { type: 'number' },
    green: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['isGit', 'testCommand', 'green', 'workspaceRoot'],
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    bugSpec: { type: 'string', description: 'Precise restatement of the defect and the correct behavior' },
    testCommand: { type: 'string' },
    testable: { type: 'boolean', description: 'Can this defect be reproduced by an automated test?' },
    reproPlan: { type: 'string', description: 'How to write a failing test that reproduces it; or why it is not testable' },
    filesLikelyTouched: { type: 'array', items: { type: 'string' } },
    strategies: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, approach: { type: 'string' } },
        required: ['name', 'approach'],
      },
      description: 'Distinct fix strategies, one per variant',
    },
  },
  required: ['bugSpec', 'testCommand', 'testable', 'strategies'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    variant: { type: 'number' },
    strategy: { type: 'string' },
    worktree: { type: 'string', description: 'Absolute path of the worktree you were TOLD to use (echo it back; the harness verifies it matches)' },
    patch: { type: 'string', description: 'Unified diff of the fix (git diff HEAD), including any new test file' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    linesChanged: { type: 'number' },
    suiteTotal: { type: 'number' },
    suitePassing: { type: 'number' },
    regressed: { type: 'boolean', description: 'true if any test that passed at HEAD now fails' },
    reproPasses: { type: 'boolean', description: 'true if the repro test now passes (false/N/A if not testable)' },
    iterations: { type: 'number' },
    notes: { type: 'string' },
  },
  required: ['variant', 'patch', 'regressed', 'reproPasses', 'worktree'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    defectFound: { type: 'boolean' },
    severity: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
    description: { type: 'string' },
    failingCase: { type: 'string' },
    unavailable: { type: 'boolean', description: 'true ONLY if the verifier could not actually run (no real verdict was produced) — never on a genuine judgment' },
  },
  required: ['defectFound', 'description'],
}

const FINAL_SCHEMA = {
  type: 'object',
  properties: {
    winner: { type: 'number' },
    rationale: { type: 'string' },
    graftedIdeas: { type: 'array', items: { type: 'string' }, description: 'Better ideas from runners-up (suggestions, NOT in the patch)' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    testUnverified: { type: 'boolean', description: 'true if the fix could not be confirmed by an automated test' },
    reviewNotes: { type: 'string' },
  },
  required: ['winner', 'rationale'],
}

// ---- Phase 1: BASELINE — confirm git, detect the test command, record HEAD's passing tests ----
phase('Baseline')
const baseline = await agent(
  `You are the BASELINE agent in a Pantheon fix harness. Target repo: ${repo}\n\n` +
    `1. Confirm it's a git repo (git -C ${repo} rev-parse --is-inside-work-tree) and whether the working tree is clean (git -C ${repo} status --porcelain — empty = clean, meaning no modified AND no untracked files).\n` +
    `2. Detect the test command for this project${givenTestCmd ? ` (the caller suggests: \`${givenTestCmd}\` — verify it)` : ' (inspect package.json / pyproject / Makefile / go.mod etc.)'}.\n` +
    `3. Run the FULL existing test suite ONCE at HEAD and report total tests, passing count, and whether the suite is green. Do NOT modify any file.\n` +
    `4. Create ONE empty scratch directory to hold the per-variant worktrees: \`mktemp -d -t pantheon-fix\`. Return its absolute path as workspaceRoot. Create nothing inside it.\n` +
    `Report isGit, cleanTree, the exact testCommand, workspaceRoot, total, passing, green, and notes (e.g. pre-existing failures).`,
  { schema: BASELINE_SCHEMA, phase: 'Baseline', label: 'baseline' },
)
log(`Baseline: git=${baseline.isGit} clean=${baseline.cleanTree} green=${baseline.green} (${baseline.passing ?? '?'}/${baseline.total ?? '?'}) cmd=\`${baseline.testCommand}\``)
if (!baseline.isGit) {
  log('Target is not a git repo — worktree isolation is unavailable; aborting for safety.')
  return { repo, gap, outcome: 'not_a_git_repo', error: 'pantheon-fix needs git for safe worktree-isolated fixing', baseline }
}
const testCmd = baseline.testCommand || givenTestCmd

// APPLY GATE. Applying is only reversible if we know exactly what the tree looked like first. On a
// clean tree, rollback is exactly `git checkout -- . && git clean -fd`. On a dirty one it is not
// expressible at all — a failed 3-way apply would leave the user's own uncommitted work tangled
// with a rejected patch. So apply requires a clean tree; otherwise we degrade to diff-only.
const doApply = applyRequested && baseline.cleanTree === true
if (applyRequested && !doApply) {
  log('⚠️ apply:true requested but the working tree is DIRTY. Refusing to apply (a failed apply could not be rolled back cleanly). Commit or stash first. Emitting the diff only.')
} else if (!baseline.cleanTree) {
  log('⚠️ Working tree is not clean — patches are computed against HEAD; commit/stash first for the cleanest diff.')
}

// ---- Phase 2: PLAN — restate the bug, decide testability, propose N strategies ----
phase('Plan')
const plan = await agent(
  `You are the PLANNER in a Pantheon fix harness. Target repo: ${repo}\nTest command: \`${testCmd}\`\n\n` +
    `DEFECT / GAP TO FIX:\n${gap}\n\n` +
    `Read the ACTUAL relevant code in the repo (do not speculate). Produce: (1) a precise bugSpec (the defect + the correct behavior), ` +
    `(2) whether it is testable (can a small automated test reproduce it before the fix and pass after?), (3) a reproPlan (exactly how to write that failing test, which test file, or why it is not testable — e.g. docs/config drift), ` +
    `(4) the files likely to change, and (5) exactly ${N} DISTINCT fix strategies (different approaches, not cosmetic variations of one). Keep each fix minimal in scope.`,
  { schema: PLAN_SCHEMA, phase: 'Plan', label: 'plan' },
)
log(`Plan: testable=${plan.testable}; ${plan.strategies.length} fix strategies`)

// ---- verifier routing: pick which model runs the adversarial step ----
const VR = resolveVerifier(A.verifier, crossVerify)
if (VR.mode === 'invalid') {
  log(`⛔ ${VR.error}`)
  return { repo, gap, baseline, outcome: 'invalid_verifier', error: VR.error }
}
const requireCodex = VR.mode === 'codex-transcribe' // an unstamped verdict then abstains -> quorum fails closed
log(`Adversarial verifier: ${VR.who}`)

// The harness — NOT the model — owns every worktree path. Each is derived from the one scratch root
// the baseline created, so cleanup only ever force-removes paths this script itself computed. The
// previous version had each fixer `mktemp -u` its own path and hand it back, then force-removed
// whatever string came out of the model.
const wtRoot = baseline.workspaceRoot
const strategies = plan.strategies.slice(0, N).map((s, i) => ({ s, i, wt: `${wtRoot}/v${i}` }))
const expectedWorktrees = strategies.map((x) => x.wt)

const reproClause = plan.testable
  ? `2. Write the repro test described here into the right test file:\n${plan.reproPlan}\n   Run the suite and CONFIRM this new test FAILS first (it must reproduce the bug).`
  : `2. This defect is NOT automatically testable (${plan.reproPlan || 'no repro test possible'}). Skip the repro test; you will rely on the suite staying green plus a manual argument that the fix is correct. Set reproPasses=false.`

// Patch excerpt for review prompts — mark truncation explicitly instead of cutting silently.
const patchExcerpt = (b) => {
  const p = b.patch || ''
  return p.length > 9000 ? p.slice(0, 9000) + `\n[PATCH TRUNCATED — ${p.length - 9000} of ${p.length} chars omitted; full patch: git -C ${b.worktree} diff HEAD]` : p
}

function verifierAgent(promptCore, meta) {
  if (VR.mode === 'http') {
    return agent(
      `You are a DRIVER. Delegate this adversarial review to an INDEPENDENT external model (${VR.who}) by calling its OpenAI-compatible chat API DIRECTLY (not via codex), then relay ITS verdict. Do NOT judge the code yourself.\n\n` +
        `Steps (use Bash; never print the key):\n` +
        `1. Read the key WITHOUT sourcing the file (it is data, not script): KEY=$(grep -m1 '^${VR.envKey}=' ~/.pantheon/env | cut -d= -f2-)\n` +
        `2. Using python3 so the prompt is safely JSON-escaped, write a request-body file with: model="${VR.model}", temperature=0, messages=[{"role":"user","content": THE REVIEW PROMPT BELOW, followed by "Reason about the patch, then output ONLY one compact JSON object with keys defectFound(boolean), severity(one of none|low|medium|high), description(string), failingCase(string)."}].\n` +
        `3. POST it: curl -s -w "\\n%{http_code}" ${VR.baseUrl}/chat/completions -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d @BODYFILE\n` +
        `4. From the JSON response take choices[0].message.content, extract the verdict JSON object it contains, and return THAT as your structured output (unchanged).\n` +
        `5. If the key is empty, the HTTP status is not 200, or no JSON comes back, return defectFound=false, severity="none", unavailable=true, description="external verifier ${VR.who} unavailable: <short error>". Never fabricate a defect; set unavailable=true ONLY on this failure path, never on a real verdict.\n\n` +
        `REVIEW PROMPT <<<\n${promptCore}\n>>>`,
      { schema: VERDICT_SCHEMA, ...meta },
    )
  }
  if (VR.mode === 'codex') {
    return agent(
      `You are a DRIVER. Delegate this adversarial review to an INDEPENDENT external model (${VR.who}) via the codex CLI, then relay ITS verdict. Do NOT judge the code yourself.\n\n` +
        `Steps (use Bash; create temp files with mktemp):\n` +
        `1. Write this JSON Schema to a file $SCHEMA:\n${JSON.stringify(VERDICT_SCHEMA)}\n` +
        `2. Write the REVIEW PROMPT (between <<< >>> below) to a file $PROMPT.\n` +
        `3. Run EXACTLY this (OUT = another mktemp file):\n   codex exec --skip-git-repo-check --ephemeral --sandbox workspace-write -C ${JSON.stringify(repo)} ${VR.codexArgs.map((a) => JSON.stringify(a)).join(' ')} --output-schema "$SCHEMA" -o "$OUT" < "$PROMPT"\n   If codex rejects --output-schema for this provider, drop that flag and instead extract the JSON object the model prints to stdout.\n` +
        `4. Read $OUT (or the parsed stdout JSON) and return it as your structured verdict, unchanged.\n` +
        `If codex is missing / the model is unreachable / no JSON is produced, return {"defectFound":false,"severity":"none","unavailable":true,"description":"external verifier ${VR.who} unavailable: <short error>"} — never fabricate a defect; unavailable=true is ONLY for this failure path.\n\n` +
        `REVIEW PROMPT <<<\n${promptCore}\n\nReason about the patch, then output ONLY the verdict JSON.\n>>>`,
      { schema: VERDICT_SCHEMA, ...meta },
    )
  }
  if (VR.mode === 'codex-transcribe') {
    // Shell out to the codex companion and RELAY its verdict. Never agentType:'codex:codex-rescue' —
    // that wrapper silently judges with its own sonnet and never calls codex (see lib/gates.js).
    return agent(
      codexTranscriber({
        core: promptCore,
        cwd: repo,
        effort: confirmEffort,
        markField: 'description',
        verdictJson: '{"defectFound": true|false, "severity": "none"|"low"|"medium"|"high", "description": "<what breaks the fix>", "failingCase": "<the input that breaks it, if any>"}',
        unavailableJson: '{"defectFound":false,"severity":"none","unavailable":true,"description":"[codex:unavailable] <what went wrong>"}',
      }),
      { schema: VERDICT_SCHEMA, ...meta },
    )
  }
  return agent(promptCore, { schema: VERDICT_SCHEMA, ...meta, ...(VR.model ? { model: VR.model } : {}) })
}

// Everything from here creates worktrees, so it runs under a finally that always cleans them up —
// including on an early return or a thrown error, both of which used to leak them.
let result
try {
  // ---- Phase 3: FIX — N variants, each in its OWN git worktree, regression- + repro-gated ----
  const built = await parallel(
    strategies.map(({ s, i, wt }) => () =>
      agent(
        `You are FIXER #${i} in a Pantheon fix harness. Fix ONE defect using ONLY the strategy below — minimal change, do not refactor unrelated code, do not copy the other strategies.\n\n` +
          `REPO: ${repo}\nTEST COMMAND: \`${testCmd}\`\nDEFECT:\n${gap}\nBUG SPEC: ${plan.bugSpec}\nSTRATEGY: ${s.name} — ${s.approach}\n\n` +
          `Work in an ISOLATED git worktree so the user's tree is never touched. Use EXACTLY this path — do not invent your own, do not use mktemp:\n` +
          `   WORKTREE = ${wt}\n` +
          `1. git -C ${repo} worktree add -d "${wt}" HEAD && cd "${wt}"\n` +
          `   (run the suite once here first and record WHICH tests pass — this is your per-variant baseline.)\n` +
          `${reproClause}\n` +
          `3. Apply your fix (strategy above) to the code in "${wt}". Re-run the FULL suite. T1 LOOP up to 5 times: if the repro test still fails OR any test that passed in your baseline now fails, read the error, adjust the fix (not the suite), re-run.\n` +
          `4. REGRESSION CHECK: regressed=true if any test that passed in your per-variant baseline now fails. reproPasses=true only if the repro test now passes.\n` +
          `5. Capture the patch: git -C "${wt}" add -A && git -C "${wt}" diff --cached HEAD  → return this unified diff verbatim as \`patch\` (it includes the new test file). Report filesTouched and linesChanged.\n` +
          `6. Do NOT remove the worktree and do NOT commit — leave "${wt}" in place (the verify phase reads it) and echo it back as \`worktree\`.\n` +
          `Report variant ${i}, strategy, worktree, patch, suiteTotal/suitePassing, regressed, reproPasses, iterations, notes.`,
        { schema: FIX_SCHEMA, phase: 'Fix', label: `fix:v${i} (${s.name})` },
      ),
    ),
  )
  const fixes = built.filter(Boolean).filter((f) => {
    // A fixer that worked somewhere other than the path it was given is not a trustworthy candidate:
    // its patch and the worktree the reviewers will read may not be the same tree.
    if (expectedWorktrees.includes(f.worktree)) return true
    log(`⚠️ Dropping variant ${f.variant}: it reported worktree "${f.worktree}", which is not the path it was assigned.`)
    return false
  })

  const fixesReport = fixes.map((f) => ({ variant: f.variant, strategy: f.strategy, regressed: f.regressed, reproPasses: f.reproPasses, linesChanged: f.linesChanged }))
  const planReport = { bugSpec: plan.bugSpec, testable: plan.testable, strategies: plan.strategies.map((s) => s.name) }
  const baseReport = { green: baseline.green, passing: baseline.passing, total: baseline.total, testCommand: testCmd }
  const noWinner = (outcome) => ({
    repo, gap, verifier: VR.who, baseline: baseReport, plan: planReport, fixes: fixesReport,
    outcome, reason: outcomeReason(outcome), patch: '', applied: null, final: null,
    note: `No patch is being offered: ${outcomeReason(outcome)}.`,
  })

  if (!fixes.length) {
    log('No variant produced a usable fix; aborting.')
    result = noWinner('no_fix_produced')
    return result
  }

  // GATE 1 (fail-closed): a candidate must not regress, and when the defect is testable its repro
  // test must actually pass. "Didn't regress" alone is a no-op, not a fix — the old code promoted
  // those anyway whenever no variant managed a real fix.
  const { pool, outcome: poolOutcome } = selectFixPool(fixes, plan.testable)
  log(`Fixes: ${fixes.length}; passed the regression + repro gate: ${pool.length}`)
  if (poolOutcome !== 'ok') {
    log(`⛔ ${outcomeReason(poolOutcome)} — no winner.`)
    result = noWinner(poolOutcome)
    return result
  }

  // ---- Phase 4: ADVERSARIAL VERIFY — try to break each candidate fix ----
  const verified = await parallel(
    pool.map((b) => () =>
      parallel(
        Array.from({ length: V }, (_, k) => () =>
          verifierAgent(
            `You are ADVERSARIAL REVIEWER ${k} of a proposed FIX (variant ${b.variant}) for this defect:\n${plan.bugSpec}\n\n` +
              `The fix lives in the worktree ${b.worktree} (the suite passes there). Its patch:\n\n${patchExcerpt(b)}\n\n` +
              `Your job is to BREAK the fix, not praise it. Look for: (a) the defect still reproduces on a NEARBY input the repro test missed; (b) the patch introduces a NEW bug/regression the suite didn't cover; (c) the change is OVER-BROAD and alters behavior outside the defect's scope. ` +
              `You MAY cd ${b.worktree}, write a tiny extra test/script, and RUN it to PROVE a failure. Set defectFound=false ONLY if you genuinely cannot break it. Return severity and the failing case.`,
            { phase: 'Verify', label: `verify:v${b.variant}.${k}` },
          ),
        ),
      ).then((vs) => ({ ...b, ...tallyRefutation(vs, V, requireCodex) })),
    ),
  )

  // GATE 2 (fail-closed): a fix wins only if a quorate adversarial vote failed to break it. Refuted
  // fixes are NOT recycled, and neither are ones nobody actually reviewed. The repo's own benchmark
  // (benchmarks/tetmux-cross-model.md) records the old behavior crowning a fix all three reviewers
  // had refuted.
  const { candidates, outcome: verdictOutcome, refuted, unverified } = selectCandidates(verified)
  const verifiedReport = verified.filter(Boolean).map((v) => ({ variant: v.variant, refuted: v.refuted, confirmedDefects: v.refutations.length, unverified: v.unverified, realVerdicts: v.realCount, quorum: v.quorum, unavailableVerdicts: v.unavailableVerdicts }))
  log(`Survivors after adversarial verify: ${candidates.length}/${pool.length} (refuted ${refuted.length}, unverified ${unverified.length})`)
  if (verdictOutcome !== 'ok') {
    log(`⛔ ${outcomeReason(verdictOutcome)} — no winner.`)
    result = { ...noWinner(verdictOutcome), verified: verifiedReport }
    return result
  }

  // ---- Phase 5: SYNTHESIZE — judge picks the minimal, safest patch ----
  phase('Synthesize')
  const final = await agent(
    `You are the JUDGE in a Pantheon fix harness for defect: ${plan.bugSpec}\n\n` +
      `Candidate fixes — every one below did NOT regress the suite${plan.testable ? ', DID make the repro test pass,' : ''} and SURVIVED a quorate adversarial review:\n${candidates
        .map((c) => `- variant ${c.variant} (${c.strategy ?? 'n/a'}): linesChanged=${c.linesChanged ?? '?'}, reproPasses=${c.reproPasses}, reviewers who tried and failed to break it=${c.realCount}, files=${(c.filesTouched || []).join(',')}`)
        .join('\n')}\n\n` +
      `Pick the SINGLE best fix. Prefer the SMALLEST, least-invasive change that fully fixes the defect. ` +
      `List any superior ideas from runners-up worth grafting (as suggestions — they are NOT in the chosen patch). ` +
      `Set testUnverified=true if no automated test confirmed the fix (${plan.testable ? 'this defect was testable' : 'this defect was NOT automatically testable'}). Give the winning variant number, rationale, and confidence. Do not rewrite the patch.`,
    { schema: FINAL_SCHEMA },
  )
  const winner = candidates.find((c) => c.variant === final.winner) || candidates[0]
  const finalPatch = winner ? winner.patch : ''

  // ---- optional: apply the winning patch, transactionally ----
  let applied = null
  if (doApply && finalPatch) {
    applied = await agent(
      `Apply a patch to ${repo} TRANSACTIONALLY. The working tree is clean (verified), so a full rollback is exactly \`git -C ${repo} checkout -- . && git -C ${repo} clean -fd\`.\n\n` +
        `1. Write the patch below to a temp file and run: git -C ${repo} apply --3way <file>\n` +
        `2. If it did NOT apply cleanly: ROLL BACK (command above) and report appliedClean=false, suiteGreen=false, rolledBack=true.\n` +
        `3. If it applied: run \`${testCmd}\`. If the suite is NOT green: ROLL BACK and report appliedClean=true, suiteGreen=false, rolledBack=true.\n` +
        `4. Only if it applied AND the suite is green, leave the change in place (do NOT commit) and report appliedClean=true, suiteGreen=true, rolledBack=false.\n` +
        `The tree must end up either fully patched-and-green, or byte-for-byte back at HEAD. Never leave it half-patched.\n\nPATCH:\n${finalPatch}`,
      {
        schema: {
          type: 'object',
          properties: { appliedClean: { type: 'boolean' }, suiteGreen: { type: 'boolean' }, rolledBack: { type: 'boolean' }, notes: { type: 'string' } },
          required: ['appliedClean', 'rolledBack'],
        },
        phase: 'Synthesize', label: 'apply',
      },
    )
    log(`Apply: clean=${applied.appliedClean} green=${applied.suiteGreen} rolledBack=${applied.rolledBack}`)
  }

  const landed = Boolean(doApply && applied && applied.appliedClean && applied.suiteGreen && !applied.rolledBack)
  result = {
    repo,
    gap,
    verifier: VR.who,
    verifierModel: VR.model ?? null, // the model actually resolved, not a label we hoped for
    baseline: baseReport,
    plan: planReport,
    fixes: fixesReport,
    verified: verifiedReport,
    survivors: candidates.map((s) => s.variant),
    refuted: refuted.map((r) => r.variant),
    unverified: unverified.map((u) => u.variant),
    outcome: 'ok',
    final: { winner: final.winner, rationale: final.rationale, confidence: final.confidence, testUnverified: final.testUnverified, graftedIdeas: final.graftedIdeas, reviewNotes: final.reviewNotes },
    patch: finalPatch,
    applied: doApply ? applied : null,
    // Report what actually happened, not what was requested. The old note said "Patch applied"
    // whenever apply was asked for, even if the apply failed.
    note: landed
      ? 'Patch applied to the working tree and the suite is green (not committed). Review `git diff` before committing.'
      : doApply
        ? 'Apply FAILED and the working tree was rolled back to HEAD. The patch is in `patch` — inspect it before retrying.'
        : applyRequested
          ? 'apply:true was requested but the working tree was DIRTY, so nothing was applied. Commit or stash, then re-run.'
          : 'Diff-only: the working tree was NOT modified. Review `patch` and apply with `git apply`.',
  }
  return result
} finally {
  // Always runs — early return, thrown error, or success. Only ever removes the paths THIS script
  // computed, and only after confirming git has them registered as worktrees of this repo.
  await agent(
    `Cleanup. For each path below: confirm \`git -C ${repo} worktree list --porcelain\` lists it as a worktree of ${repo}, and only then run \`git -C ${repo} worktree remove --force <path>\`. Skip (do not delete) anything not registered. Finally run \`git -C ${repo} worktree prune\`. Ignore errors.\nPaths:\n${expectedWorktrees.join('\n')}\nReturn a one-line summary of what was removed and what was skipped.`,
    { schema: { type: 'object', properties: { done: { type: 'boolean' }, summary: { type: 'string' } }, required: ['done'] }, phase: 'Synthesize', label: 'cleanup' },
  )
}
