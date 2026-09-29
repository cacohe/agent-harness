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

function cancelledResult(call: ToolCall, reason: unknown): ToolResult {
  return {
    status: 'cancelled',
    callId: call.id,
    reason: reason instanceof Error ? reason.message : String(reason ?? 'cancelled'),
  }
}
