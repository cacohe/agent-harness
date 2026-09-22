/**
 * 校验 workspace package 清单的依赖方向，并返回全部违反规则的诊断。
 * @param {readonly [string, Record<string, unknown>][]} manifests 已发现 package 的目录和清单。
 * @returns {string[]} 违反架构规则的诊断。
 */
export function verifyArchitecture(manifests) {
  const forbidden = {
    domain: new Set(['session', 'model', 'tools', 'agent', 'adapters', 'runtime', 'hosts', 'test-support']),
    session: new Set(['agent', 'adapters', 'runtime', 'hosts']),
    model: new Set(['agent', 'adapters', 'runtime', 'hosts']),
    tools: new Set(['agent', 'adapters', 'runtime', 'hosts']),
    agent: new Set(['adapters', 'runtime', 'hosts']),
    adapters: new Set(['runtime', 'hosts']),
    runtime: new Set(['hosts']),
  }
  const adapterDependencies = new Map([
    ['session-jsonl', new Set(['domain', 'session'])],
    ['adapters/openai-compatible', new Set(['domain', 'model'])],
  ])
  const hostDependencies = new Map([
    ['hosts/cli', new Set(['domain', 'adapters/openai-compatible', 'runtime', 'session-jsonl', 'tools'])],
  ])
  const adapterPackages = new Set(adapterDependencies.keys())
  const packageByName = new Map(manifests.map(([path, manifest]) => [manifest.name, path]))
  const failures = []

  for (const [owner, manifest] of manifests) {
    if (manifest.type !== 'module') failures.push(`${owner}: package.json must set type=module`)
    const packageName = owner.split('/').at(-1)
    if (manifest.name !== `@agent-harness/${packageName}`) failures.push(`${owner}: package name must be @agent-harness/${packageName}`)
    const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies }
    for (const dependency of Object.keys(dependencies)) {
      const match = /^@agent-harness\/(.+)$/.exec(dependency)
      if (match === null) continue
      const dependencyPath = packageByName.get(dependency)
      if (dependencyPath === undefined) {
        failures.push(`${owner}: unknown workspace dependency ${dependency}`)
        continue
      }
      const dependencyCategory = dependencyPath.split('/')[0]
      if (forbidden[owner]?.has(match[1]) || forbidden[owner]?.has(dependencyCategory)) failures.push(`${owner}: forbidden dependency on ${match[1]}`)
      if (['domain', 'session', 'model', 'tools', 'agent'].includes(owner) && adapterPackages.has(dependencyPath)) failures.push(`${owner}: core package must not depend on adapter ${match[1]}`)
      if (adapterPackages.has(owner) && !adapterDependencies.get(owner)?.has(dependencyPath)) failures.push(`${owner}: adapter has forbidden dependency on ${match[1]}`)
      if (hostDependencies.has(owner) && !hostDependencies.get(owner)?.has(dependencyPath)) failures.push(`${owner}: host has forbidden dependency on ${match[1]}`)
    }
  }
  return failures
}
