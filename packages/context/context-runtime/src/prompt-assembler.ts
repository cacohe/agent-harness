import type {
  ContextContributor,
  ContextContributorInput,
  EventEnvelope,
  ModelMessage,
  ModelRequest,
  ModelToolDefinition,
  PromptAssembler,
} from '@agent-harness/kernel';
import { deriveModelMessages } from './message-projection.js';

/** 默认 prompt 策略：保留完整的最近用户 turn，并限制模型输入字节数。 */
export class BoundedPromptAssembler implements PromptAssembler {
  readonly #systemPrompt: string | undefined;
  readonly #contributors: readonly ContextContributor[];
  readonly #maxInputBytes: number;

  constructor(options: {
    readonly maxInputBytes: number;
    readonly systemPrompt?: string;
    readonly contributors?: readonly ContextContributor[];
  }) {
    if (!Number.isSafeInteger(options.maxInputBytes) || options.maxInputBytes < 1) {
      throw new TypeError('maxInputBytes 必须是正整数');
    }
    if (options.systemPrompt !== undefined && options.systemPrompt.length === 0) {
      throw new TypeError('systemPrompt 若提供则必须是非空字符串');
    }
    this.#maxInputBytes = options.maxInputBytes;
    this.#systemPrompt = options.systemPrompt;
    this.#contributors = options.contributors ?? [];
  }

  async assemble(
    events: readonly EventEnvelope[],
    tools: readonly ModelToolDefinition[],
    signal: AbortSignal,
  ): Promise<ModelRequest> {
    const history = deriveModelMessages(events);
    const context = await this.#contextMessages({ events, tools }, signal);
    const start = this.#findStart(history, tools, context);
    const messages: readonly ModelMessage[] = [...context, ...history.slice(start)];
    return { messages, tools };
  }

  async #contextMessages(
    input: ContextContributorInput,
    signal: AbortSignal,
  ): Promise<readonly ModelMessage[]> {
    const messages: ModelMessage[] =
      this.#systemPrompt === undefined ? [] : [{ role: 'system', content: this.#systemPrompt }];
    for (const contributor of this.#contributors) {
      signal.throwIfAborted();
      for (const message of await contributor.contribute(input, signal)) {
        if (message.role !== 'system' || message.content.length === 0) {
          throw new TypeError('ContextContributor 只能返回非空 system 消息');
        }
        messages.push(message);
      }
    }
    return messages;
  }

  #findStart(
    messages: readonly ModelMessage[],
    tools: readonly ModelToolDefinition[],
    context: readonly ModelMessage[],
  ): number {
    let bytes = utf8ByteLength(JSON.stringify(context)) + utf8ByteLength(JSON.stringify(tools));
    if (bytes > this.#maxInputBytes) throw new Error('上下文与工具定义超过 maxInputBytes');
    let start = messages.length;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      bytes += utf8ByteLength(JSON.stringify(messages[index]));
      if (bytes > this.#maxInputBytes) break;
      if (messages[index]?.role === 'user') start = index;
    }
    if (start === messages.length && messages.length > 0) {
      throw new Error('最新完整用户 turn 超过 maxInputBytes');
    }
    return start;
  }
}

const textEncoder = new TextEncoder();

/** 计算字符串的 UTF-8 字节长度，避免依赖 Node Buffer。 */
function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}
