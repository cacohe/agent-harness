import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentObserver } from '@agent-harness/kernel';
import type { AgentRuntime, AgentRuntimeHandle } from '@agent-harness/runtime';
import { describe, expect, it, vi } from 'vitest';
import { SessionRegistry, type SessionRuntimeFactory } from '../src/session-registry.ts';

describe('SessionRegistry', () => {
  it('只使用 Host 持久保存的工作目录恢复会话', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'web-registry-workspace-'));
    const workspaces = new Map<string, string>();
    const create = vi.fn(async () => handle());
    const resume = vi.fn(async () => handle());
    const factory: SessionRuntimeFactory = {
      create(_observer: AgentObserver, receivedWorkspace: string): AgentRuntime {
        expect(receivedWorkspace).toBe(workspace);
        return { create, resume, close: vi.fn(async () => undefined) } as unknown as AgentRuntime;
      },
    };
    const registry = new SessionRegistry(factory, {
      idleTimeoutMs: 60_000,
      onIdleCloseError: vi.fn(),
      readEvents: async () => [],
      async createWorkspace(sessionId, value) {
        workspaces.set(sessionId, value);
      },
      async readWorkspace(sessionId) {
        return workspaces.get(sessionId);
      },
    });

    const created = await registry.createSession(workspace);
    expect(workspaces.get(created.sessionId)).toBe(workspace);
    await registry.closeSession(created.sessionId);
    await expect(registry.openSession(created.sessionId)).resolves.toEqual(created);
    expect(resume).toHaveBeenCalledOnce();
    await expect(registry.openSession('missing')).rejects.toThrow('已授权的工作目录');
    await registry.close();
  });
});

function handle(): AgentRuntimeHandle {
  return {
    agent: { cancel: vi.fn() } as unknown as AgentRuntimeHandle['agent'],
    close: vi.fn(async () => undefined),
  };
}
