import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/ecs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ecsPlugin from "../index.js";
import { getEcsTaskTracker } from "../src/task-tracker.js";
import type { EcsTask } from "../src/types.js";

vi.mock("../src/api-handler.js", () => ({
  createEcsApiHandler: () => async () => {},
}));

// Avoid real Teams HTTP.
vi.mock("../src/teams-channels.js", async () => {
  const postReplyToThread = vi.fn().mockResolvedValue({ messageId: "ack-1" });
  const postTaskAssigned = vi.fn().mockResolvedValue({ messageId: "assigned-1" });
  const postStatusUpdate = vi.fn().mockResolvedValue({ messageId: "status-1" });
  const postTaskCompleted = vi.fn().mockResolvedValue({ messageId: "done-1" });
  const postQuestion = vi.fn().mockResolvedValue({ messageId: "q-1" });
  const postQuestionTimeout = vi.fn().mockResolvedValue({ messageId: "qto-1" });
  const postIssue = vi.fn().mockResolvedValue({ messageId: "issue-1" });
  const postSystemEvent = vi.fn().mockResolvedValue({ messageId: "sys-1" });
  const registerChannel = vi.fn();
  const isEcsChannel = vi.fn().mockReturnValue(true);
  const setOnPost = vi.fn();
  const setOnDeadThread = vi.fn();

  class EcsTeamsChannels {
    postReplyToThread = postReplyToThread;
    postTaskAssigned = postTaskAssigned;
    postStatusUpdate = postStatusUpdate;
    postTaskCompleted = postTaskCompleted;
    postQuestion = postQuestion;
    postQuestionTimeout = postQuestionTimeout;
    postIssue = postIssue;
    postSystemEvent = postSystemEvent;
    registerChannel = registerChannel;
    isEcsChannel = isEcsChannel;
    setOnPost = setOnPost;
    setOnDeadThread = setOnDeadThread;
  }
  return {
    EcsTeamsChannels,
    __mocks: {
      postReplyToThread,
      postTaskAssigned,
      postStatusUpdate,
      postTaskCompleted,
      postQuestion,
      postQuestionTimeout,
      postIssue,
      postSystemEvent,
    },
  };
});

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const teamsCfg = {
  tenantId: "tenant-1",
  appId: "app-1",
  appPassword: "pw",
  teamId: "team-1",
  serviceUrl: "https://smba.example",
  defaultChannel: "19:default@thread.tacv2",
};

function makeConfig() {
  return {
    enabled: true,
    discord: {
      guildId: "g-1",
      channels: { status: "ch-status", info: "ch-info", issues: "ch-issues" },
    },
    teams: teamsCfg,
    api: {},
    controlPlane: {},
    agents: {},
  };
}

type RegisteredHook = {
  hookName: string;
  handler: (...args: never[]) => unknown;
  priority?: number;
};

function createApi(pluginConfig: Record<string, unknown>) {
  const hooks: RegisteredHook[] = [];
  const queueMessage = vi.fn();
  const run = vi.fn().mockResolvedValue({ runId: "run-1" });
  const api = {
    id: "ecs",
    name: "ECS",
    source: "test",
    config: {} as Record<string, unknown>,
    pluginConfig,
    logger: makeLogger(),
    runtime: {
      subagent: {
        run,
        waitForRun: vi.fn(),
        queueMessage,
        getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
        deleteSession: vi.fn(),
      },
      channel: {},
    },
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    registerContextEngine: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
    on: vi.fn(
      (hookName: string, handler: (...args: never[]) => unknown, opts?: { priority?: number }) => {
        hooks.push({ hookName, handler, priority: opts?.priority });
      },
    ),
  } as unknown as OpenClawPluginApi;
  return { api, hooks, queueMessage, run };
}

describe("ECS before_dispatch forwarding", () => {
  const threadId = "1776363790691";
  const sessionKey = "coding-ecs-56";
  const taskId = "56";

  beforeEach(() => {
    getEcsTaskTracker().clear();
    const task: EcsTask = {
      taskId,
      title: "Test",
      description: "desc",
      priority: "medium",
      projectId: "proj-1",
    } as EcsTask;
    const tracker = getEcsTaskTracker();
    tracker.register(task, sessionKey, "run-seed", "coding");
    tracker.setTeamsMessage(taskId, threadId);
  });

  afterEach(() => {
    getEcsTaskTracker().clear();
    vi.clearAllMocks();
  });

  it("calls subagent.queueMessage first and posts a Teams ACK when tracker matches", async () => {
    const { api, hooks, queueMessage, run } = createApi(makeConfig());
    queueMessage.mockResolvedValue({ queued: true });

    ecsPlugin.register(api);
    const hook = hooks.find((h) => h.hookName === "before_dispatch");
    expect(hook).toBeDefined();

    const result = await hook!.handler(
      { content: "what are you doing?", senderId: "human@example.com" } as never,
      { sessionKey: `agent:main:msteams:default:thread:${threadId}` } as never,
    );
    expect(result).toEqual({ handled: true });

    // Allow the fire-and-forget queueMessage/run chain to settle.
    await new Promise((r) => setImmediate(r));

    expect(queueMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        message: expect.stringContaining("what are you doing?"),
      }),
    );
    expect(run).not.toHaveBeenCalled();

    const teamsMocks = (await import("../src/teams-channels.js")) as unknown as {
      __mocks: { postReplyToThread: ReturnType<typeof vi.fn> };
    };
    expect(teamsMocks.__mocks.postReplyToThread).toHaveBeenCalledWith(
      expect.stringContaining("Got it"),
      "proj-1",
      threadId,
    );
  });

  it("falls back to subagent.run when queueMessage reports no active run", async () => {
    const { api, hooks, queueMessage, run } = createApi(makeConfig());
    queueMessage.mockResolvedValue({ queued: false, reason: "no_active_run" });

    ecsPlugin.register(api);
    const hook = hooks.find((h) => h.hookName === "before_dispatch");

    const result = await hook!.handler(
      { content: "hello", senderId: "human@example.com" } as never,
      { sessionKey: `agent:main:msteams:default:thread:${threadId}` } as never,
    );
    expect(result).toEqual({ handled: true });

    await new Promise((r) => setImmediate(r));

    expect(queueMessage).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ sessionKey, deliver: false }));
  });
});
