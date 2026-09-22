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
    ])
    expect(failures).toEqual([])
  })
})
