import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type CliSignals, closeCliResources, runCli } from '../src/index.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class Signals implements CliSignals {
  readonly listeners = new Map<string, () => void>();
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    this.listeners.set(signal, listener);
  }
  off(signal: 'SIGINT' | 'SIGTERM'): void {
    this.listeners.delete(signal);
  }
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'agent-cli-'));
  roots.push(value);
  return value;
}
function config(sessionRoot: string, shell?: Record<string, unknown>): string {
  return JSON.stringify({
    sessionRoot,
    maxSteps: 4,
    settlementTimeoutMs: 1000,
    model: {
      id: 'test',
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
    },
    ...(shell === undefined ? {} : { shell }),
  });
}
function platformConfig(sessionRoot: string): string {
  return JSON.stringify({
    sessionRoot,
    maxSteps: 4,
    settlementTimeoutMs: 1000,
    model: {
      id: 'platform-gateway',
      platformBaseUrl: 'https://platform.example/v1',
      modelId: 'approved-model',
      authorizationEnv: 'PLATFORM_AUTHORIZATION',
    },
  });
}
function sse(text: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: {"choices":[{"index":0,"delta":{"content":"${text}"}}]}\n\ndata: [DONE]\n\n`,
          ),
        );
        controller.close();
      },
    }),
  );
}
function ndjson(text: string): Response {
  return new Response(`${JSON.stringify({ type: 'text.delta', text })}\n`, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
  });
}
function toolCallSse(
  name = 'run_shell',
  args = '{"command":"echo hi"}',
  id = 'call-shell',
): Response {
  const payload = JSON.stringify({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: 'function',
              function: { name, arguments: args },
            },
          ],
        },
      },
    ],
  });
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\ndata: [DONE]\n\n`));
        controller.close();
      },
    }),
  );
}

