/** 带有编译期身份、不会与其他标识符混用的字符串。 */
export type BrandedString<Name extends string> = string & {
  readonly __brand: Name;
};

/** 会话、消息、turn、step、attempt、工具调用的品牌标识符。 */
export type SessionId = BrandedString<'SessionId'>;
export type MessageId = BrandedString<'MessageId'>;
export type TurnId = BrandedString<'TurnId'>;
export type StepId = BrandedString<'StepId'>;
export type AttemptId = BrandedString<'AttemptId'>;
export type ExecutionId = BrandedString<'ExecutionId'>;
/** 标识一次持久化原子追加，供冲突检查与审计使用。 */
export type SessionBatchId = BrandedString<'SessionBatchId'>;

/** 为已经校验的标识符字符串赋予品牌类型。 */
export function brandId<Name extends string>(value: string): BrandedString<Name> {
  if (value.length === 0) {
    throw new Error('identifier must not be empty');
  }
  return value as BrandedString<Name>;
}
