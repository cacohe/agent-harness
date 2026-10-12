import {
  AgentIdCollisionError,
  type AgentIdReservationSeed,
  type AttemptId,
  type MessageId,
  type StepId,
  type ToolCallId,
  type TurnId,
} from '@agent-harness/kernel';

/** 保留已使用的 Agent 标识符，防止新旧生命周期记录发生 ID 冲突。 */
export class AgentIdReservations {
  readonly #turnIds: Set<string>;
  readonly #stepIds: Set<string>;
  readonly #attemptIds: Set<string>;
  readonly #messageIds: Set<string>;
  readonly #toolCallIds: Set<string>;

  constructor(seed: AgentIdReservationSeed | undefined) {
    this.#turnIds = new Set(seed?.turnIds);
    this.#stepIds = new Set(seed?.stepIds);
    this.#attemptIds = new Set(seed?.attemptIds);
    this.#messageIds = new Set(seed?.messageIds);
    this.#toolCallIds = new Set(seed?.toolCallIds);
  }

  turn(value: TurnId): TurnId {
    return this.#reserve('turn', this.#turnIds, value);
  }

  step(value: StepId): StepId {
    return this.#reserve('step', this.#stepIds, value);
  }

  attempt(value: AttemptId): AttemptId {
    return this.#reserve('attempt', this.#attemptIds, value);
  }

  message(value: MessageId): MessageId {
    return this.#reserve('message', this.#messageIds, value);
  }

  toolCall(value: ToolCallId): ToolCallId {
    return this.#reserve('toolCall', this.#toolCallIds, value);
  }

  #reserve<T extends string>(
    kind: 'turn' | 'step' | 'attempt' | 'message' | 'toolCall',
    values: Set<string>,
    value: T,
  ): T {
    if (values.has(value)) throw new AgentIdCollisionError(kind, value);
    values.add(value);
    return value;
  }
}
