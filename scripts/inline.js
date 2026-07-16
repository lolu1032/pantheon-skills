#!/usr/bin/env node
// =============================================================================
// scripts/inline.js — keeps the duplicated harness logic honest.
//
// Workflow scripts must be self-contained (no imports), so the shared gate logic in
// lib/gates.js physically lives in every *-class.js. This script is what makes that
// duplication safe:
//
//   1. Regenerates the PROVIDERS/ALIASES/CODEX_* literals inside lib/gates.js from
//      providers.json (the catalog is the single source for provider routing).
//   2. Copies each PANTHEON:<SECTION> region from lib/gates.js into the matching
//      region of every target workflow file.
//
//   node scripts/inline.js          — write
//   node scripts/inline.js --check  — verify only; exit 1 on drift (used by CI)
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = process.argv.includes('--check')

// Which shared sections each workflow file needs. The base/-x generation and gap skills route
// verification through Claude or the Codex plugin only, so they do not carry the provider table.
const TARGETS = {
  'pantheon/pantheon-class.js': ['CODEX', 'GATES'],
  'pantheon-x/pantheon-class.js': ['CODEX', 'GATES'],
  'pantheon-custom/pantheon-class.js': ['CODEX', 'GATES', 'PROVIDERS'],
  'pantheon-gap/pantheon-gap-class.js': ['CODEX', 'GATES'],
  'pantheon-gap-x/pantheon-gap-class.js': ['CODEX', 'GATES'],
  'pantheon-gap-custom/pantheon-gap-class.js': ['CODEX', 'GATES', 'PROVIDERS'],
  'pantheon-fix/pantheon-fix-class.js': ['CODEX', 'GATES', 'PROVIDERS'],
}

const begin = (s) => `// <<< PANTHEON:${s}`
const end = (s) => `// >>> PANTHEON:${s}`

function extract(src, section, where) {
  const b = src.indexOf(begin(section))
  const e = src.indexOf(end(section))
  if (b === -1 || e === -1) throw new Error(`${where}: missing PANTHEON:${section} markers`)
  if (e < b) throw new Error(`${where}: PANTHEON:${section} markers are inverted`)
  return src.slice(b + begin(section).length, e)
}

function replace(src, section, body, where) {
  const b = src.indexOf(begin(section))
  const e = src.indexOf(end(section))
  if (b === -1 || e === -1) throw new Error(`${where}: missing PANTHEON:${section} markers`)
  return src.slice(0, b + begin(section).length) + body + src.slice(e)
}

// ---- 1. providers.json -> the generated literals inside lib/gates.js ----------
const catalog = JSON.parse(readFileSync(join(ROOT, 'providers.json'), 'utf8'))

// Only real HTTP providers reach the runtime table; `special` entries (claude/codex/local) are
// handled natively by resolveVerifier. Every catalogued provider IS emitted — the old hand-kept
// table listed 15 of ~30, so picking a catalogued-but-unlisted provider fell through to a codex
// route that could not work.
const runtime = Object.entries(catalog.providers)
  .filter(([, p]) => !p.special && p.baseUrl)
  .map(([id, p]) => {
    const fields = [
      `baseUrl: ${JSON.stringify(p.baseUrl)}`,
      `envKey: ${JSON.stringify(p.envKey)}`,
      `wire: ${JSON.stringify(p.wire || 'chat')}`,
      `defModel: ${JSON.stringify(p.defModel ?? (p.models && p.models[0]) ?? '')}`,
    ]
    return `  ${JSON.stringify(id)}: { ${fields.join(', ')} },`
  })

// Aliases pointing at `special` providers are resolved natively, not through the HTTP table.
const runtimeIds = new Set(
  Object.entries(catalog.providers).filter(([, p]) => !p.special && p.baseUrl).map(([id]) => id),
)
const aliases = Object.entries(catalog.aliases || {})
  .filter(([, target]) => runtimeIds.has(target))
  .map(([a, target]) => `${JSON.stringify(a)}: ${JSON.stringify(target)}`)

// Two independently generated regions: the Codex pin (needed by every skill, including the base
// ones that carry no provider table) and the provider table (only the routing skills).
const REGIONS = {
  CODEX: {
    begin: '// --- GENERATED:CODEX from providers.json by scripts/inline.js — DO NOT HAND-EDIT ---',
    end: '// --- END GENERATED:CODEX ---',
    body: [
      `const CODEX_MODEL = ${JSON.stringify(catalog.codex.model)}`,
      `const CODEX_LABEL = ${JSON.stringify(catalog.codex.label)}`,
    ],
  },
  GROK: {
    begin: '// --- GENERATED:GROK from providers.json by scripts/inline.js — DO NOT HAND-EDIT ---',
    end: '// --- END GENERATED:GROK ---',
    body: [
      `const GROK_MODEL = ${JSON.stringify(catalog.grok.model)}`,
      `const GROK_LABEL = ${JSON.stringify(catalog.grok.label)}`,
    ],
  },
  TABLE: {
    begin: '// --- GENERATED:TABLE from providers.json by scripts/inline.js — DO NOT HAND-EDIT ---',
    end: '// --- END GENERATED:TABLE ---',
    body: ['const PROVIDERS = {', ...runtime, '}', `const ALIASES = { ${aliases.join(', ')} }`],
  },
}

const gatesPath = join(ROOT, 'lib/gates.js')
const gatesOrig = readFileSync(gatesPath, 'utf8')
let gates = gatesOrig
for (const [name, r] of Object.entries(REGIONS)) {
  const b = gates.indexOf(r.begin)
  const e = gates.indexOf(r.end)
  if (b === -1 || e === -1) throw new Error(`lib/gates.js: missing GENERATED:${name} markers`)
  gates = gates.slice(0, b + r.begin.length) + '\n' + r.body.join('\n') + '\n' + gates.slice(e)
}

// ---- 2. lib/gates.js -> each workflow file ----------------------------------
const sections = {}
for (const s of ['CODEX', 'GATES', 'PROVIDERS']) sections[s] = extract(gates, s, 'lib/gates.js')

const drift = []
const writes = []

if (gates !== gatesOrig) {
  drift.push('lib/gates.js (generated provider table is stale)')
  writes.push([gatesPath, gates])
}

for (const [rel, needed] of Object.entries(TARGETS)) {
  const p = join(ROOT, rel)
  const orig = readFileSync(p, 'utf8')
  let out = orig
  for (const s of needed) out = replace(out, s, sections[s], rel)
  if (out !== orig) {
    drift.push(rel)
    writes.push([p, out])
  }
}

if (CHECK) {
  if (drift.length) {
    console.error('✗ inlined harness logic is out of date in:')
    for (const d of drift) console.error(`    ${d}`)
    console.error('\n  Fix: edit lib/gates.js (or providers.json), then run `npm run inline`.')
    process.exit(1)
  }
  console.log(`✓ ${Object.keys(TARGETS).length} workflow files are in sync with lib/gates.js`)
  process.exit(0)
}

for (const [p, content] of writes) writeFileSync(p, content)
console.log(
  writes.length
    ? `✓ inlined into ${writes.length} file(s):\n${writes.map(([p]) => `    ${relative(ROOT, p)}`).join('\n')}`
    : '✓ already in sync; nothing to write',
)
