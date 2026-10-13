import { OpenAiCompatibleModelProvider } from '../../openai-compatible/src/index.js';
import { JsonlSessionRepository } from '../../session-jsonl/src/index.js';

/** 本地 Host 传入已解析密钥后创建的 OpenAI-compatible 模型配置。 */
export interface LocalOpenAiModelOptions {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly maxResponseBytes: number;
  readonly fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

/** 共享本地默认 adapter 的构造细节，Host 只保留配置解析与进程协议。 */
export function createLocalOpenAiModel(
  options: LocalOpenAiModelOptions,
): OpenAiCompatibleModelProvider {
  return new OpenAiCompatibleModelProvider(options);
}

/** JSONL 是本地参考 Host 的默认会话实现，不属于 Host 的交互协议。 */
export function createLocalSessionRepository(rootDirectory: string): JsonlSessionRepository {
  return new JsonlSessionRepository({ rootDirectory });
}
