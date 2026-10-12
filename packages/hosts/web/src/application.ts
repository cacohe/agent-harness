import { BoundedPromptAssembler } from '@agent-harness/context-runtime'
import type { AgentObserver } from '@agent-harness/kernel'
import { OpenAiCompatibleModelProvider } from '@agent-harness/openai-compatible'
import { AgentRuntime } from '@agent-harness/runtime'
import { JsonlSessionRepository } from '@agent-harness/session-jsonl'
import { ToolRegistry } from '@agent-harness/tool-runtime'
import type { WebHostConfig } from './config.js'
import { WebUsageError } from './config.js'
import { SessionRegistry, type SessionRuntimeFactory } from './session-registry.js'

/** 在 Host 边界组合本地会话、模型和无工具的首版聊天 Agent。 */
export function createSessionRegistry(
  config: WebHostConfig,
  environment: Readonly<Record<string, string | undefined>>,
): SessionRegistry {
  const apiKey = environment[config.model.apiKeyEnv]
  if (apiKey === undefined || apiKey.length === 0) {
    throw new WebUsageError(`环境变量 ${config.model.apiKeyEnv} 未设置`)
  }
  const sessions = new JsonlSessionRepository({ rootDirectory: config.sessionRoot })
  const model = new OpenAiCompatibleModelProvider({
    id: config.model.id,
    baseUrl: config.model.baseUrl,
    apiKey,
    model: config.model.model,
    maxResponseBytes: config.maxModelOutputBytes,
  })
  const tools = new ToolRegistry([])
  const factory: SessionRuntimeFactory = {
    create(observer: AgentObserver): AgentRuntime {
      return new AgentRuntime({
        sessions,
        model,
        tools,
        maxSteps: config.maxSteps,
        settlementTimeoutMs: config.settlementTimeoutMs,
        runTimeoutMs: config.runTimeoutMs,
        maxModelOutputBytes: config.maxModelOutputBytes,
        maxInputBytes: config.maxInputBytes,
        prompts: new BoundedPromptAssembler({
          maxInputBytes: config.maxInputBytes,
          ...(config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt }),
        }),
        observers: [observer],
      })
    },
  }
  return new SessionRegistry(factory, {
    idleTimeoutMs: config.sessionIdleTimeoutMs,
    onIdleCloseError: error => console.error('空闲 Web 会话关闭失败', error),
  })
}
