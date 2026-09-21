import { readFile, readdir } from 'node:fs/promises'

const packagesDir = new URL('../packages/', import.meta.url)
const entries = await readdir(packagesDir, { recursive: true, withFileTypes: true })
const manifests = []

for (const entry of entries) {
  if (!entry.isFile() || entry.name !== 'package.json') continue
  const parentPath = entry.parentPath.replace(/^.*\/packages\/?/, '')
  const path = new URL(`../packages/${parentPath}/${entry.name}`, import.meta.url)
  manifests.push([parentPath, JSON.parse(await readFile(path, 'utf8'))])
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
const adapterDependencies = new Map([
  ['session-jsonl', new Set(['domain', 'session'])],
  ['adapters/openai-compatible', new Set(['domain', 'model'])],
])
const adapterPackages = new Set(adapterDependencies.keys())
const packageByName = new Map(manifests.map(([path, manifest]) => [manifest.name, path]))
for (const [owner, manifest] of manifests) {
  if (manifest.type !== 'module') failures.push(`${owner}: package.json must set type=module`)
  const packageName = owner.split('/').at(-1)
  if (manifest.name !== `@agent-harness/${packageName}`) {
    failures.push(`${owner}: package name must be @agent-harness/${packageName}`)
  }
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.peerDependencies,
  }
  for (const dependency of Object.keys(dependencies)) {
    const match = /^@agent-harness\/(.+)$/.exec(dependency)
    if (match === null) continue
    const dependencyPath = packageByName.get(dependency)
    if (dependencyPath === undefined) {
      failures.push(`${owner}: unknown workspace dependency ${dependency}`)
      continue
    }
    if (forbidden[owner]?.has(match[1]) || forbidden[owner]?.has(dependencyPath)) {
      failures.push(`${owner}: forbidden dependency on ${match[1]}`)
    }
    if (
      ['domain', 'session', 'model', 'tools', 'agent'].includes(owner)
      && adapterPackages.has(dependencyPath)
    ) {
      failures.push(`${owner}: core package must not depend on adapter ${match[1]}`)
    }
    if (
      adapterPackages.has(owner)
      && !adapterDependencies.get(owner)?.has(dependencyPath)
    ) {
      failures.push(`${owner}: adapter has forbidden dependency on ${match[1]}`)
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`架构 gate 已通过，共检查 ${manifests.length} 个 package\n`)
}
