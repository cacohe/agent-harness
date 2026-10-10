import { describe, expect, it } from 'vitest'
import { verifyArchitecture } from './architecture-rules.mjs'

function manifest(name, dependencies = {}) {
  return { name: `@agent-harness/${name}`, type: 'module', dependencies }
}

describe('架构依赖规则', () => {
  it('kernel 不得依赖其他 workspace package', () => {
    const failures = verifyArchitecture([
      ['kernel', manifest('kernel', { '@agent-harness/agent': 'workspace:*' })],
      ['core/agent', manifest('agent', { '@agent-harness/kernel': 'workspace:*' })],
    ])
    expect(failures).toContain('kernel: forbidden workspace dependency on core/agent')
  })

  it('core 只能依赖 kernel', () => {
    const failures = verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['core/tools', manifest('tools', { '@agent-harness/kernel': 'workspace:*' })],
      ['core/agent', manifest('agent', { '@agent-harness/tools': 'workspace:*' })],
    ])
    expect(failures).toContain('core/agent: forbidden workspace dependency on core/tools')
  })

  it('adapter 只能依赖 kernel', () => {
    expect(verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['llm/gateway', manifest('gateway', { '@agent-harness/kernel': 'workspace:*' })],
    ])).toEqual([])
    expect(verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['core/tools', manifest('tools', { '@agent-harness/kernel': 'workspace:*' })],
      ['tools/mcp', manifest('mcp', { '@agent-harness/tools': 'workspace:*' })],
    ])).toContain('tools/mcp: forbidden workspace dependency on core/tools')
  })

  it('runtime 可以组合 kernel 与 core 实现', () => {
    const failures = verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['core/agent', manifest('agent', { '@agent-harness/kernel': 'workspace:*' })],
      ['core/session', manifest('session', { '@agent-harness/kernel': 'workspace:*' })],
      ['core/tools', manifest('tools', { '@agent-harness/kernel': 'workspace:*' })],
      ['runtime', manifest('runtime', {
        '@agent-harness/kernel': 'workspace:*', '@agent-harness/agent': 'workspace:*',
        '@agent-harness/session': 'workspace:*', '@agent-harness/tools': 'workspace:*',
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
      ['core/agent', manifest('agent', { '@agent-harness/missing': 'workspace:*' })],
    ])).toContain('core/agent: unknown workspace dependency @agent-harness/missing')
  })

  it('不能通过 optionalDependency 绕过生产依赖规则', () => {
    const kernel = manifest('kernel')
    kernel.optionalDependencies = { '@agent-harness/agent': 'workspace:*' }
    expect(verifyArchitecture([
      ['kernel', kernel],
      ['core/agent', manifest('agent', { '@agent-harness/kernel': 'workspace:*' })],
    ])).toContain('kernel: forbidden workspace dependency on core/agent')
  })

  it('不能通过 devDependency 从 adapter 生产源码导入 core', () => {
    expect(verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['core/tools', manifest('tools', { '@agent-harness/kernel': 'workspace:*' })],
      ['tools/mcp', manifest('mcp', { '@agent-harness/kernel': 'workspace:*' })],
    ], [
      ['tools/mcp', 'src/index.ts', "import { ToolRegistry } from '@agent-harness/tools'"],
    ])).toContain('tools/mcp/src/index.ts: forbidden workspace import core/tools')
  })

  it('检查无插值模板形式的动态导入', () => {
    expect(verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['core/tools', manifest('tools', { '@agent-harness/kernel': 'workspace:*' })],
      ['tools/mcp', manifest('mcp', { '@agent-harness/kernel': 'workspace:*' })],
    ], [
      ['tools/mcp', 'src/index.ts', 'await import(`@agent-harness/tools`)'],
    ])).toContain('tools/mcp/src/index.ts: forbidden workspace import core/tools')
  })

  it('忽略注释和普通字符串中的 import 文本', () => {
    expect(verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['core/tools', manifest('tools', { '@agent-harness/kernel': 'workspace:*' })],
      ['tools/mcp', manifest('mcp', { '@agent-harness/kernel': 'workspace:*' })],
    ], [
      ['tools/mcp', 'src/index.ts', '// import { ToolRegistry } from "@agent-harness/tools"\nconst example = "import(\\\"@agent-harness/tools\\\")"'],
    ])).toEqual([])
  })

  it('拒绝生产源码以相对路径跨越 package 边界', () => {
    expect(verifyArchitecture([
      ['kernel', manifest('kernel')],
      ['core/agent', manifest('agent', { '@agent-harness/kernel': 'workspace:*' })],
    ], [
      ['core/agent', 'src/index.ts', "export * from '../../kernel/src/index.js'"],
    ])).toContain('core/agent/src/index.ts: relative import escapes package boundary: ../../kernel/src/index.js')
  })

  it('Kernel 和 Core 生产源码不得导入 I/O 或第三方模块', () => {
    expect(verifyArchitecture([
      ['kernel', manifest('kernel')],
    ], [
      ['kernel', 'src/index.ts', "import { readFile } from 'node:fs/promises'"],
    ])).toContain('kernel/src/index.ts: protocol-neutral source cannot import node:fs/promises')
  })
})
