/** In-memory tracking of active ECS tasks. */

import type { EcsActiveTask, EcsTask, EcsTaskStatus } from "./types.js";

/**
 * Strip the gateway's `agent:<id>:` namespace prefix so lookups match
 * regardless of whether the caller uses the raw key or the normalized one.
 * e.g. "agent:main:coding-ecs-49" → "coding-ecs-49"
 */
function stripAgentPrefix(key: string): string {
  const m = key.match(/^agent:[^:]+:(.+)$/);
  return m ? m[1] : key;
}

export class EcsTaskTracker {
  private byTaskId = new Map<string, EcsActiveTask>();
  private bySessionKey = new Map<string, EcsActiveTask>();

  register(task: EcsTask, sessionKey: string, runId?: string, agentId?: string): EcsActiveTask {
    const active: EcsActiveTask = {
      task,
      sessionKey,
      runId,
      agentId,
      status: "accepted",
      startedAt: Date.now(),
    };
    this.byTaskId.set(task.taskId, active);
    this.bySessionKey.set(stripAgentPrefix(sessionKey), active);
    return active;
  }

  getByTaskId(taskId: string): EcsActiveTask | undefined {
    return this.byTaskId.get(taskId);
  }

  getBySessionKey(sessionKey: string): EcsActiveTask | undefined {
    return this.bySessionKey.get(stripAgentPrefix(sessionKey));
  }

  updateStatus(taskId: string, status: EcsTaskStatus): void {
    const active = this.byTaskId.get(taskId);
    if (active) {
      active.status = status;
      active.lastStatusUpdate = Date.now();
    }
  }

  setDiscordThread(taskId: string, threadId: string): void {
    const active = this.byTaskId.get(taskId);
    if (active) {
      active.discordThreadId = threadId;
    }
  }

  remove(taskId: string): EcsActiveTask | undefined {
    const active = this.byTaskId.get(taskId);
    if (active) {
      this.byTaskId.delete(taskId);
      this.bySessionKey.delete(stripAgentPrefix(active.sessionKey));
    }
    return active;
  }

  all(): EcsActiveTask[] {
    return [...this.byTaskId.values()];
  }

  size(): number {
    return this.byTaskId.size;
  }

  clear(): void {
    this.byTaskId.clear();
    this.bySessionKey.clear();
  }
}
