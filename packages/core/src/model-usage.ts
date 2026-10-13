/** 拒绝不符合模型 capability 累计语义的 usage，避免下游重复计费。 */
export function assertCumulativeUsage(
  inputTokens: number,
  outputTokens: number,
  previousInputTokens: number,
  previousOutputTokens: number,
): void {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < previousInputTokens) {
    throw new TypeError('模型 inputTokens 必须是单调不减的非负安全整数');
  }
  if (!Number.isSafeInteger(outputTokens) || outputTokens < previousOutputTokens) {
    throw new TypeError('模型 outputTokens 必须是单调不减的非负安全整数');
  }
}
