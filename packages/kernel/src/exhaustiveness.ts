/** 当封闭联合类型出现未处理成员时抛出异常。 */
export function assertNever(value: never): never {
  throw new Error(`unhandled discriminant: ${JSON.stringify(value)}`);
}
