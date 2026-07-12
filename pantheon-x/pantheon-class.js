export const meta = {
  name: 'pantheon-class',
  description: 'Wrap Opus 4.8 in a Pantheon harness: plan -> parallel variants -> test-gate self-correction -> adversarial verify -> synthesize',
  phases: [
    { title: 'Plan', detail: 'Decompose task into spec, test plan, and N strategies' },
    { title: 'Implement', detail: 'N variants in parallel; each runs its own tests and self-corrects (T1 loop)' },
    { title: 'Verify', detail: 'Independent adversarial reviewers try to break each green variant' },
    { title: 'Synthesize', detail: 'Judge picks the winner and grafts the best ideas' },
  ],
}

// NOTE: the Workflow tool delivers `args` as a JSON STRING (not a parsed object).
// Parse defensively so this works whether args is a string, an object, or absent.
let A = {}
if (typeof args === 'string') { try { A = args ? JSON.parse(args) : {} } catch (e) { A = {} } }
else if (args && typeof args === 'object') { A = args }

const task = A.task ?? 'Implement a token-bucket rate limiter in pure Python 3 (standard library only). API: RateLimiter(capacity:int, refill_rate_per_sec:float) with method allow(now:float, tokens:int=1)->bool that consumes tokens if available at time now and returns True, else returns False without consuming. Tokens refill continuously at refill_rate_per_sec up to capacity. now is monotonic non-decreasing across calls.'
const workdir = A.workdir ?? '/tmp/pantheon-demo'
const lang = A.lang ?? 'pure Python 3 (standard library only); put the test file as test_limiter.py runnable with `python3 -m unittest`'
const N = A.variants ?? 3
const V = A.verifiers ?? 2
const crossVerify = A.crossModelVerify ?? false // true => the adversarial check runs on the cross-model reviewer
const confirmEffort = A.confirmEffort ?? 'medium' // codex reasoning effort; the user's config may default to xhigh, which is very slow across dozens of calls

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

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    spec: { type: 'string', description: 'Tight restatement of the requirement' },
    testPlan: { type: 'array', items: { type: 'string' }, description: 'Concrete test cases that define correctness' },
    strategies: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, approach: { type: 'string' } },
        required: ['name', 'approach'],
      },
      description: 'Distinct implementation strategies, one per variant',
    },
  },
  required: ['spec', 'testPlan', 'strategies'],
}

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    variant: { type: 'number' },
    strategy: { type: 'string' },
    path: { type: 'string' },
    iterations: { type: 'number' },
    testsTotal: { type: 'number' },
    testsPassing: { type: 'number' },
    allTestsPass: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['variant', 'path', 'allTestsPass', 'testsPassing', 'testsTotal'],
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
    graftedIdeas: { type: 'array', items: { type: 'string' } },
    finalPath: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['winner', 'rationale', 'finalPath'],
}

// ---- Phase 1: PLAN (test-time compute: think the spec + tests out first) ----
phase('Plan')
const plan = await agent(
  `You are the PLANNER in a Pantheon harness. Task:\n\n${task}\n\nProduce: (1) a tight spec, (2) a concrete test plan of edge cases that DEFINE correctness, and (3) exactly ${N} DISTINCT implementation strategies. Language/runtime constraint: ${lang}.`,
  { schema: PLAN_SCHEMA },
)
log(`Plan ready: ${plan.strategies.length} strategies, ${plan.testPlan.length} test cases`)

// ---- Phase 2: IMPLEMENT + self-correct against tests (T1 tool-integrated verification) ----
const strategies = plan.strategies.slice(0, N).map((s, i) => ({ s, i }))
const built = await parallel(
  strategies.map(({ s, i }) => () =>
    agent(
      `You are BUILDER #${i} in a Pantheon harness. Implement this task using ONLY the strategy below; do not copy the other strategies.\n\nTASK:\n${task}\n\nSTRATEGY: ${s.name} — ${s.approach}\n\nLanguage/runtime: ${lang}\n\nSpec:\n${plan.spec}\nTest plan (cover EVERY case):\n- ${plan.testPlan.join('\n- ')}\n\nWORKDIR: create ${workdir}/variant-${i}. Write the implementation file AND the test file covering every case above. Then RUN the test command for this stack inside that dir. T1 SELF-CORRECTION LOOP: if any test fails, read the error, fix the implementation (not the tests, unless a test is genuinely wrong), and re-run. Repeat up to 5 iterations. Stop when all tests pass or after 5. Report variant ${i}, the absolute path, iterations used, tests total/passing, and whether all pass.`,
      { schema: BUILD_SCHEMA, phase: 'Implement', label: `impl:v${i} (${s.name})` },
    ),
  ),
)
const ok = built.filter(Boolean)
if (!ok.length) {
  log('No variant produced a runnable build; aborting.')
  return { task, plan, built: [], error: 'no runnable builds' }
}
const green = ok.filter((b) => b.allTestsPass)
log(`Built ${ok.length}/${N}; green (all tests pass): ${green.length}`)

const builtReport = ok.map((b) => ({ variant: b.variant, strategy: b.strategy, iterations: b.iterations, tests: `${b.testsPassing}/${b.testsTotal}`, allPass: b.allTestsPass }))
const planReport = { spec: plan.spec, testCount: plan.testPlan.length, strategies: plan.strategies.map((s) => s.name) }

// ---- Phase 3: ADVERSARIAL VERIFY — independent reviewers try to BREAK each candidate ----
// GATE 1 (fail-closed): only a variant whose own suite is green may be reviewed. There is no
// "least-failing variant" consolation prize — a red build is not a candidate.
const { pool, outcome: poolOutcome } = selectBuildPool(ok)
if (poolOutcome !== 'ok') {
  log(`⛔ ${outcomeReason(poolOutcome)} — no winner.`)
  return { task, plan: planReport, built: builtReport, green: [], outcome: poolOutcome, reason: outcomeReason(poolOutcome), final: null }
}

