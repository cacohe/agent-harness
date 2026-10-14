import { constants } from 'node:fs';
import { type FileHandle, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SkillCatalog, SkillDescriptor } from '@agent-harness/kernel';

const DEFAULT_MAX_SKILL_BYTES = 256 * 1024;
const MAX_FRONTMATTER_BYTES = 16 * 1024;
const READ_CHUNK_BYTES = 16 * 1024;
const SKILL_ID = /^[a-z0-9][a-z0-9-]*$/;

interface LoadedSkill {
  readonly descriptor: SkillDescriptor;
  readonly path: string;
}

interface SkillDocument {
  readonly metadata: {
    readonly name: string;
    readonly description: string;
  };
  readonly body: string;
}

export class FilesystemSkillError extends Error {
  override readonly name = 'FilesystemSkillError';
}

/** 从受限根目录加载明确启用的 Skill；正文仅在 read 时读取。 */
export class FilesystemSkillCatalog implements SkillCatalog {
  readonly #root: string;
  readonly #skills: ReadonlyMap<string, LoadedSkill>;
  readonly #maxSkillBytes: number;

  private constructor(
    root: string,
    skills: ReadonlyMap<string, LoadedSkill>,
    maxSkillBytes: number,
  ) {
    this.#root = root;
    this.#skills = skills;
    this.#maxSkillBytes = maxSkillBytes;
  }

  static async create(
    options: {
      readonly root: string;
      readonly enabled: readonly string[];
      readonly maxSkillBytes?: number;
    },
    signal: AbortSignal,
  ): Promise<FilesystemSkillCatalog> {
    signal.throwIfAborted();
    const maxSkillBytes = positiveInteger(
      options.maxSkillBytes ?? DEFAULT_MAX_SKILL_BYTES,
      'maxSkillBytes',
    );
    if (!Array.isArray(options.enabled)) {
      throw new TypeError('enabled 必须是数组');
    }
    const root = await realpath(options.root);
    signal.throwIfAborted();
    const skills = new Map<string, LoadedSkill>();
    for (const id of options.enabled) {
      signal.throwIfAborted();
      if (typeof id !== 'string' || !SKILL_ID.test(id) || skills.has(id)) {
        throw new TypeError('Skill 标识符无效或重复');
      }
      const loaded = await withValidatedSkill(root, id, signal, async (file, path) => ({
        descriptor: Object.freeze({ id, ...(await readSkillMetadata(file, signal)) }),
        path,
      }));
      signal.throwIfAborted();
      skills.set(id, Object.freeze(loaded));
    }
    return new FilesystemSkillCatalog(root, skills, maxSkillBytes);
  }

