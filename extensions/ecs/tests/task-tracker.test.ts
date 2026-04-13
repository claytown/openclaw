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
