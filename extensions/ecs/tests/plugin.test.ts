import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/ecs";
import { afterEach, describe, expect, it, vi } from "vitest";
import ecsPlugin from "../index.js";
import { EcsTaskTracker } from "../src/task-tracker.js";

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

    // Should register 5 hooks: subagent_ended, message_received, message_sent, gateway_start, subagent_spawned
    expect(hooks).toHaveLength(5);
    expect(hooks.map((h) => h.hookName).toSorted()).toEqual([
      "gateway_start",
      "message_received",
      "message_sent",
      "subagent_ended",
      "subagent_spawned",
    ]);

    // Should register 1 tool factory (producing 4 tools).
    expect(tools).toHaveLength(1);
    expect(tools[0].names).toEqual([
      "ecs_status_update",
      "ecs_ask_question",
      "ecs_raise_issue",
      "ecs_set_persona",
    ]);
    expect(tools[0].optional).toBe(false);

    // Should register 1 HTTP route.
    expect(httpRoutes).toHaveLength(1);
    expect(httpRoutes[0].path).toBe("/ecs");
    expect(httpRoutes[0].match).toBe("prefix");
    expect(httpRoutes[0].auth).toBe("plugin");
  });

  it("tool factory produces tools with session context", () => {
    const { api, tools } = createMockApi(makeEcsPluginConfig());
    ecsPlugin.register(api);

    const factory = tools[0].factory;
    const result = factory({ sessionKey: "sess-1", agentId: "agent-1" }) as { name: string }[];
    expect(result).toHaveLength(4);
    expect(result.map((t) => t.name)).toEqual([
      "ecs_status_update",
      "ecs_ask_question",
      "ecs_raise_issue",
      "ecs_set_persona",
    ]);
  });
});
