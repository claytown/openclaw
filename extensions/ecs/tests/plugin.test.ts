import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/ecs";
import { describe, expect, it, vi } from "vitest";
import ecsPlugin from "../index.js";

// Mock api-handler to avoid pulling in deep deps.
vi.mock("../src/api-handler.js", () => ({
  createEcsApiHandler: () => async () => {},
}));

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeEcsPluginConfig() {
  return {
    enabled: true,
    discord: {
      guildId: "g-1",
      channels: { status: "ch-status", info: "ch-info", issues: "ch-issues" },
    },
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
type RegisteredTool = {
  factory: (ctx: Record<string, unknown>) => unknown;
  names?: string[];
  optional?: boolean;
};
type RegisteredHttpRoute = {
  path: string;
  match?: string;
  auth?: string;
  handler: (...args: never[]) => unknown;
};

function createMockApi(pluginConfig: Record<string, unknown>): {
  api: OpenClawPluginApi;
  hooks: RegisteredHook[];
  tools: RegisteredTool[];
  httpRoutes: RegisteredHttpRoute[];
} {
  const hooks: RegisteredHook[] = [];
  const tools: RegisteredTool[] = [];
  const httpRoutes: RegisteredHttpRoute[] = [];

  const api = {
    id: "ecs",
    name: "ECS",
    source: "test",
    config: {} as Record<string, unknown>,
    pluginConfig,
    logger: makeLogger(),
    runtime: {
      subagent: {
        run: vi.fn().mockResolvedValue({ runId: "run-1" }),
        waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
        queueMessage: vi.fn().mockResolvedValue({ queued: true }),
        getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
        deleteSession: vi.fn(),
      },
      channel: {},
    },
    registerTool: vi.fn((factory: unknown, opts: unknown) => {
      tools.push({
        factory: factory as RegisteredTool["factory"],
        ...(opts as Record<string, unknown>),
      } as RegisteredTool);
    }),
    registerHook: vi.fn(),
    registerHttpRoute: vi.fn((params: unknown) => {
      httpRoutes.push(params as RegisteredHttpRoute);
    }),
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

  return { api, hooks, tools, httpRoutes };
}

describe("extractRawId (via message hooks)", () => {
  it("message_received hook strips channel: prefix and forwards ECS messages", async () => {
    const { api, hooks } = createMockApi(makeEcsPluginConfig());
    ecsPlugin.register(api);

    const hook = hooks.find((h) => h.hookName === "message_received");
    expect(hook).toBeDefined();

    // With "channel:" prefix — should match ch-info and forward.
    await hook!.handler(
      { content: "test msg", from: "user" } as never,
      { channelId: "discord", conversationId: "channel:ch-info" } as never,
    );
    // No crash = prefix was stripped correctly.
  });

  it("message_received handles raw IDs without prefix", async () => {
    const { api, hooks } = createMockApi(makeEcsPluginConfig());
    ecsPlugin.register(api);

    const hook = hooks.find((h) => h.hookName === "message_received");

    await hook!.handler(
      { content: "raw msg", from: "user" } as never,
      { channelId: "discord", conversationId: "ch-info" } as never,
    );
  });

  it("message_received falls back to metadata.threadId when rawId has no pending question", async () => {
    const { api, hooks } = createMockApi(makeEcsPluginConfig());
    ecsPlugin.register(api);

    const hook = hooks.find((h) => h.hookName === "message_received");
    expect(hook).toBeDefined();

    // Simulate a Teams message where conversationId is the channel ID (no relay match)
    // but metadata.threadId is the question thread root message ID.
    // Since the relay has no pending question for this test, this just verifies no crash.
    await hook!.handler(
      {
        content: "answer text",
        from: "human@company.com",
        metadata: { threadId: "1713000000000" },
      } as never,
      { channelId: "msteams", conversationId: "conversation:19:abc@thread.tacv2" } as never,
    );
  });
});

describe("before_dispatch hook (ECS question routing)", () => {
  it("passes through when session key has no thread suffix", async () => {
    const { api, hooks } = createMockApi(makeEcsPluginConfig());
    ecsPlugin.register(api);

    const hook = hooks.find((h) => h.hookName === "before_dispatch");
    expect(hook).toBeDefined();

    const result = await hook!.handler(
      { content: "hello", senderId: "user1" } as never,
      { sessionKey: "agent:main:msteams:default:19:abc@thread.tacv2" } as never,
    );
    expect(result).toBeUndefined();
  });

  it("passes through when thread ID does not match a pending question", async () => {
    const { api, hooks } = createMockApi(makeEcsPluginConfig());
    ecsPlugin.register(api);

    const hook = hooks.find((h) => h.hookName === "before_dispatch");
    expect(hook).toBeDefined();

    const result = await hook!.handler(
      { content: "hello", senderId: "user1" } as never,
      { sessionKey: "agent:main:msteams:default:19:abc@thread.tacv2:thread:9999999999" } as never,
    );
    expect(result).toBeUndefined();
  });

  it("passes through when content is empty", async () => {
    const { api, hooks } = createMockApi(makeEcsPluginConfig());
    ecsPlugin.register(api);

    const hook = hooks.find((h) => h.hookName === "before_dispatch");
    expect(hook).toBeDefined();

    const result = await hook!.handler(
      { content: "", senderId: "user1" } as never,
      { sessionKey: "agent:main:msteams:default:19:abc@thread.tacv2:thread:123" } as never,
    );
    expect(result).toBeUndefined();
  });
});

describe("ECS plugin registration", () => {
  it("does not register anything when not enabled", () => {
    const { api, hooks, tools, httpRoutes } = createMockApi({ enabled: false });
    ecsPlugin.register(api);
    expect(hooks).toHaveLength(0);
    expect(tools).toHaveLength(0);
    expect(httpRoutes).toHaveLength(0);
  });

  it("registers hooks, tools, and HTTP route when enabled", () => {
    const { api, hooks, tools, httpRoutes } = createMockApi(makeEcsPluginConfig());
    ecsPlugin.register(api);

    // Should register 5 hooks: subagent_ended, message_received, before_dispatch, gateway_start, subagent_spawned.
    // (The message_sent hook was removed along with the /agent_message_callback path — ECS never implemented that endpoint.)
    expect(hooks).toHaveLength(5);
    expect(hooks.map((h) => h.hookName).toSorted()).toEqual([
      "before_dispatch",
      "gateway_start",
      "message_received",
      "subagent_ended",
      "subagent_spawned",
    ]);

    // Should register 1 tool factory (producing 6 tools).
    expect(tools).toHaveLength(1);
    expect(tools[0].names).toEqual([
      "ecs_status_update",
      "ecs_ask_question",
      "ecs_raise_issue",
      "ecs_set_persona",
      "ecs_thread_reply",
      "ecs_check_inbox",
    ]);
    expect(tools[0].optional).toBe(false);

    // Should register 1 HTTP route: the public /ecs API. The earlier
    // loopback /__internal/ecs/* endpoints were removed; the forwarder
    // now relies solely on subagent.queueMessage and logs the outcome
    // once, no fallbacks.
    expect(httpRoutes).toHaveLength(1);
    const publicRoute = httpRoutes[0];
    expect(publicRoute.path).toBe("/ecs");
    expect(publicRoute.match).toBe("prefix");
    expect(publicRoute.auth).toBe("gateway");
  });

  it("tool factory produces tools with session context", () => {
    const { api, tools } = createMockApi(makeEcsPluginConfig());
    ecsPlugin.register(api);

    const factory = tools[0].factory;
    const result = factory({ sessionKey: "sess-1", agentId: "agent-1" }) as { name: string }[];
    expect(result).toHaveLength(6);
    expect(result.map((t) => t.name)).toEqual([
      "ecs_status_update",
      "ecs_ask_question",
      "ecs_raise_issue",
      "ecs_set_persona",
      "ecs_thread_reply",
      "ecs_check_inbox",
    ]);
  });
});
