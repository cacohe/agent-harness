import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const METADATA_VERSION = 1;

/** 持久保存 Web 会话与授权工作目录的绑定关系。 */
export class SessionWorkspaceStore {
  readonly #directory: string;

  constructor(sessionRoot: string) {
    if (!isAbsolute(sessionRoot)) throw new TypeError('sessionRoot 必须是绝对路径');
    this.#directory = resolve(sessionRoot, 'web-workspaces');
  }

  async create(sessionId: string, workspace: string): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    await writeFile(
      this.#path(sessionId),
      `${JSON.stringify({ version: METADATA_VERSION, workspace })}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  }

  async read(sessionId: string): Promise<string | undefined> {
    let text: string;
    try {
      text = await readFile(this.#path(sessionId), 'utf8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('Web 会话工作目录元数据损坏');
    }
    if (
      value === null ||
      typeof value !== 'object' ||
      Reflect.get(value, 'version') !== METADATA_VERSION ||
      typeof Reflect.get(value, 'workspace') !== 'string'
    ) {
      throw new Error('Web 会话工作目录元数据损坏');
    }
    return Reflect.get(value, 'workspace') as string;
  }

  #path(sessionId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      throw new TypeError('无效会话 ID');
    }
    return join(this.#directory, `${sessionId}.json`);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
