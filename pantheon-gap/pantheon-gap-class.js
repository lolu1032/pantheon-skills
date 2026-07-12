export const meta = {
  name: 'pantheon-gap-class',
  description: 'Multi-agent gap analysis & feedback review: map the project -> probe each dimension for gaps -> adversarially confirm each gap -> synthesize a prioritized report',
  phases: [
    { title: 'Map', detail: 'Scout the project: stated purpose, stack, maturity, and which dimensions to audit' },
    { title: 'Probe', detail: 'One agent per dimension hunts for gaps with file-level evidence' },
    { title: 'Confirm', detail: 'Skeptical reviewers try to dismiss each gap; false positives are dropped' },
    { title: 'Synthesize', detail: 'Judge dedups, prioritizes by impact x effort, writes the report' },
  ],
}

// NOTE: the Workflow tool delivers `args` as a JSON STRING (not a parsed object).
// Parse defensively so this works whether args is a string, an object, or absent.
let A = {}
if (typeof args === 'string') { try { A = args ? JSON.parse(args) : {} } catch (e) { A = {} } }
else if (args && typeof args === 'object') { A = args }

const target = A.target ?? A.workdir ?? '.'         // absolute path to the project being reviewed
const focus = A.focus ?? null                       // optional: dimension/area to emphasize
const maxDims = A.maxDimensions ?? 6                // how many dimensions to probe
const V = A.verifiers ?? 2                          // skeptical reviewers per candidate gap
const crossVerify = A.crossModelVerify ?? false    // true => the confirm step runs on the cross-model reviewer
const confirmEffort = A.confirmEffort ?? 'medium'   // codex reasoning effort; a user's config may default to xhigh, which is very slow across dozens of calls
// Cost control: only spend confirm calls on gaps at these severities, e.g. ["critical","high"]. Gaps
// outside the scope are NOT dismissed — they are kept and reported as unconfirmed, and the skip count
// is logged, so a filtered run can never read as a fully-confirmed one.
const confirmSeverities = Array.isArray(A.confirmSeverities) ? A.confirmSeverities : null
const dimensionsOverride = Array.isArray(A.dimensions) ? A.dimensions : null

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

// Same audit, generation side. A builder used to write its own test file AND report whether it
// passed — so "green" was self-graded and meant something different in every variant. The planner
// now owns one canonical test file; this folds the auditor's independent re-run over what the
// builder claimed. An unaudited build is not green, whatever it says about itself.
function applyBuildAudit(build, audit) {
  if (!audit) return { ...build, allTestsPass: false, auditFailed: true }
  return {
    ...build,
    allTestsPass: audit.allTestsPass,
    testsPassing: audit.testsPassing ?? build.testsPassing,
    testsTotal: audit.testsTotal ?? build.testsTotal,
    testWasTampered: Boolean(audit.testWasTampered),
    selfReportMismatch: build.allTestsPass !== audit.allTestsPass,
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

const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    projectType: { type: 'string', description: 'What kind of project this is (CLI, web app, library, ...)' },
    statedPurpose: { type: 'string', description: 'What the project claims to do, per README/docs' },
    stack: { type: 'array', items: { type: 'string' } },
    maturity: { type: 'string', enum: ['prototype', 'mvp', 'production', 'unknown'] },
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          why: { type: 'string', description: 'Why this dimension matters for THIS project' },
        },
        required: ['key', 'why'],
      },
      description: 'The dimensions worth auditing for this specific project, most important first',
    },
  },
  required: ['statedPurpose', 'dimensions'],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    dimension: { type: 'string' },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          evidence: { type: 'string', description: 'file:line or a concrete observation from the actual code' },
          impact: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['title', 'severity', 'evidence', 'suggestion'],
      },
    },
  },
  required: ['dimension', 'gaps'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    valid: { type: 'boolean', description: 'true ONLY if the gap genuinely holds up under inspection' },
    reason: { type: 'string' },
    adjustedSeverity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    unavailable: { type: 'boolean', description: 'true ONLY if the reviewer could not actually run (no real verdict was produced) — never on a genuine judgment' },
  },
  required: ['valid', 'reason'],
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: "Short read on the project's current state" },
    highestLeverage: { type: 'string', description: 'The single most important thing to fix next' },
    topGaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          dimension: { type: 'string' },
          severity: { type: 'string' },
          evidence: { type: 'string', description: 'The file:line or concrete observation the gap rests on — carry it through from the probe verbatim' },
          verificationStatus: {
            type: 'string',
            enum: ['confirmed', 'unconfirmed'],
            description: 'confirmed = a quorate panel of skeptics failed to dismiss it. unconfirmed = the confirm step never actually ran on it (dead reviewers); it is the probe\'s unreviewed claim and must be labelled as such in the report.',
          },
          impact: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['title', 'severity', 'suggestion', 'verificationStatus'],
      },
    },
    quickWins: { type: 'array', items: { type: 'string' }, description: 'Cheap, high-value fixes' },
    overallAssessment: { type: 'string' },
  },
  required: ['summary', 'highestLeverage', 'topGaps'],
}

