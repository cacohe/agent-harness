import {
  assertJsonValue,
  type ExecutionMetadata,
  type ToolCall,
  type ToolCapability,
  type ToolExecutionContext,
  type ToolResult,
} from '@agent-harness/kernel';
import { freezeJson } from './json-snapshot.js';

/** 统一调用支持上下文的新 capability 与保留基础签名的既有 capability。 */
export function executeWithContext(
  tools: ToolCapability,
  call: ToolCall,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  if ('executeWithContext' in tools && typeof tools.executeWithContext === 'function') {
    return tools.executeWithContext(call, context);
  }
  return tools.execute(call, context.signal);
}

/** 授权与真实执行共享同一不可变调用快照，避免 await 期间参数被事后修改。 */
export function freezeToolCall(call: ToolCall): ToolCall {
  assertJsonValue(call.input);
  return Object.freeze({ id: call.id, name: call.name, input: freezeJson(call.input) });
}

/** 冻结本次授权使用的执行身份，并把同一快照传给真实工具。 */
export function freezeExecutionContext(
  context: ToolExecutionContext,
  execution: ExecutionMetadata,
): ToolExecutionContext & { readonly execution: ExecutionMetadata } {
  return Object.freeze({
    signal: context.signal,
    execution: Object.freeze({
      id: execution.id,
      subject: execution.subject,
      authorizationVersion: execution.authorizationVersion,
    }),
  });
}
