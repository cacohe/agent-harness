import { readFile as nodeReadFile } from 'node:fs/promises';
import { BoundedPromptAssembler } from '@agent-harness/adapters/context';
import { createLocalSessionRepository } from '@agent-harness/adapters/local-runtime';
import type { McpToolAdapter } from '@agent-harness/adapters/mcp';
import { RetrievedMemoryContext } from '@agent-harness/adapters/memory-context';
import { EnabledSkillsContext } from '@agent-harness/adapters/skill-context';
import { FilesystemSkillCatalog } from '@agent-harness/adapters/skill-filesystem';
import {
  brandId,
  findSessionMessageSubmission,
  type MessageId,
  type SessionId,
  type SessionMessageSubmission,
} from '@agent-harness/kernel';
import { AgentRuntime } from '@agent-harness/runtime';
import { createStdinLines, openChatSession, runChatLoop } from './chat.js';
import { parseArgv } from './command.js';
import {
  composeTools,
  createMcpAdapter,
  createMemoryCapabilities,
  createModelProvider,
} from './composition.js';
import { CliUsageError, readConfig } from './config.js';
import type { CliDependencies, CliOutput } from './contracts.js';
import { diagnostic } from './diagnostics.js';
import { readBoundedDocumentFile } from './document-file.js';

export type { CliDependencies, CliOutput, CliSignals } from './contracts.js';

