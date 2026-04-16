import { describe, expect, it } from "vitest";
import { EcsTaskTracker } from "../src/task-tracker.js";
import type { EcsTask } from "../src/types.js";

function makeTask(id = "task-1"): EcsTask {
  return {
    taskId: id,
    title: "Test task",
    description: "A test task",
    priority: "medium",
  };
}

describe("EcsTaskTracker", () => {
  it("registers and retrieves by taskId and sessionKey", () => {
    const tracker = new EcsTaskTracker();
    const task = makeTask();
    const active = tracker.register(task, "sess-1", "run-1", "agent-1");

    expect(active.task).toBe(task);
    expect(active.sessionKey).toBe("sess-1");
    expect(active.runId).toBe("run-1");
    expect(active.agentId).toBe("agent-1");
    expect(active.status).toBe("accepted");
    expect(active.startedAt).toBeGreaterThan(0);

    expect(tracker.getByTaskId("task-1")).toBe(active);
    expect(tracker.getBySessionKey("sess-1")).toBe(active);
  });

  it("returns undefined for unknown keys", () => {
    const tracker = new EcsTaskTracker();
    expect(tracker.getByTaskId("nope")).toBeUndefined();
    expect(tracker.getBySessionKey("nope")).toBeUndefined();
  });

  it("updateStatus mutates the active task", () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask(), "sess-1");

    tracker.updateStatus("task-1", "running");
    const active = tracker.getByTaskId("task-1")!;
    expect(active.status).toBe("running");
    expect(active.lastStatusUpdate).toBeGreaterThan(0);
  });

  it("updateStatus is a no-op for unknown taskId", () => {
    const tracker = new EcsTaskTracker();
    // Should not throw.
    tracker.updateStatus("unknown", "error");
  });

  it("setDiscordThread stores the thread ID", () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask(), "sess-1");

    tracker.setDiscordThread("task-1", "thread-abc");
    expect(tracker.getByTaskId("task-1")!.discordThreadId).toBe("thread-abc");
  });

  it("remove deletes from both maps", () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask(), "sess-1");

    const removed = tracker.remove("task-1");
    expect(removed).toBeDefined();
    expect(removed!.task.taskId).toBe("task-1");

    expect(tracker.getByTaskId("task-1")).toBeUndefined();
    expect(tracker.getBySessionKey("sess-1")).toBeUndefined();
    expect(tracker.size()).toBe(0);
  });

  it("remove returns undefined for unknown taskId", () => {
    const tracker = new EcsTaskTracker();
    expect(tracker.remove("nope")).toBeUndefined();
  });

  it("all() returns all active tasks", () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask("t-1"), "s-1");
    tracker.register(makeTask("t-2"), "s-2");

    const all = tracker.all();
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.task.taskId).toSorted()).toEqual(["t-1", "t-2"]);
  });

  it("clear() empties the tracker", () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask("t-1"), "s-1");
    tracker.register(makeTask("t-2"), "s-2");

    tracker.clear();
    expect(tracker.size()).toBe(0);
    expect(tracker.all()).toEqual([]);
  });

  it("indexes by teamsChannelId when task.teamsChannelId is set on register", () => {
    const tracker = new EcsTaskTracker();
    const task = makeTask("t-ch");
    task.teamsChannelId = "19:venture@thread.tacv2";
    tracker.register(task, "sess-ch");

    const found = tracker.getByTeamsChannelId("19:venture@thread.tacv2");
    expect(found?.task.taskId).toBe("t-ch");
    expect(found?.teamsChannelId).toBe("19:venture@thread.tacv2");
  });

  it("getByTeamsChannelId returns undefined for unknown channel", () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask(), "sess-1");
    expect(tracker.getByTeamsChannelId("19:nope@thread.tacv2")).toBeUndefined();
  });

  it("remove clears the teamsChannelId index", () => {
    const tracker = new EcsTaskTracker();
    const task = makeTask("t-ch");
    task.teamsChannelId = "19:venture@thread.tacv2";
    tracker.register(task, "sess-ch");
    tracker.remove("t-ch");
    expect(tracker.getByTeamsChannelId("19:venture@thread.tacv2")).toBeUndefined();
  });

  it("findByTeamsThread resolves to the same task as setTeamsMessage", () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask("t-thread"), "sess-thread");
    tracker.setTeamsMessage("t-thread", "1776371195088");

    const found = tracker.findByTeamsThread("1776371195088");
    expect(found?.task.taskId).toBe("t-thread");
    expect(tracker.teamsIndexSize()).toBe(1);
  });

  it("findByTeamsThread matches case-insensitively (session keys are lowercased)", () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask("t-thread"), "sess-thread");
    tracker.setTeamsMessage("t-thread", "AbC123");

    expect(tracker.findByTeamsThread("abc123")?.task.taskId).toBe("t-thread");
    expect(tracker.findByTeamsThread("ABC123")?.task.taskId).toBe("t-thread");
  });

  it("markDeadThread preserves inbound routing so human replies still match", () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask("t-66"), "coding-ecs-66");
    tracker.setTeamsMessage("t-66", "1776371195088");

    expect(tracker.teamsIndexSize()).toBe(1);
    tracker.markDeadThread("t-66");

    // Inbound routing must remain intact — this is the whole point of the
    // fix. markDeadThread only stops outbound posts; it must not silently
    // break thread-based routing on the inbound side.
    const active = tracker.findByTeamsThread("1776371195088");
    expect(active?.task.taskId).toBe("t-66");
    expect(active?.teamsThreadIsDead).toBe(true);
    // And outbound helpers should see a cleared teamsMessageId so they fall
    // back to root posts instead of targeting the dead thread.
    expect(active?.teamsMessageId).toBeUndefined();
    expect(tracker.teamsIndexSize()).toBe(1);
  });

  it("setTeamsMessage with a fresh id clears the dead flag", () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask("t-66"), "coding-ecs-66");
    tracker.setTeamsMessage("t-66", "dead-id");
    tracker.markDeadThread("t-66");
    expect(tracker.findByTeamsThread("dead-id")?.teamsThreadIsDead).toBe(true);

    tracker.setTeamsMessage("t-66", "fresh-id");
    const active = tracker.findByTeamsThread("fresh-id");
    expect(active?.teamsThreadIsDead).toBe(false);
    expect(active?.teamsMessageId).toBe("fresh-id");
  });

  it("teamsIndexSampleKeys returns up to N stored keys for diagnostics", () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask("t-1"), "s-1");
    tracker.register(makeTask("t-2"), "s-2");
    tracker.register(makeTask("t-3"), "s-3");
    tracker.setTeamsMessage("t-1", "ID-1");
    tracker.setTeamsMessage("t-2", "ID-2");
    tracker.setTeamsMessage("t-3", "ID-3");

    const sample = tracker.teamsIndexSampleKeys(2);
    expect(sample).toHaveLength(2);
    for (const key of sample) {
      expect(["id-1", "id-2", "id-3"]).toContain(key);
    }
  });

  it("tracks multiple tasks independently", () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask("t-1"), "s-1", undefined, "agent-a");
    tracker.register(makeTask("t-2"), "s-2", undefined, "agent-b");

    tracker.updateStatus("t-1", "running");
    tracker.updateStatus("t-2", "error");

    expect(tracker.getByTaskId("t-1")!.status).toBe("running");
    expect(tracker.getByTaskId("t-2")!.status).toBe("error");

    tracker.remove("t-1");
    expect(tracker.size()).toBe(1);
    expect(tracker.getBySessionKey("s-2")).toBeDefined();
  });
});