// The review prompt itself. In crossVerify mode it is handed to the cross-model reviewer VERBATIM;
// otherwise Claude runs it directly.
const reviewCore = (b, k) =>
  `You are ADVERSARIAL REVIEWER ${k} for variant ${b.variant} at ${b.path}. Your job is to BREAK it, not praise it. Read the implementation, then try to construct an input that violates the spec (boundary/rounding/off-by-one/concurrency/empty/overflow as applicable). You MAY write a tiny extra script and run it to PROVE a failure. Set defectFound=false ONLY if you genuinely cannot break it. Return your verdict with severity and a failing case if found.`

// crossVerify routes each reviewer through the codex companion as a TRANSCRIBER — NOT through
// agentType:'codex:codex-rescue', which silently judges with its own sonnet and never calls codex at
// all (see lib/gates.js). Verdicts without a real [codex:<threadId>] stamp count as abstentions, so a
// degraded cross-model run fails quorum instead of masquerading as verified.
const reviewerAgent = (b, k) => {
  const meta = { schema: VERDICT_SCHEMA, phase: 'Verify', label: `verify:v${b.variant}.${k}` }
  if (!crossVerify) return agent(reviewCore(b, k), meta)
  return agent(
    codexTranscriber({
      core: reviewCore(b, k),
      cwd: workdir,
      effort: confirmEffort,
      markField: 'description',
      verdictJson: '{"defectFound": true|false, "severity": "none"|"low"|"medium"|"high", "description": "<what breaks it, or why you could not>", "failingCase": "<the input that breaks it, if any>"}',
      unavailableJson: '{"defectFound":false,"severity":"none","unavailable":true,"description":"[codex:unavailable] <what went wrong>"}',
    }),
    meta,
  )
}

const verified = await parallel(
  pool.map((b) => () =>
    parallel(Array.from({ length: V }, (_, k) => () => reviewerAgent(b, k))).then((vs) => ({
      ...b,
      ...tallyRefutation(vs, V, crossVerify),
    })),
  ),
)

// Provenance audit — did the cross-model verification the caller ASKED for actually happen?
const provenance = crossModelAudit(verified.filter(Boolean), crossVerify)
if (crossVerify) {
  if (provenance.fromCodex === 0) log(`🚨 CROSS-MODEL VERIFY FAILED: 0/${provenance.total} verdicts came from ${CODEX_LABEL}. This is NOT an -x run.`)
  else if (!provenance.verified) log(`⚠️ PARTIAL cross-model verify: only ${provenance.fromCodex}/${provenance.total} verdicts (${provenance.pct}%) came from ${CODEX_LABEL}.`)
  else log(`✅ Cross-model verified: ${provenance.fromCodex}/${provenance.total} verdicts came from ${CODEX_LABEL}.`)
}

// GATE 2 (fail-closed): a variant wins only if a real vote reached quorum AND did not refute it.
// Refuted variants are NOT recycled as candidates, and neither are ones nobody actually reviewed.
const { candidates, outcome: verdictOutcome, refuted, unverified } = selectCandidates(verified)
const verifiedReport = verified.filter(Boolean).map((v) => ({ variant: v.variant, refuted: v.refuted, confirmedRefutations: v.refutations.length, unverified: v.unverified, realVerdicts: v.realCount, quorum: v.quorum, unavailableVerdicts: v.unavailableVerdicts }))
log(`Survivors after adversarial verify: ${candidates.length}/${pool.length} (refuted ${refuted.length}, unverified ${unverified.length})`)
if (verdictOutcome !== 'ok') {
  log(`⛔ ${outcomeReason(verdictOutcome)} — no winner.`)
  return {
    task,
    plan: planReport,
    built: builtReport,
    green: green.map((g) => g.variant),
    verified: verifiedReport,
    survivors: [],
    outcome: verdictOutcome,
    reason: outcomeReason(verdictOutcome),
    verifier: crossVerify ? CODEX_LABEL : 'Claude',
    crossModelVerified: provenance.verified,
    verdictProvenance: provenance,
    final: null,
  }
}

// ---- Phase 4: SYNTHESIZE — judge picks winner, grafts best ideas ----
phase('Synthesize')
const final = await agent(
  `You are the JUDGE/SYNTHESIZER in a Pantheon harness. Candidate implementations (all paths exist on disk; every one below passed its own suite AND survived a quorate adversarial review):\n${candidates
    .map((c) => `- variant ${c.variant} (${c.strategy ?? 'n/a'}) at ${c.path}: ${c.testsPassing}/${c.testsTotal} tests pass; reviewers who tried and failed to break it=${c.realCount}`)
    .join('\n')}\n\nRead the winner and runners-up. Pick the single best variant. List any superior ideas from the others worth grafting in. Give the winner's absolute path as finalPath and your confidence. Do NOT rewrite files; just decide and explain.`,
  { schema: FINAL_SCHEMA },
)

return {
  task,
  plan: planReport,
  built: builtReport,
  green: green.map((g) => g.variant),
  verified: verifiedReport,
  survivors: candidates.map((s) => s.variant),
  refuted: refuted.map((r) => r.variant),
  unverified: unverified.map((u) => u.variant),
  outcome: 'ok',
  verifier: crossVerify ? CODEX_LABEL : 'Claude',
  // Trust THIS, not the skill's name: false means the run degraded to same-model review.
  crossModelVerified: provenance.verified,
  verdictProvenance: provenance,
  final,
}
