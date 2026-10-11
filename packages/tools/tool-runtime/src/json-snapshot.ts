import type { JsonValue } from '@agent-harness/kernel'

/** 为跨 adapter 边界的任务创建不与调用方共享引用的不可变 JSON 快照。 */
export function freezeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson))
  const copy: Record<string, JsonValue> = {}
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: freezeJson(child),
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  return Object.freeze(copy)
}
