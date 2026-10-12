import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  PreparedModelCall,
} from '@agent-harness/kernel';
import { brandId, type JsonValue, type ToolCall, type ToolCallId } from '@agent-harness/kernel';

/** Platform 或 Host 已解析的单个 Gateway 模型选择。 */
export interface LlmGatewayModelSelection {
  readonly modelId: string;
}

/** Platform Gateway 为一次已选模型调用建立的流式句柄。 */
export interface LlmGatewayPreparedCall {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<unknown>;
}

/** 由 Platform 或 Host 实现的 Gateway 连接、鉴权、计费与模型调用边界。 */
export interface LlmGatewayClient {
  prepare(
    selection: LlmGatewayModelSelection,
    signal: AbortSignal,
  ): Promise<LlmGatewayPreparedCall>;
}

/** Gateway 返回的流事件不符合模型 capability 协议时抛出。 */
export class LlmGatewayProtocolError extends Error {
  override readonly name = 'LlmGatewayProtocolError';
}

/** Gateway provider 组合参数无效时抛出。 */
export class LlmGatewayConfigurationError extends Error {
  override readonly name = 'LlmGatewayConfigurationError';
}

const DEFAULT_MAX_TOOL_INPUT_BYTES = 1_048_576;
const DEFAULT_MAX_TOOL_INPUT_DEPTH = 64;

interface ToolInputLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
}

/**
 * 将已选模型的 Platform Gateway 调用转换为 ModelProvider。
 *
 * 模型选择、身份、权限与计费由 client 所在的 Platform 或 Host 决定；本 adapter
 * 只负责把不可信的 Gateway 流严格转换为模型 capability 事件。
 */
export class LlmGatewayModelProvider implements ModelProvider {
  readonly id: string;
  readonly #selection: LlmGatewayModelSelection;
  readonly #client: LlmGatewayClient;
  readonly #toolInputLimits: ToolInputLimits;

  constructor(options: {
    readonly id: string;
    readonly modelId: string;
    readonly client: LlmGatewayClient;
    /** 单个 Gateway 工具输入在复制前允许的最大规范 JSON UTF-8 字节数。 */
    readonly maxToolInputBytes?: number;
    /** 单个 Gateway 工具输入允许的最大对象或数组嵌套深度。 */
    readonly maxToolInputDepth?: number;
  }) {
    this.id = nonEmptyString(options.id, 'provider id', LlmGatewayConfigurationError);
    this.#selection = Object.freeze({
      modelId: nonEmptyString(options.modelId, 'modelId', LlmGatewayConfigurationError),
    });
    if (!isGatewayClient(options.client)) {
      throw new LlmGatewayConfigurationError('client 必须提供 prepare 方法');
    }
    this.#client = options.client;
    this.#toolInputLimits = Object.freeze({
      maxBytes: positiveSafeInteger(
        options.maxToolInputBytes ?? DEFAULT_MAX_TOOL_INPUT_BYTES,
        'maxToolInputBytes',
        LlmGatewayConfigurationError,
      ),
      maxDepth: positiveSafeInteger(
        options.maxToolInputDepth ?? DEFAULT_MAX_TOOL_INPUT_DEPTH,
        'maxToolInputDepth',
        LlmGatewayConfigurationError,
      ),
    });
  }

  async prepare(signal: AbortSignal): Promise<PreparedModelCall> {
    signal.throwIfAborted();
    const prepared = await this.#client.prepare(this.#selection, signal);
    signal.throwIfAborted();
    if (!isPreparedCall(prepared)) {
      throw new LlmGatewayProtocolError('Gateway prepare 必须返回带 stream 方法的对象');
    }
    return new GatewayPreparedModelCall(prepared, this.#toolInputLimits);
  }
}

class GatewayPreparedModelCall implements PreparedModelCall {
  readonly #call: LlmGatewayPreparedCall;
  readonly #toolInputLimits: ToolInputLimits;

