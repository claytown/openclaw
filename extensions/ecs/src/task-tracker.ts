/** In-memory tracking of active ECS tasks. Uses globalThis singleton so all
 *  plugin instances (gateway + subagents) share the same tracker. */

import type { EcsActiveTask, EcsTask, EcsTaskStatus } from "./types.js";

const TRACKER_KEY = Symbol.for("openclaw.ecsTaskTracker");
type TrackerHolder = { instance: EcsTaskTracker; instanceId: string };

/** Return the process-wide singleton tracker. */
export function getEcsTaskTracker(): EcsTaskTracker {
  const g = globalThis as typeof globalThis & { [TRACKER_KEY]?: TrackerHolder };
  if (!g[TRACKER_KEY]) {
    const instanceId = Math.random().toString(36).slice(2, 10);
    g[TRACKER_KEY] = { instance: new EcsTaskTracker(), instanceId };
    // One line per process confirms the in-process singleton is truly singular.
    // If this fires more than once per pid, something is bypassing globalThis.
    console.log(`[ecs-tracker] getEcsTaskTracker: pid=${process.pid} instanceId=${instanceId}`);
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
  private byTeamsChannelId = new Map<string, EcsActiveTask>();

  register(task: EcsTask, sessionKey: string, runId?: string, agentId?: string): EcsActiveTask {
    const active: EcsActiveTask = {
      task,
      sessionKey,
      runId,
      agentId,
      status: "accepted",
      teamsChannelId: task.teamsChannelId,
      startedAt: Date.now(),
    };
    this.byTaskId.set(task.taskId, active);
    this.bySessionKey.set(stripAgentPrefix(sessionKey), active);
    if (task.teamsChannelId) {
      this.byTeamsChannelId.set(task.teamsChannelId, active);
    }
    console.log(
      `[ecs-tracker] register: taskId=${task.taskId} sessionKey=${sessionKey} size=${this.byTaskId.size}`,
    );
    return active;
  }

  getByTeamsChannelId(channelId: string): EcsActiveTask | undefined {
    return this.byTeamsChannelId.get(channelId);
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
      // A new root thread id supersedes any prior "dead" marking: inbound
      // routing might have been flagged dead because of an earlier stale id,
      // but this one is freshly minted.
      active.teamsThreadIsDead = false;
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
        `[ecs-tracker] setTeamsMessage: taskId=${taskId} messageId=${messageId} storedKey=${key} teamsIndex=${this.byTeamsMessageId.size} keysForTask=${active.teamsMessageIds.length}`,
      );
    }
  }

  getByTeamsMessageId(messageId: string): EcsActiveTask | undefined {
    return this.byTeamsMessageId.get(messageId.toLowerCase());
  }

  /**
   * Resolve an active task from a Teams thread id pulled off a session key.
   * Thin wrapper over getByTeamsMessageId that matches how before_dispatch
   * thinks about the lookup ("find the task whose thread this is").
   */
  findByTeamsThread(threadId: string): EcsActiveTask | undefined {
    return this.getByTeamsMessageId(threadId);
  }

  /** Count of byTeamsMessageId entries. Used for diagnostics, not routing. */
  teamsIndexSize(): number {
    return this.byTeamsMessageId.size;
  }

  /**
   * Return up to `limit` keys currently indexed for Teams thread routing.
   * Used by the before_dispatch log when a lookup misses, to distinguish
   * "index was wiped" from "index has a different key than we looked up for".
   */
  teamsIndexSampleKeys(limit: number): string[] {
    const out: string[] = [];
    for (const key of this.byTeamsMessageId.keys()) {
      if (out.length >= limit) {
        break;
      }
      out.push(key);
    }
    return out;
  }

  /**
   * Flag a Teams thread as unusable for outbound replies. The inbound index
   * (byTeamsMessageId) is left intact so a human reply in the same thread
   * still resolves to this task — otherwise a dead outbound thread would
   * silently break thread-based task routing on the inbound side.
   *
   * Outbound helpers should consult `active.teamsThreadIsDead` / the cleared
   * `teamsMessageId` to decide whether to skip or fall back to a root post.
   */
  markDeadThread(taskId: string): void {
    const active = this.byTaskId.get(taskId);
    if (!active) {
      return;
    }
    active.teamsThreadIsDead = true;
    active.teamsMessageId = undefined;
    console.log(
      `[ecs-tracker] markDeadThread: taskId=${taskId} markedDead=true teamsIndex=${this.byTeamsMessageId.size} (inbound routing preserved)`,
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
      if (active.teamsChannelId) {
        this.byTeamsChannelId.delete(active.teamsChannelId);
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
    this.byTeamsChannelId.clear();
  }
}
