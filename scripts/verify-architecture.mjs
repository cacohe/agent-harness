import { readFile, readdir } from 'node:fs/promises'
import { verifyArchitecture } from './architecture-rules.mjs'

const packagesDir = new URL('../packages/', import.meta.url)
const entries = await readdir(packagesDir, { recursive: true, withFileTypes: true })
const manifests = []
const sourceEntries = []

for (const entry of entries) {
  if (!entry.isFile() || entry.name !== 'package.json') continue
  const parentPath = entry.parentPath.replaceAll('\\', '/').replace(/^.*\/packages\/?/, '')
  const path = new URL(`../packages/${parentPath}/${entry.name}`, import.meta.url)
  manifests.push([parentPath, JSON.parse(await readFile(path, 'utf8'))])
}

const owners = manifests.map(([owner]) => owner).sort((left, right) => right.length - left.length)
for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
  const parentPath = entry.parentPath.replaceAll('\\', '/').replace(/^.*\/packages\/?/, '')
  const relativePath = `${parentPath}/${entry.name}`
  const owner = owners.find(candidate => relativePath.startsWith(`${candidate}/src/`))
  if (owner === undefined) continue
  const file = relativePath.slice(owner.length + 1)
  const url = new URL(`../packages/${relativePath}`, import.meta.url)
  sourceEntries.push([owner, file, await readFile(url, 'utf8')])
}

const failures = verifyArchitecture(manifests, sourceEntries)

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`架构 gate 已通过，共检查 ${manifests.length} 个 package\n`)
}