// ---- Phase 1: MAP — scout the project and choose the dimensions worth auditing ----
phase('Map')
const profile = await agent(
  `You are the SCOUT in a Pantheon gap-analysis harness. Target project: ${target}\n\n` +
    `Survey it: read the README/docs, the directory structure, package manifests, entry points, tests, and CI config. ` +
    `Determine what the project IS, its STATED PURPOSE (what it claims to do), its stack, and its maturity. ` +
    `Then choose up to ${maxDims} dimensions most worth auditing for GAPS in THIS specific project, most important first.\n` +
    `Dimension menu (pick from these and/or add project-specific ones): product-completeness, correctness-robustness, ` +
    `testing, security, docs-onboarding, architecture-maintainability, dx-api, performance-scalability, ops-observability.` +
    (focus ? `\nThe user wants extra emphasis on: ${focus}.` : ''),
  { schema: PROFILE_SCHEMA },
)
const dims = dimensionsOverride
  ? dimensionsOverride.map((k) => ({ key: k, why: 'user-specified' }))
  : profile.dimensions.slice(0, maxDims)
log(`Scouted (${profile.maturity ?? 'unknown'}): "${(profile.statedPurpose ?? 'project').slice(0, 60)}". Auditing ${dims.length}: ${dims.map((d) => d.key).join(', ')}`)

// ---- Phases 2+3: PROBE each dimension, then CONFIRM each gap adversarially (pipelined) ----
// The skeptic prompt. In crossVerify mode it is handed to the cross-model reviewer VERBATIM.
const confirmCore = (dimension, g, k) =>
  `You are a SKEPTICAL REVIEWER (${k}) in a Pantheon gap-analysis harness. A probe claims this is a gap in project ${target}:\n\n` +
  `DIMENSION: ${dimension}\nGAP: ${g.title}\nSEVERITY: ${g.severity}\nEVIDENCE: ${g.evidence}\nSUGGESTION: ${g.suggestion}\n\n` +
  `Your job is to DISMISS it. Check the ACTUAL code: is it already handled elsewhere, out of scope for the project's stated purpose, a false positive, or trivial? ` +
  `Set valid=false unless the gap genuinely holds up under inspection. If it holds, set valid=true with an adjustedSeverity you would defend.`

// crossVerify shells out to the codex companion as a TRANSCRIBER — NOT agentType:'codex:codex-rescue',
// which silently judges with its own sonnet and never calls codex (see lib/gates.js). Verdicts without
// a real [codex:<threadId>] stamp are counted as abstentions.
const inConfirmScope = (g) => !confirmSeverities || confirmSeverities.includes(g.severity)
let skippedByScope = 0

const confirmAgent = (dimension, g, k) => {
  const meta = { schema: VERDICT_SCHEMA, phase: 'Confirm', label: `confirm:${dimension}.${k}` }
  if (!crossVerify) return agent(confirmCore(dimension, g, k), meta)
  return agent(
    codexTranscriber({
      core: confirmCore(dimension, g, k),
      cwd: target,
      effort: confirmEffort,
      markField: 'reason',
      verdictJson: '{"valid": true|false, "adjustedSeverity": "low"|"medium"|"high"|"critical", "reason": "<2-4 sentences citing file:line>"}',
      unavailableJson: '{"valid":true,"unavailable":true,"reason":"[codex:unavailable] <what went wrong> — gap KEPT unconfirmed, verify manually"}',
    }),
    meta,
  )
}

