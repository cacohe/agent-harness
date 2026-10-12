import type { ModelRequest, ModelStreamEvent } from '@agent-harness/kernel';
import { brandId, type MessageId } from '@agent-harness/kernel';
import { describe, expect, it } from 'vitest';
import {
  type LlmGatewayClient,
  LlmGatewayConfigurationError,
  LlmGatewayModelProvider,
  LlmGatewayProtocolError,
} from '../src/index.ts';

function request(): ModelRequest {
  return {
    messages: [{ id: brandId<'MessageId'>('user-1') as MessageId, role: 'user', content: '你好' }],
    tools: [],
  };
}

function provider(
  client: LlmGatewayClient,
  limits: { readonly maxToolInputBytes?: number; readonly maxToolInputDepth?: number } = {},
): LlmGatewayModelProvider {
  return new LlmGatewayModelProvider({
    id: 'platform-gateway',
    modelId: 'deepseek-v3',
    client,
    ...limits,
  });
}

async function events(
  model: LlmGatewayModelProvider,
  signal = new AbortController().signal,
): Promise<ModelStreamEvent[]> {
  const prepared = await model.prepare(signal);
  return Array.fromAsync(prepared.stream(request(), signal));
}

async function* stream(events: readonly unknown[]): AsyncIterable<unknown> {
  yield* events;
}

