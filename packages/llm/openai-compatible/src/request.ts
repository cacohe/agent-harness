import {
  assertJsonValue,
  assertNever,
  type JsonObject,
  type JsonValue,
  type ModelMessage,
} from '@agent-harness/kernel'
import type { ModelRequest } from '@agent-harness/kernel'
import { OpenAiCompatibleConfigurationError } from './errors.js'

export function resolveEndpoint(baseUrl: string): URL {
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    throw new OpenAiCompatibleConfigurationError('base URL 必须是绝对 URL')
  }
  if (!base.protocol || !base.host) {
    throw new OpenAiCompatibleConfigurationError('base URL 必须包含协议与主机')
  }
  if (base.search || base.hash) {
    throw new OpenAiCompatibleConfigurationError('base URL 不得包含 query 或 fragment')
  }
  if (/\/chat\/completions\/?$/.test(base.pathname)) {
    throw new OpenAiCompatibleConfigurationError('base URL 必须是 API 根路径，不能是完整 chat/completions endpoint')
  }
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`
  return new URL('chat/completions', base)
}

export function buildHeaders(
  apiKey: string,
  additionalHeaders: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(additionalHeaders ?? {})) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
      || typeof value !== 'string'
      || /[\r\n]/.test(value)
    ) {
      throw new OpenAiCompatibleConfigurationError('额外请求头包含非法名称或值')
    }
    if (['authorization', 'content-type', 'accept'].includes(name.toLowerCase())) {
      throw new OpenAiCompatibleConfigurationError(`额外请求头不得覆盖 ${name}`)
    }
    headers[name] = value
  }
  return {
    ...headers,
    Accept: 'text/event-stream',
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
}

export function requireNonEmpty(value: string, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OpenAiCompatibleConfigurationError(`${name} 必须是非空字符串`)
  }
  return value
}

export function toChatCompletionsRequest(model: string, request: ModelRequest) {
  return {
    model,
    stream: true as const,
    messages: request.messages.map(toChatMessage),
    // 部分供应商拒绝空 tools；无工具时省略该字段。
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map(tool => ({
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }),
  }
}

function toChatMessage(message: ModelMessage) {
  switch (message.role) {
    case 'system':
      return { role: 'system' as const, content: message.content }
    case 'user':
      return { role: 'user' as const, content: message.content }
    case 'assistant':
      return {
        role: 'assistant' as const,
        content: message.content,
        // 部分供应商拒绝空 tool_calls；无调用时省略该字段。
        ...(message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map(call => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: stableJson(call.input) },
              })),
            }),
      }
    case 'tool':
      return {
        role: 'tool' as const,
        tool_call_id: message.callId,
        content: stableJson(message.result),
      }
    default:
      return assertNever(message)
  }
}

function stableJson(value: unknown): string {
  assertJsonValue(value)
  return stableJsonValue(value)
}

function stableJsonValue(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJsonValue).join(',')}]`
  const record = value as JsonObject
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJsonValue(record[key]!)}`).join(',')}}`
}
