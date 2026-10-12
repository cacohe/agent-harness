import { LlmGatewayModelProvider } from '@agent-harness/gateway';
import {
  CompositeToolCapability,
  DuplicateToolNameError,
  type ToolDefinition,
  ToolRegistry,
} from '@agent-harness/kernel';
import { createShellTool } from '@agent-harness/local';
import { type McpClient, McpToolAdapter } from '@agent-harness/mcp';
import {
  createMemoryWriterTool,
  MemoryGatewayDocumentDeleter,
  MemoryGatewayDocumentImporter,
  MemoryGatewayDocumentStatusReader,
  MemoryGatewayRetriever,
} from '@agent-harness/memory-gateway';
import { OpenAiCompatibleModelProvider } from '@agent-harness/openai-compatible';
import { PlatformHttpClient } from '@agent-harness/platform-http';
import type { FilesystemSkillCatalog } from '@agent-harness/skill-filesystem';
import { createSkillLoaderTool } from '@agent-harness/skill-tool';
import { type CliConfig, type CliModelConfig, CliUsageError } from './config.js';
import type { CliDependencies } from './contracts.js';
import { StdioMcpClient, type StdioMcpClientOptions } from './mcp-stdio.js';

export function createMcpAdapter(
  config: CliConfig,
  environment: Readonly<Record<string, string | undefined>>,
  createClient: ((options: StdioMcpClientOptions) => McpClient) | undefined,
): McpToolAdapter {
  if (config.mcp === undefined) throw new Error('MCP 配置缺失');
  const childEnvironment: Record<string, string> = {};
  for (const [target, source] of Object.entries(config.mcp.environment)) {
    childEnvironment[target] = requiredEnvironment(environment, source);
  }
  const options: StdioMcpClientOptions = {
    command: config.mcp.command,
    args: config.mcp.args,
    ...(config.mcp.cwd === undefined ? {} : { cwd: config.mcp.cwd }),
    env: childEnvironment,
  };
  return new McpToolAdapter(createClient?.(options) ?? new StdioMcpClient(options));
}

export function composeTools(
  config: CliConfig,
  mcp: McpToolAdapter | undefined,
  skills: FilesystemSkillCatalog | undefined,
  memoryWriter: ToolDefinition | undefined,
): CompositeToolCapability {
  try {
    return new CompositeToolCapability([
      new ToolRegistry([
        ...buildTools(config),
        ...(skills === undefined || config.skills === undefined
          ? []
          : [createSkillLoaderTool(skills, { maxContentBytes: config.skills.maxSkillBytes })]),
        ...(memoryWriter === undefined ? [] : [memoryWriter]),
      ]),
      ...(mcp === undefined ? [] : [mcp]),
    ]);
  } catch (error) {
    if (error instanceof DuplicateToolNameError) {
      throw new CliUsageError(`工具名在多个来源中重复：${error.toolName}`);
    }
    throw error;
  }
}

/** Host 只根据已校验配置选择一个 provider，不在 Runtime 内保留模型目录或路由。 */
export function createModelProvider(
  config: CliModelConfig,
  maxResponseBytes: number,
  dependencies: CliDependencies,
): OpenAiCompatibleModelProvider | LlmGatewayModelProvider {
  if ('baseUrl' in config) {
    const apiKey = requiredEnvironment(dependencies.env, config.apiKeyEnv);
    return new OpenAiCompatibleModelProvider({
      id: config.id,
      baseUrl: config.baseUrl,
      apiKey,
      model: config.model,
      maxResponseBytes,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    });
  }
  const authorization = requiredEnvironment(dependencies.env, config.authorizationEnv);
  const client = new PlatformHttpClient({
    baseUrl: config.platformBaseUrl,
    authorization,
    maxResponseBytes,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });
  return new LlmGatewayModelProvider({ id: config.id, modelId: config.modelId, client });
}

export function createMemoryCapabilities(
  config: NonNullable<CliConfig['memory']>,
  dependencies: CliDependencies,
): {
  readonly retriever: MemoryGatewayRetriever;
  readonly importer: MemoryGatewayDocumentImporter;
  readonly documentDeleter: MemoryGatewayDocumentDeleter;
  readonly documentStatuses: MemoryGatewayDocumentStatusReader;
  readonly writerTool?: ToolDefinition;
} {
  const authorization = requiredEnvironment(dependencies.env, config.authorizationEnv);
  const client = new PlatformHttpClient({
    baseUrl: config.platformBaseUrl,
    authorization,
    maxResponseBytes: config.maxResponseBytes,
    maxDocumentBytes: config.maxDocumentBytes,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });
  return {
    retriever: new MemoryGatewayRetriever({
      memorySpaceId: config.memorySpaceId,
      limit: config.limit,
      client,
    }),
    importer: new MemoryGatewayDocumentImporter({
      memorySpaceId: config.memorySpaceId,
      maxDocumentBytes: config.maxDocumentBytes,
      client,
    }),
    documentDeleter: new MemoryGatewayDocumentDeleter({
      memorySpaceId: config.memorySpaceId,
      client,
    }),
    documentStatuses: new MemoryGatewayDocumentStatusReader({
      memorySpaceId: config.memorySpaceId,
      client,
    }),
    ...(config.writeEnabled
      ? { writerTool: createMemoryWriterTool({ memorySpaceId: config.memorySpaceId, client }) }
      : {}),
  };
}

function requiredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new CliUsageError(`环境变量 ${name} 未设置`);
  return value;
}

function buildTools(config: CliConfig): readonly ToolDefinition[] {
  if (!config.shell.enabled) return [];
  return [
    createShellTool({
      cwd: config.shell.cwd,
      timeoutMs: config.shell.timeoutMs,
      maxOutputBytes: config.shell.maxOutputBytes,
    }),
  ];
}
