/** 配置在构造阶段不满足协议前提时抛出。 */
export class OpenAiCompatibleConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAiCompatibleConfigurationError';
  }
}

/** HTTP 响应不是成功状态时抛出，保留供应商状态码供策略层分类。 */
export class OpenAiCompatibleHttpError extends Error {
  readonly status: number;
  readonly statusText: string;

  constructor(status: number, statusText: string) {
    super(`OpenAI-compatible 请求失败：HTTP ${status} ${statusText}`);
    this.name = 'OpenAiCompatibleHttpError';
    this.status = status;
    this.statusText = statusText;
  }
}

/** SSE 字节、事件或 Chat Completions 字段不能安全映射时抛出。 */
export class OpenAiCompatibleProtocolError extends Error {
  constructor(message: string) {
    super(`OpenAI-compatible SSE 协议错误：${message}`);
    this.name = 'OpenAiCompatibleProtocolError';
  }
}
