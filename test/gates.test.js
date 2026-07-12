import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  fromCodex,
  codexTranscriber,
  crossModelAudit,
  verifierQuorum,
  tallyRefutation,
  tallyGapVerdicts,
  selectBuildPool,
  selectFixPool,
  selectCandidates,
  bucketGaps,
  outcomeReason,
  isAllowedBaseUrl,
  isValidEnvKey,
  resolveVerifier,
  PROVIDERS,
  CODEX_MODEL,
} from '../lib/gates.js'

// Verdict helpers. `defectFound` is the refute-direction signal, `valid` the keep-direction one.
const defect = (severity = 'high') => ({ defectFound: true, severity, description: 'broken' })
const clean = () => ({ defectFound: false, severity: 'none', description: 'looks fine' })
const dead = () => ({ defectFound: false, severity: 'none', description: 'could not run', unavailable: true })
const upholds = (adjustedSeverity = 'high') => ({ valid: true, reason: 'real gap', adjustedSeverity })
const dismisses = () => ({ valid: false, reason: 'false positive' })
const deadGap = () => ({ valid: true, reason: 'reviewer unavailable', unavailable: true })

// ---------------------------------------------------------------------------
// quorum
// ---------------------------------------------------------------------------
test('quorum is a strict majority of the CONFIGURED panel, not of whoever happened to answer', () => {
  assert.equal(verifierQuorum(1), 1)
  assert.equal(verifierQuorum(2), 2) // V=2 tolerates NO dead reviewer
  assert.equal(verifierQuorum(3), 2) // V=3 tolerates one
  assert.equal(verifierQuorum(4), 3)
  assert.equal(verifierQuorum(5), 3)
})

// ---------------------------------------------------------------------------
// refute-direction vote (pantheon, pantheon-fix)
// ---------------------------------------------------------------------------
test('a tie REFUTES: one confirmed defect out of two reviewers kills the candidate', () => {
  // This is the load-bearing asymmetry. The GPT-5.6 review of this repo proposed raising this to a
  // strict majority (floor(n/2)+1), which would let a single "looks fine" outvote a real defect
  // report and admit the broken candidate. Locking the direction in.
  const t = tallyRefutation([defect(), clean()], 2)
  assert.equal(t.refuted, true)
  assert.equal(t.unverified, false)
})

test('a low-severity finding is not a refutation', () => {
  assert.equal(tallyRefutation([defect('low'), clean()], 2).refuted, false)
})

test('a clean sweep survives', () => {
  const t = tallyRefutation([clean(), clean()], 2)
  assert.equal(t.refuted, false)
  assert.equal(t.unverified, false)
  assert.equal(t.realCount, 2)
})

test('one defect out of three does not refute; two do', () => {
  assert.equal(tallyRefutation([defect(), clean(), clean()], 3).refuted, false)
  assert.equal(tallyRefutation([defect(), defect(), clean()], 3).refuted, true)
})

test('unavailable verdicts ABSTAIN — they are never counted as a pass', () => {
  const t = tallyRefutation([defect(), dead()], 2)
  assert.equal(t.realCount, 1)
  assert.equal(t.unavailableVerdicts, 1)
})

test('below quorum the candidate is unverified and CANNOT be refuted or cleared by the survivor', () => {
  // V=3, two reviewers dead. The lone survivor must not get to decide the run either way.
  const cleared = tallyRefutation([clean(), dead(), dead()], 3)
  assert.equal(cleared.unverified, true)
  assert.equal(cleared.refuted, false)

  const accused = tallyRefutation([defect(), dead(), dead()], 3)
  assert.equal(accused.unverified, true)
  assert.equal(accused.refuted, false, 'a single voice below quorum cannot refute either')
})

test('a totally dead verifier fleet yields unverified, not a silent pass', () => {
  // This is the shape of the real outage: the Codex CLI rejecting gpt-5.6-* with a 400 made every
  // reviewer unavailable. The old code read that as "nobody found a defect".
  const t = tallyRefutation([dead(), dead()], 2)
  assert.equal(t.realCount, 0)
  assert.equal(t.unverified, true)
  assert.equal(t.refuted, false)
})

