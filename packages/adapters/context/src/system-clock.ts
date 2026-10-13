import type { Clock } from '@agent-harness/kernel';

/** 本地运行时使用的系统时钟；Kernel/Core 通过 Clock 协议保持无全局依赖。 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
