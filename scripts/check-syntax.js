#!/usr/bin/env node
// Parse every workflow script the way the Workflow tool actually runs it: as the body of an async
// function with the harness globals injected. `node --check` cannot do this — the files use
// top-level await and reference bare `args`/`agent`/`log`, so it rejects valid workflow scripts and
// would pass ones that break at run time.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GLOBALS = ['args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', 'budget']
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const files = readdirSync(ROOT)
  .filter((d) => d.startsWith('pantheon') && statSync(join(ROOT, d)).isDirectory())
  .flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith('-class.js')).map((f) => join(d, f)))

let failed = 0
for (const rel of files) {
  const src = readFileSync(join(ROOT, rel), 'utf8').replace(/^export const meta/m, 'const meta')
  try {
    new AsyncFunction(...GLOBALS, src)
    console.log(`  ✓ ${rel}`)
  } catch (e) {
    console.error(`  ✗ ${rel}: ${e.message}`)
    failed++
  }
}

if (!files.length) {
  console.error('no workflow scripts found — did the layout change?')
  process.exit(1)
}
console.log(failed ? `\n✗ ${failed}/${files.length} workflow script(s) do not parse` : `\n✓ all ${files.length} workflow scripts parse`)
process.exit(failed ? 1 : 0)
