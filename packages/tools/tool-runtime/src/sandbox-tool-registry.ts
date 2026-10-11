import {
  assertJsonValue,
  isAbortError,
  serializeError,
  type ExecutionAwareToolCapability,
  type ExecutionMetadata,
  type ModelToolDefinition,
  type SandboxDispatcher,
  type SandboxResourceLimits,
  type SandboxToolRegistryOptions,
  type ToolCall,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from '@agent-harness/kernel'
import { indexToolDefinitions, toModelToolDefinitions } from './tool-definitions.js'
import { freezeJson } from './json-snapshot.js'
import { authorizationFailure, cancelledResult, unknownToolResult } from './tool-results.js'

/** 将已定义工具的执行委派给 Sandbox，并在 Host 侧先校验模型输入。 */
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
    const indexedDefinitions = indexToolDefinitions(definitions)
    const normalized = normalizeSandboxOptions(options)
    this.#definitions = indexedDefinitions
    this.#dispatcher = dispatcher
    this.#workspace = normalized.workspace
    this.#limits = normalized.limits
  }

  list(): readonly ModelToolDefinition[] { return toModelToolDefinitions(this.#definitions) }

  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    return this.executeWithContext(call, { signal })
  }

  async executeWithContext(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (context.signal.aborted) return cancelledResult(call, context.signal.reason)
    if (context.execution === undefined) return authorizationFailure(call, '缺少冻结执行上下文')
    const definition = this.#definitions.get(call.name)
    if (definition === undefined) return unknownToolResult(call)
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
