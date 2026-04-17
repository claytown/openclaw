import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/ecs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ecsPlugin from "../index.js";
import { getEcsTaskTracker } from "../src/task-tracker.js";
import type { EcsTask } from "../src/types.js";

vi.mock("../src/api-handler.js", () => ({
  createEcsApiHandler: () => async () => {},
}));

// Mock Teams so isEcsChannel is a controllable vi.fn per-test.
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
  const isEcsChannel = vi.fn().mockReturnValue(false);
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
    __mocks: { isEcsChannel, registerChannel },
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
  projectChannels: {
    "proj-static": "19:static@thread.tacv2",
  },
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
};

function createApi(pluginConfig: Record<string, unknown>): {
  api: OpenClawPluginApi;
  hooks: RegisteredHook[];
  logger: PluginLogger;
} {
  const hooks: RegisteredHook[] = [];
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
    on: vi.fn((hookName: string, handler: (...args: never[]) => unknown) => {
      hooks.push({ hookName, handler });
    }),
  } as unknown as OpenClawPluginApi;
  return { api, hooks, logger };
}

async function fireMessageReceived(hooks: RegisteredHook[], rawChannelId: string): Promise<void> {
  const hook = hooks.find((h) => h.hookName === "message_received");
  expect(hook).toBeDefined();
  await hook!.handler(
    { content: "hi", from: "human@example.com" } as never,
    {
      channelId: "msteams",
      conversationId: `conversation:${rawChannelId}`,
    } as never,
  );
}

function findAclLog(logger: PluginLogger): string | undefined {
  const info = logger.info as ReturnType<typeof vi.fn>;
  const call = info.mock.calls.find(
    (args) => typeof args[0] === "string" && args[0].startsWith("[ecs] message_received"),
  );
  return call?.[0] as string | undefined;
}

describe("ECS Teams ACL paths", () => {
  beforeEach(() => {
    getEcsTaskTracker().clear();
  });

  afterEach(() => {
    getEcsTaskTracker().clear();
    vi.clearAllMocks();
  });

  it("logs via=default when the raw id matches config.teams.defaultChannel", async () => {
    const { api, hooks, logger } = createApi(makeConfig());
    ecsPlugin.register(api);

    await fireMessageReceived(hooks, teamsCfg.defaultChannel);

    const line = findAclLog(logger);
    expect(line).toContain("isEcsTeams=true");
    expect(line).toContain("via=default");
  });

  it("logs via=projectChannels when the raw id matches a static projectChannels value", async () => {
    const { api, hooks, logger } = createApi(makeConfig());
    ecsPlugin.register(api);

    await fireMessageReceived(hooks, teamsCfg.projectChannels["proj-static"]);

    const line = findAclLog(logger);
    expect(line).toContain("isEcsTeams=true");
    expect(line).toContain("via=projectChannels");
  });

  it("logs via=registered when teams.isEcsChannel accepts the id", async () => {
    const { api, hooks, logger } = createApi(makeConfig());
    const teamsMod = (await import("../src/teams-channels.js")) as unknown as {
      __mocks: { isEcsChannel: ReturnType<typeof vi.fn> };
    };
    teamsMod.__mocks.isEcsChannel.mockReturnValueOnce(true);

    ecsPlugin.register(api);

    await fireMessageReceived(hooks, "19:dynamic@thread.tacv2");

    const line = findAclLog(logger);
    expect(line).toContain("isEcsTeams=true");
    expect(line).toContain("via=registered");
  });

  it("logs via=tracker for a channel only present in the tracker (pod-restart case)", async () => {
    const channelId = "19:venture@thread.tacv2";
    const tracker = getEcsTaskTracker();
    tracker.register(
      {
        taskId: "t-1",
        title: "T",
        description: "",
        priority: "medium",
        teamsChannelId: channelId,
      } as EcsTask,
      "coding-ecs-t-1",
      "run-1",
      "coding",
    );

    const { api, hooks, logger } = createApi(makeConfig());
    ecsPlugin.register(api);

    await fireMessageReceived(hooks, channelId);

    const line = findAclLog(logger);
    expect(line).toContain("isEcsTeams=true");
    expect(line).toContain("via=tracker");
  });

  it("logs isEcsTeams=false with no via when no rule matches", async () => {
    const { api, hooks, logger } = createApi(makeConfig());
    ecsPlugin.register(api);

    await fireMessageReceived(hooks, "19:stranger@thread.tacv2");

    const line = findAclLog(logger);
    expect(line).toContain("isEcsTeams=false");
    expect(line).not.toContain("via=");
  });
});

describe("ECS projectChannels seeding on init", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls teams.registerChannel for each configured projectChannels value", async () => {
    const teamsMod = (await import("../src/teams-channels.js")) as unknown as {
      __mocks: { registerChannel: ReturnType<typeof vi.fn> };
    };
    const before = teamsMod.__mocks.registerChannel.mock.calls.length;

    const { api } = createApi(makeConfig());
    ecsPlugin.register(api);

    const after = teamsMod.__mocks.registerChannel.mock.calls.length;
    const delta = after - before;
    expect(delta).toBeGreaterThanOrEqual(1);
    const calls = teamsMod.__mocks.registerChannel.mock.calls.slice(before);
    const seeded = calls.map((args) => args[0]);
    expect(seeded).toContain(teamsCfg.projectChannels["proj-static"]);
  });
});
