import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EcsTeamsChannels } from "../src/teams-channels.js";

const TOKEN_BODY = JSON.stringify({ access_token: "token-1", expires_in: 3600 });

function makeTokenOk(): Response {
  return new Response(TOKEN_BODY, { status: 200 });
}

function makeActivityOk(id: string): Response {
  return new Response(JSON.stringify({ id }), { status: 200 });
}

function make404(): Response {
  return new Response(JSON.stringify({ error: { code: "ActivityNotFoundInConversation" } }), {
    status: 404,
  });
}

/**
 * botSend caches the bot token at module scope, so tests cannot rely on a
 * predictable number of fetch calls. Route by URL instead: OAuth token
 * requests always resolve to tokenOk; activity POSTs use the per-test queue.
 */
function routedFetchMock(activityResponses: Array<() => Response>): ReturnType<typeof vi.fn> {
  let activityIdx = 0;
  return vi.fn(async (url: unknown) => {
    const urlStr = String(url);
    if (urlStr.includes("login.microsoftonline.com")) {
      return makeTokenOk();
    }
    const next = activityResponses[activityIdx++];
    if (!next) {
      throw new Error(`unexpected activity POST to ${urlStr}`);
    }
    return next();
  });
}

function findActivityCall(mock: ReturnType<typeof vi.fn>): [unknown, ...unknown[]] {
  for (const call of mock.mock.calls) {
    if (!String(call[0]).includes("login.microsoftonline.com")) {
      return call as [unknown, ...unknown[]];
    }
  }
  throw new Error("no activity fetch call");
}

const creds = {
  tenantId: "tenant-1",
  appId: "app-1",
  appPassword: "pw",
  serviceUrl: "https://smba.trafficmanager.net/emea/",
};

const cfg = {
  tenantId: "tenant-1",
  appId: "app-1",
  appPassword: "pw",
  teamId: "team-1",
  serviceUrl: "https://smba.trafficmanager.net/emea/",
  defaultChannel: "19:default@thread.tacv2",
};

describe("EcsTeamsChannels serviceUrl selection", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.ECS_TEAMS_FALLBACK_ROOT_ON_404 = "false";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.ECS_TEAMS_FALLBACK_ROOT_ON_404;
  });

  it("uses the cached inbound serviceUrl for outbound posts to the same channel", async () => {
    const teams = new EcsTeamsChannels(creds, cfg);
    teams.recordInboundServiceUrl(cfg.defaultChannel, "https://smba.trafficmanager.net/amer/");

    const fetchMock = routedFetchMock([() => makeActivityOk("msg-1")]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await teams.postSystemEvent({ title: "hello", description: "world" });

    const url = String(findActivityCall(fetchMock)[0]);
    expect(url.startsWith("https://smba.trafficmanager.net/amer")).toBe(true);
    expect(url.includes("/emea")).toBe(false);
  });

  it("falls back to configured serviceUrl when no inbound cache entry exists", async () => {
    const teams = new EcsTeamsChannels(creds, cfg);

    const fetchMock = routedFetchMock([() => makeActivityOk("msg-1")]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await teams.postSystemEvent({ title: "hello" });

    const url = String(findActivityCall(fetchMock)[0]);
    expect(url.startsWith("https://smba.trafficmanager.net/emea")).toBe(true);
  });

  it("skips empty or blank inbound serviceUrl writes", async () => {
    const teams = new EcsTeamsChannels(creds, cfg);
    teams.recordInboundServiceUrl(cfg.defaultChannel, "");
    teams.recordInboundServiceUrl(cfg.defaultChannel, "   ");

    const fetchMock = routedFetchMock([() => makeActivityOk("msg-1")]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await teams.postSystemEvent({ title: "hello" });

    const url = String(findActivityCall(fetchMock)[0]);
    expect(url.startsWith("https://smba.trafficmanager.net/emea")).toBe(true);
  });
});

describe("EcsTeamsChannels 404 fallback feature flag", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.ECS_TEAMS_FALLBACK_ROOT_ON_404;
  });

  it("bubbles the 404 instead of posting a fresh root when the flag is off", async () => {
    process.env.ECS_TEAMS_FALLBACK_ROOT_ON_404 = "false";
    const teams = new EcsTeamsChannels(creds, cfg);
    const onDead = vi.fn();
    const onRoot = vi.fn();
    teams.setOnDeadThread(onDead);
    teams.setOnRootFallback(onRoot);

    const fetchMock = routedFetchMock([() => make404()]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(teams.postReplyToThread("hi", undefined, "msg-root-1")).rejects.toThrow(
      /ActivityNotFoundInConversation/,
    );
    expect(onDead).not.toHaveBeenCalled();
    expect(onRoot).not.toHaveBeenCalled();
    // Exactly one activity POST attempted (the 404); no fresh root follow-up.
    const activityCalls = fetchMock.mock.calls.filter(
      (c) => !String(c[0]).includes("login.microsoftonline.com"),
    );
    expect(activityCalls).toHaveLength(1);
  });

  it("posts a fresh root and notifies callbacks when the flag is on", async () => {
    process.env.ECS_TEAMS_FALLBACK_ROOT_ON_404 = "true";
    const teams = new EcsTeamsChannels(creds, cfg);
    const onDead = vi.fn();
    const onRoot = vi.fn();
    teams.setOnDeadThread(onDead);
    teams.setOnRootFallback(onRoot);

    const fetchMock = routedFetchMock([() => make404(), () => makeActivityOk("msg-fresh-1")]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await teams.postReplyToThread("hi", undefined, "msg-root-1");
    expect(result.messageId).toBe("msg-fresh-1");
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToId: "msg-root-1",
        newMessageId: "msg-fresh-1",
      }),
    );
  });
});
