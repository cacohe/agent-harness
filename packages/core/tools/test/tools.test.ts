import { brandId, type ExecutionId, type ToolCallId } from '@agent-harness/kernel'
import { describe, expect, it } from 'vitest'
import {
  CompositeToolCapability,
  PolicyControlledTools,
  SandboxToolRegistry,
  ToolRegistry,
  type ExecutionAwareToolCapability,
} from '../src/index.ts'

function call(name: string, input: unknown = {}) {
  return {
    id: brandId<'ToolCallId'>('call-1') as ToolCallId,
    name,
    input,
  }
}

describe('ToolRegistry', () => {
  it('拒绝重复工具注册', () => {
    const definition = {
      name: 'lookup',
      description: '查询',
      inputSchema: { type: 'object' },
      parseInput: input => input,
      execute: async () => ({ ok: true }),
    }
    expect(() => new ToolRegistry([definition, definition])).toThrow(
      'duplicate tool registration: lookup',
    )
  })

  it('list 暴露模型可见 schema 且不含执行函数', () => {
    const registry = new ToolRegistry([
      {
        name: 'lookup',
        description: '查询',
        inputSchema: { type: 'object' },
        parseInput: input => input,
        execute: async () => ({ ok: true }),
      },
    ])

    expect(registry.list()).toEqual([
      {
        name: 'lookup',
        description: '查询',
        inputSchema: { type: 'object' },
      },
    ])
  })

  it('成功执行并校验输出为 JSON', async () => {
    const registry = new ToolRegistry([
      {
        name: 'lookup',
        description: '查询',
        inputSchema: { type: 'object' },
        parseInput: input => input,
        execute: async input => ({ echoed: input }),
      },
    ])

    await expect(
      registry.execute(call('lookup', { q: 1 }), new AbortController().signal),
    ).resolves.toEqual({
      status: 'success',
      callId: 'call-1',
      output: { echoed: { q: 1 } },
    })
  })

  it('未知工具与执行抛错都返回 failure', async () => {
    const registry = new ToolRegistry([
      {
        name: 'lookup',
        description: '查询',
        inputSchema: { type: 'object' },
        parseInput: input => input,
        execute: async () => {
          throw new Error('boom')
        },
      },
    ])
    const signal = new AbortController().signal

    await expect(registry.execute(call('missing'), signal)).resolves.toMatchObject({
      status: 'failure',
      error: { name: 'UnknownToolError' },
    })
    await expect(registry.execute(call('lookup'), signal)).resolves.toEqual({
      status: 'failure',
      callId: 'call-1',
      error: { name: 'Error', message: 'boom' },
    })
  })

  it('在执行副作用前拒绝未通过输入解析的模型 JSON', async () => {
    let executed = false
    const registry = new ToolRegistry([{
      name: 'lookup',
      description: '查询',
      inputSchema: { type: 'object' },
      parseInput: () => { throw new TypeError('q 必须是字符串') },
      execute: async () => {
        executed = true
        return { ok: true }
      },
    }])

    await expect(registry.execute(call('lookup'), new AbortController().signal)).resolves.toMatchObject({
      status: 'failure',
      error: { name: 'TypeError', message: 'q 必须是字符串' },
    })
    expect(executed).toBe(false)
  })

  it('拒绝非 JSON 输出', async () => {
    const registry = new ToolRegistry([
      {
        name: 'lookup',
        description: '查询',
        inputSchema: { type: 'object' },
        parseInput: input => input,
        execute: async () => () => undefined,
      },
    ])

    await expect(
      registry.execute(call('lookup'), new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'failure',
      error: { name: 'TypeError' },
    })
  })

  it('已中止或执行中取消时返回 cancelled', async () => {
    const controller = new AbortController()
    const registry = new ToolRegistry([
      {
        name: 'lookup',
        description: '查询',
        inputSchema: { type: 'object' },
        parseInput: input => input,
        async execute() {
          controller.abort(new Error('stop'))
          return { ok: true }
        },
      },
    ])

    await expect(
      registry.execute(call('lookup'), controller.signal),
    ).resolves.toEqual({
      status: 'cancelled',
      callId: 'call-1',
      reason: 'stop',
    })

    const preAborted = new AbortController()
    preAborted.abort(new Error('already'))
    await expect(
      registry.execute(call('lookup'), preAborted.signal),
    ).resolves.toEqual({
      status: 'cancelled',
      callId: 'call-1',
      reason: 'already',
    })
  })

  it('策略拒绝时不执行工具，并把拒绝持久化为失败结果', async () => {
    let executed = false
    const tools = new PolicyControlledTools(new ToolRegistry([{
      name: 'write',
      description: '写入',
      inputSchema: { type: 'object' },
      parseInput: input => input,
      execute: async () => {
        executed = true
        return { ok: true }
      },
    }]), {
      authorize: async () => ({ status: 'denied', reason: '需要审批' }),
    })

    await expect(tools.executeWithContext(call('write'), {
      signal: new AbortController().signal,
      execution: {
        id: brandId<'ExecutionId'>('execution-1') as ExecutionId,
        subject: 'user-1',
        authorizationVersion: 'v1',
      },
    })).resolves.toEqual({
      status: 'failure',
      callId: 'call-1',
      error: { name: 'ToolAuthorizationError', message: '需要审批' },
    })
    expect(executed).toBe(false)
  })

  it('策略收到冻结上下文后才委派工具', async () => {
    const observed: string[] = []
    const tools = new PolicyControlledTools(new ToolRegistry([{
      name: 'write',
      description: '写入',
      inputSchema: { type: 'object' },
      parseInput: input => input,
      execute: async (_input, context) => ({ subject: context.execution?.subject ?? 'missing' }),
    }]), {
      authorize: async (_call, context) => {
        observed.push(context.execution.id)
        return { status: 'allowed' }
      },
    })

    await expect(tools.executeWithContext(call('write'), {
      signal: new AbortController().signal,
      execution: {
        id: brandId<'ExecutionId'>('execution-1') as ExecutionId,
        subject: 'user-1',
        authorizationVersion: 'v1',
      },
    })).resolves.toMatchObject({ status: 'success', output: { subject: 'user-1' } })
    expect(observed).toEqual(['execution-1'])
  })

  it('授权等待期间的调用和执行身份修改不影响真实执行', async () => {
    let release!: () => void
    const authorized = new Promise<void>(resolve => { release = resolve })
    const observed: unknown[] = []
    const tools = new PolicyControlledTools(new ToolRegistry([{
      name: 'write',
      description: '写入',
      inputSchema: { type: 'object' },
      parseInput: input => input,
      execute: async (input, context) => ({
        input,
        subject: context.execution?.subject ?? 'missing',
      }),
    }]), {
      authorize: async (authorizedCall, authorizedContext) => {
        observed.push({ call: authorizedCall, execution: authorizedContext.execution })
        await authorized
        return { status: 'allowed' }
      },
    })
    const input = { path: 'before' }
    const execution = {
      id: brandId<'ExecutionId'>('execution-1') as ExecutionId,
      subject: 'user-1',
      authorizationVersion: 'v1',
    }
    const mutableCall = call('write', input)
    const running = tools.executeWithContext(mutableCall, {
      signal: new AbortController().signal,
      execution,
    })

    input.path = 'after'
    execution.subject = 'attacker'
    ;(mutableCall as { name: string }).name = 'missing'
    release()

    await expect(running).resolves.toMatchObject({
      status: 'success',
      output: { input: { path: 'before' }, subject: 'user-1' },
    })
    expect(observed).toEqual([{
      call: { id: 'call-1', name: 'write', input: { path: 'before' } },
      execution: { id: 'execution-1', subject: 'user-1', authorizationVersion: 'v1' },
    }])
    const snapshot = observed[0] as { call: object, execution: object }
    expect(Object.isFrozen(snapshot.call)).toBe(true)
    expect(Object.isFrozen(snapshot.execution)).toBe(true)
  })

  it.each(['denied', 'error', 'cancelled'] as const)(
    '授权等待后的 %s 使用冻结 call ID 结算',
    async outcome => {
      let release!: () => void
      const authorized = new Promise<void>(resolve => { release = resolve })
      const controller = new AbortController()
      const tools = new PolicyControlledTools(new ToolRegistry([]), {
        authorize: async () => {
          await authorized
          if (outcome === 'error') throw new Error('Platform 响应无效')
          if (outcome === 'denied') return { status: 'denied', reason: '需要审批' }
          return { status: 'allowed' }
        },
      })
      const mutableCall = call('write')
      const running = tools.executeWithContext(mutableCall, {
        signal: controller.signal,
        execution: {
          id: brandId<'ExecutionId'>('execution-1') as ExecutionId,
          subject: 'user-1',
          authorizationVersion: 'v1',
        },
      })

      ;(mutableCall as { id: ToolCallId }).id = brandId<'ToolCallId'>('tampered') as ToolCallId
      if (outcome === 'cancelled') controller.abort('用户取消')
      release()

      await expect(running).resolves.toMatchObject({
        status: outcome === 'cancelled' ? 'cancelled' : 'failure',
        callId: 'call-1',
      })
    },
  )

  it('冻结 JSON 时保留 __proto__ 自有字段且不修改对象原型', async () => {
    const input = JSON.parse('{"__proto__":{"admin":true},"value":1}') as Record<string, unknown>
    let observedInput: unknown
    const tools = new PolicyControlledTools(new ToolRegistry([{
      name: 'inspect',
      description: '检查输入',
      inputSchema: { type: 'object' },
      parseInput: value => value,
      execute: async value => value,
    }]), {
      authorize: async authorizedCall => {
        observedInput = authorizedCall.input
        return { status: 'allowed' }
      },
    })

    const result = await tools.executeWithContext(call('inspect', input), {
      signal: new AbortController().signal,
      execution: {
        id: brandId<'ExecutionId'>('execution-1') as ExecutionId,
        subject: 'user-1',
        authorizationVersion: 'v1',
      },
    })
    expect(result).toMatchObject({ status: 'success', callId: 'call-1' })
    if (result.status !== 'success') throw new Error('预期工具成功')
    const output = result.output as Record<string, unknown>
    expect(Object.hasOwn(output, '__proto__')).toBe(true)
    expect(output['__proto__']).toEqual({ admin: true })
    expect(output.value).toBe(1)
    expect(Object.hasOwn(observedInput as object, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(observedInput as object)).toBe(Object.prototype)
  })

  it('无效策略结果 fail closed，且不执行工具', async () => {
    let executed = false
    const tools = new PolicyControlledTools(new ToolRegistry([{
      name: 'write',
      description: '写入',
      inputSchema: { type: 'object' },
      parseInput: input => input,
      execute: async () => {
        executed = true
        return { ok: true }
      },
    }]), {
      authorize: async () => ({ status: 'pending' } as never),
    })

    await expect(tools.executeWithContext(call('write'), {
      signal: new AbortController().signal,
      execution: {
        id: brandId<'ExecutionId'>('execution-1') as ExecutionId,
        subject: 'user-1',
        authorizationVersion: 'v1',
      },
    })).resolves.toMatchObject({
      status: 'failure',
      error: { name: 'ToolAuthorizationError', message: '执行策略返回无效授权决定' },
    })
    expect(executed).toBe(false)
  })

  it('Sandbox 在派发前校验输入，并传递任务边界', async () => {
    const tasks: unknown[] = []
    const tools = new SandboxToolRegistry([{
      name: 'write',
      description: '写入',
      inputSchema: { type: 'object' },
      parseInput: input => {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw new TypeError('输入必须是对象')
        }
        return { normalized: true }
      },
      execute: async () => ({ local: true }),
    }], {
      dispatch: async task => {
        tasks.push(task)
        return { sandboxed: true }
      },
    }, {
      workspace: '/workspace',
      limits: { timeoutMs: 1_000, maxOutputBytes: 4_096 },
    })

    await expect(tools.executeWithContext(call('write'), {
      signal: new AbortController().signal,
      execution: {
        id: brandId<'ExecutionId'>('execution-1') as ExecutionId,
        subject: 'user-1',
        authorizationVersion: 'v1',
      },
    })).resolves.toEqual({
      status: 'success', callId: 'call-1', output: { sandboxed: true },
    })
    expect(tasks).toEqual([{
      call: { id: 'call-1', name: 'write', input: { normalized: true } },
      workspace: '/workspace',
      limits: { timeoutMs: 1_000, maxOutputBytes: 4_096 },
    }])
  })

  it('Sandbox 输入校验失败时不派发任务', async () => {
    let dispatched = false
    const tools = new SandboxToolRegistry([{
      name: 'write',
      description: '写入',
      inputSchema: { type: 'object' },
      parseInput: () => { throw new TypeError('无效输入') },
      execute: async () => ({ local: true }),
    }], {
      dispatch: async () => {
        dispatched = true
        return { sandboxed: true }
      },
    })

    await expect(tools.executeWithContext(call('write'), {
      signal: new AbortController().signal,
      execution: {
        id: brandId<'ExecutionId'>('execution-1') as ExecutionId,
        subject: 'user-1',
        authorizationVersion: 'v1',
      },
    })).resolves.toMatchObject({
      status: 'failure', error: { name: 'TypeError', message: '无效输入' },
    })
    expect(dispatched).toBe(false)
  })

  it('Sandbox 使用与普通注册表一致的唯一注册规则', () => {
    const definition = {
      name: 'write',
      description: '写入',
      inputSchema: { type: 'object' },
      parseInput: (input: unknown) => input,
      execute: async () => ({ ok: true }),
    }

    expect(() => new SandboxToolRegistry([definition, definition], {
      dispatch: async () => ({ ok: true }),
    })).toThrow('duplicate tool registration: write')
  })

  it('Sandbox list 只暴露模型可见 schema', () => {
    const tools = new SandboxToolRegistry([{
      name: 'write',
      description: '写入',
      inputSchema: { type: 'object' },
      parseInput: input => input,
      execute: async () => ({ ok: true }),
    }], { dispatch: async () => ({ ok: true }) })

    expect(tools.list()).toEqual([{
      name: 'write',
      description: '写入',
      inputSchema: { type: 'object' },
    }])
  })

  it('Sandbox 缺少冻结执行上下文时拒绝派发', async () => {
    let dispatched = false
    const tools = new SandboxToolRegistry([{
      name: 'write', description: '写入', inputSchema: { type: 'object' },
      parseInput: input => input, execute: async () => ({ ok: true }),
    }], { dispatch: async () => { dispatched = true; return { ok: true } } })

    await expect(tools.execute(call('write'), new AbortController().signal)).resolves.toMatchObject({
      status: 'failure', error: { name: 'ToolAuthorizationError' },
    })
    expect(dispatched).toBe(false)
  })

  it('Sandbox 复制冻结资源限制，并拒绝不完整限制', async () => {
    const limits = { timeoutMs: 1_000, maxOutputBytes: 4_096 }
    const observed: unknown[] = []
    const tools = new SandboxToolRegistry([{
      name: 'write', description: '写入', inputSchema: { type: 'object' },
      parseInput: input => input, execute: async () => ({ ok: true }),
    }], { dispatch: async task => { observed.push(task.limits); return { ok: true } } }, { limits })
    limits.timeoutMs = 0

    await tools.executeWithContext(call('write'), {
      signal: new AbortController().signal,
      execution: {
        id: brandId<'ExecutionId'>('execution-1') as ExecutionId,
        subject: 'user-1', authorizationVersion: 'v1',
      },
    })
    expect(observed).toEqual([{ timeoutMs: 1_000, maxOutputBytes: 4_096 }])
    expect(() => new SandboxToolRegistry([], { dispatch: async () => ({}) }, {
      limits: { timeoutMs: 1_000 } as never,
    })).toThrow('sandbox limits 只能包含')
  })

  it('Sandbox 在跨边界前拒绝 parser 返回的非 JSON', async () => {
    let dispatched = false
    const tools = new SandboxToolRegistry([{
      name: 'write', description: '写入', inputSchema: { type: 'object' },
      parseInput: () => (() => undefined) as never, execute: async () => ({ ok: true }),
    }], { dispatch: async () => { dispatched = true; return { ok: true } } })

    await expect(tools.executeWithContext(call('write'), {
      signal: new AbortController().signal,
      execution: {
        id: brandId<'ExecutionId'>('execution-1') as ExecutionId,
        subject: 'user-1', authorizationVersion: 'v1',
      },
    })).resolves.toMatchObject({ status: 'failure', error: { name: 'TypeError' } })
    expect(dispatched).toBe(false)
  })
})

