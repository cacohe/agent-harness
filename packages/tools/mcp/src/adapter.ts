/** 将 MCP client 映射为 Agent 的工具 capability。 */
import {
  assertJsonValue,
  isAbortError,
  serializeError,
  type JsonValue,
  type ToolCall,
  type ToolResult,
} from '@agent-harness/kernel'
import type { ModelToolDefinition } from '@agent-harness/kernel'
import type { ToolCapability } from '@agent-harness/kernel'

/** MCP Server 返回的可调用工具描述。 */
export interface McpToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

/** 由 Host 或 Platform 实现的 MCP 连接；adapter 不依赖传输协议或 SDK。 */
export interface McpClient {
  listTools(signal: AbortSignal): Promise<readonly McpToolDescriptor[]>
  callTool(name: string, input: JsonValue, signal: AbortSignal): Promise<JsonValue>
  close(signal: AbortSignal): Promise<void>
}

/** 表示 adapter 尚未完成工具发现，不能安全向模型暴露工具。 */
export class McpToolsNotStartedError extends Error {
  override readonly name = 'McpToolsNotStartedError'
}

/** 已启动的 MCP 工具表；同一实例由组合方显式拥有 start 与 close 生命周期。 */
export class McpToolAdapter implements ToolCapability {
  readonly #client: McpClient
  #tools: ReadonlyMap<string, McpToolDescriptor> | undefined
  #startPromise: Promise<void> | undefined
  #startController: AbortController | undefined
  #closePromise: Promise<void> | undefined
  #closing = false
  #closed = false

  constructor(client: McpClient) {
    this.#client = client
  }

  /** 拉取并校验远程工具表；重复启动安全，但关闭后不可重新启动。 */
  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.#closed || this.#closing) throw new McpToolsNotStartedError('MCP 工具 adapter 已关闭')
    if (this.#tools !== undefined) return
    if (this.#startPromise === undefined) {
      const controller = new AbortController()
      this.#startController = controller
      this.#startPromise = this.#discover(controller.signal)
    }
    return waitFor(this.#startPromise, signal)
  }

  /** 停止接纳调用并关闭外部 client；重复调用安全。 */
  close(signal: AbortSignal): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closing = true
      this.#tools = undefined
      this.#startController?.abort(new McpToolsNotStartedError('MCP 工具 adapter 正在关闭'))
      this.#closePromise = this.#closeClient()
    }
    return waitFor(this.#closePromise, signal)
  }

  list(): readonly ModelToolDefinition[] {
    const tools = this.#readyTools()
    return [...tools.values()].map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))
  }

  async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) return cancelled(call, signal.reason)
    const tool = this.#readyTools().get(call.name)
    if (tool === undefined) return unknownTool(call)
    try {
      assertJsonValue(call.input)
      const output = await this.#client.callTool(tool.name, call.input, signal)
      if (signal.aborted) return cancelled(call, signal.reason)
      assertJsonValue(output)
      return { status: 'success', callId: call.id, output }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return cancelled(call, signal.reason ?? error)
      return { status: 'failure', callId: call.id, error: serializeError(error) }
    }
  }

  #readyTools(): ReadonlyMap<string, McpToolDescriptor> {
    if (this.#tools === undefined || this.#closing || this.#closed) {
      throw new McpToolsNotStartedError('MCP 工具 adapter 尚未启动或已经关闭')
    }
    return this.#tools
  }

  async #discover(signal: AbortSignal): Promise<void> {
    try {
      signal.throwIfAborted()
      const tools = await this.#client.listTools(signal)
      signal.throwIfAborted()
      if (this.#closed || this.#closing) throw new McpToolsNotStartedError('MCP 工具 adapter 已关闭')
      this.#tools = validateTools(tools)
    } finally {
      this.#startPromise = undefined
      this.#startController = undefined
    }
  }

  async #closeClient(): Promise<void> {
    try {
      await this.#client.close(neverAbortedSignal)
    } finally {
      this.#tools = undefined
      this.#closed = true
      this.#closing = false
    }
  }
}

const neverAbortedSignal = new AbortController().signal

/** 调用方可取消等待，但已开始的资源释放始终在后台完成。 */
function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined)
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function validateTools(value: readonly McpToolDescriptor[]): ReadonlyMap<string, McpToolDescriptor> {
  if (!Array.isArray(value)) throw new TypeError('MCP tools 必须是数组')
  const tools = new Map<string, McpToolDescriptor>()
  for (const tool of value) {
    if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) {
      throw new TypeError('MCP tool 必须是对象')
    }
    const keys = Object.keys(tool)
    const expected = ['description', 'inputSchema', 'name']
    if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) {
      throw new TypeError('MCP tool 只能包含 name、description 与 inputSchema')
    }
    if (typeof tool.name !== 'string' || tool.name.length === 0) throw new TypeError('MCP tool.name 必须是非空字符串')
    if (typeof tool.description !== 'string' || tool.description.length === 0) throw new TypeError('MCP tool.description 必须是非空字符串')
    if (typeof tool.inputSchema !== 'object' || tool.inputSchema === null || Array.isArray(tool.inputSchema)) {
      throw new TypeError('MCP tool.inputSchema 必须是对象')
    }
    assertJsonValue(tool.inputSchema)
    if (tools.has(tool.name)) throw new TypeError(`MCP tool 重复注册：${tool.name}`)
    tools.set(tool.name, Object.freeze({
      name: tool.name,
      description: tool.description,
      inputSchema: freezeSchema(tool.inputSchema),
    }))
  }
  return tools
}

function freezeSchema(value: JsonValue): Readonly<Record<string, unknown>> {
  return freezeJson(value) as Readonly<Record<string, unknown>>
}

/** 远程 schema 进入模型请求前复制并深度冻结，避免 client 事后修改工具定义。 */
function freezeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson))
  const copy: Record<string, JsonValue> = {}
  for (const [key, child] of Object.entries(value)) copy[key] = freezeJson(child)
  return Object.freeze(copy)
}

function unknownTool(call: ToolCall): ToolResult {
  return { status: 'failure', callId: call.id, error: { name: 'UnknownToolError', message: `unknown tool: ${call.name}` } }
}

function cancelled(call: ToolCall, reason: unknown): ToolResult {
  return {
    status: 'cancelled',
    callId: call.id,
    reason: reason instanceof Error ? reason.message : String(reason ?? 'cancelled'),
  }
}