test('dead agents (null) are filtered before the vote', () => {
  const t = tallyRefutation([null, clean(), null], 2)
  assert.equal(t.realCount, 1)
  assert.equal(t.unverified, true, 'one real verdict does not meet quorum 2')
})

// ---------------------------------------------------------------------------
// keep-direction vote (pantheon-gap) — deliberately the OPPOSITE tie rule
// ---------------------------------------------------------------------------
test('gap tie KEEPS: a split vote never silently discards a probe finding', () => {
  const t = tallyGapVerdicts([upholds(), dismisses()], 2)
  assert.equal(t.kept, true)
  assert.equal(t.unconfirmed, false)
})

test('gap is dismissed only when a real majority dismisses it', () => {
  assert.equal(tallyGapVerdicts([dismisses(), dismisses()], 2).kept, false)
  assert.equal(tallyGapVerdicts([upholds(), dismisses(), dismisses()], 3).kept, false)
  assert.equal(tallyGapVerdicts([upholds(), upholds(), dismisses()], 3).kept, true)
})

test('gap with no quorate reviewer is KEPT but flagged unconfirmed', () => {
  const t = tallyGapVerdicts([deadGap(), deadGap()], 2)
  assert.equal(t.kept, true)
  assert.equal(t.unconfirmed, true)
})

test('an upheld gap carries its adjusted severity', () => {
  assert.equal(tallyGapVerdicts([upholds('critical'), upholds('high')], 2).adjustedSeverity, 'critical')
})

// ---------------------------------------------------------------------------
// build gate
// ---------------------------------------------------------------------------
test('a red build is never a candidate — there is no least-failing consolation prize', () => {
  const red = [
    { variant: 0, allTestsPass: false, testsPassing: 9, testsTotal: 10 },
    { variant: 1, allTestsPass: false, testsPassing: 2, testsTotal: 10 },
  ]
  const r = selectBuildPool(red)
  assert.equal(r.outcome, 'no_green_candidate')
  assert.deepEqual(r.pool, [], 'the 9/10 build must NOT be revived')
})

test('only green builds enter the pool', () => {
  const builds = [
    { variant: 0, allTestsPass: false, testsPassing: 9, testsTotal: 10 },
    { variant: 1, allTestsPass: true, testsPassing: 10, testsTotal: 10 },
  ]
  const r = selectBuildPool(builds)
  assert.equal(r.outcome, 'ok')
  assert.deepEqual(r.pool.map((b) => b.variant), [1])
})

// ---------------------------------------------------------------------------
// fix gate
// ---------------------------------------------------------------------------
test('a testable defect requires the repro test to pass — "did not regress" is not a fix', () => {
  const fixes = [
    { variant: 0, regressed: false, reproPasses: false }, // a no-op that happens to be safe
    { variant: 1, regressed: true, reproPasses: true },
  ]
  const r = selectFixPool(fixes, true)
  assert.equal(r.outcome, 'no_repro_passing_fix')
  assert.deepEqual(r.pool, [], 'the non-regressing no-op must NOT be promoted')
})

test('a repro-passing, non-regressing fix is admitted', () => {
  const fixes = [
    { variant: 0, regressed: false, reproPasses: false },
    { variant: 1, regressed: false, reproPasses: true },
  ]
  const r = selectFixPool(fixes, true)
  assert.equal(r.outcome, 'ok')
  assert.deepEqual(r.pool.map((f) => f.variant), [1])
})

test('when every fix regresses, the outcome says so', () => {
  const r = selectFixPool([{ variant: 0, regressed: true, reproPasses: true }], true)
  assert.equal(r.outcome, 'no_non_regressing_fix')
  assert.deepEqual(r.pool, [])
})

test('for a non-testable defect, not regressing is the whole bar', () => {
  const r = selectFixPool([{ variant: 0, regressed: false, reproPasses: false }], false)
  assert.equal(r.outcome, 'ok')
  assert.equal(r.pool.length, 1)
})

