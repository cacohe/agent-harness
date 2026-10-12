import { posix as path } from 'node:path';
import ts from 'typescript';

/** 校验 workspace package 的向内依赖方向和生产源码导入，并返回全部诊断。 */
export function verifyArchitecture(manifests, sources = []) {
  const coreSourceFiles = new Set([
    'src/agent-id-reservations.ts',
    'src/agent.ts',
    'src/execution-support.ts',
    'src/index.ts',
    'src/lifecycle.ts',
  ]);
  const protocolNeutralOwners = new Set([
    'kernel',
    'core',
    'context/context-runtime',
    'memory/memory-context',
    'session/session-lifecycle',
    'session/session-memory',
    'skills/skill-context',
  ]);
  const adapters = [
    'llm/gateway',
    'llm/openai-compatible',
    'memory/memory-gateway',
    'platform/platform-http',
    'session/session-jsonl',
    'skills/skill-filesystem',
    'skills/skill-tool',
    'tools/mcp',
    'tools/platform-policy',
    'tools/sandbox-docker',
  ];
  const allowedByOwner = new Map([
    ['kernel', new Set(['kernel'])],
    ['core', new Set(['kernel'])],
    ['context/context-runtime', new Set(['kernel'])],
    ['memory/memory-context', new Set(['kernel'])],
    ['session/session-lifecycle', new Set(['kernel'])],
    ['session/session-memory', new Set(['kernel'])],
    ['skills/skill-context', new Set(['kernel'])],
    ['tools/local', new Set(['kernel'])],
    [
      'runtime',
      new Set(['kernel', 'core', 'context/context-runtime', 'session/session-lifecycle']),
    ],
    ['test-support', new Set(['kernel', 'core', 'session/session-memory'])],
    [
      'hosts/cli',
      new Set([
        'kernel',
        'core',
        'context/context-runtime',
        'tools/local',
        'llm/gateway',
        'llm/openai-compatible',
        'memory/memory-context',
        'memory/memory-gateway',
        'platform/platform-http',
        'runtime',
        'session/session-jsonl',
        'skills/skill-context',
        'skills/skill-filesystem',
        'skills/skill-tool',
        'tools/mcp',
      ]),
    ],
    [
      'hosts/web',
      new Set([
        'kernel',
        'context/context-runtime',
        'tools/local',
        'llm/openai-compatible',
        'runtime',
        'session/session-jsonl',
      ]),
    ],
  ]);
  for (const path of adapters) allowedByOwner.set(path, new Set(['kernel']));

  const packageByName = new Map(manifests.map(([path, manifest]) => [manifest.name, path]));
  const failures = [];
  for (const [owner, manifest] of manifests) {
    if (manifest.type !== 'module') failures.push(`${owner}: package.json must set type=module`);
    const leaf = owner.split('/').at(-1);
    if (manifest.name !== `@agent-harness/${leaf}`) {
      failures.push(`${owner}: package name must be @agent-harness/${leaf}`);
    }
    const allowed = allowedByOwner.get(owner);
    if (allowed === undefined) failures.push(`${owner}: package path is not classified`);
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    for (const dependency of Object.keys(dependencies)) {
      if (!dependency.startsWith('@agent-harness/')) {
        if (protocolNeutralOwners.has(owner)) {
          failures.push(`${owner}: protocol-neutral package cannot depend on ${dependency}`);
        }
        continue;
      }
      const dependencyPath = packageByName.get(dependency);
      if (dependencyPath === undefined) {
        failures.push(`${owner}: unknown workspace dependency ${dependency}`);
      } else if (allowed !== undefined && !allowed.has(dependencyPath)) {
        failures.push(`${owner}: forbidden workspace dependency on ${dependencyPath}`);
      }
    }
  }
  for (const [owner, file, source] of sources) {
    const allowed = allowedByOwner.get(owner);
    if (owner === 'core') {
      if (!coreSourceFiles.has(file)) {
        failures.push(`core/${file}: source file is outside the Agent loop allowlist`);
      }
      if (!coreSourceFiles.has(file) || file === 'src/agent.ts' || file === 'src/index.ts') {
        for (const exportedName of exportedNames(source)) {
          if (exportedName !== 'Agent') {
            failures.push(`core/${file}: core can only export Agent, found ${exportedName}`);
          }
        }
      }
    }
    for (const specifier of importedSpecifiers(source)) {
      if (specifier.startsWith('.')) {
        const resolved = path.normalize(path.join(path.dirname(file), specifier));
        if (resolved === '..' || resolved.startsWith('../')) {
          failures.push(`${owner}/${file}: relative import escapes package boundary: ${specifier}`);
        }
        continue;
      }
      if (specifier.startsWith('@agent-harness/')) {
        const dependencyPath = packageByName.get(specifier);
        if (dependencyPath === undefined) {
          failures.push(`${owner}/${file}: unknown workspace import ${specifier}`);
        } else if (allowed !== undefined && !allowed.has(dependencyPath)) {
          failures.push(`${owner}/${file}: forbidden workspace import ${dependencyPath}`);
        }
        continue;
      }
      if (protocolNeutralOwners.has(owner)) {
        failures.push(`${owner}/${file}: protocol-neutral source cannot import ${specifier}`);
      }
    }
  }
  return failures;
}

function exportedNames(source) {
  const names = [];
  const sourceFile = ts.createSourceFile(
    'source.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      names.push('default');
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause === undefined) {
        names.push('*');
      } else if (ts.isNamedExports(statement.exportClause)) {
        names.push(...statement.exportClause.elements.map((element) => element.name.text));
      } else {
        names.push('default');
      }
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) !== true)
      continue;
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      names.push('default');
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
      continue;
    }
    if ('name' in statement && statement.name !== undefined && ts.isIdentifier(statement.name)) {
      names.push(statement.name.text);
    }
  }
  return names;
}

function collectBindingNames(binding, names) {
  if (ts.isIdentifier(binding)) {
    names.push(binding.text);
    return;
  }
  for (const element of binding.elements) {
    if (!ts.isOmittedExpression(element)) collectBindingNames(element.name, names);
  }
}

function importedSpecifiers(source) {
  const specifiers = [];
  const sourceFile = ts.createSourceFile(
    'source.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  visit(sourceFile);
  return specifiers;

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        specifiers.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  }
}
