import { describe, expect, it } from 'vitest';
import { pickWorkspaceDirectory } from '../src/workspace-picker.ts';

describe('pickWorkspaceDirectory', () => {
  it('Windows 使用系统文件夹对话框并返回选中路径', async () => {
    const picked = await pickWorkspaceDirectory({
      platform: 'win32',
      run: async (file, args) => {
        expect(file).toBe('powershell.exe');
        expect(args).toContain('-STA');
        expect(args.at(-1)).toContain('FolderBrowserDialog');
        return { exitCode: 0, stdout: 'F:\\work\n', stderr: '' };
      },
    });
    expect(picked).toBe('F:\\work');
  });

  it('用户取消对话框时不返回路径', async () => {
    await expect(
      pickWorkspaceDirectory({
        platform: 'win32',
        run: async () => ({ exitCode: 2, stdout: '', stderr: '' }),
      }),
    ).resolves.toBeUndefined();
  });
});
