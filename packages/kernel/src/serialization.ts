/** JSON 能够无损表示的递归值。 */
export type JsonPrimitive = string | number | boolean | null;

/** JSON primitive、对象或数组的递归联合类型。 */
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

/** 键为字符串且值可由 JSON 无损表示的对象。 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** 拒绝无法由 JSON 无损表示的值，包括循环引用与非有限数字。 */
export function assertJsonValue(value: unknown): asserts value is JsonValue {
  assertJsonValueAt(value, '$', new Set<object>());
}

function assertJsonValueAt(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} 必须是有限数字`);
    return;
  }
  if (typeof value !== 'object') throw new TypeError(`${path} 不是合法 JSON 值`);
  if (ancestors.has(value)) throw new TypeError(`${path} 包含循环引用`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${path}[${index}] 不能是稀疏数组空位`);
        }
        assertJsonValueAt(value[index], `${path}[${index}]`, ancestors);
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) {
          throw new TypeError(`${path} 包含 JSON 不会保存的数组属性`);
        }
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} 必须是普通 JSON 对象`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new TypeError(`${path} 包含 JSON 不会保存的 symbol 属性`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${path}.${key} 必须是可枚举的数据属性`);
      }
      assertJsonValueAt(descriptor.value, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

/** 可写入会话事件的错误快照。 */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
}

/** 将未知的抛出值转换为可持久化的错误数据。 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

/** 判断错误是否表示由中止信号触发的取消。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
