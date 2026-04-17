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
  const setOnRootFallback = vi.fn();

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
    setOnRootFallback = setOnRootFallback;
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

  it("falls back to loopback HTTP inject when queueMessage reports no active run", async () => {
    const { api, hooks, queueMessage, run } = createApi(makeConfig());
    queueMessage.mockResolvedValue({ queued: false, reason: "no_active_run" });
    const fetchMock = vi.fn().mockResolvedValue({ status: 202 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      ecsPlugin.register(api);
      // Fire gateway_start so the plugin captures the loopback port used by
      // the forwarder to POST /__internal/ecs/inject.
      const gatewayStart = hooks.find((h) => h.hookName === "gateway_start");
      await gatewayStart!.handler({ port: 54321 } as never, {} as never);

      const hook = hooks.find((h) => h.hookName === "before_dispatch");
      const result = await hook!.handler(
        { content: "hello", senderId: "human@example.com" } as never,
        { sessionKey: `agent:main:msteams:default:thread:${threadId}` } as never,
      );
      expect(result).toEqual({ handled: true });

      // Let queueMessage settle, then the follow-up fetch.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(queueMessage).toHaveBeenCalledTimes(1);
      // run() must NOT be called directly from the hook stack anymore — the
      // loopback handler takes ownership of attaching the fresh run off a
      // separate HTTP request scope so the session write lock can't deadlock.
      expect(run).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:54321/__internal/ecs/inject",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining(sessionKey),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("still forwards when the thread has been flagged dead, and skips the Teams ACK", async () => {
    // Simulate an outbound 404 that flipped the tracker's dead-thread flag.
    // Inbound routing must still resolve so the human reply reaches the agent.
    getEcsTaskTracker().markDeadThread(taskId);

    const { api, hooks, queueMessage } = createApi(makeConfig());
    queueMessage.mockResolvedValue({ queued: true });

    ecsPlugin.register(api);
    const hook = hooks.find((h) => h.hookName === "before_dispatch");

    const result = await hook!.handler(
      { content: "still there?", senderId: "human@example.com" } as never,
      { sessionKey: `agent:main:msteams:default:thread:${threadId}` } as never,
    );
    expect(result).toEqual({ handled: true });

    await new Promise((r) => setImmediate(r));

    expect(queueMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        message: expect.stringContaining("still there?"),
      }),
    );

    const teamsMocks = (await import("../src/teams-channels.js")) as unknown as {
      __mocks: { postReplyToThread: ReturnType<typeof vi.fn> };
    };
    // Posting to a known-dead thread would 404 again — suppress it.
    expect(teamsMocks.__mocks.postReplyToThread).not.toHaveBeenCalled();
  });

  it("does not mark the Teams thread dead when forwarding fails with an arbitrary error", async () => {
    const { api, hooks, queueMessage, run } = createApi(makeConfig());
    queueMessage.mockRejectedValue(
      new Error("Plugin runtime subagent methods are only available during a gateway request."),
    );
    run.mockRejectedValue(new Error("subagent unavailable"));

    ecsPlugin.register(api);
    const hook = hooks.find((h) => h.hookName === "before_dispatch");

    const result = await hook!.handler(
      { content: "hi", senderId: "human@example.com" } as never,
      { sessionKey: `agent:main:msteams:default:thread:${threadId}` } as never,
    );
    expect(result).toEqual({ handled: true });

    // Let the fire-and-forget chain settle (queueMessage rejects → fallback
    // to run → run rejects → caught and logged, not rethrown).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const tracker = getEcsTaskTracker();
    const active = tracker.findByTeamsThread(threadId);
    expect(active).toBeDefined();
    // Forwarding failures must NOT flip the tracker's dead-thread flag. That
    // bit is reserved for Teams 404 ActivityNotFoundInConversation responses.
    expect(active?.teamsThreadIsDead).not.toBe(true);
  });
});