describe('CLI Host', () => {
  it('显式组合 run，并把 stream 和结果写为 stdout JSONL', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    const code = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 's1', '--message', 'hello'],
      env: { TEST_KEY: 'secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () => config(sessionRoot),
      fetch: async () => sse('done'),
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(output.map((line) => JSON.parse(line))).toMatchObject([
      { type: 'stream', event: { type: 'text.delta', text: 'done' } },
      { type: 'result', sessionId: 's1', message: { content: 'done' } },
    ]);
  });

  it('run 接受调用方提供的稳定 message ID', async () => {
    const sessionRoot = await root();
    let modelCalls = 0;
    const first = await runCli({
      argv: [
        'run',
        '--config',
        '/config.json',
        '--session',
        'message-id',
        '--message',
        'hello',
        '--message-id',
        'message-1',
      ],
      env: { TEST_KEY: 'secret' },
      stdout: { write() {} },
      stderr: { write() {} },
      signals: new Signals(),
      readFile: async () => config(sessionRoot),
      fetch: async () => {
        modelCalls += 1;
        return sse('done');
      },
    });
    const output: string[] = [];
    const retry = await runCli({
      argv: [
        'resume',
        '--config',
        '/config.json',
        '--session',
        'message-id',
        '--message',
        'hello',
        '--message-id',
        'message-1',
      ],
      env: { TEST_KEY: 'secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write() {} },
      signals: new Signals(),
      readFile: async () => config(sessionRoot),
      fetch: async () => {
        modelCalls += 1;
        return sse('unexpected');
      },
    });
    expect(first).toBe(0);
    expect(retry).toBe(0);
    expect(modelCalls).toBe(1);
    expect(output.map((line) => JSON.parse(line))).toEqual([
      { type: 'submission', sessionId: 'message-id', status: 'completed' },
    ]);
  });

  it.skipIf(process.platform !== 'linux')('从文件系统 Skill catalog 只注入启用摘要', async () => {
    const sessionRoot = await root();
    const skillsRoot = await root();
    const skillRoot = join(skillsRoot, 'review');
    await mkdir(skillRoot);
    await writeFile(
      join(skillRoot, 'SKILL.md'),
      '---\nname: review\ndescription: 审查代码\n---\n不得自动注入的正文',
    );
    let request: Record<string, unknown> | undefined;
    const code = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'skills-1', '--message', 'hello'],
      env: { TEST_KEY: 'secret' },
      stdout: { write() {} },
      stderr: { write() {} },
      signals: new Signals(),
      readFile: async () =>
        JSON.stringify({
          ...JSON.parse(config(sessionRoot)),
          skills: { root: skillsRoot, enabled: ['review'] },
        }),
      fetch: async (_input, init) => {
        request = JSON.parse(String(init?.body));
        return sse('done');
      },
    });
    expect(code).toBe(0);
    const serialized = JSON.stringify(request);
    expect(serialized).toContain('当前启用 Skills');
    expect(serialized).toContain('id: review');
    expect(serialized).toContain('审查代码');
    expect(serialized).toContain('load_skill');
    expect(serialized).not.toContain('不得自动注入的正文');
  });

  it.skipIf(process.platform !== 'linux')(
    '通过 load_skill 工具按需读取正文并写入下一步模型请求',
    async () => {
      const sessionRoot = await root();
      const skillsRoot = await root();
      const skillRoot = join(skillsRoot, 'review');
      await mkdir(skillRoot);
      await writeFile(
        join(skillRoot, 'SKILL.md'),
        '---\nname: 代码审查\ndescription: 审查代码\n---\n按需加载的审查步骤',
      );
      const requests: Record<string, unknown>[] = [];
      const code = await runCli({
        argv: [
          'run',
          '--config',
          '/config.json',
          '--session',
          'skills-load',
          '--message',
          'review',
        ],
        env: { TEST_KEY: 'secret' },
        stdout: { write() {} },
        stderr: { write() {} },
        signals: new Signals(),
        readFile: async () =>
          JSON.stringify({
            ...JSON.parse(config(sessionRoot)),
            skills: { root: skillsRoot, enabled: ['review'] },
          }),
        fetch: async (_input, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return requests.length === 1
            ? toolCallSse('load_skill', '{"id":"review"}', 'call-skill')
            : sse('reviewed');
        },
      });
      expect(code).toBe(0);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1])).toContain('按需加载的审查步骤');
    },
  );

  it('组合 Platform Gateway 的已选模型，并且不泄露认证头', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    let request: Request | undefined;
    const code = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'platform-1', '--message', 'hello'],
      env: { PLATFORM_AUTHORIZATION: 'Bearer platform-secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () => platformConfig(sessionRoot),
      fetch: async (input, init) => {
        request = new Request(input, init);
        return ndjson('from-platform');
      },
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(request?.url).toBe('https://platform.example/v1/agent/model-calls');
    expect(request?.headers.get('authorization')).toBe('Bearer platform-secret');
    expect(await request?.json()).toMatchObject({
      modelId: 'approved-model',
      request: { messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(output.map((line) => JSON.parse(line))).toMatchObject([
      { type: 'stream', event: { type: 'text.delta', text: 'from-platform' } },
      { type: 'result', sessionId: 'platform-1', message: { content: 'from-platform' } },
    ]);
    expect(`${errors.join('')} ${output.join(' ')}`).not.toContain('platform-secret');
  });

  it('通过 Platform Memory Gateway 检索长期记忆并注入当前模型步骤', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    let memoryRequest: Request | undefined;
    let modelRequest: Record<string, unknown> | undefined;
    const code = await runCli({
      argv: [
        'run',
        '--config',
        '/config.json',
        '--session',
        'memory-1',
        '--message',
        '如何回答我？',
      ],
      env: { TEST_KEY: 'model-secret', MEMORY_AUTHORIZATION: 'Bearer memory-secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () =>
        JSON.stringify({
          ...JSON.parse(config(sessionRoot)),
          memory: {
            platformBaseUrl: 'https://memory.example/v1',
            authorizationEnv: 'MEMORY_AUTHORIZATION',
            memorySpaceId: 'personal-memory',
            limit: 4,
          },
        }),
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith('/agent/memory-searches')) {
          memoryRequest = request;
          return new Response(
            JSON.stringify([
              {
                id: 'chunk-match-1',
                content: '用户喜欢简洁回答',
                source: {
                  type: 'document',
                  documentId: 'document-1',
                  fileName: 'preferences.md',
                  chunkId: 'chunk-1',
                },
              },
            ]),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        modelRequest = JSON.parse(String(init?.body));
        return sse('明白');
      },
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(memoryRequest?.url).toBe('https://memory.example/v1/agent/memory-searches');
    expect(memoryRequest?.headers.get('authorization')).toBe('Bearer memory-secret');
    expect(memoryRequest?.headers.get('idempotency-key')).toBeTruthy();
    expect(await memoryRequest?.json()).toMatchObject({
      memorySpaceId: 'personal-memory',
      query: '如何回答我？',
      limit: 4,
    });
    expect(JSON.stringify(modelRequest)).toContain('相关长期记忆');
    expect(JSON.stringify(modelRequest)).toContain('用户喜欢简洁回答');
    expect(JSON.stringify(modelRequest)).toContain('preferences.md');
    expect(JSON.stringify(modelRequest)).toContain('chunk-1');
    expect(JSON.stringify(modelRequest)).not.toContain('remember_memory');
    expect(`${errors.join('')} ${output.join(' ')}`).not.toContain('memory-secret');
  });

  it('显式启用后通过 Platform Memory Gateway 保存长期记忆', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    const modelRequests: Record<string, unknown>[] = [];
    let writeRequest: Request | undefined;
    const code = await runCli({
      argv: [
        'run',
        '--config',
        '/config.json',
        '--session',
        'memory-write',
        '--message',
        '请记住我喜欢简洁回答',
      ],
      env: { TEST_KEY: 'model-secret', MEMORY_AUTHORIZATION: 'Bearer memory-secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () =>
        JSON.stringify({
          ...JSON.parse(config(sessionRoot)),
          memory: {
            platformBaseUrl: 'https://memory.example/v1',
            authorizationEnv: 'MEMORY_AUTHORIZATION',
            memorySpaceId: 'personal-memory',
            writeEnabled: true,
          },
        }),
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith('/agent/memory-searches')) {
          return new Response('[]', { headers: { 'content-type': 'application/json' } });
        }
        if (request.url.endsWith('/agent/memory-statements')) {
          writeRequest = request;
          return new Response('{"id":"preference-1"}', {
            headers: { 'content-type': 'application/json' },
          });
        }
        modelRequests.push(JSON.parse(String(init?.body)));
        return modelRequests.length === 1
          ? toolCallSse('remember_memory', '{"statement":"用户喜欢简洁回答"}', 'call-memory')
          : sse('已经记住');
      },
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(modelRequests).toHaveLength(2);
    expect(JSON.stringify(modelRequests[0])).toContain('remember_memory');
    expect(JSON.stringify(modelRequests[1])).toContain('preference-1');
    expect(writeRequest?.url).toBe('https://memory.example/v1/agent/memory-statements');
    expect(writeRequest?.headers.get('authorization')).toBe('Bearer memory-secret');
    expect(writeRequest?.headers.get('idempotency-key')).toBeTruthy();
    expect(await writeRequest?.json()).toMatchObject({
      memorySpaceId: 'personal-memory',
      statement: '用户喜欢简洁回答',
    });
    expect(`${errors.join('')} ${output.join(' ')}`).not.toContain('memory-secret');
  });

  it('通过独立 import 命令上传文件且不启动 Agent Runtime', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    let uploadRequest: Request | undefined;
    let observedRead:
      | { readonly path: string; readonly maxBytes: number; readonly signal: AbortSignal }
      | undefined;
    const code = await runCli({
      argv: [
        'import',
        '--config',
        '/config.json',
        '--file',
        '/documents/guide.txt',
        '--media-type',
        'text/plain',
      ],
      env: { MEMORY_AUTHORIZATION: 'Bearer memory-secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () =>
        JSON.stringify({
          ...JSON.parse(config(sessionRoot)),
          memory: {
            platformBaseUrl: 'https://memory.example/v1',
            authorizationEnv: 'MEMORY_AUTHORIZATION',
            memorySpaceId: 'personal-memory',
            maxDocumentBytes: 123,
          },
        }),
      readDocumentFile: async (path, maxBytes, signal) => {
        observedRead = { path, maxBytes, signal };
        return { fileName: 'guide.txt', bytes: new TextEncoder().encode('hello') };
      },
      fetch: async (input, init) => {
        uploadRequest = new Request(input, init);
        return new Response('{"documentId":"document-1","status":"queued"}', {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(observedRead).toMatchObject({ path: '/documents/guide.txt', maxBytes: 123 });
    expect(uploadRequest?.url).toBe('https://memory.example/v1/agent/document-imports');
    expect(uploadRequest?.headers.get('authorization')).toBe('Bearer memory-secret');
    expect(uploadRequest?.headers.get('content-type')).toBe('text/plain');
    expect(new TextDecoder().decode(await uploadRequest?.arrayBuffer())).toBe('hello');
    expect(output.map((line) => JSON.parse(line))).toEqual([
      {
        type: 'document.imported',
        documentId: 'document-1',
        status: 'queued',
      },
    ]);
    expect(`${errors.join('')} ${output.join(' ')}`).not.toContain('memory-secret');
  });

  it('import 要求 memory 配置和绝对文件路径', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    const relative = await runCli({
      argv: [
        'import',
        '--config',
        '/config.json',
        '--file',
        'guide.txt',
        '--media-type',
        'text/plain',
      ],
      env: { TEST_KEY: 'secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
    });
    const missingMemory = await runCli({
      argv: [
        'import',
        '--config',
        '/config.json',
        '--file',
        '/guide.txt',
        '--media-type',
        'text/plain',
      ],
      env: { TEST_KEY: 'secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () => config(sessionRoot),
    });
    expect(relative).toBe(1);
    expect(missingMemory).toBe(1);
    expect(errors.join('')).toContain('--file 必须是绝对路径');
    expect(errors.join('')).toContain('import 命令要求 memory 配置');
    expect(output.map((line) => JSON.parse(line))).toEqual([
      { type: 'error', code: 'failed' },
      { type: 'error', code: 'failed' },
    ]);
  });

  it('通过独立 document-status 命令查询索引状态且不启动 Agent Runtime', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    let statusRequest: Request | undefined;
    const code = await runCli({
      argv: ['document-status', '--config', '/config.json', '--document', 'document-1'],
      env: { MEMORY_AUTHORIZATION: 'Bearer memory-secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () =>
        JSON.stringify({
          ...JSON.parse(config(sessionRoot)),
          memory: {
            platformBaseUrl: 'https://memory.example/v1',
            authorizationEnv: 'MEMORY_AUTHORIZATION',
            memorySpaceId: 'personal-memory',
          },
        }),
      fetch: async (input, init) => {
        statusRequest = new Request(input, init);
        return new Response(
          JSON.stringify({
            documentId: 'document-1',
            status: 'failed',
            failureCode: 'DOCUMENT.PARSE_FAILED',
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(statusRequest?.url).toBe('https://memory.example/v1/agent/document-statuses');
    expect(statusRequest?.headers.get('authorization')).toBe('Bearer memory-secret');
    expect(statusRequest?.headers.get('idempotency-key')).toBeTruthy();
    expect(await statusRequest?.json()).toMatchObject({
      memorySpaceId: 'personal-memory',
      documentId: 'document-1',
    });
    expect(output.map((line) => JSON.parse(line))).toEqual([
      {
        type: 'document.status',
        documentId: 'document-1',
        status: 'failed',
        failureCode: 'DOCUMENT.PARSE_FAILED',
      },
    ]);
    expect(`${errors.join('')} ${output.join(' ')}`).not.toContain('memory-secret');
  });

  it('document-status 要求 memory 配置与非空文档 ID', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    const emptyId = await runCli({
      argv: ['document-status', '--config', '/config.json', '--document', ''],
      env: {},
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
    });
    const missingMemory = await runCli({
      argv: ['document-status', '--config', '/config.json', '--document', 'document-1'],
      env: { TEST_KEY: 'secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () => config(sessionRoot),
    });
    expect(emptyId).toBe(1);
    expect(missingMemory).toBe(1);
    expect(errors.join('')).toContain('--document 必须是非空字符串');
    expect(errors.join('')).toContain('document-status 命令要求 memory 配置');
    expect(output.map((line) => JSON.parse(line))).toEqual([
      { type: 'error', code: 'failed' },
      { type: 'error', code: 'failed' },
    ]);
  });

  it('通过独立 document-delete 命令提交删除且不启动 Agent Runtime', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    let deleteRequest: Request | undefined;
    let calls = 0;
    const code = await runCli({
      argv: ['document-delete', '--config', '/config.json', '--document', 'document-1'],
      env: { MEMORY_AUTHORIZATION: 'Bearer memory-secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () =>
        JSON.stringify({
          ...JSON.parse(config(sessionRoot)),
          memory: {
            platformBaseUrl: 'https://memory.example/v1',
            authorizationEnv: 'MEMORY_AUTHORIZATION',
            memorySpaceId: 'personal-memory',
          },
        }),
      fetch: async (input, init) => {
        calls += 1;
        deleteRequest = new Request(input, init);
        return new Response('{"documentId":"document-1","status":"deleting"}', {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(calls).toBe(1);
    expect(deleteRequest?.url).toBe('https://memory.example/v1/agent/document-deletions');
    expect(deleteRequest?.headers.get('authorization')).toBe('Bearer memory-secret');
    expect(deleteRequest?.headers.get('idempotency-key')).toBeTruthy();
    expect(await deleteRequest?.json()).toMatchObject({
      memorySpaceId: 'personal-memory',
      documentId: 'document-1',
    });
    expect(output.map((line) => JSON.parse(line))).toEqual([
      {
        type: 'document.deletion',
        documentId: 'document-1',
        status: 'deleting',
      },
    ]);
    expect(`${errors.join('')} ${output.join(' ')}`).not.toContain('memory-secret');
  });

  it('document-delete 要求 memory 配置与非空文档 ID', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    const emptyId = await runCli({
      argv: ['document-delete', '--config', '/config.json', '--document', ''],
      env: {},
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
    });
    const missingMemory = await runCli({
      argv: ['document-delete', '--config', '/config.json', '--document', 'document-1'],
      env: { TEST_KEY: 'secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () => config(sessionRoot),
    });
    expect(emptyId).toBe(1);
    expect(missingMemory).toBe(1);
    expect(errors.join('')).toContain('--document 必须是非空字符串');
    expect(errors.join('')).toContain('document-delete 命令要求 memory 配置');
    expect(output.map((line) => JSON.parse(line))).toEqual([
      { type: 'error', code: 'failed' },
      { type: 'error', code: 'failed' },
    ]);
  });

  it('拒绝非布尔 memory.writeEnabled', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    const code = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'memory-invalid', '--message', 'x'],
      env: { TEST_KEY: 'secret', MEMORY_AUTHORIZATION: 'Bearer memory-secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () =>
        JSON.stringify({
          ...JSON.parse(config(sessionRoot)),
          memory: {
            platformBaseUrl: 'https://memory.example/v1',
            authorizationEnv: 'MEMORY_AUTHORIZATION',
            memorySpaceId: 'personal-memory',
            writeEnabled: 'yes',
          },
        }),
    });
    expect(code).toBe(1);
    expect(output.map((line) => JSON.parse(line))).toEqual([{ type: 'error', code: 'failed' }]);
    expect(errors.join('')).toContain('memory.writeEnabled 必须是布尔值');
    expect(`${errors.join('')} ${output.join(' ')}`).not.toContain('memory-secret');
  });

  it('将参数和密钥失败写为不含密钥的 JSONL error', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const relative = await runCli({
      argv: ['run', '--config', 'config.json', '--session', 's', '--message', 'x'],
      env: { TEST_KEY: 'top-secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
    });
    expect(relative).toBe(1);
    expect(errors.join('')).not.toContain('top-secret');
    const missing = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 's', '--message', 'x'],
      env: {},
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () => config(await root()),
    });
    expect(missing).toBe(1);
    expect(errors.join('')).not.toContain('top-secret');
    expect(output.map((line) => JSON.parse(line))).toEqual([
      { type: 'error', code: 'failed' },
      { type: 'error', code: 'failed' },
    ]);
  });

  it('拒绝空消息和包含未知字段的配置', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    const emptyMessage = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 's', '--message', ''],
      env: { TEST_KEY: 'secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
    });
    const unknownField = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 's', '--message', 'x'],
      env: { TEST_KEY: 'secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () =>
        JSON.stringify({
          ...JSON.parse(config(sessionRoot)),
          model: {
            id: 'test',
            baseUrl: 'https://example.test/v1',
            model: 'test-model',
            apiKeyEnv: 'TEST_KEY',
            headers: { 'X-Api-Key': 'forbidden' },
          },
        }),
    });
    expect(emptyMessage).toBe(1);
    expect(unknownField).toBe(1);
    expect(output.map((line) => JSON.parse(line))).toEqual([
      { type: 'error', code: 'failed' },
      { type: 'error', code: 'failed' },
    ]);
    expect(errors.join('')).not.toContain('forbidden');
  });

  it('拒绝混合模型配置，并对缺失的 Platform 认证保持诊断安全', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    const mixed = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'mixed', '--message', 'x'],
      env: { PLATFORM_AUTHORIZATION: 'Bearer not-for-output' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () =>
        JSON.stringify({
          ...JSON.parse(platformConfig(sessionRoot)),
          model: {
            id: 'platform-gateway',
            platformBaseUrl: 'https://platform.example/v1',
            modelId: 'approved-model',
            authorizationEnv: 'PLATFORM_AUTHORIZATION',
            baseUrl: 'https://forbidden.example/v1',
          },
        }),
    });
    const missing = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'missing', '--message', 'x'],
      env: {},
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () => platformConfig(sessionRoot),
    });
    expect(mixed).toBe(1);
    expect(missing).toBe(1);
    expect(errors.join('')).toContain('PLATFORM_AUTHORIZATION 未设置');
    expect(`${errors.join('')} ${output.join(' ')}`).not.toContain('not-for-output');
  });

  it('同时组合 MCP 与本机 shell，且不输出 MCP 环境变量值', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    let request: Record<string, unknown> | undefined;
    let closed = false;
    const code = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'mcp-shell', '--message', 'x'],
      env: { TEST_KEY: 'secret', MCP_TOKEN: 'mcp-secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () =>
        JSON.stringify({
          ...JSON.parse(config(sessionRoot, { enabled: true })),
          mcp: { command: 'fake', environment: { TOKEN: 'MCP_TOKEN' } },
        }),
      createMcpClient: (options) => ({
        async listTools() {
          expect(options.env).toEqual({ TOKEN: 'mcp-secret' });
          return [{ name: 'mcp_lookup', description: '远程查询', inputSchema: { type: 'object' } }];
        },
        async callTool() {
          return { ok: true };
        },
        async close() {
          closed = true;
        },
      }),
      fetch: async (_input, init) => {
        request = JSON.parse(String(init?.body));
        return sse('done');
      },
    });
    expect(code).toBe(0);
    expect(JSON.stringify(request)).toContain('run_shell');
    expect(JSON.stringify(request)).toContain('mcp_lookup');
    expect(closed).toBe(true);
    expect(`${errors.join('')} ${output.join(' ')}`).not.toContain('mcp-secret');
  });

  it('在模型调用前拒绝跨来源重复工具名并关闭 MCP', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    let fetched = false;
    let closed = false;
    const code = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'mcp-duplicate', '--message', 'x'],
      env: { TEST_KEY: 'secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () =>
        JSON.stringify({
          ...JSON.parse(config(sessionRoot, { enabled: true })),
          mcp: { command: 'fake' },
        }),
      createMcpClient: () => ({
        async listTools() {
          return [{ name: 'run_shell', description: '冲突工具', inputSchema: { type: 'object' } }];
        },
        async callTool() {
          return { ok: true };
        },
        async close() {
          closed = true;
        },
      }),
      fetch: async () => {
        fetched = true;
        return sse('unexpected');
      },
    });
    expect(code).toBe(1);
    expect(fetched).toBe(false);
    expect(closed).toBe(true);
    expect(errors.join('')).toContain('工具名在多个来源中重复：run_shell');
    expect(output.map((line) => JSON.parse(line))).toEqual([{ type: 'error', code: 'failed' }]);
  });

  it('MCP 工具发现失败时关闭 client 且不调用模型', async () => {
    const output: string[] = [];
    const sessionRoot = await root();
    let fetched = false;
    let closed = false;
    const code = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'mcp-start-failure', '--message', 'x'],
      env: { TEST_KEY: 'secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write() {} },
      signals: new Signals(),
      readFile: async () =>
        JSON.stringify({
          ...JSON.parse(config(sessionRoot)),
          mcp: { command: 'fake' },
        }),
      createMcpClient: () => ({
        async listTools() {
          throw new Error('discover failure');
        },
        async callTool() {
          return { ok: true };
        },
        async close() {
          closed = true;
        },
      }),
      fetch: async () => {
        fetched = true;
        return sse('unexpected');
      },
    });
    expect(code).toBe(1);
    expect(fetched).toBe(false);
    expect(closed).toBe(true);
    expect(output.map((line) => JSON.parse(line))).toEqual([{ type: 'error', code: 'failed' }]);
  });

  it('SIGINT 取消运行，并在 finally 释放 reader 与信号监听器', async () => {
    const sessionRoot = await root();
    const signals = new Signals();
    let cancelled = false;
    let startFetch: (() => void) | undefined;
    let startRead: (() => void) | undefined;
    const fetched = new Promise<void>((resolve) => {
      startFetch = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      startRead = resolve;
    });
    const running = runCli({
      argv: ['run', '--config', '/config.json', '--session', 'cancel', '--message', 'x'],
      env: { TEST_KEY: 'secret' },
      stdout: { write() {} },
      stderr: { write() {} },
      signals,
      readFile: async () => config(sessionRoot),
      fetch: async () => {
        startFetch?.();
        return new Response(
          new ReadableStream({
            pull() {
              startRead?.();
              return new Promise<void>(() => undefined);
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    });
    await fetched;
    await reading;
    signals.listeners.get('SIGINT')?.();
    await expect(running).resolves.toBe(1);
    expect(cancelled).toBe(true);
    expect(signals.listeners).toEqual(new Map());
  });

  it('关闭失败不会阻止其余资源关闭，并保留全部错误', async () => {
    const calls: string[] = [];
    const errors = await closeCliResources([
      {
        async close() {
          calls.push('handle');
          throw new Error('handle failure');
        },
      },
      {
        async close() {
          calls.push('runtime');
          throw new Error('runtime failure');
        },
      },
    ]);
    expect(calls).toEqual(['handle', 'runtime']);
    expect(errors).toHaveLength(2);
  });

  it('按所有权顺序关闭资源，不让后一个资源提前关闭', async () => {
    const calls: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstClosed = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const closing = closeCliResources([
      {
        async close() {
          calls.push('handle:start');
          await firstClosed;
          calls.push('handle:end');
        },
      },
      {
        async close() {
          calls.push('runtime');
        },
      },
      {
        async close() {
          calls.push('mcp');
        },
      },
    ]);
    await Promise.resolve();
    expect(calls).toEqual(['handle:start']);
    releaseFirst?.();
    await expect(closing).resolves.toEqual([]);
    expect(calls).toEqual(['handle:start', 'handle:end', 'runtime', 'mcp']);
  });

  it('对已存在会话的 run 提示改用 resume', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    const first = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'dup', '--message', 'one'],
      env: { TEST_KEY: 'secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () => config(sessionRoot),
      fetch: async () => sse('ok'),
    });
    expect(first).toBe(0);
    const second = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'dup', '--message', 'two'],
      env: { TEST_KEY: 'secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      readFile: async () => config(sessionRoot),
      fetch: async () => sse('ok'),
    });
    expect(second).toBe(1);
    expect(errors.at(-1)).toContain('已有会话请改用 resume');
  });

  it('chat 在同一进程内处理多轮输入并自动打开已有会话', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const sessionRoot = await root();
    const cwd = await root();
    const replies = ['first-reply', 'second-reply'];
    let call = 0;
    const first = await runCli({
      argv: ['chat', '--config', '/config.json', '--session', 'chat-1', '--message', 'hello'],
      env: { TEST_KEY: 'secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      cwd,
      readFile: async () =>
        config(sessionRoot, { enabled: true, cwd, timeoutMs: 5000, maxOutputBytes: 1024 }),
      fetch: async () => sse(replies[call++] ?? 'extra'),
      lines: (async function* () {
        yield 'again';
        yield '/exit';
      })(),
    });
    expect(first).toBe(0);
    expect(output).toEqual([]);
    expect(errors.join('')).toContain('你: hello');
    expect(errors.join('')).toContain('助手:\nfirst-reply');
    expect(errors.join('')).toContain('助手:\nsecond-reply');

    const resumeChat = await runCli({
      argv: ['chat', '--config', '/config.json', '--session', 'chat-1'],
      env: { TEST_KEY: 'secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      signals: new Signals(),
      cwd,
      readFile: async () => config(sessionRoot, { enabled: false }),
      fetch: async () => sse('resumed'),
      lines: (async function* () {
        yield 'third';
        yield '/quit';
      })(),
    });
    expect(resumeChat).toBe(0);
    expect(output).toEqual([]);
    expect(errors.join('')).toContain('助手:\nresumed');
  });

  it('chat 空闲时 SIGINT 结束交互并关闭行迭代器', async () => {
    const errors: string[] = [];
    const sessionRoot = await root();
    const signals = new Signals();
    let waiting: (() => void) | undefined;
    const startedWaiting = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    let closed = false;
    let resolveNext: ((value: IteratorResult<string>) => void) | undefined;
    const lines: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            waiting?.();
            return new Promise((resolve) => {
              resolveNext = resolve;
            });
          },
          async return() {
            closed = true;
            resolveNext?.({ done: true, value: undefined });
            return { done: true, value: undefined };
          },
        };
      },
    };
    const running = runCli({
      argv: ['chat', '--config', '/config.json', '--session', 'chat-sigint'],
      env: { TEST_KEY: 'secret' },
      stdout: { write() {} },
      stderr: { write: (value) => errors.push(value) },
      signals,
      readFile: async () => config(sessionRoot, { enabled: false }),
      fetch: async () => sse('should-not-run'),
      lines,
    });
    await startedWaiting;
    signals.listeners.get('SIGINT')?.();
    await expect(running).resolves.toBe(0);
    expect(closed).toBe(true);
    expect(errors.join('')).not.toContain('助手:');
    expect(signals.listeners).toEqual(new Map());
  });

  it('chat 在读取到行后若进程已取消则不开始新回合', async () => {
    const errors: string[] = [];
    const sessionRoot = await root();
    const signals = new Signals();
    let fetchCount = 0;
    const lines: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        let delivered = false;
        return {
          next() {
            if (delivered) return Promise.resolve({ done: true as const, value: undefined });
            delivered = true;
            signals.listeners.get('SIGINT')?.();
            return Promise.resolve({ done: false as const, value: 'should-skip' });
          },
          async return() {
            return { done: true, value: undefined };
          },
        };
      },
    };
    const code = await runCli({
      argv: ['chat', '--config', '/config.json', '--session', 'chat-skip'],
      env: { TEST_KEY: 'secret' },
      stdout: { write() {} },
      stderr: { write: (value) => errors.push(value) },
      signals,
      readFile: async () => config(sessionRoot, { enabled: false }),
      fetch: async () => {
        fetchCount += 1;
        return sse('nope');
      },
      lines,
    });
    expect(code).toBe(0);
    expect(fetchCount).toBe(0);
    expect(errors.join('')).not.toContain('助手:');
  });

  it('注册 run_shell 后可完成工具调用回合', async () => {
    const output: string[] = [];
    const sessionRoot = await root();
    const cwd = await root();
    let step = 0;
    const code = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'shell-1', '--message', 'run echo'],
      env: { TEST_KEY: 'secret' },
      stdout: { write: (value) => output.push(value) },
      stderr: { write() {} },
      signals: new Signals(),
      cwd,
      readFile: async () =>
        config(sessionRoot, { enabled: true, cwd, timeoutMs: 10_000, maxOutputBytes: 4096 }),
      fetch: async () => {
        step += 1;
        if (step === 1) return toolCallSse();
        return sse('shell-done');
      },
    });
    expect(code).toBe(0);
    const events = output.map((line) => JSON.parse(line));
    expect(
      events.some((event) => event.type === 'stream' && event.event?.type === 'tool.call'),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      sessionId: 'shell-1',
      message: { content: 'shell-done' },
    });
  });
});
