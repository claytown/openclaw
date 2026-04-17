import { describe, expect, it, vi } from "vitest";
import { EcsTaskTracker } from "../src/task-tracker.js";
import {
  createEcsAskQuestionTool,
  createEcsCheckInboxTool,
  createEcsRaiseIssueTool,
  createEcsStatusUpdateTool,
  createEcsThreadReplyTool,
  type EcsToolDeps,
} from "../src/tools.js";
import type { EcsTask } from "../src/types.js";

// Store mock references at the top level so lint's unbound-method rule is satisfied.
const mocks = {
  postStatusUpdate: vi.fn().mockResolvedValue({ messageId: "msg-1" }),
  postQuestion: vi.fn().mockResolvedValue({ messageId: "msg-1", threadId: "thread-1" }),
  postIssue: vi.fn().mockResolvedValue({ messageId: "msg-1" }),
  postToThread: vi.fn().mockResolvedValue({ messageId: "msg-thread-1" }),
  postReplyToThread: vi.fn().mockResolvedValue({ messageId: "msg-teams-thread-1" }),
  reportStatus: vi.fn().mockResolvedValue({ ok: true }),
  reportCompleted: vi.fn().mockResolvedValue({ ok: true }),
  reportError: vi.fn().mockResolvedValue({ ok: true }),
  reportQuestion: vi.fn().mockResolvedValue({ ok: true }),
  reportUserMessageQueued: vi.fn().mockResolvedValue({ ok: true }),
  checkInbox: vi.fn().mockResolvedValue({ messages: [] }),
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
      postToThread: mocks.postToThread,
    } as never,
    teams: null,
    callback: {
      reportStatus: mocks.reportStatus,
      reportCompleted: mocks.reportCompleted,
      reportError: mocks.reportError,
      reportQuestion: mocks.reportQuestion,
      reportUserMessageQueued: mocks.reportUserMessageQueued,
      checkInbox: mocks.checkInbox,
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

  it("uses explicit projectId param when no active task (main agent scenario)", async () => {
    const deps = makeDeps();
    const tool = createEcsStatusUpdateTool(deps, {
      sessionKey: "agent:main:main",
      agentId: "main",
    });

    await tool.execute("call-1", {
      status: "running",
      summary: "Coordinating SafePlate",
      projectId: "safeplate",
    });

    expect(mocks.postStatusUpdate).toHaveBeenCalledWith(expect.anything(), "safeplate");
  });

  it("tracker projectId takes precedence over explicit param", async () => {
    const tracker = new EcsTaskTracker();
    const task = { ...makeTask(), projectId: "from-tracker" };
    tracker.register(task, "sess-1", undefined, "agent-1");
    const deps = makeDeps(tracker);

    const tool = createEcsStatusUpdateTool(deps, { sessionKey: "sess-1", agentId: "agent-1" });
    await tool.execute("call-1", {
      status: "running",
      summary: "Working",
      projectId: "from-param",
    });

    expect(mocks.postStatusUpdate).toHaveBeenCalledWith(expect.anything(), "from-tracker");
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

  it("fires reportQuestion callback after Discord post", async () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask(), "sess-1");
    const deps = makeDeps(tracker);

    const tool = createEcsAskQuestionTool(deps, { sessionKey: "sess-1", agentId: "agent-1" });
    await tool.execute("call-1", { question: "What color is the sky?" });

    expect(mocks.reportQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question_text: "What color is the sky?",
        agent_task_id: "task-1",
        asked_by: "agent-1",
        discord_thread_id: "thread-1",
        discord_channel: "info",
      }),
    );
  });

  it("does not block when reportQuestion fails", async () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask(), "sess-1");
    const deps = makeDeps(tracker);
    mocks.reportQuestion.mockRejectedValue(new Error("network error"));

    const tool = createEcsAskQuestionTool(deps, { sessionKey: "sess-1" });
    const result = await tool.execute("call-1", { question: "Help?" });

    const parsed = parseResult(result as never) as Record<string, unknown>;
    expect(parsed.answer).toBe("42");
  });

  it("returns error when thread creation fails", async () => {
    const deps = makeDeps();
    mocks.postQuestion.mockResolvedValue({});

    const tool = createEcsAskQuestionTool(deps, { sessionKey: "sess-1" });
    const result = await tool.execute("call-1", { question: "Help?" });

    const parsed = parseResult(result as never) as Record<string, unknown>;
    expect(parsed.answer).toBeNull();
    expect(parsed.error).toContain("Failed to post question to any channel");
  });

  it("uses explicit projectId param when no active task", async () => {
    const deps = makeDeps();
    // Re-set mock since a prior test overrides it to return no threadId.
    mocks.postQuestion.mockResolvedValue({ messageId: "msg-1", threadId: "thread-1" });

    const tool = createEcsAskQuestionTool(deps, {
      sessionKey: "agent:main:main",
      agentId: "main",
    });

    await tool.execute("call-1", {
      question: "Which DB should SafePlate use?",
      projectId: "safeplate",
    });

    expect(mocks.postQuestion).toHaveBeenCalledWith(expect.anything(), "safeplate");
    expect(mocks.registerPendingQuestion).toHaveBeenCalledWith(
      expect.anything(),
      "thread-1",
      "safeplate",
      undefined,
    );
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

  it("uses explicit projectId param when no active task", async () => {
    const deps = makeDeps();
    const tool = createEcsRaiseIssueTool(deps, { agentId: "main" });

    await tool.execute("call-1", {
      severity: "warn",
      title: "SafePlate build issue",
      description: "Something broke",
      attempted: [],
      projectId: "safeplate",
    });

    expect(mocks.postIssue).toHaveBeenCalledWith(expect.anything(), "safeplate");
  });
});

