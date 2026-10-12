import {
  type AgentIdGenerator,
  type AttemptId,
  brandId,
  type MessageId,
  type StepId,
  type TurnId,
} from '@agent-harness/kernel';

/** 生成测试可预测的品牌标识符。 */
export class SequentialAgentIds implements AgentIdGenerator {
  #next = 1;
  #attemptsAllocated = 0;

  get attemptsAllocated(): number {
    return this.#attemptsAllocated;
  }

  turn(): TurnId {
    return brandId<'TurnId'>(`turn-${this.#next++}`);
  }

  step(): StepId {
    return brandId<'StepId'>(`step-${this.#next++}`);
  }

  attempt(): AttemptId {
    this.#attemptsAllocated += 1;
    return brandId<'AttemptId'>(`attempt-${this.#next++}`);
  }

  message(): MessageId {
    return brandId<'MessageId'>(`message-${this.#next++}`);
  }
}
