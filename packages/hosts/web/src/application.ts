import { BoundedPromptAssembler } from '@agent-harness/context-runtime';
import { type AgentObserver, brandId, type SessionId, ToolRegistry } from '@agent-harness/kernel';
import { createWorkspaceTools } from '@agent-harness/local';
import { OpenAiCompatibleModelProvider } from '@agent-harness/openai-compatible';
import { AgentRuntime } from '@agent-harness/runtime';
import { JsonlSessionRepository } from '@agent-harness/session-jsonl';
import type { WebHostConfig } from './config.js';
import { WebUsageError } from './config.js';
import { SessionRegistry, type SessionRuntimeFactory } from './session-registry.js';
import { SessionWorkspaceStore } from './session-workspaces.js';

/** 在 Host 边界组合本地会话、模型和工作目录内工具。 */
export function createSessionRegistry(
  config: WebHostConfig,
  environment: Readonly<Record<string, string | undefined>>,
): SessionRegistry {
  const apiKey = environment[config.model.apiKeyEnv];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new WebUsageError(`环境变量 ${config.model.apiKeyEnv} 未设置`);
  }
  const sessions = new JsonlSessionRepository({ rootDirectory: config.sessionRoot });
  const workspaces = new SessionWorkspaceStore(config.sessionRoot);
  const model = new OpenAiCompatibleModelProvider({
    id: config.model.id,
    baseUrl: config.model.baseUrl,
    apiKey,
    model: config.model.model,
    maxResponseBytes: config.maxModelOutputBytes,
  });
  const factory: SessionRuntimeFactory = {
    create(observer: AgentObserver, workspace: string): AgentRuntime {
      const workspacePrompt = `你正在本地工作目录 ${workspace} 中协助用户。必须使用 list_dir、read_file、write_file 在该目录内查看和修改文件。工具路径相对于工作目录；禁止访问工作目录之外。当前 Web Host 不提供 shell。`;
      const systemPrompt =
        config.agentProfile === undefined
          ? workspacePrompt
          : `${workspacePrompt}\n\n${config.agentProfile.instructions}`;
      return new AgentRuntime({
        sessions,
        model,
        tools: new ToolRegistry(createWorkspaceTools(workspace)),
        maxSteps: config.maxSteps,
        settlementTimeoutMs: config.settlementTimeoutMs,
        runTimeoutMs: config.runTimeoutMs,
        maxModelOutputBytes: config.maxModelOutputBytes,
        maxInputBytes: config.maxInputBytes,
        prompts: new BoundedPromptAssembler({
          maxInputBytes: config.maxInputBytes,
          systemPrompt,
        }),
        observers: [observer],
      });
    },
  };
  return new SessionRegistry(factory, {
    idleTimeoutMs: config.sessionIdleTimeoutMs,
    onIdleCloseError: (error) => console.error('空闲 Web 会话关闭失败', error),
    async readEvents(sessionId, signal) {
      const reader = await sessions.open(brandId<'SessionId'>(sessionId) as SessionId, {
        mode: 'read',
        signal,
      });
      try {
        return await reader.read({ signal });
      } finally {
        await reader.close({ signal });
      }
    },
    createWorkspace: (sessionId, workspace) => workspaces.create(sessionId, workspace),
    readWorkspace: (sessionId) => workspaces.read(sessionId),
  });
}
