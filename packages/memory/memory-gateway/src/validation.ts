/** 在 Gateway 边界校验非空 UTF-8 文本。 */
export function boundedText(value: unknown, maxBytes: number, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError(`${name} 必须是非空字符串`);
  if (value.length > maxBytes || utf8ByteLength(value) > maxBytes) {
    throw new RangeError(`${name} 不能超过 ${maxBytes} UTF-8 字节`);
  }
  return value;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} 必须是正安全整数`);
  }
  return value;
}
