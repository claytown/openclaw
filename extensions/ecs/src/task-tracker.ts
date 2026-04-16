/** In-memory tracking of active ECS tasks. Uses globalThis singleton so all
 *  plugin instances (gateway + subagents) share the same tracker. */

import type { EcsActiveTask, EcsTask, EcsTaskStatus } from "./types.js";

const TRACKER_KEY = Symbol.for("openclaw.ecsTaskTracker");
type TrackerHolder = { instance: EcsTaskTracker };

/** Return the process-wide singleton tracker. */
export function getEcsTaskTracker(): EcsTaskTracker {
  const g = globalThis as typeof globalThis & { [TRACKER_KEY]?: TrackerHolder };
  if (!g[TRACKER_KEY]) {
    g[TRACKER_KEY] = { instance: new EcsTaskTracker() };
  }
  return g[TRACKER_KEY].instance;
}

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
  private byTeamsMessageId = new Map<string, EcsActiveTask>();

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
    console.log(
      `[ecs-tracker] register: taskId=${task.taskId} sessionKey=${sessionKey} size=${this.byTaskId.size}`,
    );
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

  setTeamsMessage(taskId: string, messageId: string): void {
    const active = this.byTaskId.get(taskId);
    if (active) {
      active.teamsMessageId = messageId;
      const key = messageId.toLowerCase();
      // Store under the lowercased key so lookups from the session key
      // (which is lowercased by resolveThreadSessionKeys) always match.
      this.byTeamsMessageId.set(key, active);
      // Track all indexed keys for this task so remove() can clean them all up.
      if (!active.teamsMessageIds) {
        active.teamsMessageIds = [];
      }
      if (!active.teamsMessageIds.includes(key)) {
        active.teamsMessageIds.push(key);
      }
      console.log(
        `[ecs-tracker] setTeamsMessage: taskId=${taskId} messageId=${messageId} teamsIndex=${this.byTeamsMessageId.size} keysForTask=${active.teamsMessageIds.length}`,
      );
    }
  }

  getByTeamsMessageId(messageId: string): EcsActiveTask | undefined {
    return this.byTeamsMessageId.get(messageId.toLowerCase());
  }

  /**
   * Drop Teams thread indices for a task without removing the entry itself.
   * Used when a thread is confirmed dead (Teams returns 404) so subsequent
   * posts and thread lookups stop targeting it, but the session remains
   * routable through other indices.
   */
  markDeadThread(taskId: string): void {
    const active = this.byTaskId.get(taskId);
    if (!active) {
      return;
    }
    for (const key of active.teamsMessageIds ?? []) {
      this.byTeamsMessageId.delete(key);
    }
    active.teamsMessageIds = [];
    active.teamsMessageId = undefined;
    console.log(
      `[ecs-tracker] markDeadThread: taskId=${taskId} teamsIndex=${this.byTeamsMessageId.size}`,
    );
  }

  /**
   * Remove tracker entries that look stranded: started more than `maxAgeMs`
   * ago AND with no `lastStatusUpdate` within `idleMs`. Returns the list of
   * taskIds that were pruned.
   */
  pruneStale(opts: { maxAgeMs: number; idleMs: number; now?: number }): string[] {
    const now = opts.now ?? Date.now();
    const pruned: string[] = [];
    // Snapshot into an array so we can mutate the map while iterating.
    const snapshot = Array.from(this.byTaskId.values());
    for (const active of snapshot) {
      if (now - active.startedAt < opts.maxAgeMs) {
        continue;
      }
      const lastUpdate = active.lastStatusUpdate ?? active.startedAt;
      if (now - lastUpdate < opts.idleMs) {
        continue;
      }
      this.remove(active.task.taskId);
      pruned.push(active.task.taskId);
    }
    return pruned;
  }

  remove(taskId: string): EcsActiveTask | undefined {
    const active = this.byTaskId.get(taskId);
    if (active) {
      this.byTaskId.delete(taskId);
      this.bySessionKey.delete(stripAgentPrefix(active.sessionKey));
      for (const key of active.teamsMessageIds ?? []) {
        this.byTeamsMessageId.delete(key);
      }
      console.log(`[ecs-tracker] remove: taskId=${taskId} remaining=${this.byTaskId.size}`);
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
    this.byTeamsMessageId.clear();
  }
}