const reviewed = await pipeline(
  dims,
  // Stage 1 — probe one dimension for concrete, evidence-backed gaps
  (d) =>
    agent(
      `You are GAP-PROBE for the "${d.key}" dimension in a Pantheon gap-analysis harness. Target project: ${target}\n` +
        `Project purpose: ${profile.statedPurpose}\nWhy this dimension matters here: ${d.why}\n\n` +
        `Hunt for concrete GAPS — things that are MISSING, incomplete, or weak in this dimension. ` +
        `For each gap give a short title, a severity, EVIDENCE (cite a file:line or a concrete observation — read the actual code, do NOT speculate), the impact, and a concrete suggestion. ` +
        `Prefer 3-8 real, high-signal gaps over a long noisy list. If this dimension is genuinely solid, return an empty gaps array.`,
      { schema: FINDINGS_SCHEMA, phase: 'Probe', label: `probe:${d.key}` },
    ),
  // Stage 2 — for each gap, V skeptical reviewers try to DISMISS it
  (review, d) => {
    // A dead probe agent returns null. That is NOT "this dimension is clean" — treating it as an
    // empty gap list is how an unaudited dimension gets reported as "no problems found". Surface it.
    if (!review) return { dimension: d.key, probeFailed: true, gaps: [] }
    const dimension = review.dimension ?? d.key
    return parallel(
      (review.gaps ?? []).map((g) => () => {
        if (!inConfirmScope(g)) {
          skippedByScope++
          // Out of confirm scope: keep it, but it is UNCONFIRMED — never counted as confirmed.
          return Promise.resolve({ ...g, dimension, kept: true, unconfirmed: true, realCount: 0, codexCount: 0, adjustedSeverity: g.severity })
        }
        return parallel(
          Array.from({ length: V }, (_, k) => () => confirmAgent(dimension, g, k)),
        ).then((vs) => {
          const t = tallyGapVerdicts(vs, V, crossVerify)
          return { ...g, dimension, ...t, adjustedSeverity: t.adjustedSeverity ?? g.severity }
        })
      }),
    ).then((gaps) => ({ dimension, probeFailed: false, gaps: gaps.filter(Boolean) }))
  },
)

// Buckets are DISJOINT: a gap kept only because nobody reviewed it is NOT confirmed. The old code
// counted it in both `gapsConfirmed` and `gapsUnconfirmed`, which laundered an unreviewed claim
// into a confirmed finding.
const probeFailed = dims.filter((d, i) => !reviewed[i] || reviewed[i].probeFailed).map((d) => d.key)
const allGaps = reviewed.filter(Boolean).flatMap((r) => r.gaps ?? [])
const { confirmed, keptUnconfirmed, dismissed } = bucketGaps(allGaps)

// Provenance audit. The failure this guards against was silent: the confirm agents produced plausible
// verdicts that never came from the cross-model reviewer, and nothing in the output said so.
if (skippedByScope) log(`⚠️ ${skippedByScope} gap(s) NOT confirmed — filtered out by confirmSeverities=${JSON.stringify(confirmSeverities)}; kept as unconfirmed`)
const provenance = crossModelAudit(allGaps, crossVerify)
if (crossVerify) {
  if (provenance.fromCodex === 0) log(`🚨 CROSS-MODEL CONFIRM FAILED: 0/${provenance.total} verdicts came from ${CODEX_LABEL}. Treat this as a base pantheon-gap run, NOT -x.`)
  else if (!provenance.verified) log(`⚠️ PARTIAL cross-model confirm: only ${provenance.fromCodex}/${provenance.total} verdicts (${provenance.pct}%) came from ${CODEX_LABEL}.`)
  else log(`✅ Cross-model confirmed: ${provenance.fromCodex}/${provenance.total} verdicts came from ${CODEX_LABEL}.`)
}
log(
  `Gaps: ${confirmed.length} confirmed, ${keptUnconfirmed.length} kept-unconfirmed, ${dismissed.length} dismissed (of ${allGaps.length})` +
    (keptUnconfirmed.length ? ` — ⚠️ ${keptUnconfirmed.length} had no quorate reviewer verdict` : '') +
    (probeFailed.length ? ` — ⚠️ ${probeFailed.length} dimension(s) FAILED to probe: ${probeFailed.join(', ')} (NOT audited; absence of gaps there means nothing)` : ''),
)

