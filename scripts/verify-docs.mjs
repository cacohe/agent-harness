import { access, readFile, readdir } from 'node:fs/promises'

const required = [
  new URL('../AGENTS.md', import.meta.url),
  new URL('../packages/AGENTS.md', import.meta.url),
  new URL('../docs/AGENTS.md', import.meta.url),
  new URL('../docs/architecture.md', import.meta.url),
]

for (const path of required) await access(path)

const decisions = await readdir(new URL('../docs/decisions/', import.meta.url))
if (!decisions.some(name => /^\d{4}-.+\.md$/.test(name))) {
  throw new Error('docs/decisions must contain at least one numbered decision record')
}

for (const name of decisions.filter(name => name.endsWith('.md'))) {
  const text = await readFile(new URL(`../docs/decisions/${name}`, import.meta.url), 'utf8')
  for (const heading of ['## Context', '## Decision', '## Consequences']) {
    if (!text.includes(heading)) throw new Error(`${name}: missing ${heading}`)
  }
}

process.stdout.write(`documentation gate passed for ${decisions.length} decision records\n`)