  constructor(call: LlmGatewayPreparedCall, toolInputLimits: ToolInputLimits) {
    this.#call = call;
    this.#toolInputLimits = toolInputLimits;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    signal.throwIfAborted();
    const events = this.#call.stream(request, signal);
    if (!isAsyncIterable(events)) {
      throw new LlmGatewayProtocolError('Gateway stream 必须返回 AsyncIterable');
    }
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const event of events) {
      signal.throwIfAborted();
      const parsed = parseStreamEvent(event, this.#toolInputLimits);
      if (parsed.type === 'usage') {
        if (parsed.inputTokens < inputTokens || parsed.outputTokens < outputTokens) {
          throw new LlmGatewayProtocolError('Gateway usage 必须单调不减');
        }
        inputTokens = parsed.inputTokens;
        outputTokens = parsed.outputTokens;
      }
      yield parsed;
    }
    signal.throwIfAborted();
  }
}

function isPreparedCall(value: unknown): value is LlmGatewayPreparedCall {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { stream?: unknown }).stream === 'function'
  );
}

function isGatewayClient(value: unknown): value is LlmGatewayClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === 'function'
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

function parseStreamEvent(value: unknown, toolInputLimits: ToolInputLimits): ModelStreamEvent {
  const event = exactRecord(value, 'Gateway 流事件');
  const type = event.type;
  if (type === 'text.delta') {
    requireExactKeys(event, ['text', 'type'], 'Gateway text.delta 事件');
    return Object.freeze({
      type,
      text: nonEmptyString(event.text, 'Gateway text.delta.text', LlmGatewayProtocolError),
    });
  }
  if (type === 'tool.call') {
    requireExactKeys(event, ['call', 'type'], 'Gateway tool.call 事件');
    return Object.freeze({ type, call: parseToolCall(event.call, toolInputLimits) });
  }
  if (type === 'usage') {
    requireExactKeys(event, ['inputTokens', 'outputTokens', 'type'], 'Gateway usage 事件');
    return Object.freeze({
      type,
      inputTokens: nonNegativeInteger(event.inputTokens, 'Gateway usage.inputTokens'),
      outputTokens: nonNegativeInteger(event.outputTokens, 'Gateway usage.outputTokens'),
    });
  }
  throw new LlmGatewayProtocolError('Gateway 流事件 type 无效');
}

function parseToolCall(value: unknown, limits: ToolInputLimits): ToolCall {
  const call = exactRecord(value, 'Gateway tool.call.call');
  requireExactKeys(call, ['id', 'input', 'name'], 'Gateway tool.call.call');
  return Object.freeze({
    id: brandId<'ToolCallId'>(
      nonEmptyString(call.id, 'Gateway tool.call.id', LlmGatewayProtocolError),
    ) as ToolCallId,
    name: nonEmptyString(call.name, 'Gateway tool.call.name', LlmGatewayProtocolError),
    input: copyToolInput(call.input, limits),
  });
}

function exactRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LlmGatewayProtocolError(`${name}必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    throw new LlmGatewayProtocolError(`${name}字段无效`);
  }
}

function nonEmptyString<T extends Error>(
  value: unknown,
  name: string,
  ErrorType: new (message: string) => T,
): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new ErrorType(`${name}必须是非空字符串`);
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LlmGatewayProtocolError(`${name}必须是非负安全整数`);
  }
  return value;
}

function positiveSafeInteger<T extends Error>(
  value: unknown,
  name: string,
  ErrorType: new (message: string) => T,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ErrorType(`${name}必须是正安全整数`);
  }
  return value;
}

/** 在接触不可信输入时以显式栈限制大小与深度，再生成不共享引用的不可变 JSON 快照。 */
function copyToolInput(value: unknown, limits: ToolInputLimits): JsonValue {
  let bytes = 0;
  let root: JsonValue | undefined;
  const ancestors = new Set<object>();
  const jobs: JsonCopyJob[] = [
    {
      type: 'value',
      value,
      depth: 0,
      assign: (copied) => {
        root = copied;
      },
    },
  ];

  const addBytes = (amount: number): void => {
    bytes += amount;
    if (bytes > limits.maxBytes) {
      throw new LlmGatewayProtocolError(
        `Gateway tool.call.input 超过 maxToolInputBytes (${limits.maxBytes})`,
      );
    }
  };

  while (jobs.length > 0) {
    const job = jobs.pop()!;
    if (job.type === 'freeze') {
      ancestors.delete(job.source);
      Object.freeze(job.target);
      continue;
    }
    const current = job.value;
    if (current === null) {
      addBytes(4);
      job.assign(null);
      continue;
    }
    if (typeof current === 'boolean') {
      addBytes(current ? 4 : 5);
      job.assign(current);
      continue;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current))
        throw new LlmGatewayProtocolError('Gateway tool.call.input 必须是有限数字');
      addBytes(JSON.stringify(current).length);
      job.assign(current);
      continue;
    }
    if (typeof current === 'string') {
      addBytes(jsonStringUtf8Bytes(current));
      job.assign(current);
      continue;
    }
    if (typeof current !== 'object') {
      throw new LlmGatewayProtocolError('Gateway tool.call.input 不是合法 JSON 值');
    }
    if (job.depth >= limits.maxDepth) {
      throw new LlmGatewayProtocolError(
        `Gateway tool.call.input 超过 maxToolInputDepth (${limits.maxDepth})`,
      );
    }
    if (ancestors.has(current))
      throw new LlmGatewayProtocolError('Gateway tool.call.input 包含循环引用');
    ancestors.add(current);

    if (Array.isArray(current)) {
      const minimumBytes = current.length === 0 ? 2 : current.length * 2 + 1;
      if (bytes + minimumBytes > limits.maxBytes) {
        throw new LlmGatewayProtocolError(
          `Gateway tool.call.input 超过 maxToolInputBytes (${limits.maxBytes})`,
        );
      }
      const keys = Reflect.ownKeys(current);
      if (keys.length !== current.length + 1) {
        throw new LlmGatewayProtocolError('Gateway tool.call.input 不能是稀疏数组或包含额外属性');
      }
      for (const key of keys) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) {
          throw new LlmGatewayProtocolError('Gateway tool.call.input 包含 JSON 不会保存的数组属性');
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new LlmGatewayProtocolError('Gateway tool.call.input 数组元素必须是可枚举数据属性');
        }
      }
      addBytes(2 + Math.max(0, current.length - 1));
      const copy: JsonValue[] = new Array(current.length);
      job.assign(copy);
      jobs.push({ type: 'freeze', source: current, target: copy });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        jobs.push({
          type: 'value',
          value: current[index],
          depth: job.depth + 1,
          assign: (copied) => {
            copy[index] = copied;
          },
        });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new LlmGatewayProtocolError('Gateway tool.call.input 必须是普通 JSON 对象');
    }
    const keys = Reflect.ownKeys(current);
    const entries: { readonly key: string; readonly value: unknown }[] = [];
    for (const key of keys) {
      if (typeof key !== 'string')
        throw new LlmGatewayProtocolError('Gateway tool.call.input 包含 symbol 属性');
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new LlmGatewayProtocolError('Gateway tool.call.input 属性必须是可枚举数据属性');
      }
      addBytes(jsonStringUtf8Bytes(key) + 1);
      entries.push({ key, value: descriptor.value });
    }
    addBytes(2 + Math.max(0, entries.length - 1));
    const copy: Record<string, JsonValue> = {};
    job.assign(copy);
    jobs.push({ type: 'freeze', source: current, target: copy });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      jobs.push({
        type: 'value',
        value: entry.value,
        depth: job.depth + 1,
        assign: (copied) => {
          Object.defineProperty(copy, entry.key, {
            value: copied,
            enumerable: true,
            writable: false,
            configurable: false,
          });
        },
      });
    }
  }
  if (root === undefined) throw new LlmGatewayProtocolError('Gateway tool.call.input 无法复制');
  return root;
}

type JsonCopyJob =
  | {
      readonly type: 'value';
      readonly value: unknown;
      readonly depth: number;
      readonly assign: (value: JsonValue) => void;
    }
  | { readonly type: 'freeze'; readonly source: object; readonly target: object };

/** 逐 code point 计数，避免为了计算边界而创建与不可信字符串等大的转义副本。 */
function jsonStringUtf8Bytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x22 || code === 0x5c) {
      bytes +=
        code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d
          ? 2
          : code <= 0x1f
            ? 6
            : 2;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
