import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  assertJsonValue,
  brandId,
  type AssistantSettlement,
  type EventEnvelope,
  type JsonValue,
  type SerializedError,
  type SessionEvent,
  type SessionId,
  type ToolCall,
  type ToolResult,
} from '@agent-harness/kernel'
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionClosedError,
  SessionCorruptionError,
  SessionCreateUncertainError,
  SessionNotFoundError,
  SessionPoisonedError,
  SessionSequenceConflictError,
  SessionUncertainCommitError,
  type SessionAppendOptions,
  type SessionClock,
  type SessionLog,
  type SessionOpenOptions,
  type SessionOperationOptions,
  type SessionReader,
  type SessionRepository,
  type SessionWriteLease,
  type SessionWriteLeaseProvider,
} from '@agent-harness/kernel'
import type { JsonlFile, JsonlIo, JsonlOpenFlags } from './io.js'

const FORMAT_VERSION = 1
const FILE_NAME = 'session.v1.jsonl'
const activeWriterPaths = new Set<string>()

/** 在同一 Node.js 进程内为规范文件路径提供 writer 互斥。 */
export class InProcessSessionWriteLeaseProvider implements SessionWriteLeaseProvider {
  async acquire(key: string, signal: AbortSignal): Promise<SessionWriteLease> {
    signal.throwIfAborted()
    if (activeWriterPaths.has(key)) {
      throw new SessionAlreadyOwnedError(`会话已有 writer：${key}`)
    }
    activeWriterPaths.add(key)
    let released = false
    return {
      release() {
        if (released) return
        released = true
        activeWriterPaths.delete(key)
      },
    }
  }
}

/** JSONL repository 的组合配置，不包含测试 I/O 接缝。 */
export interface JsonlSessionRepositoryOptions {
  /** 必须是显式绝对路径，所有会话文件都位于该目录下。 */
  readonly rootDirectory: string
  readonly clock?: SessionClock
  readonly leases?: SessionWriteLeaseProvider
}

/** 将任意 UTF-16 code unit 序列单射为单个安全路径段。 */
export function encodePathSegment(value: string): string {
  let encoded = 's'
  for (let index = 0; index < value.length; index += 1) {
    encoded += `-${value.charCodeAt(index).toString(16).padStart(4, '0')}`
  }
  return encoded
}

/** JSONL repository 的 package 私有实现，由生产与测试入口注入 I/O。 */
export class JsonlSessionRepositoryImplementation implements SessionRepository {
  readonly #configuredRoot: string
  readonly #clock: SessionClock
  readonly #leases: SessionWriteLeaseProvider
  readonly #io: JsonlIo

  constructor(options: JsonlSessionRepositoryOptions, io: JsonlIo) {
    if (!isAbsolute(options.rootDirectory)) {
      throw new TypeError('rootDirectory 必须是绝对路径')
    }
    this.#configuredRoot = resolve(options.rootDirectory)
    this.#clock = options.clock ?? { now: () => new Date().toISOString() }
    this.#leases = options.leases ?? new InProcessSessionWriteLeaseProvider()
    this.#io = io
  }