describe("ecs_thread_reply", () => {
  it("posts reply to Discord thread for active task", async () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask(), "sess-1", undefined, "agent-1");
    tracker.setDiscordThread("task-1", "discord-thread-1");
    const deps = makeDeps(tracker);

    const tool = createEcsThreadReplyTool(deps, { sessionKey: "sess-1", agentId: "agent-1" });
    const result = await tool.execute("call-1", {
      message: "I'm working on the BRD preview component next.",
    });

    const parsed = parseResult(result as never) as Record<string, unknown>;
    expect(parsed.posted).toBe(true);
    expect(parsed.taskId).toBe("task-1");
    expect(parsed.discordMessageId).toBe("msg-thread-1");
    expect(mocks.postToThread).toHaveBeenCalledWith(
      "discord-thread-1",
      "I'm working on the BRD preview component next.",
    );
  });

  it("posts reply to Teams thread when teams deps provided", async () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask(), "sess-1", undefined, "agent-1");
    tracker.setTeamsMessage("task-1", "teams-msg-1");
    const deps = makeDeps(tracker);
    deps.teams = {
      postReplyToThread: mocks.postReplyToThread,
    } as never;

    const tool = createEcsThreadReplyTool(deps, { sessionKey: "sess-1", agentId: "agent-1" });
    const result = await tool.execute("call-1", {
      message: "Running verification now.",
    });

    const parsed = parseResult(result as never) as Record<string, unknown>;
    expect(parsed.posted).toBe(true);
    expect(parsed.teamsMessageId).toBe("msg-teams-thread-1");
    expect(mocks.postReplyToThread).toHaveBeenCalledWith(
      "Running verification now.",
      undefined,
      "teams-msg-1",
      undefined,
    );
  });

  it("gracefully handles no active task", async () => {
    const deps = makeDeps();
    const tool = createEcsThreadReplyTool(deps, { sessionKey: "no-task" });

    const result = await tool.execute("call-1", {
      message: "Hello",
    });

    const parsed = parseResult(result as never) as Record<string, unknown>;
    expect(parsed.posted).toBe(true);
    expect(parsed.taskId).toBe("unknown");
    expect(parsed.discordMessageId).toBeNull();
    expect(parsed.teamsMessageId).toBeNull();
    expect(mocks.postToThread).not.toHaveBeenCalled();
  });
});

describe("ecs_check_inbox", () => {
  it("resolves taskId from session and forwards to callback.checkInbox", async () => {
    const tracker = new EcsTaskTracker();
    tracker.register(makeTask(), "sess-1", undefined, "agent-1");
    const deps = makeDeps(tracker);
    mocks.checkInbox.mockResolvedValueOnce({
      messages: [{ id: "m-1", sender: "alice", content: "ping", ts: "2026-04-17T00:00:00Z" }],
    });

    const tool = createEcsCheckInboxTool(deps, { sessionKey: "sess-1", agentId: "agent-1" });
    const result = await tool.execute("call-1", {});

    const parsed = parseResult(result as never) as { messages: Array<Record<string, unknown>> };
    expect(mocks.checkInbox).toHaveBeenCalledWith("task-1");
    expect(parsed.messages).toEqual([
      { id: "m-1", sender: "alice", content: "ping", ts: "2026-04-17T00:00:00Z" },
    ]);
  });

  it("returns empty array when no task resolves from session or args", async () => {
    const deps = makeDeps();
    const tool = createEcsCheckInboxTool(deps, { sessionKey: "no-task" });

    const result = await tool.execute("call-1", {});

    const parsed = parseResult(result as never) as { messages: unknown[] };
    expect(parsed.messages).toEqual([]);
    expect(mocks.checkInbox).not.toHaveBeenCalled();
  });

  it("falls back to taskId arg when session does not match", async () => {
    const deps = makeDeps();
    mocks.checkInbox.mockResolvedValueOnce({ messages: [] });

    const tool = createEcsCheckInboxTool(deps, { sessionKey: "no-task" });
    await tool.execute("call-1", { taskId: "task-42" });

    expect(mocks.checkInbox).toHaveBeenCalledWith("task-42");
  });
});
