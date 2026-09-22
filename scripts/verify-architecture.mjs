import { readFile, readdir } from 'node:fs/promises'
import { verifyArchitecture } from './architecture-rules.mjs'

const packagesDir = new URL('../packages/', import.meta.url)
const entries = await readdir(packagesDir, { recursive: true, withFileTypes: true })
const manifests = []

for (const entry of entries) {
  if (!entry.isFile() || entry.name !== 'package.json') continue
  const parentPath = entry.parentPath.replaceAll('\\', '/').replace(/^.*\/packages\/?/, '')
  const path = new URL(`../packages/${parentPath}/${entry.name}`, import.meta.url)
  manifests.push([parentPath, JSON.parse(await readFile(path, 'utf8'))])
}

const failures = verifyArchitecture(manifests)

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`架构 gate 已通过，共检查 ${manifests.length} 个 package\n`)
}
