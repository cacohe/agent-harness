import { posix as path } from 'node:path'
import ts from 'typescript'

/** 校验 workspace package 的向内依赖方向和生产源码导入，并返回全部诊断。 */
export function verifyArchitecture(manifests, sources = []) {
  const protocolNeutralOwners = new Set([
    'kernel',
    'core',
    'session/session-lifecycle',
    'session/session-memory',
    'tools/tool-runtime',
  ])
  const adapters = [
    'llm/gateway', 'llm/openai-compatible', 'memory/memory-gateway',
    'platform/platform-http', 'session/session-jsonl', 'skills/skill-filesystem',
    'skills/skill-tool', 'tools/mcp', 'tools/platform-policy', 'tools/sandbox-docker',
  ]
  const allowedByOwner = new Map([
    ['kernel', new Set()],
    ['core', new Set(['kernel'])],
    ['session/session-lifecycle', new Set(['kernel'])],
    ['session/session-memory', new Set(['kernel'])],
    ['tools/tool-runtime', new Set(['kernel'])],
    ['runtime', new Set(['kernel', 'core', 'session/session-lifecycle', 'tools/tool-runtime'])],
    ['test-support', new Set(['kernel', 'core', 'session/session-memory', 'tools/tool-runtime'])],
    ['hosts/cli', new Set([
      'kernel', 'core', 'tools/tool-runtime', 'llm/gateway', 'llm/openai-compatible',
      'memory/memory-gateway', 'platform/platform-http', 'runtime',
      'session/session-jsonl', 'skills/skill-filesystem', 'skills/skill-tool', 'tools/mcp',
    ])],
  ])
  for (const path of adapters) allowedByOwner.set(path, new Set(['kernel']))

  const packageByName = new Map(manifests.map(([path, manifest]) => [manifest.name, path]))
  const failures = []
  for (const [owner, manifest] of manifests) {
    if (manifest.type !== 'module') failures.push(`${owner}: package.json must set type=module`)
    const leaf = owner.split('/').at(-1)
    if (manifest.name !== `@agent-harness/${leaf}`) {
      failures.push(`${owner}: package name must be @agent-harness/${leaf}`)
    }
    const allowed = allowedByOwner.get(owner)
    if (allowed === undefined) failures.push(`${owner}: package path is not classified`)
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    }
    for (const dependency of Object.keys(dependencies)) {
      if (!dependency.startsWith('@agent-harness/')) {
        if (protocolNeutralOwners.has(owner)) {
          failures.push(`${owner}: protocol-neutral package cannot depend on ${dependency}`)
        }
        continue
      }
      const dependencyPath = packageByName.get(dependency)
      if (dependencyPath === undefined) {
        failures.push(`${owner}: unknown workspace dependency ${dependency}`)
      } else if (allowed !== undefined && !allowed.has(dependencyPath)) {
        failures.push(`${owner}: forbidden workspace dependency on ${dependencyPath}`)
      }
    }
  }
  for (const [owner, file, source] of sources) {
    const allowed = allowedByOwner.get(owner)
    for (const specifier of importedSpecifiers(source)) {
      if (specifier.startsWith('.')) {
        const resolved = path.normalize(path.join(path.dirname(file), specifier))
        if (resolved === '..' || resolved.startsWith('../')) {
          failures.push(`${owner}/${file}: relative import escapes package boundary: ${specifier}`)
        }
        continue
      }
      if (specifier.startsWith('@agent-harness/')) {
        const dependencyPath = packageByName.get(specifier)
        if (dependencyPath === undefined) {
          failures.push(`${owner}/${file}: unknown workspace import ${specifier}`)
        } else if (allowed !== undefined && !allowed.has(dependencyPath)) {
          failures.push(`${owner}/${file}: forbidden workspace import ${dependencyPath}`)
        }
        continue
      }
      if (protocolNeutralOwners.has(owner)) {
        failures.push(`${owner}/${file}: protocol-neutral source cannot import ${specifier}`)
      }
    }
  }
  return failures
}

function importedSpecifiers(source) {
  const specifiers = []
  const sourceFile = ts.createSourceFile(
    'source.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  visit(sourceFile)
  return specifiers

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
    ) {
      const argument = node.arguments[0]
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        specifiers.push(argument.text)
      }
    }
    ts.forEachChild(node, visit)
  }
}
