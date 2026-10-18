import type { ExecutionMetadata } from '../agent.js';
import type { JsonValue } from '../serialization.js';
import {
  assertJsonValue,
  freezeJsonValue,
  isAbortError,
  serializeError,
} from '../serialization.js';
import type {
  ExecutableTool,
  ModelToolDefinition,
  SandboxDispatcher,
  SandboxResourceLimits,
  SandboxToolSetOptions,
  ToolCall,
  ToolContract,
  ToolExecutionContext,
  ToolExecutionPolicy,
  ToolResult,
  ToolSet,
} from './protocol.js';
import { toModelToolDefinition } from './protocol.js';

/** 不可变的直接执行工具集，也是顺序工具执行器。 */
export class DirectToolSet implements ToolSet {
  readonly #definitions: ReadonlyMap<string, ExecutableTool>;

  constructor(definitions: readonly ExecutableTool[]) {
    this.#definitions = indexTools(definitions);
  }

  list(): readonly ModelToolDefinition[] {
    return toModelToolDefinitions(this.#definitions);
  }

  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    return settleRegisteredCall(call, context, this.#definitions, (tool, input) =>
      tool.execute(input, context),
    );
  }
}

/** 将工具契约的执行委派给 Sandbox，并在 Host 侧先校验模型输入。 */
export class SandboxToolSet implements ToolSet {
  readonly #definitions: ReadonlyMap<string, ToolContract>;
  readonly #dispatcher: SandboxDispatcher;
  readonly #workspace: string | undefined;
  readonly #limits: SandboxResourceLimits | undefined;

  constructor(
    definitions: readonly ToolContract[],
    dispatcher: SandboxDispatcher,
    options: SandboxToolSetOptions = {},
  ) {
    this.#definitions = indexTools(definitions);
    const normalized = normalizeSandboxOptions(options);
    this.#dispatcher = dispatcher;
    this.#workspace = normalized.workspace;
    this.#limits = normalized.limits;
  }

  list(): readonly ModelToolDefinition[] {
    return toModelToolDefinitions(this.#definitions);
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (context.signal.aborted) {
      return cancelledResult(call, context.signal.reason);
    }
    if (!hasExecution(context)) {
      return authorizationFailure(call, '缺少冻结执行上下文');
    }
    return settleRegisteredCall(call, context, this.#definitions, (_tool, input) => {
      assertJsonValue(input);
      const task = Object.freeze({
        call: Object.freeze({ ...call, input: freezeJsonValue(input) }),
        ...(this.#workspace === undefined ? {} : { workspace: this.#workspace }),
        ...(this.#limits === undefined ? {} : { limits: this.#limits }),
      });
      return this.#dispatcher.dispatch(task, context);
    });
  }
}

/** 在执行工具前强制执行策略，并把拒绝作为普通工具失败持久化。 */
export class PolicyControlledToolSet implements ToolSet {
  readonly #delegate: ToolSet;
  readonly #policy: ToolExecutionPolicy;

  constructor(delegate: ToolSet, policy: ToolExecutionPolicy) {
    this.#delegate = delegate;
    this.#policy = policy;
  }

  list(): readonly ModelToolDefinition[] {
    return this.#delegate.list();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (context.signal.aborted) {
      return cancelledResult(call, context.signal.reason);
    }
    if (!hasExecution(context)) {
      return authorizationFailure(call, '缺少冻结执行上下文');
    }
    let settlementCall = call;
    try {
      const authorizedCall = freezeToolCall(call);
      settlementCall = authorizedCall;
      const authorizedContext = freezeExecutionContext(context);
      const decision = await this.#policy.authorize(authorizedCall, authorizedContext);
      if (context.signal.aborted) {
        return cancelledResult(authorizedCall, context.signal.reason);
      }
      if (!isAllowed(decision)) {
        return authorizationFailure(authorizedCall, denialReason(decision));
      }
      return this.#delegate.execute(authorizedCall, authorizedContext);
    } catch (error) {
      if (context.signal.aborted || isAbortError(error)) {
        return cancelledResult(settlementCall, context.signal.reason ?? error);
      }
      return authorizationFailure(settlementCall, serializeError(error).message);
    }
  }
}

/** 将多个已就绪的工具来源合并为单一目录，并按工具名路由执行。 */
export class CompositeToolSet implements ToolSet {
  readonly #definitions: readonly ModelToolDefinition[];
  readonly #routes: ReadonlyMap<string, ToolSet>;

  constructor(toolSets: readonly ToolSet[]) {
    const definitions: ModelToolDefinition[] = [];
    const routes = new Map<string, ToolSet>();
    for (const toolSet of toolSets) {
      for (const definition of toolSet.list()) {
        if (routes.has(definition.name)) {
          throw new DuplicateToolNameError(definition.name);
        }
        assertJsonValue(definition.inputSchema);
        routes.set(definition.name, toolSet);
        definitions.push(
          Object.freeze({
            name: definition.name,
            description: definition.description,
            inputSchema: freezeJsonValue(definition.inputSchema as JsonValue) as Readonly<
              Record<string, unknown>
            >,
          }),
        );
      }
    }
    this.#definitions = Object.freeze(definitions);
    this.#routes = routes;
  }

  list(): readonly ModelToolDefinition[] {
    return this.#definitions;
  }

  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (context.signal.aborted) {
      return Promise.resolve(cancelledResult(call, context.signal.reason));
    }
    const capability = this.#routes.get(call.name);
    if (capability === undefined) {
      return Promise.resolve(unknownToolResult(call));
    }
    return capability.execute(call, context);
  }
}