// ---------------------------------------------------------------------------
// candidate gate — the bug the repo's own benchmark caught
// ---------------------------------------------------------------------------
test('when the reviewers break every candidate, NOTHING wins', () => {
  // benchmarks/tetmux-cross-model.md recorded the old behavior: all 3 fixes refuted, v0 crowned
  // anyway as "refuted — but best of 3". That patch could then be applied with apply:true.
  const verified = [
    { variant: 0, refuted: true, unverified: false },
    { variant: 1, refuted: true, unverified: false },
    { variant: 2, refuted: true, unverified: false },
  ]
  const r = selectCandidates(verified)
  assert.equal(r.outcome, 'all_candidates_refuted')
  assert.deepEqual(r.candidates, [], 'a refuted candidate must never be recycled into the judge pool')
  assert.equal(r.refuted.length, 3)
})

test('an unreviewed candidate cannot win either', () => {
  const r = selectCandidates([{ variant: 0, refuted: false, unverified: true }])
  assert.equal(r.outcome, 'insufficient_verifier_quorum')
  assert.deepEqual(r.candidates, [])
})

test('only genuinely surviving candidates reach the judge', () => {
  const r = selectCandidates([
    { variant: 0, refuted: true, unverified: false },
    { variant: 1, refuted: false, unverified: true },
    { variant: 2, refuted: false, unverified: false },
  ])
  assert.equal(r.outcome, 'ok')
  assert.deepEqual(r.candidates.map((c) => c.variant), [2])
  assert.deepEqual(r.refuted.map((c) => c.variant), [0])
  assert.deepEqual(r.unverified.map((c) => c.variant), [1])
})

// ---------------------------------------------------------------------------
// gap accounting
// ---------------------------------------------------------------------------
test('gap buckets are disjoint — an unconfirmed gap is never counted as confirmed', () => {
  // The old code did `confirmed = allGaps.filter(g => g.kept)` and then counted the unconfirmed
  // subset of THAT as `gapsUnconfirmed`, so the same gap landed in both totals.
  const gaps = [
    { title: 'a', kept: true, unconfirmed: false },
    { title: 'b', kept: true, unconfirmed: true },
    { title: 'c', kept: false, unconfirmed: false },
  ]
  const { confirmed, keptUnconfirmed, dismissed } = bucketGaps(gaps)
  assert.deepEqual(confirmed.map((g) => g.title), ['a'])
  assert.deepEqual(keptUnconfirmed.map((g) => g.title), ['b'])
  assert.deepEqual(dismissed.map((g) => g.title), ['c'])
  assert.equal(confirmed.length + keptUnconfirmed.length + dismissed.length, gaps.length)
  assert.equal(confirmed.some((g) => g.unconfirmed), false)
})

test('every outcome has a human reason', () => {
  for (const o of ['no_green_candidate', 'no_repro_passing_fix', 'no_non_regressing_fix', 'all_candidates_refuted', 'insufficient_verifier_quorum']) {
    assert.notEqual(outcomeReason(o), o, `${o} needs a prose explanation`)
  }
})

// ---------------------------------------------------------------------------
// cross-model provenance — the silent codex-rescue failure
// ---------------------------------------------------------------------------
const STAMP = '[codex:3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607]'
const codexDefect = () => ({ defectFound: true, severity: 'high', description: `${STAMP} race on line 40` })
const codexClean = () => ({ defectFound: false, severity: 'none', description: `${STAMP} could not break it` })
const codexUpholds = () => ({ valid: true, reason: `${STAMP} real gap`, adjustedSeverity: 'high' })

test('a verdict only counts as cross-model if it carries a real codex thread id', () => {
  assert.equal(fromCodex(codexClean()), true)
  assert.equal(fromCodex(codexUpholds()), true)
  assert.equal(fromCodex(clean()), false, 'an unstamped verdict is not cross-model')
  // A transcriber that fakes the marker without running the command must not satisfy the audit.
  assert.equal(fromCodex({ description: '[codex:yes-i-really-did] trust me' }), false)
  assert.equal(fromCodex({ description: '[codex:] ' }), false)
})

