import { readFile, readdir } from 'node:fs/promises'

const packagesDir = new URL('../packages/', import.meta.url)
const entries = await readdir(packagesDir, { withFileTypes: true })
const manifests = []

for (const entry of entries) {
  if (!entry.isDirectory()) continue
  const path = new URL(`../packages/${entry.name}/package.json`, import.meta.url)
  try {
    manifests.push([entry.name, JSON.parse(await readFile(path, 'utf8'))])
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

const forbidden = {
  domain: new Set(['session', 'model', 'tools', 'agent', 'adapters', 'runtime', 'hosts', 'test-support']),
  session: new Set(['agent', 'adapters', 'runtime', 'hosts']),
  model: new Set(['agent', 'adapters', 'runtime', 'hosts']),
  tools: new Set(['agent', 'adapters', 'runtime', 'hosts']),
  agent: new Set(['adapters', 'runtime', 'hosts']),
  adapters: new Set(['runtime', 'hosts']),
  runtime: new Set(['hosts']),
}

const failures = []
for (const [owner, manifest] of manifests) {
  if (manifest.type !== 'module') failures.push(`${owner}: package.json must set type=module`)
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.peerDependencies,
  }
  for (const dependency of Object.keys(dependencies)) {
    const match = /^@agent-harness\/(.+)$/.exec(dependency)
    if (match === null) continue
    if (forbidden[owner]?.has(match[1])) {
      failures.push(`${owner}: forbidden dependency on ${match[1]}`)
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`architecture gate passed for ${manifests.length} packages\n`)
}
