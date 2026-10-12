import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveInsideWorkspace, resolveWorkspaceDirectory } from '../src/workspace.js';
import { createWorkspaceTools } from '../src/workspace-tools.js';

describe('workspace', () => {
  it('拒绝相对路径和目录外访问，并允许目录内读写', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-workspace-'));
    await expect(resolveWorkspaceDirectory('relative')).rejects.toThrow('绝对路径');
    const workspace = await resolveWorkspaceDirectory(root);
    await expect(resolveInsideWorkspace(workspace, '../secret')).rejects.toThrow('工作目录内');
    const tool = createWorkspaceTools(workspace).find((item) => item.name === 'write_file');
    const reader = createWorkspaceTools(workspace).find((item) => item.name === 'read_file');
    const listed = createWorkspaceTools(workspace).find((item) => item.name === 'list_dir');
    if (tool === undefined || reader === undefined || listed === undefined)
      throw new Error('工具缺失');
    expect(createWorkspaceTools(workspace).some((item) => item.name === 'run_shell')).toBe(false);
    const signal = new AbortController().signal;
    await tool.execute({ path: 'notes/a.txt', content: '你好' }, { signal });
    const read = await reader.execute({ path: 'notes/a.txt' }, { signal });
    expect(read).toMatchObject({ path: 'notes/a.txt', content: '你好' });
    const listing = await listed.execute({}, { signal });
    expect(listing).toMatchObject({ truncated: false });
    await expect(
      reader.execute({ path: join(root, '..', 'outside.txt') }, { signal }),
    ).rejects.toThrow('工作目录内');
    await writeFile(join(root, '..notes'), '合法文件名', 'utf8');
    await expect(reader.execute({ path: '..notes' }, { signal })).resolves.toMatchObject({
      content: '合法文件名',
    });
  });
});