  listEnabled(): readonly SkillDescriptor[] {
    return Object.freeze([...this.#skills.values()].map((skill) => skill.descriptor));
  }

  async read(skillId: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const skill = this.#skills.get(skillId);
    if (skill === undefined) {
      throw new FilesystemSkillError(`Skill 未启用：${skillId}`);
    }
    return withValidatedSkill(this.#root, skillId, signal, async (file, path) => {
      if (path !== skill.path) {
        throw new FilesystemSkillError(`Skill ${skillId} 路径在加载后发生变化`);
      }
      return (await readSkillDocument(file, this.#maxSkillBytes, signal)).body;
    });
  }
}

async function withValidatedSkill<T>(
  root: string,
  id: string,
  signal: AbortSignal,
  use: (file: FileHandle, path: string) => Promise<T>,
): Promise<T> {
  const configuredPath = resolve(root, id, 'SKILL.md');
  const file = await open(
    configuredPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    signal.throwIfAborted();
    const fileStat = await file.stat();
    signal.throwIfAborted();
    if (!fileStat.isFile()) {
      throw new FilesystemSkillError(`Skill ${id} 必须是普通文件`);
    }
    // 校验已打开对象而非先校验路径，避免祖先目录替换造成的检查与使用竞态。
    const actualPath = await realpath(`/proc/self/fd/${file.fd}`);
    signal.throwIfAborted();
    if (!isWithin(root, actualPath)) {
      throw new FilesystemSkillError(`Skill ${id} 路径逃逸根目录`);
    }
    return await use(file, actualPath);
  } finally {
    await file.close();
  }
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

async function readSkillMetadata(
  file: FileHandle,
  signal: AbortSignal,
): Promise<SkillDocument['metadata']> {
  const bytes = await readFrontmatter(file, signal);
  return parseMetadata(decodeUtf8(bytes));
}

async function readFrontmatter(file: FileHandle, signal: AbortSignal): Promise<Uint8Array> {
  let bytes = Buffer.alloc(0);
  while (bytes.byteLength < MAX_FRONTMATTER_BYTES) {
    const chunk = Buffer.alloc(
      Math.min(READ_CHUNK_BYTES, MAX_FRONTMATTER_BYTES - bytes.byteLength),
    );
    const result = await file.read(chunk, 0, chunk.byteLength, bytes.byteLength);
    signal.throwIfAborted();
    if (result.bytesRead === 0) {
      break;
    }
    bytes = Buffer.concat([bytes, chunk.subarray(0, result.bytesRead)]);
    const end = frontmatterEnd(bytes);
    if (end !== undefined) {
      return bytes.subarray(0, end);
    }
  }
  throw new FilesystemSkillError(`Skill frontmatter 未在 ${MAX_FRONTMATTER_BYTES} 字节内结束`);
}

function frontmatterEnd(bytes: Buffer): number | undefined {
  const lf = Buffer.from('\n---\n');
  const crlf = Buffer.from('\r\n---\r\n');
  const lfIndex = bytes.indexOf(lf, 3);
  const crlfIndex = bytes.indexOf(crlf, 3);
  const candidates = [
    ...(lfIndex < 0 ? [] : [lfIndex + lf.byteLength]),
    ...(crlfIndex < 0 ? [] : [crlfIndex + crlf.byteLength]),
  ];
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

async function readSkillDocument(
  file: FileHandle,
  maxBytes: number,
  signal: AbortSignal,
): Promise<SkillDocument> {
  const bytes = await readBounded(file, maxBytes, signal);
  return parseSkill(decodeUtf8(bytes));
}

async function readBounded(
  file: FileHandle,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset <= maxBytes) {
    const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - offset));
    const result = await file.read(chunk, 0, chunk.byteLength, offset);
    signal.throwIfAborted();
    if (result.bytesRead === 0) {
      return Buffer.concat(chunks, offset);
    }
    chunks.push(chunk.subarray(0, result.bytesRead));
    offset += result.bytesRead;
  }
  throw new FilesystemSkillError(`Skill 文件超过 ${maxBytes} 字节`);
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new FilesystemSkillError('Skill 文件不是有效 UTF-8', { cause: error });
  }
}

function parseSkill(text: string): SkillDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new FilesystemSkillError('Skill 缺少 frontmatter');
  }
  return {
    metadata: parseMetadata(match[0].slice(0, match[0].length - match[2].length)),
    body: match[2],
  };
}

function parseMetadata(frontmatter: string): SkillDocument['metadata'] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n$/.exec(frontmatter);
  if (match?.[1] === undefined) {
    throw new FilesystemSkillError('Skill 缺少 frontmatter');
  }
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(name|description):\s*(.+)$/.exec(line);
    if (field?.[1] === undefined || field[2] === undefined || fields.has(field[1])) {
      throw new FilesystemSkillError('Skill frontmatter 只能包含唯一的 name 与 description');
    }
    fields.set(field[1], field[2]);
  }
  const name = fields.get('name');
  const description = fields.get('description');
  if (fields.size !== 2 || name === undefined || description === undefined) {
    throw new FilesystemSkillError('Skill frontmatter 必须包含 name 与 description');
  }
  return { name, description };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} 必须是正整数`);
  }
  return value;
}
