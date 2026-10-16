import type { ExecutionMetadata } from '../agent.js';
import type { JsonValue } from '../serialization.js';
import { assertJsonValue, isAbortError, serializeError } from '../serialization.js';
import { toModelToolDefinition } from './protocol.js';
import type {
  ModelToolDefinition,
  SandboxDispatcher,
  SandboxResourceLimits,
  SandboxToolSetOptions,
  ToolCall,
  ExecutableTool,
  ToolExecutionContext,
  ToolExecutionPolicy,
  ToolResult,
  ToolContract,
  ToolSet,
} from './protocol.js';

/** 不可变的直接执行工具注册表，也是顺序工具执行器。 */
export class ToolRegistry implements ToolSet {
  readonly #definitions: ReadonlyMap<string, ExecutableTool>;

  constructor(definitions: readonly ExecutableTool[]) {
    this.#definitions = indexTools(definitions);
  }

  list(): readonly ModelToolDefinition[] {
    return toModelToolDefinitions(this.#definitions);
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const { signal } = context;
    if (signal.aborted) {
      return cancelledResult(call, signal.reason);
    }
    const definition = this.#definitions.get(call.name);
    if (definition === undefined) {
      return unknownToolResult(call);
    }
    try {
      const input = definition.parseInput(call.input);
      const output = await definition.execute(input, context);
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
    const definition = this.#definitions.get(call.name);
    if (definition === undefined) {
      return unknownToolResult(call);
    }
    try {
      const input = definition.parseInput(call.input);
      assertJsonValue(input);
      const task = Object.freeze({
        call: Object.freeze({ ...call, input: freezeJson(input) }),
        ...(this.#workspace === undefined ? {} : { workspace: this.#workspace }),
        ...(this.#limits === undefined ? {} : { limits: this.#limits }),
      });
      const output = await this.#dispatcher.dispatch(task, context);
      if (context.signal.aborted) {
        return cancelledResult(call, context.signal.reason);
      }
      assertJsonValue(output);
      return { status: 'success', callId: call.id, output };
    } catch (error) {
      if (context.signal.aborted || isAbortError(error)) {
        return cancelledResult(call, context.signal.reason ?? error);
      }
      return { status: 'failure', callId: call.id, error: serializeError(error) };
    }
  }
}

/** 在真实工具前强制执行策略，并把拒绝作为普通工具失败持久化。 */
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

/** 工具来源在组合时暴露了重复名称。 */
export class DuplicateToolNameError extends Error {
  override readonly name = 'DuplicateToolNameError';

  constructor(readonly toolName: string) {
    super(`duplicate tool registration: ${toolName}`);
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
            inputSchema: freezeJson(definition.inputSchema as JsonValue) as Readonly<
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

function toModelToolDefinitions(
  definitions: ReadonlyMap<string, ToolContract>,
): readonly ModelToolDefinition[] {
  return [...definitions.values()].map(toModelToolDefinition);
}

function authorizationFailure(call: ToolCall, message: string): ToolResult {
  return { status: 'failure', callId: call.id, error: { name: 'ToolAuthorizationError', message } };
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

function freezeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeJson));
  }
  const copy: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: freezeJson(child),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(copy);
}

function freezeToolCall(call: ToolCall): ToolCall {
  assertJsonValue(call.input);
  return Object.freeze({ id: call.id, name: call.name, input: freezeJson(call.input) });
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
