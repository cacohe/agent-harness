import type { McpClient, McpToolDescriptor } from '@agent-harness/adapters/mcp';
import { assertJsonValue, type JsonValue } from '@agent-harness/kernel';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export interface StdioMcpClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
}

/** 将官方 SDK 的 stdio transport 收敛为 MCP adapter 所需的最小接口。 */
export class StdioMcpClient implements McpClient {
  readonly #options: StdioMcpClientOptions;
  #client: Client | undefined;
  #transport: StdioClientTransport | undefined;
  #connecting: Promise<Client> | undefined;
  #closed = false;

  constructor(options: StdioMcpClientOptions) {
    this.#options = options;
  }

  async listTools(signal: AbortSignal): Promise<readonly McpToolDescriptor[]> {
    const client = await this.#connect(signal);
    const result = await client.listTools(undefined, { signal });
    signal.throwIfAborted();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema as Readonly<Record<string, unknown>>,
    }));
  }

  async callTool(name: string, input: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    if (input === null || Array.isArray(input) || typeof input !== 'object') {
      throw new TypeError('MCP 工具输入必须是对象');
    }
    const client = await this.#connect(signal);
    const result = await client.callTool(
      { name, arguments: input as Record<string, unknown> },
      { signal },
    );
    signal.throwIfAborted();
    const output =
      result.structuredContent === undefined
        ? { content: result.content, ...(result.isError === true ? { isError: true } : {}) }
        : result.isError === true
          ? { structuredContent: result.structuredContent, isError: true }
          : result.structuredContent;
    assertJsonValue(output as JsonValue);
    return output as JsonValue;
  }

  async close(signal: AbortSignal): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#transport?.close().catch(() => undefined);
    const connecting = this.#connecting;
    if (connecting !== undefined) {
      const client = await connecting.catch(() => undefined);
      if (client === undefined) return;
      signal.throwIfAborted();
      await client.close();
      return;
    }
    if (this.#client !== undefined) {
      signal.throwIfAborted();
      await this.#client.close();
    }
  }

  async #connect(signal: AbortSignal): Promise<Client> {
    signal.throwIfAborted();
    if (this.#closed) throw new Error('MCP stdio client 已关闭');
    if (this.#client !== undefined) return this.#client;
    if (this.#connecting === undefined) {
      this.#connecting = this.#open();
    }
    const client = await this.#connecting;
    signal.throwIfAborted();
    return client;
  }

  async #open(): Promise<Client> {
    const client = new Client({ name: 'agent-harness-cli', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: this.#options.command,
      args: [...this.#options.args],
      env: { ...getDefaultEnvironment(), ...this.#options.env },
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
      stderr: 'pipe',
    });
    this.#transport = transport;
    try {
      await client.connect(transport);
      if (this.#closed) {
        await client.close();
        throw new Error('MCP stdio client 已关闭');
      }
      this.#client = client;
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }
}