describe('LlmGatewayModelProvider', () => {
  it('把 Host 已选模型传给 Gateway，并保留模型请求与取消信号', async () => {
    let selection: unknown;
    let preparedSignal: AbortSignal | undefined;
    let receivedRequest: ModelRequest | undefined;
    let streamSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const model = provider({
      prepare: async (input, signal) => {
        selection = input;
        preparedSignal = signal;
        return {
          stream: (inputRequest, inputSignal) => {
            receivedRequest = inputRequest;
            streamSignal = inputSignal;
            return stream([{ type: 'text.delta', text: '好的' }]);
          },
        };
      },
    });

    await expect(events(model, controller.signal)).resolves.toEqual([
      { type: 'text.delta', text: '好的' },
    ]);
    expect(model.id).toBe('platform-gateway');
    expect(selection).toEqual({ modelId: 'deepseek-v3' });
    expect(Object.isFrozen(selection)).toBe(true);
    expect(preparedSignal).toBe(controller.signal);
    expect(receivedRequest).toEqual(request());
    expect(streamSignal).toBe(controller.signal);
  });

  it('隔离 Gateway 后续对 tool input 的修改', async () => {
    const input = JSON.parse('{"__proto__":{"admin":true},"path":"before"}') as Record<
      string,
      unknown
    >;
    const model = provider({
      prepare: async () => ({
        stream: () =>
          (async function* (): AsyncIterable<unknown> {
            yield { type: 'tool.call', call: { id: 'call-1', name: 'write', input } };
            input.path = 'after';
          })(),
      }),
    });

    const observed = await events(model);
    expect(observed).toHaveLength(1);
    const call = observed[0] as Extract<ModelStreamEvent, { type: 'tool.call' }>;
    expect(call.type).toBe('tool.call');
    expect(call.call.id).toBe('call-1');
    expect(call.call.name).toBe('write');
    const snapshot = call.call.input as Record<string, unknown>;
    expect(Object.hasOwn(snapshot, '__proto__')).toBe(true);
    expect(snapshot['__proto__']).toEqual({ admin: true });
    expect(snapshot.path).toBe('before');
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
    expect(Object.isFrozen(call.call)).toBe(true);
  });

  it.each([
    ['空 provider id', { id: '', modelId: 'model' }],
    ['空 modelId', { id: 'gateway', modelId: '' }],
    ['无效 client', { id: 'gateway', modelId: 'model', client: {} }],
    ['零字节输入上限', { id: 'gateway', modelId: 'model', maxToolInputBytes: 0 }],
    ['零层输入深度上限', { id: 'gateway', modelId: 'model', maxToolInputDepth: 0 }],
  ])('拒绝%s', (_name, options) => {
    expect(
      () =>
        new LlmGatewayModelProvider({
          ...options,
          client: options.client ?? { prepare: async () => ({ stream: () => stream([]) }) },
        }),
    ).toThrow(LlmGatewayConfigurationError);
  });

  it.each([
    ['未知事件', { type: 'finished' }],
    ['text.delta 的未知字段', { type: 'text.delta', text: 'ok', extra: true }],
    ['空文本', { type: 'text.delta', text: '' }],
    ['负数用量', { type: 'usage', inputTokens: -1, outputTokens: 0 }],
    ['无效工具输入', { type: 'tool.call', call: { id: 'call', name: 'write', input: Number.NaN } }],
  ])('拒绝%s', async (_name, event) => {
    const model = provider({ prepare: async () => ({ stream: () => stream([event]) }) });
    await expect(events(model)).rejects.toBeInstanceOf(LlmGatewayProtocolError);
  });

  it('拒绝递减的累计用量', async () => {
    const model = provider({
      prepare: async () => ({
        stream: () =>
          stream([
            { type: 'usage', inputTokens: 3, outputTokens: 2 },
            { type: 'usage', inputTokens: 2, outputTokens: 2 },
          ]),
      }),
    });
    await expect(events(model)).rejects.toThrow('Gateway usage 必须单调不减');
  });

  it('在复制前限制工具输入的规范 JSON 字节数', async () => {
    const model = provider(
      {
        prepare: async () => ({
          stream: () =>
            stream([{ type: 'tool.call', call: { id: 'call', name: 'write', input: '超过限制' } }]),
        }),
      },
      { maxToolInputBytes: 8 },
    );

    await expect(events(model)).rejects.toThrow(
      'Gateway tool.call.input 超过 maxToolInputBytes (8)',
    );
  });

  it('接受恰好处于 JSON 字节上限的数组与短控制字符转义', async () => {
    const arrayModel = provider(
      {
        prepare: async () => ({
          stream: () =>
            stream([{ type: 'tool.call', call: { id: 'call', name: 'write', input: [0, 0] } }]),
        }),
      },
      { maxToolInputBytes: 5 },
    );
    await expect(events(arrayModel)).resolves.toMatchObject([
      {
        type: 'tool.call',
        call: { id: 'call', name: 'write', input: [0, 0] },
      },
    ]);

    const escapedModel = provider(
      {
        prepare: async () => ({
          stream: () =>
            stream([{ type: 'tool.call', call: { id: 'call', name: 'write', input: '\n' } }]),
        }),
      },
      { maxToolInputBytes: 4 },
    );
    await expect(events(escapedModel)).resolves.toMatchObject([
      {
        type: 'tool.call',
        call: { id: 'call', name: 'write', input: '\n' },
      },
    ]);
  });

  it('在递归复制前限制工具输入嵌套深度', async () => {
    let input: unknown = 'leaf';
    for (let index = 0; index < 128; index += 1) input = [input];
    const model = provider(
      {
        prepare: async () => ({
          stream: () => stream([{ type: 'tool.call', call: { id: 'call', name: 'write', input } }]),
        }),
      },
      { maxToolInputDepth: 8 },
    );

    await expect(events(model)).rejects.toThrow(
      'Gateway tool.call.input 超过 maxToolInputDepth (8)',
    );
  });

  it('在 prepare 返回后和流式期间重新检查取消', async () => {
    const afterPrepare = new AbortController();
    const model = provider({
      prepare: async () => {
        afterPrepare.abort(new Error('停止准备'));
        return { stream: () => stream([]) };
      },
    });
    await expect(model.prepare(afterPrepare.signal)).rejects.toThrow('停止准备');

    const duringStream = new AbortController();
    const streamModel = provider({
      prepare: async () => ({
        stream: () =>
          (async function* (): AsyncIterable<unknown> {
            duringStream.abort(new Error('停止流'));
            yield { type: 'text.delta', text: '不应发布' };
          })(),
      }),
    });
    await expect(events(streamModel, duringStream.signal)).rejects.toThrow('停止流');
  });

  it('拒绝 Gateway 返回的无效 prepare 结果或非异步流', async () => {
    const invalidPrepared = provider({ prepare: async () => ({}) as never });
    await expect(invalidPrepared.prepare(new AbortController().signal)).rejects.toBeInstanceOf(
      LlmGatewayProtocolError,
    );

    const invalidStream = provider({ prepare: async () => ({ stream: () => [] as never }) });
    await expect(events(invalidStream)).rejects.toBeInstanceOf(LlmGatewayProtocolError);
  });
});
