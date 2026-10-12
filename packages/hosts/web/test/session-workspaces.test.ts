import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionWorkspaceStore } from '../src/session-workspaces.ts';

describe('SessionWorkspaceStore', () => {
  it('持久保存会话与工作目录的绑定且不允许覆盖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-session-workspaces-'));
    const store = new SessionWorkspaceStore(root);
    await store.create('session-1', 'F:\\work');
    await expect(store.read('session-1')).resolves.toBe('F:\\work');
    await expect(store.create('session-1', 'F:\\other')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await expect(store.read('missing')).resolves.toBeUndefined();
  });

  it('拒绝损坏的元数据和无效会话 ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-session-workspaces-'));
    const store = new SessionWorkspaceStore(root);
    await expect(store.read('../escape')).rejects.toThrow('无效会话 ID');
    await store.create('broken', 'F:\\work');
    await writeFile(join(root, 'web-workspaces', 'broken.json'), '{}\n', 'utf8');
    await expect(store.read('broken')).rejects.toThrow('元数据损坏');
  });
});
