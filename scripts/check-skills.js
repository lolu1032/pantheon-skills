#!/usr/bin/env node
// Validate the SKILL.md manifests against the Agent Skills spec (agentskills.io/specification).
// The binding constraint in practice is the 1024-char description cap: a standard validator rejects
// the skill outright, and the description is also what the model matches on to trigger the skill —
// so it is the one field that silently breaks everything if it is wrong.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_DESCRIPTION = 1024
const MAX_NAME = 64

const dirs = readdirSync(ROOT)
  .filter((d) => d.startsWith('pantheon') && statSync(join(ROOT, d)).isDirectory())
  .filter((d) => existsSync(join(ROOT, d, 'SKILL.md')))

const errors = []

for (const d of dirs) {
  const src = readFileSync(join(ROOT, d, 'SKILL.md'), 'utf8')
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(src)
  if (!fm) {
    errors.push(`${d}/SKILL.md: no YAML frontmatter`)
    continue
  }

  // These descriptions are multi-line YAML: a `key:` line followed by indented continuation lines.
  // Collect the continuations and normalize the whitespace to get the string a validator would see.
  const field = (key) => {
    const lines = fm[1].split('\n')
    const start = lines.findIndex((l) => l.startsWith(`${key}:`))
    if (start === -1) return null
    const parts = [lines[start].slice(key.length + 1)]
    for (let i = start + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) parts.push(lines[i])
    const text = parts.join(' ').split(/\s+/).filter(Boolean).join(' ')
    return text.replace(/^["']|["']$/g, '')
  }

  const name = field('name')
  const description = field('description')

  if (!name) errors.push(`${d}: missing \`name\``)
  else if (name !== d) errors.push(`${d}: name "${name}" does not match its directory`)
  else if (name.length > MAX_NAME) errors.push(`${d}: name is ${name.length} chars (max ${MAX_NAME})`)

  if (!description) {
    errors.push(`${d}: missing \`description\``)
  } else if (description.length > MAX_DESCRIPTION) {
    errors.push(`${d}: description is ${description.length} chars (max ${MAX_DESCRIPTION}) — trim it or a spec validator will reject the skill`)
  } else {
    console.log(`  ✓ ${d} (description ${description.length}/${MAX_DESCRIPTION})`)
  }
}

if (errors.length) {
  console.error('\n✗ skill manifest problems:')
  for (const e of errors) console.error(`    ${e}`)
  process.exit(1)
}
console.log(`\n✓ all ${dirs.length} skill manifests valid`)
