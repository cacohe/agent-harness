import type { MessageId, SessionMessageSubmission } from '@agent-harness/kernel';

/** Host 接收的一条带调用方稳定身份的用户消息。 */
export interface SubmittedMessage {
  readonly id: MessageId;
  readonly content: string;
}

/** 重复提交时可由会话事实重建的执行状态。 */
export type SubmissionReceipt = SessionMessageSubmission;
