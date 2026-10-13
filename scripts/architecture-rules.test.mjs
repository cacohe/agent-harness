import { describe, expect, it } from 'vitest';
import { verifyArchitecture } from './architecture-rules.mjs';

const manifest = (path, name, dependencies = {}) => [path, { name, type: 'module', dependencies }];

const workspace = [
  manifest('kernel', '@agent-harness/kernel'),
  manifest('core', '@agent-harness/core', { '@agent-harness/kernel': 'workspace:*' }),
  manifest('adapters', '@agent-harness/adapters', { '@agent-harness/kernel': 'workspace:*' }),
  manifest('runtime', '@agent-harness/runtime', {
    '@agent-harness/kernel': 'workspace:*',
    '@agent-harness/core': 'workspace:*',
    '@agent-harness/adapters': 'workspace:*',
  }),
  manifest('test-support', '@agent-harness/test-support', {
    '@agent-harness/kernel': 'workspace:*',
    '@agent-harness/core': 'workspace:*',
    '@agent-harness/adapters': 'workspace:*',
  }),
  manifest('hosts/cli', '@agent-harness/cli', {
    '@agent-harness/kernel': 'workspace:*',
    '@agent-harness/core': 'workspace:*',
    '@agent-harness/adapters': 'workspace:*',
    '@agent-harness/runtime': 'workspace:*',
  }),
  manifest('hosts/web', '@agent-harness/web', {
    '@agent-harness/kernel': 'workspace:*',
    '@agent-harness/adapters': 'workspace:*',
    '@agent-harness/runtime': 'workspace:*',
  }),
];

describe('架构依赖规则', () => {
  it('接受七 package 的依赖图', () => {
    expect(verifyArchitecture(workspace)).toEqual([]);
  });

  it('禁止 kernel、core 和 adapters 向外依赖', () => {
    expect(
      verifyArchitecture([...workspace, manifest('unclassified', '@agent-harness/unclassified')]),
    ).toContain('unclassified: package path is not classified');
    expect(
      verifyArchitecture([
        manifest('kernel', '@agent-harness/kernel', { '@agent-harness/adapters': 'workspace:*' }),
        manifest('adapters', '@agent-harness/adapters'),
      ]),
    ).toContain('kernel: forbidden workspace dependency on adapters');
  });

  it('允许 Host 导入 adapters 子路径并拒绝 core 这样做', () => {
    expect(
      verifyArchitecture(workspace, [
        ['hosts/cli', 'src/index.ts', "import '@agent-harness/adapters/local';"],
        ['core', 'src/agent.ts', "import '@agent-harness/adapters/local';"],
      ]),
    ).toContain('core/src/agent.ts: forbidden workspace import adapters');
  });
});
