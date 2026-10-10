import { describe, expect, it } from 'vitest'
import { verifyArchitecture } from './architecture-rules.mjs'

function manifest(name, dependencies = {}) {
  return { name: `@agent-harness/${name}`, type: 'module', dependencies }
}

describe('架构依赖规则', () => {
  it('kernel 不得依赖其他 workspace package', () => {
    const failures = verifyArchitecture([
      ['kernel', manifest('kernel', { '@agent-harness/core': 'workspace:*' })],
      ['core', manifest('core', { '@agent-harness/kernel': 'workspace:*' })],
    ])
    expect(failures).toContain('kernel: forbidden workspace dependency on core')
  })

  it('core 只能依赖 kernel', () => {
    const failures = verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['tools/tool-runtime', manifest('tool-runtime', { '@agent-harness/kernel': 'workspace:*' })],
      ['core', manifest('core', { '@agent-harness/tool-runtime': 'workspace:*' })],
    ])
    expect(failures).toContain('core: forbidden workspace dependency on tools/tool-runtime')
  })

  it('协议无关能力实现只能依赖 kernel', () => {
    const failures = verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['core', manifest('core', { '@agent-harness/kernel': 'workspace:*' })],
      ['session/session-memory', manifest('session-memory', {
        '@agent-harness/core': 'workspace:*',
      })],
      ['tools/tool-runtime', manifest('tool-runtime', {
        '@agent-harness/session-memory': 'workspace:*',
      })],
    ])
    expect(failures).toContain('session/session-memory: forbidden workspace dependency on core')
    expect(failures).toContain(
      'tools/tool-runtime: forbidden workspace dependency on session/session-memory',
    )
  })

  it('协议无关 package 不得声明第三方生产依赖', () => {
    const core = manifest('core', { '@agent-harness/kernel': 'workspace:*', lodash: '^4.0.0' })
    const memory = manifest('session-memory', { '@agent-harness/kernel': 'workspace:*' })
    memory.optionalDependencies = { redis: '^5.0.0' }
    const tools = manifest('tool-runtime', { '@agent-harness/kernel': 'workspace:*' })
    tools.peerDependencies = { zod: '^4.0.0' }
    expect(verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['core', core],
      ['session/session-memory', memory],
      ['tools/tool-runtime', tools],
    ])).toEqual(expect.arrayContaining([
      'core: protocol-neutral package cannot depend on lodash',
      'session/session-memory: protocol-neutral package cannot depend on redis',
      'tools/tool-runtime: protocol-neutral package cannot depend on zod',
    ]))
  })

  it('adapter 只能依赖 kernel', () => {
    expect(verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['llm/gateway', manifest('gateway', { '@agent-harness/kernel': 'workspace:*' })],
    ])).toEqual([])
    expect(verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['tools/tool-runtime', manifest('tool-runtime', { '@agent-harness/kernel': 'workspace:*' })],
      ['tools/mcp', manifest('mcp', { '@agent-harness/tool-runtime': 'workspace:*' })],
    ])).toContain('tools/mcp: forbidden workspace dependency on tools/tool-runtime')
  })

  it('runtime 可以组合 kernel 与 core 实现', () => {
    const failures = verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['core', manifest('core', { '@agent-harness/kernel': 'workspace:*' })],
      ['session/session-lifecycle', manifest('session-lifecycle', { '@agent-harness/kernel': 'workspace:*' })],
      ['session/session-memory', manifest('session-memory', { '@agent-harness/kernel': 'workspace:*' })],
      ['tools/tool-runtime', manifest('tool-runtime', { '@agent-harness/kernel': 'workspace:*' })],
      ['runtime', manifest('runtime', {
        '@agent-harness/kernel': 'workspace:*', '@agent-harness/core': 'workspace:*',
        '@agent-harness/session-lifecycle': 'workspace:*', '@agent-harness/tool-runtime': 'workspace:*',
      })],
    ])
    expect(failures).toEqual([])
  })

  it('拒绝未分类 package，防止新增目录绕过规则', () => {
    expect(verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['misc/unknown', manifest('unknown', { '@agent-harness/kernel': 'workspace:*' })],
    ])).toContain('misc/unknown: package path is not classified')
  })

  it('拒绝不存在的 workspace 依赖', () => {
    expect(verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['core', manifest('core', { '@agent-harness/missing': 'workspace:*' })],
    ])).toContain('core: unknown workspace dependency @agent-harness/missing')
  })

  it('不能通过 optionalDependency 绕过生产依赖规则', () => {
    const kernel = manifest('kernel')
    kernel.optionalDependencies = { '@agent-harness/core': 'workspace:*' }
    expect(verifyArchitecture([
      ['kernel', kernel],
      ['core', manifest('core', { '@agent-harness/kernel': 'workspace:*' })],
    ])).toContain('kernel: forbidden workspace dependency on core')
  })

  it('不能通过 devDependency 从 adapter 生产源码导入 core', () => {
    expect(verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['tools/tool-runtime', manifest('tool-runtime', { '@agent-harness/kernel': 'workspace:*' })],
      ['tools/mcp', manifest('mcp', { '@agent-harness/kernel': 'workspace:*' })],
    ], [
      ['tools/mcp', 'src/index.ts', "import { ToolRegistry } from '@agent-harness/tool-runtime'"],
    ])).toContain('tools/mcp/src/index.ts: forbidden workspace import tools/tool-runtime')
  })

  it('检查无插值模板形式的动态导入', () => {
    expect(verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['tools/tool-runtime', manifest('tool-runtime', { '@agent-harness/kernel': 'workspace:*' })],
      ['tools/mcp', manifest('mcp', { '@agent-harness/kernel': 'workspace:*' })],
    ], [
      ['tools/mcp', 'src/index.ts', 'await import(`@agent-harness/tool-runtime`)'],
    ])).toContain('tools/mcp/src/index.ts: forbidden workspace import tools/tool-runtime')
  })

  it('忽略注释和普通字符串中的 import 文本', () => {
    expect(verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['tools/tool-runtime', manifest('tool-runtime', { '@agent-harness/kernel': 'workspace:*' })],
      ['tools/mcp', manifest('mcp', { '@agent-harness/kernel': 'workspace:*' })],
    ], [
      ['tools/mcp', 'src/index.ts', '// import { ToolRegistry } from "@agent-harness/tool-runtime"\nconst example = "import(\\\"@agent-harness/tool-runtime\\\")"'],
    ])).toEqual([])
  })

  it('拒绝生产源码以相对路径跨越 package 边界', () => {
    expect(verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['core', manifest('core', { '@agent-harness/kernel': 'workspace:*' })],
    ], [
      ['core', 'src/index.ts', "export * from '../../kernel/src/index.js'"],
    ])).toContain('core/src/index.ts: relative import escapes package boundary: ../../kernel/src/index.js')
  })

  it('协议无关生产源码不得导入 I/O 或第三方模块', () => {
    const manifests = [
      ['kernel', manifest('kernel')],
      ['core', manifest('core', { '@agent-harness/kernel': 'workspace:*' })],
      ['session/session-memory', manifest('session-memory', {
        '@agent-harness/kernel': 'workspace:*',
      })],
    ]
    expect(verifyArchitecture(manifests, [
      ['kernel', 'src/index.ts', "import { readFile } from 'node:fs/promises'"],
    ])).toContain('kernel/src/index.ts: protocol-neutral source cannot import node:fs/promises')
    expect(verifyArchitecture(manifests, [
      ['core', 'src/index.ts', "import client from 'provider-sdk'"],
      ['session/session-memory', 'src/index.ts', "import { open } from 'node:fs/promises'"],
    ])).toEqual([
      'core/src/index.ts: protocol-neutral source cannot import provider-sdk',
      'session/session-memory/src/index.ts: protocol-neutral source cannot import node:fs/promises',
    ])
  })
})
