import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EcsTeamsChannels } from "../src/teams-channels.js";

const TOKEN_BODY = JSON.stringify({ access_token: "token-1", expires_in: 3600 });

function makeTokenOk(): Response {
  return new Response(TOKEN_BODY, { status: 200 });
}

function makeActivityOk(id: string): Response {
  return new Response(JSON.stringify({ id }), { status: 200 });
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

// The "404 fallback feature flag" describe block that lived here was removed
// when postReplyToThread stopped accepting a threadId. No public method now
// passes replyToId, so the retry ladder + onDeadThread + onRootFallback paths
// in EcsTeamsChannels.post() are intentionally unreachable from the public
// API. The ladder code is preserved as documented dead code for future Bot
// Framework pivots (see collectReplyCandidates, bestThreadSelector, and the
// `fallbackRootOn404Enabled` env flag in src/teams-channels.ts).
