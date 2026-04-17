import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/ecs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ecsPlugin from "../index.js";
import { getEcsTaskTracker } from "../src/task-tracker.js";

vi.mock("../src/api-handler.js", () => ({
  createEcsApiHandler: () => async () => {},
}));

// Mock EcsApiCallback so we can stub fetchActiveTasks per test.
vi.mock("../src/api-callback.js", () => {
  const fetchActiveTasks = vi.fn().mockResolvedValue([]);
  const reportStarted = vi.fn().mockResolvedValue({ ok: true });
  const reportCompleted = vi.fn().mockResolvedValue({ ok: true });
  const reportError = vi.fn().mockResolvedValue({ ok: true });
  const reportStatus = vi.fn().mockResolvedValue({ ok: true });
  const reportMessage = vi.fn().mockResolvedValue({ ok: true });
  const reportProjectChannels = vi.fn().mockResolvedValue({ ok: true });
  const reportProjectTeamsChannel = vi.fn().mockResolvedValue({ ok: true });
  const reportQuestion = vi.fn().mockResolvedValue({ ok: true });

  class EcsApiCallback {
    fetchActiveTasks = fetchActiveTasks;
    reportStarted = reportStarted;
    reportCompleted = reportCompleted;
    reportError = reportError;
    reportStatus = reportStatus;
    reportMessage = reportMessage;
    reportProjectChannels = reportProjectChannels;
    reportProjectTeamsChannel = reportProjectTeamsChannel;
    reportQuestion = reportQuestion;
    report = vi.fn().mockResolvedValue({ ok: true });
  }
  return { EcsApiCallback, __mocks: { fetchActiveTasks } };
});

vi.mock("../src/teams-channels.js", async () => {
  const registerChannel = vi.fn();
  const isEcsChannel = vi.fn().mockReturnValue(false);
  const postTaskAssigned = vi.fn().mockResolvedValue({ messageId: "x" });
  const postSystemEvent = vi.fn().mockResolvedValue({ messageId: "x" });
  const setOnPost = vi.fn();
  const setOnDeadThread = vi.fn();
  const setOnRootFallback = vi.fn();

  class EcsTeamsChannels {
    registerChannel = registerChannel;
    isEcsChannel = isEcsChannel;
    postTaskAssigned = postTaskAssigned;
    postSystemEvent = postSystemEvent;
    setOnPost = setOnPost;
    setOnDeadThread = setOnDeadThread;
    setOnRootFallback = setOnRootFallback;
  }
  return { EcsTeamsChannels, __mocks: { registerChannel } };
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
    // Non-empty controlPlane.url is required to trigger rehydrate.
    controlPlane: { url: "https://control-plane.example", apiKey: "k" },
    agents: {},
  };
}

function createApi(pluginConfig: Record<string, unknown>): {
  api: OpenClawPluginApi;
  logger: PluginLogger;
} {
  const logger = makeLogger();
  const api = {
    id: "ecs",
    name: "ECS",
    source: "test",
    config: {} as Record<string, unknown>,
    pluginConfig,
    logger,
    runtime: {
      subagent: {
        run: vi.fn().mockResolvedValue({ runId: "run-1" }),
        waitForRun: vi.fn(),
        queueMessage: vi.fn().mockResolvedValue({ queued: true }),
        interrupt: vi.fn().mockResolvedValue({ interrupted: true }),
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
    on: vi.fn(),
  } as unknown as OpenClawPluginApi;
  return { api, logger };
}

describe("ECS tracker rehydrate on init", () => {
  beforeEach(() => {
    getEcsTaskTracker().clear();
  });

  afterEach(() => {
    getEcsTaskTracker().clear();
    vi.clearAllMocks();
  });

  it("populates the tracker, registers channels, and indexes thread IDs from fetchActiveTasks", async () => {
    const callbackMod = (await import("../src/api-callback.js")) as unknown as {
      __mocks: { fetchActiveTasks: ReturnType<typeof vi.fn> };
    };
    const teamsMod = (await import("../src/teams-channels.js")) as unknown as {
      __mocks: { registerChannel: ReturnType<typeof vi.fn> };
    };

    callbackMod.__mocks.fetchActiveTasks.mockResolvedValueOnce([
      {
        taskId: "t-101",
        title: "Rehydrated A",
        description: "desc",
        projectId: "proj-a",
        teams_channel_id: "19:ventureA@thread.tacv2",
        teams_thread_id: "1700000000001",
      },
      {
        agent_task_id: 202,
        title: "Rehydrated B",
        description: "desc",
        teams_channel_id: "19:ventureB@thread.tacv2",
        // No teams_thread_id for this one.
      },
    ]);

    const { api } = createApi(makeConfig());
    ecsPlugin.register(api);

    // Rehydrate runs in a fire-and-forget async IIFE; allow the microtask
    // queue and the awaited fetch to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const tracker = getEcsTaskTracker();
    const a = tracker.getByTaskId("t-101");
    const b = tracker.getByTaskId("202");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a?.sessionKey).toBe("coding-ecs-t-101");
    expect(a?.teamsChannelId).toBe("19:ventureA@thread.tacv2");

    // Channel indices populated so ACL will match post-restart.
    expect(tracker.getByTeamsChannelId("19:ventureA@thread.tacv2")?.task.taskId).toBe("t-101");
    expect(tracker.getByTeamsChannelId("19:ventureB@thread.tacv2")?.task.taskId).toBe("202");

    // Teams thread id from the dispatch payload routes via byTeamsMessageId.
    expect(tracker.getByTeamsMessageId("1700000000001")?.task.taskId).toBe("t-101");

    // Both venture channels were registered on the teams helper.
    const calls = teamsMod.__mocks.registerChannel.mock.calls.map((c) => c[0]);
    expect(calls).toContain("19:ventureA@thread.tacv2");
    expect(calls).toContain("19:ventureB@thread.tacv2");
  });

  it("does not call fetchActiveTasks when controlPlane.url is not set", async () => {
    const callbackMod = (await import("../src/api-callback.js")) as unknown as {
      __mocks: { fetchActiveTasks: ReturnType<typeof vi.fn> };
    };
    callbackMod.__mocks.fetchActiveTasks.mockClear();

    const cfg = makeConfig();
    cfg.controlPlane = {} as typeof cfg.controlPlane;
    const { api } = createApi(cfg);
    ecsPlugin.register(api);

    await new Promise((r) => setImmediate(r));
    expect(callbackMod.__mocks.fetchActiveTasks).not.toHaveBeenCalled();
  });

  it("logs a warning when fetchActiveTasks rejects but does not throw", async () => {
    const callbackMod = (await import("../src/api-callback.js")) as unknown as {
      __mocks: { fetchActiveTasks: ReturnType<typeof vi.fn> };
    };
    callbackMod.__mocks.fetchActiveTasks.mockRejectedValueOnce(new Error("network down"));

    const { api, logger } = createApi(makeConfig());
    expect(() => ecsPlugin.register(api)).not.toThrow();

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const found = warnCalls.find(
      (args) => typeof args[0] === "string" && args[0].includes("tracker rehydrate failed"),
    );
    expect(found).toBeDefined();
  });
});