/** 无论前一个资源是否失败都关闭全部资源，并返回所有关闭错误。 */
export async function closeCliResources(
  resources: readonly { close(): Promise<void> }[],
): Promise<readonly unknown[]> {
  const errors: unknown[] = [];
  for (const resource of resources) {
    try {
      await resource.close();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

/** 执行一次 CLI 命令，并返回适合进程退出码的结果。 */
export async function runCli(dependencies: CliDependencies): Promise<number> {
  let runtime: AgentRuntime | undefined;
  let handle: Awaited<ReturnType<AgentRuntime['create']>> | undefined;
  let mcp: McpToolAdapter | undefined;
  const processController = new AbortController();
  let turnController: AbortController | undefined;
  const cancel = () => {
    if (turnController !== undefined && !turnController.signal.aborted) {
      turnController.abort(new DOMException('收到终止信号', 'AbortError'));
      return;
    }
    processController.abort(new DOMException('收到终止信号', 'AbortError'));
  };
  dependencies.signals.on('SIGINT', cancel);
  dependencies.signals.on('SIGTERM', cancel);
  let code = 0;
  let failure: unknown;
  try {
    const command = parseArgv(dependencies.argv);
    const config = await readConfig(
      command.configPath,
      dependencies.readFile ?? nodeReadFile,
      dependencies.cwd ?? process.cwd(),
    );
    const memory =
      config.memory === undefined
        ? undefined
        : createMemoryCapabilities(config.memory, dependencies);
    if (command.mode === 'import') {
      if (memory === undefined || config.memory === undefined) {
        throw new CliUsageError('import 命令要求 memory 配置');
      }
      const document = await (dependencies.readDocumentFile ?? readBoundedDocumentFile)(
        command.filePath,
        config.memory.maxDocumentBytes,
        processController.signal,
      );
      const result = await memory.importer.import(
        {
          fileName: document.fileName,
          mediaType: command.mediaType,
          bytes: document.bytes,
        },
        processController.signal,
      );
      writeJson(dependencies.stdout, { type: 'document.imported', ...result });
    } else if (command.mode === 'document-status') {
      if (memory === undefined) {
        throw new CliUsageError('document-status 命令要求 memory 配置');
      }
      const result = await memory.documentStatuses.get(
        command.documentId,
        processController.signal,
      );
      writeJson(dependencies.stdout, { type: 'document.status', ...result });
    } else if (command.mode === 'document-delete') {
      if (memory === undefined) {
        throw new CliUsageError('document-delete 命令要求 memory 配置');
      }
      const result = await memory.documentDeleter.delete(
        command.documentId,
        processController.signal,
      );
      writeJson(dependencies.stdout, { type: 'document.deletion', ...result });
    } else {
      mcp =
        config.mcp === undefined
          ? undefined
          : createMcpAdapter(config, dependencies.env, dependencies.createMcpClient);
      await mcp?.start(processController.signal);
      const skills =
        config.skills === undefined
          ? undefined
          : await FilesystemSkillCatalog.create(config.skills, processController.signal);
      const sessions = createLocalSessionRepository(config.sessionRoot);
      runtime = new AgentRuntime({
        sessions,
        model: createModelProvider(config.model, config.maxModelOutputBytes, dependencies),
        tools: composeTools(config, mcp, skills, memory?.writerTool),
        maxSteps: config.maxSteps,
        settlementTimeoutMs: config.settlementTimeoutMs,
        runTimeoutMs: config.runTimeoutMs,
        modelAttemptTimeoutMs: config.modelAttemptTimeoutMs,
        toolTimeoutMs: config.toolTimeoutMs,
        maxModelOutputBytes: config.maxModelOutputBytes,
        maxToolResultBytes: config.maxToolResultBytes,
        maxInputBytes: config.maxInputBytes,
        maxQueuedRuns: config.maxQueuedRuns,
        prompts: new BoundedPromptAssembler({
          maxInputBytes: config.maxInputBytes,
          ...(config.agentProfile === undefined
            ? {}
            : { systemPrompt: config.agentProfile.instructions }),
          contributors: [
            ...(skills === undefined ? [] : [new EnabledSkillsContext(skills)]),
            ...(memory === undefined ? [] : [new RetrievedMemoryContext(memory.retriever)]),
          ],
        }),
        // chat 仅展示最终回复；run/resume 保持 JSONL stream。
        observers:
          command.mode === 'chat'
            ? []
            : [{ onStream: (event) => writeJson(dependencies.stdout, { type: 'stream', event }) }],
      });
      const sessionId = brandId<'SessionId'>(command.session) as SessionId;
      if (command.mode === 'chat') {
        handle = await openChatSession(runtime, sessionId, processController.signal);
        await runChatLoop({
          handle,
          firstMessage: command.message,
          lines: dependencies.lines ?? createStdinLines(processController.signal),
          stderr: dependencies.stderr,
          processSignal: processController.signal,
          beginTurn: () => {
            turnController = new AbortController();
            return turnController;
          },
          endTurn: () => {
            turnController = undefined;
          },
        });
      } else {
        turnController = processController;
        handle =
          command.mode === 'run'
            ? await runtime.create(sessionId, { signal: processController.signal })
            : await runtime.resume(sessionId, { signal: processController.signal });
        const input = {
          id: brandId<'MessageId'>(command.messageId ?? crypto.randomUUID()) as MessageId,
          role: 'user' as const,
          content: command.message,
        };
        const reader = await sessions.open(sessionId, {
          mode: 'read',
          signal: processController.signal,
        });
        let existing: SessionMessageSubmission | undefined;
        try {
          existing = findSessionMessageSubmission(
            await reader.read({ signal: processController.signal }),
            input,
          );
        } finally {
          await reader.close({ signal: processController.signal });
        }
        if (existing !== undefined) {
          writeJson(dependencies.stdout, { type: 'submission', sessionId, ...existing });
        } else {
          const message = await handle.agent.run(input, processController.signal);
          writeJson(dependencies.stdout, { type: 'result', sessionId, message });
        }
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    const resources: { close(): Promise<void> }[] = [];
    if (handle !== undefined) {
      resources.push(handle);
    }
    if (runtime !== undefined) {
      resources.push(runtime);
    }
    if (mcp !== undefined) {
      const adapter = mcp;
      resources.push({ close: () => adapter.close(new AbortController().signal) });
    }
    const closeErrors = await closeCliResources(resources);
    if (failure !== undefined || closeErrors.length > 0) {
      code = 1;
      const error =
        closeErrors.length === 0
          ? failure
          : new AggregateError(
              [...(failure === undefined ? [] : [failure]), ...closeErrors],
              'CLI 清理失败',
            );
      writeJson(dependencies.stdout, {
        type: 'error',
        code: processController.signal.aborted ? 'cancelled' : 'failed',
      });
      dependencies.stderr.write(`${diagnostic(error, processController.signal)}\n`);
    }
    dependencies.signals.off('SIGINT', cancel);
    dependencies.signals.off('SIGTERM', cancel);
  }
  return code;
}

function writeJson(output: CliOutput, value: unknown): void {
  output.write(`${JSON.stringify(value)}\n`);
}