test('under crossVerify, an UNSTAMPED verdict abstains — so codex-rescue cannot fake an -x run', () => {
  // This is the exact silent failure: codex:codex-rescue returns confident, plausible, non-unavailable
  // verdicts that never came from codex. Measured 1/84 confirm agents actually reaching it. Without
  // requireCodex the harness reads these as a clean adversarial pass.
  const t = tallyRefutation([clean(), clean()], 2, true)
  assert.equal(t.realCount, 0, 'unstamped verdicts are not real verdicts under crossVerify')
  assert.equal(t.unverified, true)
  assert.equal(t.refuted, false)

  // ...and quorum then refuses to crown it.
  const r = selectCandidates([{ variant: 0, ...t }])
  assert.equal(r.outcome, 'insufficient_verifier_quorum')
  assert.deepEqual(r.candidates, [], 'a fake cross-verified run must produce NO winner')
})

test('the same verdicts are accepted when crossVerify is off', () => {
  const t = tallyRefutation([clean(), clean()], 2, false)
  assert.equal(t.realCount, 2)
  assert.equal(t.unverified, false)
})

test('genuinely stamped verdicts vote normally, and the tie still refutes', () => {
  const t = tallyRefutation([codexDefect(), codexClean()], 2, true)
  assert.equal(t.realCount, 2)
  assert.equal(t.codexCount, 2)
  assert.equal(t.refuted, true)
})

test('gap confirm: an unstamped verdict leaves the gap unconfirmed rather than "dismissed by GPT"', () => {
  const t = tallyGapVerdicts([dismisses(), dismisses()], 2, true)
  assert.equal(t.realCount, 0)
  assert.equal(t.unconfirmed, true)
  assert.equal(t.kept, true, 'a gap must not be dismissed by a reviewer that never ran')
})

test('the provenance audit reports a degraded run instead of hiding it', () => {
  const honest = [{ realCount: 2, codexCount: 2 }, { realCount: 2, codexCount: 2 }]
  assert.deepEqual(crossModelAudit(honest, true), { total: 4, fromCodex: 4, verified: true, pct: 100 })

  const degraded = [{ realCount: 2, codexCount: 1 }, { realCount: 2, codexCount: 0 }]
  const a = crossModelAudit(degraded, true)
  assert.equal(a.verified, false)
  assert.equal(a.pct, 25)

  // crossVerify off => never claim cross-model verification
  assert.equal(crossModelAudit(honest, false).verified, false)
})

// ---------------------------------------------------------------------------
// verifier routing
// ---------------------------------------------------------------------------
test('codex routes to the transcriber shell-out, NEVER to the codex-rescue agent', () => {
  for (const v of ['codex', 'gpt', 'openai', 'gpt-5.6-sol']) {
    const r = resolveVerifier(v)
    assert.equal(r.mode, 'codex-transcribe', `${v} must shell out to the companion`)
    assert.notEqual(r.agentType, 'codex:codex-rescue', `${v} must not route through the silent wrapper`)
  }
  const cross = resolveVerifier('', true)
  assert.equal(cross.mode, 'codex-transcribe')
  assert.equal(cross.model, CODEX_MODEL)

  // The transcriber prompt must pin the model and forbid the agent from judging on its own.
  const p = codexTranscriber({ core: 'review this', cwd: '/tmp/x', verdictJson: '{}', unavailableJson: '{}' })
  assert.match(p, new RegExp(`--model ${CODEX_MODEL}`))
  assert.match(p, /NOT the reviewer/)
  assert.match(p, /NEVER substitute your own judgment/)
})

test('default and Claude tiers', () => {
  assert.equal(resolveVerifier('').mode, 'claude')
  assert.equal(resolveVerifier('claude').mode, 'claude')
  assert.equal(resolveVerifier('opus').model, 'opus')
  assert.equal(resolveVerifier('anthropic/haiku').model, 'haiku')
})

