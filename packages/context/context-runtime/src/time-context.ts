import type {
  Clock,
  ContextContributor,
  ContextContributorInput,
  ModelMessage,
} from '@agent-harness/kernel';

/** 将组合方提供的当前时间作为一条系统消息加入每次模型请求。 */
export class CurrentTimeContext implements ContextContributor {
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  contribute(_input: ContextContributorInput, _signal: AbortSignal): readonly ModelMessage[] {
    const now = this.#clock.now();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TypeError('Clock.now 必须返回有效 Date');
    }
    return [{ role: 'system', content: `当前时间（UTC）：${now.toISOString()}` }];
  }
}
