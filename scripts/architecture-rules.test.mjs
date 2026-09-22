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
})