  async create(
    sessionId: SessionId,
    options: SessionOperationOptions,
  ): Promise<SessionLog> {
    const root = await this.#canonicalRoot(options.signal)
    const paths = this.#paths(root, sessionId)
    const lease = await this.#leases.acquire(paths.file, options.signal)
    const stagingDirectory = join(root, `.session-staging-${randomUUID()}`)
    const stagingFile = join(stagingDirectory, FILE_NAME)
    let file: JsonlFile | undefined
    let stagingCreated = false
    let published = false
    try {
      await this.#assertSessionAbsent(paths.directory, sessionId, options.signal)
      await runIo(options.signal, () => this.#io.mkdir(stagingDirectory))
      stagingCreated = true
      const header = Buffer.from(`${JSON.stringify({
        type: 'session.header',
        formatVersion: FORMAT_VERSION,
        sessionId,
      })}\n`, 'utf8')
      file = await openFile(this.#io, stagingFile, 'w+', options.signal)
      await writeFully(file, header, 0, options.signal)
      await runIo(options.signal, () => file!.datasync())
      await syncDirectory(this.#io, stagingDirectory, options.signal)
      // Windows 不允许在目录内仍有打开句柄时 rename；发布前必须关闭。
      await file.close()
      file = undefined

      options.signal.throwIfAborted()
      try {
        await this.#io.rename(stagingDirectory, paths.directory)
      } catch (error) {
        if (errorCode(error) === 'EEXIST' || errorCode(error) === 'ENOTEMPTY') {
          throw new SessionAlreadyExistsError(`会话已存在：${sessionId}`)
        }
        throw error
      }
      published = true
      // 发布已完成：即使 signal 已取消也必须重新打开并返回 writer。
      file = await this.#io.open(paths.file, 'r+')
      try {
        await syncDirectoryWithoutSignal(this.#io, root)
      } catch (error) {
        throw new SessionCreateUncertainError(sessionId, error)
      }
      return new JsonlSessionWriter(
        sessionId,
        file,
        lease,
        this.#clock,
        header.length,
        [],
        new Set(),
      )
    } catch (error) {
      await file?.close().catch(() => undefined)
      if (!published && stagingCreated) {
        await this.#io.removeTree(stagingDirectory).catch(() => undefined)
      }
      lease.release()
      throw error
    }
  }

  open(
    sessionId: SessionId,
    options: Extract<SessionOpenOptions, { mode: 'read' }>,
  ): Promise<SessionReader>
  open(
    sessionId: SessionId,
    options: Extract<SessionOpenOptions, { mode: 'write' }>,
  ): Promise<SessionLog>
  async open(
    sessionId: SessionId,
    options: SessionOpenOptions,
  ): Promise<SessionReader | SessionLog> {
    const root = await this.#canonicalRoot(options.signal)
    const paths = this.#paths(root, sessionId)
    if (options.mode === 'read') {
      const file = await openExisting(
        this.#io,
        paths.file,
        'r',
        sessionId,
        options.signal,
      )
      try {
        const content = await runIo(options.signal, () => file.readFile())
        const parsed = parseCommittedPrefix(content, sessionId)
        return new JsonlSessionReader(sessionId, parsed.envelopes)
      } finally {
        await file.close()
      }
    }

    const lease = await this.#leases.acquire(paths.file, options.signal)
    let file: JsonlFile | undefined
    try {
      file = await openExisting(
        this.#io,
        paths.file,
        'r+',
        sessionId,
        options.signal,
      )
      const content = await runIo(options.signal, () => file!.readFile())
      const parsed = parseCommittedPrefix(content, sessionId)
      if (parsed.committedLength !== content.length) {
        await repairTornTail(file, parsed.committedLength, options.signal)
      }
      return new JsonlSessionWriter(
        sessionId,
        file,
        lease,
        this.#clock,
        parsed.committedLength,
        parsed.envelopes,
        parsed.batchIds,
      )
    } catch (error) {
      await file?.close().catch(() => undefined)
      lease.release()
      throw error
    }
  }

  async #canonicalRoot(signal: AbortSignal): Promise<string> {
    await ensureDurableDirectory(this.#io, this.#configuredRoot, signal)
    const canonicalRoot = await runIo(
      signal,
      () => this.#io.realpath(this.#configuredRoot),
    )
    const metadata = await runIo(signal, () => this.#io.stat(canonicalRoot))
    if (!metadata.isDirectory) {
      throw new TypeError('rootDirectory 必须解析为目录')
    }
    return canonicalRoot
  }

  async #assertSessionAbsent(
    directory: string,
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await runIo(signal, () => this.#io.stat(directory))
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw error
    }
    throw new SessionAlreadyExistsError(`会话已存在：${sessionId}`)
  }

  #paths(root: string, sessionId: SessionId): { directory: string; file: string } {
    const directory = join(root, encodePathSegment(sessionId))
    return { directory, file: join(directory, FILE_NAME) }
  }
}

class JsonlSessionReader implements SessionReader {
  readonly sessionId: SessionId
  readonly #events: readonly EventEnvelope[]
  #closed = false

  constructor(sessionId: SessionId, events: readonly EventEnvelope[]) {
    this.sessionId = sessionId
    this.#events = immutableSnapshot(events)
  }

  async read(options: SessionOperationOptions): Promise<readonly EventEnvelope[]> {
    this.#assertOpen()
    options.signal.throwIfAborted()
    return immutableSnapshot(this.#events)
  }

  async close(options: SessionOperationOptions): Promise<void> {
    if (this.#closed) return
    options.signal.throwIfAborted()
    this.#closed = true
  }

  #assertOpen(): void {
    if (this.#closed) throw new SessionClosedError('会话 reader 已关闭')
  }
}

class JsonlSessionWriter implements SessionLog {
  readonly sessionId: SessionId
  readonly #file: JsonlFile
  readonly #lease: SessionWriteLease
  readonly #clock: SessionClock
  readonly #events: EventEnvelope[]
  readonly #batchIds: Set<string>
  #length: number
  #queue: Promise<void> = Promise.resolve()
  #closePromise: Promise<void> | undefined
  #closing = false
  #closed = false
  #poisonReason: SessionUncertainCommitError | undefined

  constructor(
    sessionId: SessionId,
    file: JsonlFile,
    lease: SessionWriteLease,
    clock: SessionClock,
    length: number,
    events: readonly EventEnvelope[],
    batchIds: Set<string>,
  ) {
    this.sessionId = sessionId
    this.#file = file
    this.#lease = lease
    this.#clock = clock
    this.#length = length
    this.#events = [...events]
    this.#batchIds = batchIds
  }

  append(
    events: readonly SessionEvent[],
    options: SessionAppendOptions,
  ): Promise<readonly EventEnvelope[]> {
    try {
      this.#assertAcceptingOperations()
      options.signal.throwIfAborted()
    } catch (error) {
      return Promise.reject(error)
    }
    let eventSnapshot: readonly SessionEvent[]
    try {
      for (const event of events) {
        assertJsonValue(event)
        validateSessionEvent(event)
      }
      eventSnapshot = immutableSnapshot(events)
    } catch (error) {
      return Promise.reject(error)
    }
    const appendOptions: SessionAppendOptions = {
      signal: options.signal,
      ...(options.expectedSequence === undefined
        ? {}
        : { expectedSequence: options.expectedSequence }),
      ...(options.batchId === undefined ? {} : { batchId: options.batchId }),
    }
    let started = false
    const operation = this.#queue.then(() => {
      started = true
      appendOptions.signal.throwIfAborted()
      this.#assertUsable()
      return this.#append(eventSnapshot, appendOptions)
    })
    this.#queue = operation.then(() => undefined, () => undefined)
    return waitForQueued(operation, options.signal, () => started)
  }

  async read(options: SessionOperationOptions): Promise<readonly EventEnvelope[]> {
    this.#assertAcceptingOperations()
    await waitFor(this.#queue, options.signal)
    this.#assertUsable()
    options.signal.throwIfAborted()
    return immutableSnapshot(this.#events)
  }

  async flush(options: SessionOperationOptions): Promise<void> {
    this.#assertAcceptingOperations()
    await waitFor(this.#queue, options.signal)
    this.#assertUsable()
    await runIo(options.signal, () => this.#file.datasync())
  }

  async close(options: SessionOperationOptions): Promise<void> {
    if (this.#closed) return
    if (this.#closePromise === undefined) {
      this.#closing = true
      this.#closePromise = this.#close()
    }
    return waitFor(this.#closePromise, options.signal)
  }

  async #close(): Promise<void> {
    let failure: unknown
    try {
      await this.#queue
      if (this.#poisonReason === undefined) await this.#file.datasync()
    } catch (error) {
      failure = error
    }
    try {
      await this.#file.close()
    } catch (error) {
      failure ??= error
    } finally {
      this.#closed = true
      this.#lease.release()
    }
    if (failure !== undefined) throw failure
  }

  async #append(
    events: readonly SessionEvent[],
    options: SessionAppendOptions,
  ): Promise<readonly EventEnvelope[]> {
    this.#assertUsable()
    options.signal.throwIfAborted()
    if (events.length === 0) return []
    const currentSequence = this.#events.length
    const expectedSequence = options.expectedSequence ?? currentSequence
    if (expectedSequence !== currentSequence) {
      throw new SessionSequenceConflictError(
        `expected sequence ${expectedSequence}，当前为 ${currentSequence}`,
      )
    }
    const batchId = options.batchId ?? brandId<'SessionBatchId'>(randomUUID())
    if (this.#batchIds.has(batchId)) {
      throw new SessionSequenceConflictError(`batchId 已存在：${batchId}`)
    }
    const envelopes = events.map((event, index): EventEnvelope => ({
      version: 1,
      sessionId: this.sessionId,
      sequence: currentSequence + index + 1,
      timestamp: this.#clock.now(),
      event,
    }))
    for (const envelope of envelopes) assertJsonValue(envelope)
    const line = `${JSON.stringify({
      type: 'session.batch',
      batchId,
      expectedSequence,
      envelopes,
    })}\n`
    const bytes = Buffer.from(line, 'utf8')
    const previousLength = this.#length
    try {
      await writeFully(this.#file, bytes, previousLength, options.signal)
      await runIo(options.signal, () => this.#file.datasync())
    } catch (writeError) {
      try {
        await this.#file.truncate(previousLength)
        await this.#file.datasync()
      } catch (rollbackError) {
        const uncertain = new SessionUncertainCommitError(
          writeError,
          rollbackError,
        )
        this.#poisonReason = uncertain
        throw uncertain
      }
      throw writeError
    }
    this.#length += bytes.length
    const snapshots = immutableSnapshot(envelopes)
    this.#events.push(...snapshots)
    this.#batchIds.add(batchId)
    return immutableSnapshot(snapshots)
  }

  #assertUsable(): void {
    if (this.#poisonReason !== undefined) {
      throw new SessionPoisonedError(this.#poisonReason)
    }
    if (this.#closed) throw new SessionClosedError('会话 writer 已关闭')
  }

  #assertAcceptingOperations(): void {
    this.#assertUsable()
    if (this.#closing || this.#closed) {
      throw new SessionClosedError('会话 writer 已关闭')
    }
  }
}

interface ParsedFile {
  readonly committedLength: number
  readonly envelopes: readonly EventEnvelope[]
  readonly batchIds: Set<string>
}

function parseCommittedPrefix(content: Buffer, expectedSessionId: SessionId): ParsedFile {
  const lastNewline = content.lastIndexOf(0x0a)
  const committedLength = lastNewline + 1
  if (committedLength === 0) {
    throw new SessionCorruptionError('会话文件缺少完整 header')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      content.subarray(0, committedLength),
    )
  } catch (error) {
    throw corruption('会话文件包含非法 UTF-8', error)
  }
  const lines = text.split('\n')
  lines.pop()
  let header: unknown
  try {
    header = JSON.parse(lines[0] ?? '')
  } catch (error) {
    throw corruption('header 不是合法 JSON', error)
  }
  assertExactObject(header, ['type', 'formatVersion', 'sessionId'], 'header')
  if (
    header.type !== 'session.header'
    || header.formatVersion !== FORMAT_VERSION
    || header.sessionId !== expectedSessionId
  ) {
    throw new SessionCorruptionError('header 与请求的会话或格式版本不一致')
  }

  const envelopes: EventEnvelope[] = []
  const batchIds = new Set<string>()
  for (let index = 1; index < lines.length; index += 1) {
    let record: unknown
    try {
      record = JSON.parse(lines[index]!)
    } catch (error) {
      throw corruption(`第 ${index + 1} 行不是合法 JSON`, error)
    }
    assertExactObject(
      record,
      ['type', 'batchId', 'expectedSequence', 'envelopes'],
      `第 ${index + 1} 行`,
    )
    if (
      record.type !== 'session.batch'
      || typeof record.batchId !== 'string'
      || record.batchId.length === 0
      || !Number.isSafeInteger(record.expectedSequence)
      || (record.expectedSequence as number) < 0
      || !Array.isArray(record.envelopes)
      || record.envelopes.length === 0
    ) {
      throw new SessionCorruptionError(`第 ${index + 1} 行 batch 字段无效`)
    }
    if (batchIds.has(record.batchId)) {
      throw new SessionCorruptionError(`第 ${index + 1} 行 batchId 重复`)
    }
    if (record.expectedSequence !== envelopes.length) {
      throw new SessionCorruptionError(`第 ${index + 1} 行 expectedSequence 不连续`)
    }
    for (const rawEnvelope of record.envelopes) {
      envelopes.push(parseEnvelope(rawEnvelope, expectedSessionId, envelopes.length + 1))
    }
    batchIds.add(record.batchId)
  }
  return {
    committedLength,
    envelopes: immutableSnapshot(envelopes),
    batchIds,
  }
}

function parseEnvelope(
  value: unknown,
  sessionId: SessionId,
  sequence: number,
): EventEnvelope {
  assertExactObject(
    value,
    ['version', 'sessionId', 'sequence', 'timestamp', 'event'],
    'event envelope',
  )
  if (
    value.version !== 1
    || value.sessionId !== sessionId
    || value.sequence !== sequence
    || typeof value.timestamp !== 'string'
  ) {
    throw new SessionCorruptionError(`event envelope sequence ${sequence} 无效`)
  }
  const event = validateSessionEvent(value.event)
  return immutableSnapshot({
    version: 1,
    sessionId,
    sequence,
    timestamp: value.timestamp,
    event,
  })
}

function validateSessionEvent(value: unknown): SessionEvent {
  assertExactObject(value, ['type'], 'session event', true)
  switch (value.type) {
    case 'turn.started':
      assertExactObject(
        value,
        value.execution === undefined ? ['type', 'turnId'] : ['type', 'turnId', 'execution'],
        value.type,
      )
      assertId(value.turnId, 'turnId')
      if (value.execution !== undefined) parseExecutionMetadata(value.execution)
      return value as unknown as SessionEvent
    case 'user.message':
      assertExactObject(value, ['type', 'message'], value.type)
      parseMessage(value.message, 'user')
      return value as unknown as SessionEvent
    case 'step.started':
      assertExactObject(value, ['type', 'turnId', 'stepId'], value.type)
      assertId(value.turnId, 'turnId')
      assertId(value.stepId, 'stepId')
      return value as unknown as SessionEvent
    case 'assistant.settled':
      assertExactObject(value, ['type', 'turnId', 'stepId', 'settlement'], value.type)
      assertId(value.turnId, 'turnId')
      assertId(value.stepId, 'stepId')
      parseSettlement(value.settlement)
      return value as unknown as SessionEvent
    case 'tool.completed':
      assertExactObject(value, ['type', 'turnId', 'stepId', 'result'], value.type)
      assertId(value.turnId, 'turnId')
      assertId(value.stepId, 'stepId')
      parseToolResult(value.result)
      return value as unknown as SessionEvent
    case 'step.ended':
      assertExactObject(value, ['type', 'turnId', 'stepId', 'outcome'], value.type)
      assertId(value.turnId, 'turnId')
      assertId(value.stepId, 'stepId')
      assertOutcome(value.outcome)
      return value as unknown as SessionEvent
    case 'turn.ended':
      assertExactObject(
        value,
        value.error === undefined
          ? ['type', 'turnId', 'outcome']
          : ['type', 'turnId', 'outcome', 'error'],
        value.type,
      )
      assertId(value.turnId, 'turnId')
      assertOutcome(value.outcome)
      if (value.error !== undefined) parseSerializedError(value.error)
      return value as unknown as SessionEvent
    default:
      throw new SessionCorruptionError('未知 session event type')
  }
}

function parseSettlement(value: unknown): AssistantSettlement {
  assertExactObject(value, ['status', 'attemptId'], 'assistant settlement', true)
  assertId(value.attemptId, 'attemptId')
  if (value.status === 'completed') {
    assertExactObject(value, ['status', 'attemptId', 'message'], 'assistant settlement')
    parseMessage(value.message, 'assistant')
  } else if (value.status === 'failed') {
    assertExactObject(
      value,
      ['status', 'attemptId', 'partialText', 'observedToolCalls', 'error'],
      'assistant settlement',
    )
    assertPartialAttempt(value)
    parseSerializedError(value.error)
  } else if (value.status === 'interrupted') {
    assertExactObject(
      value,
      ['status', 'attemptId', 'partialText', 'observedToolCalls', 'reason'],
      'assistant settlement',
    )
    assertPartialAttempt(value)
    if (typeof value.reason !== 'string') {
      throw new SessionCorruptionError('中断原因必须是字符串')
    }
  } else {
    throw new SessionCorruptionError('未知 assistant settlement status')
  }
  return value as unknown as AssistantSettlement
}

function assertPartialAttempt(value: Record<string, unknown>): void {
  if (typeof value.partialText !== 'string' || !Array.isArray(value.observedToolCalls)) {
    throw new SessionCorruptionError('assistant 部分结果字段无效')
  }
  for (const call of value.observedToolCalls) parseToolCall(call)
}

function parseMessage(value: unknown, role: 'user' | 'assistant'): void {
  assertExactObject(
    value,
    role === 'user'
      ? ['id', 'role', 'content']
      : ['id', 'role', 'content', 'toolCalls'],
    `${role} message`,
  )
  assertId(value.id, 'message id')
  if (value.role !== role || typeof value.content !== 'string') {
    throw new SessionCorruptionError(`${role} message 字段无效`)
  }
  if (role === 'assistant') {
    if (!Array.isArray(value.toolCalls)) {
      throw new SessionCorruptionError('toolCalls 必须是数组')
    }
    for (const call of value.toolCalls) parseToolCall(call)
  }
}

function parseToolCall(value: unknown): ToolCall {
  assertExactObject(value, ['id', 'name', 'input'], 'tool call')
  assertId(value.id, 'tool call id')
  if (typeof value.name !== 'string' || value.name.length === 0) {
    throw new SessionCorruptionError('工具名称不能为空')
  }
  assertPersistedJson(value.input)
  return value as unknown as ToolCall
}

function parseToolResult(value: unknown): ToolResult {
  assertExactObject(value, ['status', 'callId'], 'tool result', true)
  assertId(value.callId, 'tool call id')
  if (value.status === 'success') {
    assertExactObject(value, ['status', 'callId', 'output'], 'tool result')
    assertPersistedJson(value.output)
  } else if (value.status === 'failure') {
    assertExactObject(value, ['status', 'callId', 'error'], 'tool result')
    parseSerializedError(value.error)
  } else if (value.status === 'cancelled' || value.status === 'unknown') {
    assertExactObject(value, ['status', 'callId', 'reason'], 'tool result')
    if (typeof value.reason !== 'string') {
      throw new SessionCorruptionError('工具结果原因必须是字符串')
    }
  } else {
    throw new SessionCorruptionError('未知工具结果状态')
  }
  return value as unknown as ToolResult
}

function parseSerializedError(value: unknown): SerializedError {
  assertExactObject(value, ['name', 'message'], 'serialized error')
  if (typeof value.name !== 'string' || typeof value.message !== 'string') {
    throw new SessionCorruptionError('错误字段必须是字符串')
  }
  return value as unknown as SerializedError
}

function parseExecutionMetadata(value: unknown): void {
  assertExactObject(value, ['id', 'subject', 'authorizationVersion'], 'execution metadata')
  for (const [name, field] of Object.entries(value)) {
    if (typeof field !== 'string' || field.length === 0) {
      throw new SessionCorruptionError(`execution.${name} 必须是非空字符串`)
    }
  }
}

function assertPersistedJson(value: unknown): asserts value is JsonValue {
  try {
    assertJsonValue(value)
  } catch (error) {
    throw corruption('持久值不是合法 JSON', error)
  }
}

function assertExactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
  allowAdditional = false,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionCorruptionError(`${label} 必须是对象`)
  }
  if (allowAdditional) {
    for (const key of keys) {
      if (!Object.hasOwn(value, key)) {
        throw new SessionCorruptionError(`${label} 缺少 ${key}`)
      }
    }
    return
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new SessionCorruptionError(`${label} 字段集合无效`)
  }
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SessionCorruptionError(`${label} 不能为空`)
  }
}

function assertOutcome(value: unknown): void {
  if (
    value !== 'completed'
    && value !== 'failed'
    && value !== 'cancelled'
    && value !== 'interrupted'
  ) {
    throw new SessionCorruptionError('生命周期 outcome 无效')
  }
}

async function openExisting(
  io: JsonlIo,
  path: string,
  flags: Extract<JsonlOpenFlags, 'r' | 'r+'>,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<JsonlFile> {
  try {
    return await openFile(io, path, flags, signal)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new SessionNotFoundError(`会话不存在：${sessionId}`)
    }
    throw error
  }
}

async function syncDirectory(
  io: JsonlIo,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  const directory = await openFile(io, path, 'r', signal)
  try {
    await runIo(signal, () => directory.sync())
  } catch (error) {
    // Windows 常对目录 fd 拒绝 fsync；目录项持久化不保证，文件仍走 datasync。
    if (!isIgnorableDirectorySyncError(error)) throw error
  } finally {
    await directory.close()
  }
}

async function syncDirectoryWithoutSignal(io: JsonlIo, path: string): Promise<void> {
  const directory = await io.open(path, 'r')
  try {
    await directory.sync()
  } catch (error) {
    if (!isIgnorableDirectorySyncError(error)) throw error
  } finally {
    await directory.close()
  }
}

function isIgnorableDirectorySyncError(error: unknown): boolean {
  return (
    process.platform === 'win32'
    && error instanceof Error
    && 'code' in error
    && error.code === 'EPERM'
    && 'syscall' in error
    && error.syscall === 'fsync'
  )
}

/** 逐层创建目录，并在每次创建后同步父目录项与新目录。 */
async function ensureDurableDirectory(
  io: JsonlIo,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  const missing: string[] = []
  let existing = path
  while (true) {
    try {
      const metadata = await runIo(signal, () => io.stat(existing))
      if (!metadata.isDirectory) {
        throw new TypeError(`路径不是目录：${existing}`)
      }
      break
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      missing.push(existing)
      const parent = dirname(existing)
      if (parent === existing) throw error
      existing = parent
    }
  }

  for (const directory of missing.reverse()) {
    await createDirectoryDurably(io, directory, signal)
  }
}

/** 将 mkdir 与父目录同步视为一个不可被取消拆开的 durability 单元。 */
async function createDirectoryDurably(
  io: JsonlIo,
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  try {
    await io.mkdir(directory)
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
    const metadata = await io.stat(directory)
    if (!metadata.isDirectory) {
      throw new TypeError(`路径不是目录：${directory}`)
    }
  }
  await syncDirectoryWithoutSignal(io, dirname(directory))
  await syncDirectoryWithoutSignal(io, directory)
  signal.throwIfAborted()
}

async function repairTornTail(
  file: JsonlFile,
  committedLength: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  await file.truncate(committedLength)
  await file.datasync()
  signal.throwIfAborted()
}

async function writeFully(
  file: JsonlFile,
  bytes: Buffer,
  position: number,
  signal: AbortSignal,
): Promise<void> {
  let written = 0
  while (written < bytes.length) {
    const result = await runIo(
      signal,
      () => file.write(bytes, written, bytes.length - written, position + written),
    )
    if (result.bytesWritten === 0) throw new Error('会话文件写入未取得进展')
    written += result.bytesWritten
  }
}

async function openFile(
  io: JsonlIo,
  path: string,
  flags: JsonlOpenFlags,
  signal: AbortSignal,
): Promise<JsonlFile> {
  signal.throwIfAborted()
  const file = await io.open(path, flags)
  try {
    signal.throwIfAborted()
    return file
  } catch (error) {
    await file.close().catch(() => undefined)
    throw error
  }
}

async function runIo<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  const result = await operation()
  signal.throwIfAborted()
  return result
}

function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    signal.throwIfAborted()
  } catch (error) {
    return Promise.reject(error)
  }
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      try {
        signal.throwIfAborted()
      } catch (error) {
        rejectPromise(error)
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    operation.then(
      value => {
        if (settled) return
        settled = true
        cleanup()
        resolvePromise(value)
      },
      error => {
        if (settled) return
        settled = true
        cleanup()
        rejectPromise(error)
      },
    )
  })
}

function waitForQueued<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  hasStarted: () => boolean,
): Promise<T> {
  try {
    signal.throwIfAborted()
  } catch (error) {
    return Promise.reject(error)
  }
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      if (settled || hasStarted()) return
      settled = true
      cleanup()
      try {
        signal.throwIfAborted()
      } catch (error) {
        rejectPromise(error)
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    operation.then(
      value => {
        if (settled) return
        settled = true
        cleanup()
        resolvePromise(value)
      },
      error => {
        if (settled) return
        settled = true
        cleanup()
        rejectPromise(error)
      },
    )
  })
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined
}

function corruption(message: string, cause: unknown): SessionCorruptionError {
  return new SessionCorruptionError(message, { cause })
}

function immutableSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key), seen)
  }
  return Object.freeze(value)
}
