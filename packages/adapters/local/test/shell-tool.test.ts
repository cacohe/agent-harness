import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createShellTool, type ShellSpawn } from '../src/shell-tool.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-shell-'));
  roots.push(root);
  return root;
}

function fakeSpawn(handlers: {
  readonly stdout?: Buffer;
  readonly stderr?: Buffer;
  readonly exitCode?: number;
  readonly delayMs?: number;
  readonly onKill?: (signal: NodeJS.Signals | number | undefined) => void;
  /** true 时 kill 不触发 close，用于验证强制结算。 */
  readonly hangAfterKill?: boolean;
}): ShellSpawn {
  return () => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    child.stdout = stdout as ChildProcess['stdout'];
    child.stderr = stderr as ChildProcess['stderr'];
    child.kill = ((signal?: NodeJS.Signals | number) => {
      handlers.onKill?.(signal);
      if (!handlers.hangAfterKill) {
        queueMicrotask(() => child.emit('close', null));
      }
      return true;
    }) as ChildProcess['kill'];
    queueMicrotask(() => {
      if (handlers.stdout !== undefined) {
        stdout.emit('data', handlers.stdout);
      }
      if (handlers.stderr !== undefined) {
        stderr.emit('data', handlers.stderr);
      }
    });
    if (!handlers.hangAfterKill) {
      setTimeout(() => {
        child.emit('close', handlers.exitCode ?? 0);
      }, handlers.delayMs ?? 5);
    }
    return child;
  };
}

describe('createShellTool', () => {
  it('拒绝相对 cwd', () => {
    expect(() =>
      createShellTool({
        cwd: 'relative',
        timeoutMs: 1000,
        maxOutputBytes: 100,
      }),
    ).toThrow(/绝对路径/);
  });

  it('执行命令并返回截断后的输出', async () => {
    const cwd = await workspace();
    const tool = createShellTool({
      cwd,
      timeoutMs: 1000,
      maxOutputBytes: 4,
      spawn: fakeSpawn({ stdout: Buffer.from('hello-world'), exitCode: 0 }),
    });
    const output = await tool.execute(
      { command: 'echo hi' },
      { signal: new AbortController().signal },
    );
    expect(output).toMatchObject({
      exitCode: 0,
      stdout: 'hell',
      stderr: '',
      truncated: true,
      timedOut: false,
      cancelled: false,
    });
  });

  it('取消时终止子进程并抛出', async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const tool = createShellTool({
      cwd,
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      spawn: fakeSpawn({
        delayMs: 200,
        onKill: (signal) => {
          signals.push(signal);
        },
      }),
    });
    const running = tool.execute({ command: 'sleep' }, { signal: controller.signal });
    controller.abort(new DOMException('stop', 'AbortError'));
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals).toContain('SIGTERM');
  });

  it('超时后若子进程不 close 仍强制结束等待', async () => {
    const cwd = await workspace();
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const tool = createShellTool({
      cwd,
      timeoutMs: 20,
      killGraceMs: 30,
      maxOutputBytes: 1024,
      spawn: fakeSpawn({
        hangAfterKill: true,
        onKill: (signal) => {
          signals.push(signal);
        },
      }),
    });
    const output = await tool.execute(
      { command: 'hang' },
      { signal: new AbortController().signal },
    );
    expect(signals).toContain('SIGTERM');
    expect(signals).toContain('SIGKILL');
    expect(output).toMatchObject({
      exitCode: null,
      timedOut: true,
      cancelled: false,
    });
  });

  it('真实子进程在 cwd 下执行', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'marker.txt'), 'ok\n', 'utf8');
    const tool = createShellTool({
      cwd,
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      platform: process.platform,
    });
    const command = process.platform === 'win32' ? 'type marker.txt' : 'cat marker.txt';
    const output = await tool.execute({ command }, { signal: new AbortController().signal });
    expect(output).toMatchObject({
      exitCode: 0,
      truncated: false,
      timedOut: false,
      cancelled: false,
    });
    expect(String(Reflect.get(output as object, 'stdout'))).toContain('ok');
  });
});