/** 工具来源在组合时暴露了重复名称。 */
export class DuplicateToolNameError extends Error {
  override readonly name = 'DuplicateToolNameError';

  constructor(readonly toolName: string) {
    super(`duplicate tool registration: ${toolName}`);
  }
}

/** 结算一次已登记工具调用：查找、解析输入、执行，并把输出或异常收成终态。 */
async function settleRegisteredCall<T extends ToolContract>(
  call: ToolCall,
  context: ToolExecutionContext,
  definitions: ReadonlyMap<string, T>,
  run: (tool: T, input: JsonValue) => Promise<JsonValue>,
): Promise<ToolResult> {
  const { signal } = context;
  if (signal.aborted) {
    return cancelledResult(call, signal.reason);
  }
  const tool = definitions.get(call.name);
  if (tool === undefined) {
    return unknownToolResult(call);
  }
  try {
    const input = tool.parseInput(call.input);
    const output = await run(tool, input);
    if (signal.aborted) {
      return cancelledResult(call, signal.reason);
    }
    assertJsonValue(output);
    return { status: 'success', callId: call.id, output };
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      return cancelledResult(call, signal.reason ?? error);
    }
    return { status: 'failure', callId: call.id, error: serializeError(error) };
  }
}

function cancelledResult(call: ToolCall, reason: unknown): ToolResult {
  return {
    status: 'cancelled',
    callId: call.id,
    reason: reason instanceof Error ? reason.message : String(reason ?? 'cancelled'),
  };
}

function unknownToolResult(call: ToolCall): ToolResult {
  return {
    status: 'failure',
    callId: call.id,
    error: { name: 'UnknownToolError', message: `unknown tool: ${call.name}` },
  };
}

function authorizationFailure(call: ToolCall, message: string): ToolResult {
  return { status: 'failure', callId: call.id, error: { name: 'ToolAuthorizationError', message } };
}

/** 将工具列表构建工具名称到工具的映射列表，用于按名称路由工具。 */
function indexTools<T extends ToolContract>(definitions: readonly T[]): ReadonlyMap<string, T> {
  const entries = new Map<string, T>();
  for (const definition of definitions) {
    if (entries.has(definition.name)) {
      throw new Error(`duplicate tool registration: ${definition.name}`);
    }
    entries.set(definition.name, definition);
  }
  return entries;
}

/** 将工具契约转换为模型可见的只读定义。 */
function toModelToolDefinitions(
  definitions: ReadonlyMap<string, ToolContract>,
): readonly ModelToolDefinition[] {
  return [...definitions.values()].map(toModelToolDefinition);
}

function normalizeSandboxOptions(options: SandboxToolSetOptions): {
  readonly workspace: string | undefined;
  readonly limits: SandboxResourceLimits | undefined;
} {
  const optionKeys = Object.keys(options);
  if (!optionKeys.every((key) => key === 'workspace' || key === 'limits')) {
    throw new TypeError('sandbox options 包含未知字段');
  }
  if (
    options.workspace !== undefined &&
    (typeof options.workspace !== 'string' || options.workspace.length === 0)
  ) {
    throw new TypeError('sandbox workspace 若提供则必须是非空字符串');
  }
  if (options.limits === undefined) {
    return { workspace: options.workspace, limits: undefined };
  }
  if (
    typeof options.limits !== 'object' ||
    options.limits === null ||
    Array.isArray(options.limits)
  ) {
    throw new TypeError('sandbox limits 必须是对象');
  }
  const keys = Object.keys(options.limits);
  const expected = ['maxOutputBytes', 'timeoutMs'];
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    throw new TypeError('sandbox limits 只能包含 timeoutMs 与 maxOutputBytes');
  }
  const { timeoutMs, maxOutputBytes } = options.limits;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('sandbox limits.timeoutMs 必须是正整数');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new TypeError('sandbox limits.maxOutputBytes 必须是正整数');
  }
  return {
    workspace: options.workspace,
    limits: Object.freeze({ timeoutMs, maxOutputBytes }),
  };
}

function hasExecution(
  context: ToolExecutionContext,
): context is ToolExecutionContext & { readonly execution: ExecutionMetadata } {
  return context.execution !== undefined;
}

function isAllowed(decision: unknown): decision is { readonly status: 'allowed' } {
  return (
    typeof decision === 'object' &&
    decision !== null &&
    Object.keys(decision).length === 1 &&
    (decision as { status?: unknown }).status === 'allowed'
  );
}

function denialReason(decision: unknown): string {
  if (
    typeof decision === 'object' &&
    decision !== null &&
    Object.keys(decision).length === 2 &&
    (decision as { status?: unknown }).status === 'denied' &&
    typeof (decision as { reason?: unknown }).reason === 'string' &&
    (decision as { reason: string }).reason.length > 0
  ) {
    return (decision as { reason: string }).reason;
  }
  return '执行策略返回无效授权决定';
}

function freezeToolCall(call: ToolCall): ToolCall {
  assertJsonValue(call.input);
  return Object.freeze({ id: call.id, name: call.name, input: freezeJsonValue(call.input) });
}

function freezeExecutionContext(
  context: ToolExecutionContext & { readonly execution: ExecutionMetadata },
): ToolExecutionContext & { readonly execution: ExecutionMetadata } {
  return Object.freeze({
    signal: context.signal,
    execution: Object.freeze({
      id: context.execution.id,
      subject: context.execution.subject,
      authorizationVersion: context.execution.authorizationVersion,
    }),
  });
}
