/**
 * 校验 workspace package 清单的依赖方向，并返回全部违反规则的诊断。
 * @param {readonly [string, Record<string, unknown>][]} manifests 已发现 package 的目录和清单。
 * @returns {string[]} 违反架构规则的诊断。
 */
export function verifyArchitecture(manifests) {
  const forbiddenByLeaf = {
    domain: new Set(['session', 'model', 'tools', 'agent', 'adapters', 'runtime', 'hosts', 'test-support']),
    session: new Set(['agent', 'adapters', 'runtime', 'hosts']),
    model: new Set(['agent', 'adapters', 'runtime', 'hosts']),
    tools: new Set(['agent', 'adapters', 'runtime', 'hosts']),
    agent: new Set(['adapters', 'runtime', 'hosts']),
    runtime: new Set(['hosts']),
  }
  const coreCapabilityLeaves = new Set(['domain', 'session', 'model', 'tools', 'agent'])
  const adapterDependencies = new Map([
    ['session/session-jsonl', new Set(['domain', 'session/session'])],
    ['llm/openai-compatible', new Set(['domain', 'llm/model'])],
    ['llm/gateway', new Set(['domain', 'llm/model'])],
    ['platform/platform-http', new Set(['llm/model'])],
    ['tools/platform-policy', new Set(['domain', 'core/tools'])],
  ])
  const hostDependencies = new Map([
    [
      'hosts/cli',
      new Set(['domain', 'llm/openai-compatible', 'runtime', 'session/session-jsonl', 'core/tools']),
    ],
  ])
  const adapterPackages = new Set(adapterDependencies.keys())
  const packageByName = new Map(manifests.map(([path, manifest]) => [manifest.name, path]))
  const failures = []

  for (const [owner, manifest] of manifests) {
    if (manifest.type !== 'module') failures.push(`${owner}: package.json must set type=module`)
    const leaf = owner.split('/').at(-1)
    if (manifest.name !== `@agent-harness/${leaf}`) failures.push(`${owner}: package name must be @agent-harness/${leaf}`)
    const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies }
    for (const dependency of Object.keys(dependencies)) {
      const match = /^@agent-harness\/(.+)$/.exec(dependency)
      if (match === null) continue
      const dependencyPath = packageByName.get(dependency)
      if (dependencyPath === undefined) {
        failures.push(`${owner}: unknown workspace dependency ${dependency}`)
        continue
      }
      const dependencyLeaf = match[1]
      const dependencyGroup = dependencyPath.split('/')[0]
      const forbidden = forbiddenByLeaf[leaf]
      if (forbidden?.has(dependencyLeaf) || forbidden?.has(dependencyGroup)) {
        failures.push(`${owner}: forbidden dependency on ${dependencyLeaf}`)
      }
      if (coreCapabilityLeaves.has(leaf) && adapterPackages.has(dependencyPath)) {
        failures.push(`${owner}: core package must not depend on adapter ${dependencyLeaf}`)
      }
      if (adapterPackages.has(owner) && !adapterDependencies.get(owner)?.has(dependencyPath)) {
        failures.push(`${owner}: adapter has forbidden dependency on ${dependencyLeaf}`)
      }
      if (hostDependencies.has(owner) && !hostDependencies.get(owner)?.has(dependencyPath)) {
        failures.push(`${owner}: host has forbidden dependency on ${dependencyLeaf}`)
      }
    }
  }
  return failures
}
