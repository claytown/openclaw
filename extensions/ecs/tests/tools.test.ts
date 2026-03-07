import { describe, expect, it, vi } from "vitest";
import { EcsTaskTracker } from "../src/task-tracker.js";
import {
  createEcsAskQuestionTool,
  createEcsRaiseIssueTool,
  createEcsStatusUpdateTool,
  type EcsToolDeps,
} from "../src/tools.js";
import type { EcsTask } from "../src/types.js";

// Store mock references at the top level so lint's unbound-method rule is satisfied.
const mocks = {
  postStatusUpdate: vi.fn().mockResolvedValue({ messageId: "msg-1" }),
  postQuestion: vi.fn().mockResolvedValue({ messageId: "msg-1", threadId: "thread-1" }),
  postIssue: vi.fn().mockResolvedValue({ messageId: "msg-1" }),
  reportStatus: vi.fn().mockResolvedValue({ ok: true }),
  reportCompleted: vi.fn().mockResolvedValue({ ok: true }),
  reportError: vi.fn().mockResolvedValue({ ok: true }),
  registerPendingQuestion: vi.fn().mockResolvedValue({
    answer: "42",
    answeredBy: "human",
    timedOut: false,
    escalatedToIssues: false,
  }),
};

function makeDeps(tracker?: EcsTaskTracker): EcsToolDeps {
  // Reset all mocks between calls.
  for (const m of Object.values(mocks)) {
    m.mockClear();
  }

  return {
    tracker: tracker ?? new EcsTaskTracker(),
    discord: {
      postStatusUpdate: mocks.postStatusUpdate,
      postQuestion: mocks.postQuestion,
      postIssue: mocks.postIssue,
    } as never,
    callback: {
      reportStatus: mocks.reportStatus,
      reportCompleted: mocks.reportCompleted,
      reportError: mocks.reportError,
    } as never,
    questionRelay: {
      registerPendingQuestion: mocks.registerPendingQuestion,
    } as never,
  };
}

function makeTask(id = "task-1"): EcsTask {
  return {
    taskId: id,
    title: "Test task",
    description: "A test task",
    priority: "medium",
  };
}

function parseResult(result: { content: { type: string; text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

describe("ecs_status_update", () => {
  it("posts status for an active ECS task", async () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask(), "sess-1", undefined, "agent-1");
    const deps = makeDeps(tracker);

    const tool = createEcsStatusUpdateTool(deps, { sessionKey: "sess-1", agentId: "agent-1" });
    const result = await tool.execute("call-1", {
      status: "running",
      summary: "Working on it",
      progressPct: 50,
    });

    const parsed = parseResult(result as never) as Record<string, unknown>;
    expect(parsed.posted).toBe(true);
    expect(parsed.taskId).toBe("task-1");
    expect(parsed.status).toBe("running");
    expect(mocks.postStatusUpdate).toHaveBeenCalled();
    expect(mocks.reportStatus).toHaveBeenCalled();

    // Tracker should be updated.
    expect(tracker.getByTaskId("task-1")!.status).toBe("running");
  });

  it("gracefully handles no active ECS task (non-ECS session)", async () => {
    const deps = makeDeps();
    const tool = createEcsStatusUpdateTool(deps, { sessionKey: "no-task" });

    const result = await tool.execute("call-1", {
      status: "running",
      summary: "Just checking",
    });

    const parsed = parseResult(result as never) as Record<string, unknown>;
    expect(parsed.posted).toBe(true);
    expect(parsed.taskId).toBe("unknown");
  });

  it("gracefully handles undefined sessionKey", async () => {
    const deps = makeDeps();
    const tool = createEcsStatusUpdateTool(deps, {});

    const result = await tool.execute("call-1", {
      status: "accepted",
      summary: "No session",
    });

    const parsed = parseResult(result as never) as Record<string, unknown>;
    expect(parsed.taskId).toBe("unknown");
  });
});

describe("ecs_ask_question", () => {
  it("posts a question and returns the relay result", async () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask(), "sess-1");
    const deps = makeDeps(tracker);

    const tool = createEcsAskQuestionTool(deps, { sessionKey: "sess-1", agentId: "agent-1" });
    const result = await tool.execute("call-1", {
      question: "What color is the sky?",
    });

    const parsed = parseResult(result as never) as Record<string, unknown>;
    expect(parsed.answer).toBe("42");
    expect(parsed.timedOut).toBe(false);
    expect(mocks.postQuestion).toHaveBeenCalled();
    expect(mocks.registerPendingQuestion).toHaveBeenCalled();
  });

  it("returns error when thread creation fails", async () => {
    const deps = makeDeps();
    mocks.postQuestion.mockResolvedValue({});

    const tool = createEcsAskQuestionTool(deps, { sessionKey: "sess-1" });
    const result = await tool.execute("call-1", { question: "Help?" });

    const parsed = parseResult(result as never) as Record<string, unknown>;
    expect(parsed.answer).toBeNull();
    expect(parsed.error).toContain("Failed to create Discord thread");
  });
});

describe("ecs_raise_issue", () => {
  it("posts an issue to Discord", async () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask(), "sess-1");
    const deps = makeDeps(tracker);

    const tool = createEcsRaiseIssueTool(deps, { sessionKey: "sess-1", agentId: "agent-1" });
    const result = await tool.execute("call-1", {
      severity: "error",
      title: "Build failed",
      description: "npm run build exits with code 1",
      attempted: ["cleared cache", "reinstalled deps"],
    });

    const parsed = parseResult(result as never) as Record<string, unknown>;
    expect(parsed.posted).toBe(true);
    expect(parsed.taskId).toBe("task-1");
    expect(parsed.severity).toBe("error");
    expect(mocks.postIssue).toHaveBeenCalled();
  });

  it("uses 'unknown' taskId when no active task", async () => {
    const deps = makeDeps();
    const tool = createEcsRaiseIssueTool(deps, {});

    const result = await tool.execute("call-1", {
      severity: "warn",
      title: "Minor issue",
      description: "Something odd",
      attempted: [],
    });

    const parsed = parseResult(result as never) as Record<string, unknown>;
    expect(parsed.taskId).toBe("unknown");
  });
});
