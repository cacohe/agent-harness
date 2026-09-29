import {
  assertJsonValue,
  isAbortError,
  serializeError,
  type ToolCall,
  type ToolResult,
  type JsonValue,
  type ExecutionMetadata,
} from '@agent-harness/domain'
import type { ModelToolDefinition } from '@agent-harness/model'

export interface ToolExecutionContext {
  readonly signal: AbortSignal
  /** 本次 turn 的冻结执行上下文；未经策略包装的既有工具可忽略它。 */
  readonly execution?: ExecutionMetadata
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>

  /** 在任何副作用前把不可信模型 JSON 解析为已验证输入。 */
  parseInput(input: JsonValue): JsonValue
  execute(input: JsonValue, context: ToolExecutionContext): Promise<JsonValue>
}

/** 向模型公开当前可用工具，不暴露具体注册方式。 */
export interface ToolCatalog {
  list(): readonly ModelToolDefinition[]
}

/** 执行规范化工具调用，不暴露工具查找与调度实现。 */
export interface ToolExecutor {
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>
}

/** Agent loop 所需的最小工具 capability。 */
export interface ToolCapability extends ToolCatalog, ToolExecutor {}

/** 支持接收冻结执行上下文的工具 capability；保留旧 execute 签名以兼容现有工具。 */
export interface ExecutionAwareToolCapability extends ToolCapability {
  executeWithContext(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult>
}

/** 平台、审批或本地策略在任何副作用前作出的闭合许可决定。 */
export type ToolAuthorizationDecision =
  | { readonly status: 'allowed' }
  | { readonly status: 'denied', readonly reason: string }

/** 工具执行前的可替换策略；远程调用实现必须响应 context.signal。 */
export interface ToolExecutionPolicy {
  authorize(
    call: ToolCall,
    context: ToolExecutionContext & { readonly execution: ExecutionMetadata },
  ): Promise<ToolAuthorizationDecision>
}

/** Sandbox 运行一次工具所需的、可传递给外部执行器的稳定任务描述。 */
export interface SandboxTask {
  readonly call: ToolCall
  readonly workspace?: string
  readonly limits?: SandboxResourceLimits
}

/** Sandbox 任务的资源边界；具体强制方式由 dispatcher adapter 决定。 */
export interface SandboxResourceLimits {
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

/** 将已验证工具任务派发到隔离执行环境的 capability。 */
export interface SandboxDispatcher {
  dispatch(task: SandboxTask, context: ToolExecutionContext): Promise<JsonValue>
}

export interface SandboxToolRegistryOptions {
  readonly workspace?: string
  readonly limits?: SandboxResourceLimits
}

/** 不可变的工具注册表，也是第一阶段的顺序工具执行器。 */
export class ToolRegistry implements ToolCapability {
  readonly #definitions: ReadonlyMap<string, ToolDefinition>

  constructor(definitions: readonly ToolDefinition[]) {
    const entries = new Map<string, ToolDefinition>()
    for (const definition of definitions) {
      if (entries.has(definition.name)) {
        throw new Error(`duplicate tool registration: ${definition.name}`)
      }
      entries.set(definition.name, definition)
    }
    this.#definitions = entries
  }

  list(): readonly ModelToolDefinition[] {
    return [...this.#definitions.values()].map(definition => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    }))
  }

  async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    return this.executeWithContext(call, { signal })
  }

  async executeWithContext(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const { signal } = context
    if (signal.aborted) return cancelledResult(call, signal.reason)

    const definition = this.#definitions.get(call.name)
    if (definition === undefined) {
      return {
        status: 'failure',
        callId: call.id,
        error: {
          name: 'UnknownToolError',
          message: `unknown tool: ${call.name}`,
        },
      }
    }

    try {
      const input = definition.parseInput(call.input)
      const output = await definition.execute(input, context)
      if (signal.aborted) return cancelledResult(call, signal.reason)
      assertJsonValue(output)
      return { status: 'success', callId: call.id, output }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        return cancelledResult(call, signal.reason ?? error)
      }
      return { status: 'failure', callId: call.id, error: serializeError(error) }
    }
  }
}

/**
 * 将一组已定义工具的执行委派给 Sandbox。输入仍在 Host 侧校验，避免把不可信模型 JSON
 * 直接交给外部执行器；执行器只接收已通过对应工具 parser 的任务。
 */
export class SandboxToolRegistry implements ExecutionAwareToolCapability {
  readonly #definitions: ReadonlyMap<string, ToolDefinition>
  readonly #dispatcher: SandboxDispatcher
  readonly #workspace: string | undefined
  readonly #limits: SandboxResourceLimits | undefined

  constructor(
    definitions: readonly ToolDefinition[],
    dispatcher: SandboxDispatcher,
    options: SandboxToolRegistryOptions = {},
  ) {
    const entries = new Map<string, ToolDefinition>()
    for (const definition of definitions) {
      if (entries.has(definition.name)) throw new Error(`duplicate tool registration: ${definition.name}`)
      entries.set(definition.name, definition)
    }
    const normalized = normalizeSandboxOptions(options)
    this.#definitions = entries
    this.#dispatcher = dispatcher
    this.#workspace = normalized.workspace
    this.#limits = normalized.limits
  }

  list(): readonly ModelToolDefinition[] {
    return [...this.#definitions.values()].map(definition => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    }))
  }

  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    return this.executeWithContext(call, { signal })
  }

