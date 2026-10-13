import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemSkillCatalog } from '../src/index.ts';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'skills-'));
  roots.push(path);
  return path;
}

async function skill(rootPath: string, id: string, text: string): Promise<void> {
  const path = join(rootPath, id);
  await mkdir(path);
  await writeFile(join(path, 'SKILL.md'), text);
}

describe('FilesystemSkillCatalog', () => {
  it('只列出摘要，并按 ID 读取正文', async () => {
    const path = await root();
    await skill(path, 'review', '---\ndescription: 审查代码\nname: review\n---\n正文\n');
    const catalog = await FilesystemSkillCatalog.create(
      { root: path, enabled: ['review'] },
      new AbortController().signal,
    );
    expect(catalog.listEnabled()).toEqual([
      { id: 'review', name: 'review', description: '审查代码' },
    ]);
    await expect(catalog.read('review', new AbortController().signal)).resolves.toBe('正文\n');
    await expect(catalog.read('missing', new AbortController().signal)).rejects.toThrow('未启用');
  });
  it('拒绝重复 ID、未知 frontmatter 与超限文件', async () => {
    const path = await root();
    await skill(path, 'bad', '---\nname: bad\ndescription: bad\nextra: x\n---\nbody');
    await expect(
      FilesystemSkillCatalog.create({ root: path, enabled: ['bad'] }, new AbortController().signal),
    ).rejects.toThrow('frontmatter');
    await skill(path, 'valid', '---\nname: valid\ndescription: valid\n---\nbody');
    await expect(
      FilesystemSkillCatalog.create(
        { root: path, enabled: ['valid', 'valid'] },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    const catalog = await FilesystemSkillCatalog.create(
      { root: path, enabled: ['valid'], maxSkillBytes: 8 },
      new AbortController().signal,
    );
    await expect(catalog.read('valid', new AbortController().signal)).rejects.toThrow('超过');
  });
  it('拒绝符号链接逃逸并响应取消', async () => {
    const path = await root();
    const outside = await root();
    await skill(outside, 'external', '---\nname: x\ndescription: x\n---\nbody');
    await symlink(join(outside, 'external'), join(path, 'linked'), 'dir');
    await expect(
      FilesystemSkillCatalog.create(
        { root: path, enabled: ['linked'] },
        new AbortController().signal,
      ),
    ).rejects.toThrow('逃逸');
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      FilesystemSkillCatalog.create({ root: path, enabled: [] }, controller.signal),
    ).rejects.toThrow('stop');
  });

  it('拒绝加载后被替换的 Skill 路径', async () => {
    const path = await root();
    const outside = await root();
    await skill(path, 'review', '---\nname: review\ndescription: 初始\n---\n正文');
    await skill(outside, 'external', '---\nname: external\ndescription: 外部\n---\n外部正文');
    const catalog = await FilesystemSkillCatalog.create(
      { root: path, enabled: ['review'] },
      new AbortController().signal,
    );
    await rm(join(path, 'review'), { recursive: true });
    await symlink(join(outside, 'external'), join(path, 'review'), 'dir');
    await expect(catalog.read('review', new AbortController().signal)).rejects.toThrow('逃逸');
  });

  it('初始化只读取 frontmatter，并在按需读取时校验正文编码', async () => {
    const path = await root();
    const skillPath = join(path, 'binary');
    await mkdir(skillPath);
    await writeFile(
      join(skillPath, 'SKILL.md'),
      Buffer.concat([
        Buffer.from('---\nname: binary\ndescription: 二进制正文\n---\n'),
        Buffer.from([0xff]),
      ]),
    );
    const catalog = await FilesystemSkillCatalog.create(
      { root: path, enabled: ['binary'] },
      new AbortController().signal,
    );
    expect(catalog.listEnabled()).toEqual([
      { id: 'binary', name: 'binary', description: '二进制正文' },
    ]);
    await expect(catalog.read('binary', new AbortController().signal)).rejects.toThrow('UTF-8');
  });

  it('响应根目录解析期间发生的取消', async () => {
    const path = await root();
    const controller = new AbortController();
    const creation = FilesystemSkillCatalog.create({ root: path, enabled: [] }, controller.signal);
    controller.abort(new Error('stop'));
    await expect(creation).rejects.toThrow('stop');
  });

  it('拒绝 FIFO，且不会等待 writer', async () => {
    const path = await root();
    const skillPath = join(path, 'pipe');
    await mkdir(skillPath);
    await execFileAsync('mkfifo', [join(skillPath, 'SKILL.md')]);
    await expect(
      FilesystemSkillCatalog.create(
        { root: path, enabled: ['pipe'] },
        new AbortController().signal,
      ),
    ).rejects.toThrow('普通文件');
  }, 500);
});
