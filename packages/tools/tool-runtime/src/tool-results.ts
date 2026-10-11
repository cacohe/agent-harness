import type { ToolCall, ToolResult } from '@agent-harness/kernel'

export function authorizationFailure(call: ToolCall, message: string): ToolResult {
  return { status: 'failure', callId: call.id, error: { name: 'ToolAuthorizationError', message } }
}

export function cancelledResult(call: ToolCall, reason: unknown): ToolResult {
  return {
    status: 'cancelled',
    callId: call.id,
    reason: reason instanceof Error ? reason.message : String(reason ?? 'cancelled'),
  }
}

export function unknownToolResult(call: ToolCall): ToolResult {
  return {
    status: 'failure',
    callId: call.id,
    error: { name: 'UnknownToolError', message: `unknown tool: ${call.name}` },
  }
}