  async executeWithContext(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (context.signal.aborted) return cancelledResult(call, context.signal.reason)
    if (context.execution === undefined) {
      return authorizationFailure(call, '缺少冻结执行上下文')
    }
    const definition = this.#definitions.get(call.name)
    if (definition === undefined) {
      return {
        status: 'failure',
        callId: call.id,
        error: { name: 'UnknownToolError', message: `unknown tool: ${call.name}` },
      }
    }
    try {
      const input = definition.parseInput(call.input)
      assertJsonValue(input)
      const task = Object.freeze({
        call: Object.freeze({ ...call, input: freezeJson(input) }),
        ...(this.#workspace === undefined ? {} : { workspace: this.#workspace }),
        ...(this.#limits === undefined ? {} : { limits: this.#limits }),
      })
      const output = await this.#dispatcher.dispatch(task, context as ToolExecutionContext & {
        readonly execution: ExecutionMetadata
      })
      if (context.signal.aborted) return cancelledResult(call, context.signal.reason)
      assertJsonValue(output)
      return { status: 'success', callId: call.id, output }
    } catch (error) {
      if (context.signal.aborted || isAbortError(error)) {
        return cancelledResult(call, context.signal.reason ?? error)
      }
      return { status: 'failure', callId: call.id, error: serializeError(error) }
    }
  }
}

/**
 * 在真实工具前强制执行策略。拒绝会成为普通工具失败，因此可以被会话恢复与模型历史完整观察。
 */
export class PolicyControlledTools implements ExecutionAwareToolCapability {
  readonly #delegate: ToolCapability
  readonly #policy: ToolExecutionPolicy

  constructor(delegate: ToolCapability, policy: ToolExecutionPolicy) {
    this.#delegate = delegate
    this.#policy = policy
  }

  list(): readonly ModelToolDefinition[] {
    return this.#delegate.list()
  }

  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    return this.executeWithContext(call, { signal })
  }

  async executeWithContext(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (context.signal.aborted) return cancelledResult(call, context.signal.reason)
    if (context.execution === undefined) {
      return authorizationFailure(call, '缺少冻结执行上下文')
    }
    try {
      const decision = await this.#policy.authorize(call, context as ToolExecutionContext & {
        readonly execution: ExecutionMetadata
      })
      if (context.signal.aborted) return cancelledResult(call, context.signal.reason)
      if (!isAllowed(decision)) return authorizationFailure(call, denialReason(decision))
      return executeWithContext(this.#delegate, call, context)
    } catch (error) {
      if (context.signal.aborted || isAbortError(error)) {
        return cancelledResult(call, context.signal.reason ?? error)
      }
      return authorizationFailure(call, serializeError(error).message)
    }
  }
}

/** 外部策略边界 fail closed：只有精确的 allowed 决定可以触发副作用。 */
function isAllowed(decision: unknown): decision is { readonly status: 'allowed' } {
  return typeof decision === 'object'
    && decision !== null
    && Object.keys(decision).length === 1
    && (decision as { status?: unknown }).status === 'allowed'
}

function denialReason(decision: unknown): string {
  if (
    typeof decision === 'object'
    && decision !== null
    && Object.keys(decision).length === 2
    && (decision as { status?: unknown }).status === 'denied'
    && typeof (decision as { reason?: unknown }).reason === 'string'
    && (decision as { reason: string }).reason.length > 0
  ) {
    return (decision as { reason: string }).reason
  }
  return '执行策略返回无效授权决定'
}

/** 统一调用支持上下文的新 capability 与保留旧签名的既有 capability。 */
export function executeWithContext(
  tools: ToolCapability,
  call: ToolCall,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  if ('executeWithContext' in tools && typeof tools.executeWithContext === 'function') {
    return tools.executeWithContext(call, context)
  }
  return tools.execute(call, context.signal)
}

function authorizationFailure(call: ToolCall, message: string): ToolResult {
  return {
    status: 'failure',
    callId: call.id,
    error: { name: 'ToolAuthorizationError', message },
  }
}

function normalizeSandboxOptions(options: SandboxToolRegistryOptions): {
  readonly workspace: string | undefined
  readonly limits: SandboxResourceLimits | undefined
} {
  const optionKeys = Object.keys(options)
  if (!optionKeys.every(key => key === 'workspace' || key === 'limits')) {
    throw new TypeError('sandbox options 包含未知字段')
  }
  if (options.workspace !== undefined && (typeof options.workspace !== 'string' || options.workspace.length === 0)) {
    throw new TypeError('sandbox workspace 若提供则必须是非空字符串')
  }
  if (options.limits === undefined) return { workspace: options.workspace, limits: undefined }
  if (typeof options.limits !== 'object' || options.limits === null || Array.isArray(options.limits)) {
    throw new TypeError('sandbox limits 必须是对象')
  }
  const keys = Object.keys(options.limits)
  const expected = ['maxOutputBytes', 'timeoutMs']
  if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) {
    throw new TypeError('sandbox limits 只能包含 timeoutMs 与 maxOutputBytes')
  }
  const { timeoutMs, maxOutputBytes } = options.limits
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('sandbox limits.timeoutMs 必须是正整数')
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new TypeError('sandbox limits.maxOutputBytes 必须是正整数')
  }
  return {
    workspace: options.workspace,
    limits: Object.freeze({ timeoutMs, maxOutputBytes }),
  }
}

/** 为跨 adapter 边界的任务创建不与调用方共享引用的不可变 JSON 快照。 */
function freezeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson))
  const copy: Record<string, JsonValue> = {}
  for (const [key, child] of Object.entries(value)) copy[key] = freezeJson(child)
  return Object.freeze(copy)
}

function cancelledResult(call: ToolCall, reason: unknown): ToolResult {
  return {
    status: 'cancelled',
    callId: call.id,
    reason: reason instanceof Error ? reason.message : String(reason ?? 'cancelled'),
  }
}
