import { brandId, type ToolCallId } from '@agent-harness/kernel'
import { ToolRegistry } from '@agent-harness/tools'
import { describe, expect, it } from 'vitest'
import { createSkillLoaderTool } from '../src/index.ts'

const callId = brandId<'ToolCallId'>('call-1') as ToolCallId

describe('createSkillLoaderTool', () => {
  it('读取已启用 Skill 并返回带 ID 的正文', async () => {
    const reads: string[] = []
    const tools = new ToolRegistry([createSkillLoaderTool({
      listEnabled: () => [{ id: 'review', name: '审查', description: '审查代码' }],
      async read(id) { reads.push(id); return '审查步骤' },
    })])
    await expect(tools.execute({ id: callId, name: 'load_skill', input: { id: 'review' } }, new AbortController().signal))
      .resolves.toEqual({ status: 'success', callId, output: { id: 'review', content: '审查步骤' } })
    expect(reads).toEqual(['review'])
  })

  it('在读取前拒绝无效输入，并限制返回正文大小', async () => {
    let reads = 0
    const tools = new ToolRegistry([createSkillLoaderTool({
      listEnabled: () => [{ id: 'x', name: 'x', description: 'x' }],
      async read() { reads += 1; return '过长正文' },
    }, { maxContentBytes: 3 })])
    const signal = new AbortController().signal
    await expect(tools.execute({ id: callId, name: 'load_skill', input: { id: 'x', extra: true } }, signal))
      .resolves.toMatchObject({ status: 'failure', error: { name: 'TypeError' } })
    expect(reads).toBe(0)
    await expect(tools.execute({ id: callId, name: 'load_skill', input: { id: 'x' } }, signal))
      .resolves.toMatchObject({ status: 'failure', error: { name: 'RangeError' } })
  })

  it('在读取前拒绝未启用 ID', async () => {
    let reads = 0
    const tools = new ToolRegistry([createSkillLoaderTool({
      listEnabled: () => [{ id: 'enabled', name: 'enabled', description: 'enabled' }],
      async read() { reads += 1; return 'secret' },
    })])
    await expect(tools.execute(
      { id: callId, name: 'load_skill', input: { id: 'hidden' } },
      new AbortController().signal,
    )).resolves.toMatchObject({ status: 'failure', error: { name: 'SkillNotEnabledError' } })
    expect(reads).toBe(0)
  })

  it('把取消信号传给 catalog，并将取消结算为 cancelled', async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const tools = new ToolRegistry([createSkillLoaderTool({
      listEnabled: () => [{ id: 'x', name: 'x', description: 'x' }],
      async read(_id, signal): Promise<string> {
        observedSignal = signal
        controller.abort(new Error('stop'))
        signal.throwIfAborted()
      },
    })])
    await expect(tools.execute({ id: callId, name: 'load_skill', input: { id: 'x' } }, controller.signal))
      .resolves.toEqual({ status: 'cancelled', callId, reason: 'stop' })
    expect(observedSignal).toBe(controller.signal)
  })
})
