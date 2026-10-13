import { brandId, type ExecutionId, type JsonValue, type ToolCallId } from '@agent-harness/kernel';
import { describe, expect, it } from 'vitest';
import {
  type PlatformPermitClient,
  PlatformPermitPolicy,
  PlatformPermitProtocolError,
  type PlatformPermitRequest,
} from '../src/index.ts';

const now = new Date('2026-10-09T00:00:00.000Z');

function policy(client: PlatformPermitClient): PlatformPermitPolicy {
  return new PlatformPermitPolicy({ client, clock: { now: () => now } });
}

function context(signal = new AbortController().signal) {
  return {
    signal,
    execution: {
      id: brandId<'ExecutionId'>('execution-1') as ExecutionId,
      subject: 'user-1',
      authorizationVersion: 'v7',
    },
  };
}

function call(input: JsonValue = { path: '/tmp/a', value: 1 }) {
  return {
    id: brandId<'ToolCallId'>('call-1') as ToolCallId,
    name: 'write_file',
    input,
  };
}

function allowed(request: PlatformPermitRequest): Record<string, unknown> {
  return {
    status: 'allowed',
    permitId: 'permit-1',
    executionId: request.executionId,
    subject: request.subject,
    authorizationVersion: request.authorizationVersion,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    inputDigest: request.inputDigest,
    expiresAt: '2026-10-09T00:01:00.000Z',
  };
}

describe('PlatformPermitPolicy', () => {
  it('把冻结执行身份、工具调用和规范输入摘要绑定到许可请求', async () => {
    const requests: PlatformPermitRequest[] = [];
    const adapter = policy({
      authorizeTool: async (request) => {
        requests.push(request);
        return allowed(request);
      },
    });

    await expect(adapter.authorize(call(), context())).resolves.toEqual({ status: 'allowed' });
    expect(requests).toEqual([
      {
        executionId: 'execution-1',
        subject: 'user-1',
        authorizationVersion: 'v7',
        toolCallId: 'call-1',
        toolName: 'write_file',
        inputDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    ]);
    expect(Object.isFrozen(requests[0])).toBe(true);
  });

  it('对象字段顺序不改变输入摘要', async () => {
    const digests: string[] = [];
    const adapter = policy({
      authorizeTool: async (request) => {
        digests.push(request.inputDigest);
        return allowed(request);
      },
    });

    await adapter.authorize(call({ a: 1, b: 2 }), context());
    await adapter.authorize(call({ b: 2, a: 1 }), context());
    expect(digests[0]).toBe(digests[1]);
  });

  it('保留 Platform 的拒绝原因', async () => {
    const adapter = policy({
      authorizeTool: async () => ({ status: 'denied', reason: '需要审批' }),
    });
    await expect(adapter.authorize(call(), context())).resolves.toEqual({
      status: 'denied',
      reason: '需要审批',
    });
  });

  it('在调用 Platform 前拒绝非 JSON 工具输入', async () => {
    let called = false;
    const adapter = policy({
      authorizeTool: async (request) => {
        called = true;
        return allowed(request);
      },
    });

    await expect(adapter.authorize(call(Number.NaN), context())).rejects.toThrow('必须是有限数字');
    expect(called).toBe(false);
  });

  it('拒绝绑定不匹配、过期或带未知字段的许可', async () => {
    const mismatch = policy({
      authorizeTool: async (request) => ({ ...allowed(request), toolCallId: 'other' }),
    });
    await expect(mismatch.authorize(call(), context())).rejects.toThrow(
      'toolCallId 与当前调用不匹配',
    );

    const wrongTool = policy({
      authorizeTool: async (request) => ({ ...allowed(request), toolName: 'delete_file' }),
    });
    await expect(wrongTool.authorize(call(), context())).rejects.toThrow(
      'toolName 与当前调用不匹配',
    );

    const staleAuthorization = policy({
      authorizeTool: async (request) => ({ ...allowed(request), authorizationVersion: 'v6' }),
    });
    await expect(staleAuthorization.authorize(call(), context())).rejects.toThrow(
      'authorizationVersion 与当前调用不匹配',
    );

    const wrongSubject = policy({
      authorizeTool: async (request) => ({ ...allowed(request), subject: 'user-2' }),
    });
    await expect(wrongSubject.authorize(call(), context())).rejects.toThrow(
      'subject 与当前调用不匹配',
    );

    const expired = policy({
      authorizeTool: async (request) => ({ ...allowed(request), expiresAt: now.toISOString() }),
    });
    await expect(expired.authorize(call(), context())).rejects.toThrow('permit 已过期');

    const unknown = policy({
      authorizeTool: async (request) => ({ ...allowed(request), unexpected: true }),
    });
    await expect(unknown.authorize(call(), context())).rejects.toBeInstanceOf(
      PlatformPermitProtocolError,
    );
  });

  it('把取消信号传给 Platform client 并在响应后重新检查取消', async () => {
    const controller = new AbortController();
    const adapter = policy({
      authorizeTool: async (request, signal) => {
        expect(signal).toBe(controller.signal);
        controller.abort(new Error('停止授权'));
        return allowed(request);
      },
    });

    await expect(adapter.authorize(call(), context(controller.signal))).rejects.toThrow('停止授权');
  });

  it('拒绝无效时钟结果', async () => {
    const adapter = new PlatformPermitPolicy({
      client: { authorizeTool: async (request) => allowed(request) },
      clock: { now: () => new Date(Number.NaN) },
    });
    await expect(adapter.authorize(call(), context())).rejects.toThrow('必须返回有效 Date');
  });
});
