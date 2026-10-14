import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** 工作目录路径无效或试图逃逸。 */
export class WorkspaceError extends Error {
  override readonly name = 'WorkspaceError';
}

/** 校验并规范化用户选择的工作目录。 */
export async function resolveWorkspaceDirectory(path: string): Promise<string> {
  const trimmed = path.trim();
  if (!isAbsolute(trimmed)) {
    throw new WorkspaceError('工作目录必须是绝对路径');
  }
  try {
    const stats = await lstat(trimmed);
    if (!stats.isDirectory()) {
      throw new WorkspaceError('工作目录必须是已存在的目录');
    }
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }
    throw new WorkspaceError('工作目录不存在');
  }
  return await realpath(trimmed);
}

/** 把相对或绝对路径解析到工作目录内，拒绝逃逸。 */
export async function resolveInsideWorkspace(
  workspace: string,
  inputPath: string,
): Promise<string> {
  if (inputPath.trim().length === 0) {
    throw new WorkspaceError('路径不能为空');
  }
  const target = isAbsolute(inputPath) ? resolve(inputPath) : resolve(workspace, inputPath);
  assertInside(workspace, target);
  try {
    const real = await realpath(target);
    assertInside(workspace, real);
    return real;
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    const missing: string[] = [basename(target)];
    let current = dirname(target);
    while (true) {
      try {
        const realParent = await realpath(current);
        assertInside(workspace, realParent);
        return resolve(realParent, ...missing.toReversed());
      } catch (inner) {
        if (!isNotFound(inner)) {
          throw inner;
        }
        if (current === dirname(current)) {
          throw error;
        }
        missing.push(basename(current));
        current = dirname(current);
      }
    }
  }
}

function assertInside(workspace: string, target: string): void {
  const rel = relative(workspace, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new WorkspaceError('路径必须位于工作目录内');
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
