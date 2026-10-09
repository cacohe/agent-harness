import { describe, expect, it } from 'vitest'
import { verifyArchitecture } from './architecture-rules.mjs'

function manifest(name, dependencies = {}) {
  return { name: `@agent-harness/${name}`, type: 'module', dependencies }
}

describe('架构依赖规则', () => {
  it('拒绝 domain 对嵌套 host package 的依赖', () => {
    const failures = verifyArchitecture([
      ['domain', manifest('domain', { '@agent-harness/cli': 'workspace:*' })],
      ['hosts/cli', manifest('cli')],
    ])
    expect(failures).toContain('domain: forbidden dependency on cli')
  })

  it('拒绝 core capability 对能力域 adapter 的依赖', () => {
    const failures = verifyArchitecture([
      ['core/agent', manifest('agent', { '@agent-harness/openai-compatible': 'workspace:*' })],
      ['llm/openai-compatible', manifest('openai-compatible')],
    ])
    expect(failures).toContain('core/agent: core package must not depend on adapter openai-compatible')
  })

  it('允许 adapter 依赖同域 capability 路径', () => {
    const failures = verifyArchitecture([
      ['domain', manifest('domain')],
      ['llm/model', manifest('model', { '@agent-harness/domain': 'workspace:*' })],
      [
        'llm/openai-compatible',
        manifest('openai-compatible', {
          '@agent-harness/domain': 'workspace:*',
          '@agent-harness/model': 'workspace:*',
        }),
      ],
      [
        'llm/gateway',
        manifest('gateway', {
          '@agent-harness/domain': 'workspace:*',
          '@agent-harness/model': 'workspace:*',
        }),
      ],
    ])
    expect(failures).toEqual([])
  })

  it('限制 Platform 策略 adapter 只能依赖工具 capability 与 domain', () => {
    const allowed = verifyArchitecture([
      ['domain', manifest('domain')],
      ['core/tools', manifest('tools', { '@agent-harness/domain': 'workspace:*' })],
      [
        'tools/platform-policy',
        manifest('platform-policy', {
          '@agent-harness/domain': 'workspace:*',
          '@agent-harness/tools': 'workspace:*',
        }),
      ],
    ])
    expect(allowed).toEqual([])

    const forbidden = verifyArchitecture([
      ['domain', manifest('domain')],
      ['runtime', manifest('runtime')],
      [
        'tools/platform-policy',
        manifest('platform-policy', { '@agent-harness/runtime': 'workspace:*' }),
      ],
    ])
    expect(forbidden).toContain('tools/platform-policy: adapter has forbidden dependency on runtime')
  })

  it('允许 Platform HTTP client 依赖模型请求词汇但不依赖 Runtime', () => {
    const allowed = verifyArchitecture([
      ['llm/model', manifest('model')],
      ['platform/platform-http', manifest('platform-http', { '@agent-harness/model': 'workspace:*' })],
    ])
    expect(allowed).toEqual([])

    const forbidden = verifyArchitecture([
      ['runtime', manifest('runtime')],
      ['platform/platform-http', manifest('platform-http', { '@agent-harness/runtime': 'workspace:*' })],
    ])
    expect(forbidden).toContain('platform/platform-http: adapter has forbidden dependency on runtime')
  })

  it('限制文件系统 Skill adapter 只依赖 Agent capability', () => {
    const allowed = verifyArchitecture([
      ['core/agent', manifest('agent')],
      ['skills/skill-filesystem', manifest('skill-filesystem', { '@agent-harness/agent': 'workspace:*' })],
    ])
    expect(allowed).toEqual([])

    const forbidden = verifyArchitecture([
      ['runtime', manifest('runtime')],
      ['skills/skill-filesystem', manifest('skill-filesystem', { '@agent-harness/runtime': 'workspace:*' })],
    ])
    expect(forbidden).toContain('skills/skill-filesystem: adapter has forbidden dependency on runtime')
  })
})