test('cloud providers resolve to a direct HTTP route', () => {
  const ds = resolveVerifier('deepseek')
  assert.equal(ds.mode, 'http')
  assert.equal(ds.baseUrl, 'https://api.deepseek.com')
  assert.equal(ds.envKey, 'DEEPSEEK_API_KEY')
  assert.equal(ds.model, 'deepseek-chat')
})

test('aliases resolve, with and without an explicit model', () => {
  assert.equal(resolveVerifier('qwen').baseUrl, PROVIDERS.dashscope.baseUrl)
  assert.equal(resolveVerifier('qwen/qwen3-coder-plus').model, 'qwen3-coder-plus')
  assert.equal(resolveVerifier('kimi').envKey, 'MOONSHOT_API_KEY')
})

test('every provider in the catalog is actually routable', () => {
  // The hand-maintained runtime table held 15 of ~30 catalogued providers, so picking one of the
  // other 15 in /pantheon-model fell through to a codex route that could not work.
  for (const id of Object.keys(PROVIDERS)) {
    const r = resolveVerifier(id)
    assert.equal(r.mode, 'http', `${id} should resolve to an http route, got ${r.mode}`)
  }
  assert.ok(Object.keys(PROVIDERS).length >= 25, 'the full catalog should be inlined')
})

test('local models route through codex', () => {
  const o = resolveVerifier('ollama/qwen2.5:7b')
  assert.equal(o.mode, 'codex')
  assert.deepEqual(o.codexArgs, ['--oss', '--local-provider', 'ollama', '-m', 'qwen2.5:7b'])
})

test('an unknown verifier FAILS LOUDLY instead of guessing a codex route', () => {
  assert.equal(resolveVerifier('not-a-real-provider').mode, 'invalid')
  assert.equal(resolveVerifier('nonsense/some-model').mode, 'invalid')
})

// ---------------------------------------------------------------------------
// transport safety
// ---------------------------------------------------------------------------
test('source code is never shipped over plaintext http to a remote host', () => {
  assert.equal(isAllowedBaseUrl('https://api.deepseek.com'), true)
  assert.equal(isAllowedBaseUrl('http://127.0.0.1:8000/v1'), true) // loopback is fine
  assert.equal(isAllowedBaseUrl('http://localhost:1234/v1'), true)
  assert.equal(isAllowedBaseUrl('http://evil.example.com/v1'), false)
  assert.equal(isAllowedBaseUrl('ftp://x'), false)
  assert.equal(isAllowedBaseUrl(undefined), false)
})

test('env key names are constrained to what a real env var can be', () => {
  assert.equal(isValidEnvKey('DEEPSEEK_API_KEY'), true)
  assert.equal(isValidEnvKey('lower_case'), false)
  assert.equal(isValidEnvKey('X; rm -rf /'), false)
  assert.equal(isValidEnvKey('9LEADING_DIGIT'), false)
})

// ---------------------------------------------------------------------------
// catalog integrity — providers.json is the single source, so it must stay sane
// ---------------------------------------------------------------------------
test('providers.json: every routable provider has a safe baseUrl, a valid envKey, and a default model', () => {
  const catalog = JSON.parse(readFileSync(new URL('../providers.json', import.meta.url), 'utf8'))
  for (const [id, p] of Object.entries(catalog.providers)) {
    if (p.special) continue
    assert.ok(isAllowedBaseUrl(p.baseUrl), `${id}: unsafe baseUrl ${p.baseUrl}`)
    assert.ok(isValidEnvKey(p.envKey), `${id}: bad envKey ${p.envKey}`)
    assert.ok('defModel' in p, `${id}: missing defModel`)
  }
})

test('providers.json: every alias points at a provider that exists', () => {
  const catalog = JSON.parse(readFileSync(new URL('../providers.json', import.meta.url), 'utf8'))
  for (const [alias, target] of Object.entries(catalog.aliases)) {
    assert.ok(catalog.providers[target], `alias ${alias} -> unknown provider ${target}`)
  }
})
