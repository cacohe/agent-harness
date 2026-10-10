import { createHash } from 'node:crypto'
import {
  assertJsonValue,
  type ExecutionMetadata,
  type JsonObject,
  type JsonValue,
  type ToolCall,
} from '@agent-harness/kernel'
import type {
  ToolAuthorizationDecision,
  ToolExecutionContext,
  ToolExecutionPolicy,
} from '@agent-harness/kernel'

/** Platform 原子领取并记账一次工具执行许可所需的稳定请求。 */
export interface PlatformPermitRequest {
  readonly executionId: string
  readonly subject: string
  readonly authorizationVersion: string
  readonly toolCallId: string
  readonly toolName: string
  readonly inputDigest: string
}

/** 由 Host 提供传输、认证与重试的 Platform 连接。 */
export interface PlatformPermitClient {
  authorizeTool(request: PlatformPermitRequest, signal: AbortSignal): Promise<unknown>
}

/** 为许可过期校验提供可替换时间。 */
export interface PlatformPermitClock {
  now(): Date
}

export interface PlatformPermitPolicyOptions {
  readonly client: PlatformPermitClient
  readonly clock: PlatformPermitClock
}

/** Platform 响应无法证明许可与当前工具调用绑定时抛出。 */
export class PlatformPermitProtocolError extends Error {
  override readonly name = 'PlatformPermitProtocolError'
}

/** 将 Platform 的原子许可领取转换为 core 工具执行策略。 */
export class PlatformPermitPolicy implements ToolExecutionPolicy {
  readonly #client: PlatformPermitClient
  readonly #clock: PlatformPermitClock

  constructor(options: PlatformPermitPolicyOptions) {
    this.#client = options.client
    this.#clock = options.clock
  }

  async authorize(
    call: ToolCall,
    context: ToolExecutionContext & { readonly execution: ExecutionMetadata },
  ): Promise<ToolAuthorizationDecision> {
    context.signal.throwIfAborted()
    const request = createPermitRequest(call, context.execution)
    const response = await this.#client.authorizeTool(request, context.signal)
    context.signal.throwIfAborted()
    return validateDecision(response, request, this.#now())
  }

  #now(): Date {
    const now = this.#clock.now()
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TypeError('PlatformPermitClock.now 必须返回有效 Date')
    }
    return now
  }
}

function createPermitRequest(
  call: ToolCall,
  execution: ExecutionMetadata,
): PlatformPermitRequest {
  assertJsonValue(call.input)
  return Object.freeze({
    executionId: execution.id,
    subject: execution.subject,
    authorizationVersion: execution.authorizationVersion,
    toolCallId: call.id,
    toolName: call.name,
    inputDigest: `sha256:${createHash('sha256').update(canonicalJson(call.input)).digest('hex')}`,
  })
}

function validateDecision(
  value: unknown,
  request: PlatformPermitRequest,
  now: Date,
): ToolAuthorizationDecision {
  const response = exactRecord(value, 'Platform permit 响应')
  if (response.status === 'denied') {
    requireExactKeys(response, ['reason', 'status'], 'Platform denied 响应')
    return { status: 'denied', reason: nonEmptyString(response.reason, 'Platform denied reason') }
  }
  if (response.status !== 'allowed') {
    throw new PlatformPermitProtocolError('Platform permit status 必须是 allowed 或 denied')
  }
  requireExactKeys(
    response,
    [
      'authorizationVersion',
      'executionId',
      'expiresAt',
      'inputDigest',
      'permitId',
      'status',
      'subject',
      'toolCallId',
      'toolName',
    ],
    'Platform allowed 响应',
  )
  nonEmptyString(response.permitId, 'Platform permitId')
  requireBinding(response.executionId, request.executionId, 'executionId')
  requireBinding(response.subject, request.subject, 'subject')
  requireBinding(response.authorizationVersion, request.authorizationVersion, 'authorizationVersion')
  requireBinding(response.toolCallId, request.toolCallId, 'toolCallId')
  requireBinding(response.toolName, request.toolName, 'toolName')
  requireBinding(response.inputDigest, request.inputDigest, 'inputDigest')
  const expiresAt = nonEmptyString(response.expiresAt, 'Platform expiresAt')
  const expiration = new Date(expiresAt)
  if (Number.isNaN(expiration.getTime()) || expiration.toISOString() !== expiresAt) {
    throw new PlatformPermitProtocolError('Platform expiresAt 必须是规范 ISO 时间')
  }
  if (expiration.getTime() <= now.getTime()) {
    throw new PlatformPermitProtocolError('Platform permit 已过期')
  }
  return { status: 'allowed' }
}

function exactRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlatformPermitProtocolError(`${name}必须是对象`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const keys = Object.keys(value)
  if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) {
    throw new PlatformPermitProtocolError(`${name}字段无效`)
  }
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PlatformPermitProtocolError(`${name}必须是非空字符串`)
  }
  return value
}

function requireBinding(value: unknown, expected: string, name: string): void {
  if (value !== expected) {
    throw new PlatformPermitProtocolError(`Platform permit ${name} 与当前调用不匹配`)
  }
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as JsonObject
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(',')}}`
}
