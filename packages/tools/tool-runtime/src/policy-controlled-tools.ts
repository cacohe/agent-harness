import {
  isAbortError,
  serializeError,
  type ExecutionAwareToolCapability,
  type ModelToolDefinition,
  type ToolCall,
  type ToolCapability,
  type ToolExecutionContext,
  type ToolExecutionPolicy,
  type ToolResult,
} from '@agent-harness/kernel'
import { executeWithContext, freezeExecutionContext, freezeToolCall } from './tool-execution.js'
import { authorizationFailure, cancelledResult } from './tool-results.js'

/** 在真实工具前强制执行策略，并把拒绝作为普通工具失败持久化。 */
export class PolicyControlledTools implements ExecutionAwareToolCapability {
  readonly #delegate: ToolCapability
  readonly #policy: ToolExecutionPolicy

  constructor(delegate: ToolCapability, policy: ToolExecutionPolicy) {
    this.#delegate = delegate
    this.#policy = policy
  }

  list(): readonly ModelToolDefinition[] { return this.#delegate.list() }

  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    return this.executeWithContext(call, { signal })
  }

  async executeWithContext(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (context.signal.aborted) return cancelledResult(call, context.signal.reason)
    if (context.execution === undefined) return authorizationFailure(call, '缺少冻结执行上下文')
    let settlementCall = call
    try {
      const authorizedCall = freezeToolCall(call)
      settlementCall = authorizedCall
      const authorizedContext = freezeExecutionContext(context, context.execution)
      const decision = await this.#policy.authorize(authorizedCall, authorizedContext)
      if (context.signal.aborted) return cancelledResult(authorizedCall, context.signal.reason)
      if (!isAllowed(decision)) return authorizationFailure(authorizedCall, denialReason(decision))
      return executeWithContext(this.#delegate, authorizedCall, authorizedContext)
    } catch (error) {
      if (context.signal.aborted || isAbortError(error)) {
        return cancelledResult(settlementCall, context.signal.reason ?? error)
      }
      return authorizationFailure(settlementCall, serializeError(error).message)
    }
  }
}

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