// ---- Phase 4: SYNTHESIZE — dedup, prioritize, write the feedback report ----
phase('Synthesize')

// Everything the caller needs to judge how much this run is worth, whatever the outcome.
const coverage = {
  probed: dims.filter((d) => !probeFailed.includes(d.key)).map((d) => d.key),
  probeFailed, // NOT audited — silence about these dimensions carries no information
  verifier: crossVerify ? CODEX_LABEL : 'Claude',
  // Trust THIS, not the skill's name: false means the run degraded to same-model review.
  crossModelVerified: provenance.verified,
  verdictProvenance: { ...provenance, skippedByScope },
}
const counts = {
  gapsFound: allGaps.length,
  gapsConfirmed: confirmed.length,
  gapsKeptUnconfirmed: keptUnconfirmed.length,
  gapsDismissed: dismissed.length,
}

// Unconfirmed gaps are still worth reporting — they just have to be LABELLED, never folded into
// the confirmed count. They go to the judge tagged so the report can say which is which.
const forReport = [
  ...confirmed.map((g) => ({ ...g, verificationStatus: 'confirmed' })),
  ...keptUnconfirmed.map((g) => ({ ...g, verificationStatus: 'unconfirmed' })),
]

if (!forReport.length) {
  const nothingAudited = coverage.probed.length === 0
  return {
    target,
    profile: { purpose: profile.statedPurpose, stack: profile.stack, maturity: profile.maturity, dimensions: dims.map((d) => d.key) },
    ...coverage,
    ...counts,
    outcome: nothingAudited ? 'no_dimension_audited' : 'no_gaps_survived',
    report: {
      summary: nothingAudited
        ? 'NOTHING WAS AUDITED — every probe agent failed. This is not a clean bill of health.'
        : `No gaps survived adversarial review across the ${coverage.probed.length} audited dimension(s).`,
      highestLeverage: nothingAudited
        ? 'Re-run the audit; the probes did not execute, so this run says nothing about the project.'
        : 'Nothing critical surfaced. Widen the dimension set or deepen the probe if you want more coverage.',
      topGaps: [],
      quickWins: [],
      overallAssessment: nothingAudited
        ? 'Inconclusive: the harness failed, not the project.'
        : 'The audited dimensions look solid, or the project is too early/empty to probe meaningfully.',
    },
  }
}

const report = await agent(
  `You are the JUDGE/SYNTHESIZER in a Pantheon gap-analysis harness for project ${target} (purpose: ${profile.statedPurpose}). ` +
    `Here are the gaps that survived the skeptics. Each is tagged with its verification status — carry that tag through to every gap you put in topGaps, and carry its evidence through verbatim:\n` +
    forReport
      .map((g, i) => `${i + 1}. [${g.dimension} | ${g.adjustedSeverity} | ${g.verificationStatus.toUpperCase()}${g.verificationStatus === 'unconfirmed' ? ' — no quorate reviewer verdict ran on this; it is the probe\'s unreviewed claim' : ''}] ${g.title} — ${g.impact ?? ''} (evidence: ${g.evidence}; fix: ${g.suggestion})`)
      .join('\n') +
    (probeFailed.length
      ? `\n\n⚠️ These dimensions were NOT audited (their probe agent failed): ${probeFailed.join(', ')}. Say so in the summary — do not imply they are clean.`
      : '') +
    `\n\nDeduplicate overlapping gaps, then produce the final feedback review: a short summary of the project's state, the TOP gaps prioritized by impact x effort, a list of quick wins (cheap high-value fixes), and the single HIGHEST-LEVERAGE thing to fix next. Be direct and concrete — this is feedback for the author.`,
  { schema: REPORT_SCHEMA },
)

return {
  target,
  profile: { purpose: profile.statedPurpose, stack: profile.stack, maturity: profile.maturity, dimensions: dims.map((d) => d.key) },
  ...coverage,
  ...counts,
  outcome: 'ok',
  report,
}
