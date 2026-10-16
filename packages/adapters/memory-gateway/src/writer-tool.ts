import { type ExecutableTool, type JsonValue, MEMORY_CONTEXT_LIMITS } from '@agent-harness/kernel';
import { boundedText } from './validation.js';

const MAX_MEMORY_STATEMENT_BYTES = 4_096;

/** Host 已解析的 memory space 与一条用户明确要求保存的长期陈述。 */
export interface MemoryGatewayWriteRequest {
  readonly memorySpaceId: string;
  readonly statement: string;
}

/** 由 Platform 或 Host 实现；写入授权、权威存储和向量化均由 client 拥有。 */
export interface MemoryGatewayWriterClient {
  writeMemory(request: MemoryGatewayWriteRequest, signal: AbortSignal): Promise<unknown>;
}

export interface MemoryGatewayWriterToolOptions {
  readonly memorySpaceId: string;
  readonly client: MemoryGatewayWriterClient;
}

/** 创建只能保存用户显式长期陈述的 Platform Memory function tool。 */
export function createMemoryWriterTool(options: MemoryGatewayWriterToolOptions): ExecutableTool {
  const memorySpaceId = boundedText(
    options.memorySpaceId,
    MEMORY_CONTEXT_LIMITS.maxFieldBytes,
    'memorySpaceId',
  );
  if (!isMemoryGatewayWriterClient(options.client)) {
    throw new TypeError('client 必须实现 writeMemory');
  }
  return {
    name: 'remember_memory',
    description:
      '保存用户明确要求长期记住的偏好或事实。不要保存临时任务状态，也不要保存未经用户明确要求的推断。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['statement'],
      properties: {
        statement: { type: 'string', description: '用户明确要求长期记住的完整陈述' },
      },
    },
    parseInput(input): JsonValue {
      return { statement: readMemoryStatement(input) };
    },
    async execute(input, context): Promise<JsonValue> {
      const request = Object.freeze({ memorySpaceId, statement: readMemoryStatement(input) });
      const response = await options.client.writeMemory(request, context.signal);
      context.signal.throwIfAborted();
      return normalizeWriteResponse(response);
    },
  };
}

function readMemoryStatement(input: JsonValue): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('remember_memory 输入必须是对象');
  }
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== 'statement') {
    throw new TypeError('remember_memory 输入只能包含 statement');
  }
  return boundedText(
    Reflect.get(input, 'statement'),
    MAX_MEMORY_STATEMENT_BYTES,
    'remember_memory.statement',
  );
}

function normalizeWriteResponse(value: unknown): JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Memory Gateway 写入响应必须是对象');
  }
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length !== 1 || keys[0] !== 'id') {
    throw new TypeError('Memory Gateway 写入响应只能包含 id');
  }
  return Object.freeze({
    id: boundedText(fields.id, MEMORY_CONTEXT_LIMITS.maxFieldBytes, 'Memory Gateway 写入响应.id'),
  });
}

function isMemoryGatewayWriterClient(value: unknown): value is MemoryGatewayWriterClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { writeMemory?: unknown }).writeMemory === 'function'
  );
}
