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
  for (const heading of ['## 背景', '## 决策', '## 后果', '## 放弃的方案']) {
    if (!text.includes(heading)) throw new Error(`${name}: missing ${heading}`)
  }
}

const proseFiles = [
  ...required,
  new URL('../.agents/skills/add-capability/SKILL.md', import.meta.url),
  ...decisions.filter(name => name.endsWith('.md')).map(
    name => new URL(`../docs/decisions/${name}`, import.meta.url),
  ),
]

for (const path of proseFiles) {
  const text = await readFile(path, 'utf8')
  if (!/\p{Script=Han}/u.test(text)) {
    throw new Error(`${path.pathname}: 解释性文档必须使用中文`)
  }
}

const packageEntries = await readdir(new URL('../packages/', import.meta.url), {
  recursive: true,
  withFileTypes: true,
})
for (const entry of packageEntries) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
  const path = new URL(`../packages/${entry.parentPath.replace(/^.*\/packages\/?/, '')}/${entry.name}`, import.meta.url)
  const text = await readFile(path, 'utf8')
  for (const comment of text.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    if (!/\p{Script=Han}/u.test(comment[0])) {
      throw new Error(`${path.pathname}: JSDoc 必须使用中文`)
    }
  }
}

process.stdout.write(`文档 gate 已通过，共检查 ${decisions.length} 个决定记录\n`)