describe('CompositeToolCapability', () => {
  const registry = (name: string) => new ToolRegistry([{
    name,
    description: name,
    inputSchema: { type: 'object' },
    parseInput: input => input,
    execute: async input => ({ source: name, input }),
  }])

  it('合并目录并按名称路由执行', async () => {
    const tools = new CompositeToolCapability([registry('local'), registry('remote')])
    expect(tools.list().map(tool => tool.name)).toEqual(['local', 'remote'])
    await expect(tools.execute(
      call('remote', { q: 'x' }),
      new AbortController().signal,
    )).resolves.toMatchObject({ status: 'success', output: { source: 'remote', input: { q: 'x' } } })
  })

  it('在组合时拒绝跨来源重复工具名', () => {
    expect(() => new CompositeToolCapability([registry('same'), registry('same')]))
      .toThrow('duplicate tool registration: same')
  })

  it('固定模型可见目录，避免来源事后修改 schema', () => {
    const inputSchema = { type: 'object' }
    const source = registry('stable')
    const mutableSource = {
      list: () => [{ name: 'stable', description: 'stable', inputSchema }],
      execute: source.execute.bind(source),
    }
    const tools = new CompositeToolCapability([mutableSource])
    inputSchema.type = 'array'
    expect(tools.list()).toEqual([{
      name: 'stable', description: 'stable', inputSchema: { type: 'object' },
    }])
  })

  it('把冻结执行上下文传给支持它的来源', async () => {
    let subject: string | undefined
    const aware: ExecutionAwareToolCapability = {
      list: () => [{ name: 'write', description: 'write', inputSchema: { type: 'object' } }],
      execute: async toolCall => ({ status: 'failure', callId: toolCall.id, error: { name: 'Unexpected', message: '未传上下文' } }),
      async executeWithContext(toolCall, context) {
        subject = context.execution?.subject
        return { status: 'success', callId: toolCall.id, output: { ok: true } }
      },
    }
    const tools = new CompositeToolCapability([aware])
    await expect(tools.executeWithContext(call('write'), {
      signal: new AbortController().signal,
      execution: {
        id: brandId<'ExecutionId'>('execution-composite') as ExecutionId,
        subject: 'user-composite',
        authorizationVersion: 'v1',
      },
    })).resolves.toMatchObject({ status: 'success' })
    expect(subject).toBe('user-composite')
  })

  it('对未知工具和已取消调用返回稳定结果', async () => {
    const tools = new CompositeToolCapability([])
    await expect(tools.execute(call('missing'), new AbortController().signal)).resolves.toMatchObject({
      status: 'failure', error: { name: 'UnknownToolError' },
    })
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(tools.execute(call('missing'), controller.signal)).resolves.toEqual({
      status: 'cancelled', callId: 'call-1', reason: 'stop',
    })
  })
})
