import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveActiveEmbeddedRunSessionId: vi.fn<(sessionKey: string) => string | undefined>(),
  queueEmbeddedPiMessageDetailed:
    vi.fn<
      (
        sessionId: string,
        text: string,
      ) =>
        | { queued: true }
        | { queued: false; reason: "no_active_run" | "not_streaming" | "compacting" }
    >(),
  loadConfig: vi.fn<() => Record<string, unknown>>(),
  resolveSessionStoreKey: vi.fn<(params: { cfg: unknown; sessionKey: string }) => string>(),
}));

vi.mock("../../agents/pi-embedded-runner/runs.js", () => ({
  resolveActiveEmbeddedRunSessionId: (key: string) => mocks.resolveActiveEmbeddedRunSessionId(key),
  queueEmbeddedPiMessageDetailed: (sessionId: string, text: string) =>
    mocks.queueEmbeddedPiMessageDetailed(sessionId, text),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => mocks.loadConfig(),
}));

vi.mock("../../gateway/session-store-key.js", () => ({
  resolveSessionStoreKey: (params: { cfg: unknown; sessionKey: string }) =>
    mocks.resolveSessionStoreKey(params),
}));

import { queueSubagentMessageInProcess } from "./runtime-subagent-queue.js";

describe("queueSubagentMessageInProcess", () => {
  beforeEach(() => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReset();
    mocks.queueEmbeddedPiMessageDetailed.mockReset();
    mocks.loadConfig.mockReset().mockReturnValue({});
    // Default: canonicalizer returns the key unchanged (no-op).
    mocks.resolveSessionStoreKey.mockReset().mockImplementation(({ sessionKey }) => sessionKey);
  });

  it("returns no_active_run when no session id resolves for the key", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);

    const result = await queueSubagentMessageInProcess({
      sessionKey: "agent:main:main",
      message: "hi",
    });

    expect(result).toEqual({ queued: false, reason: "no_active_run" });
    expect(mocks.queueEmbeddedPiMessageDetailed).not.toHaveBeenCalled();
  });

  it("falls back to the canonical sessionKey when the raw key misses", async () => {
    // Plugin passes the raw key (tracker stored it as e.g. "coding-ecs-67"), but
    // the gateway `agent` handler canonicalized it to "agent:coding:coding-ecs-67"
    // before dispatching, so the embedded-runner registration lives under the
    // canonical form. The canonical fallback must resolve the session.
    mocks.resolveActiveEmbeddedRunSessionId.mockImplementation((key) =>
      key === "agent:coding:coding-ecs-67" ? "session-777" : undefined,
    );
    mocks.resolveSessionStoreKey.mockImplementation(({ sessionKey }) =>
      sessionKey === "coding-ecs-67" ? "agent:coding:coding-ecs-67" : sessionKey,
    );
    mocks.queueEmbeddedPiMessageDetailed.mockReturnValue({ queued: true });

    const result = await queueSubagentMessageInProcess({
      sessionKey: "coding-ecs-67",
      message: "hi",
    });

    expect(result).toEqual({ queued: true });
    expect(mocks.queueEmbeddedPiMessageDetailed).toHaveBeenCalledWith("session-777", "hi");
  });

  it("swallows canonicalizer failures and returns no_active_run", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
    mocks.loadConfig.mockImplementation(() => {
      throw new Error("config not available in minimal env");
    });

    const result = await queueSubagentMessageInProcess({
      sessionKey: "coding-ecs-67",
      message: "hi",
    });

    expect(result).toEqual({ queued: false, reason: "no_active_run" });
  });

  it("returns queued:true when the embedded run accepts the message", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-123");
    mocks.queueEmbeddedPiMessageDetailed.mockReturnValue({ queued: true });

    const result = await queueSubagentMessageInProcess({
      sessionKey: "agent:main:main",
      message: "hi",
    });

    expect(result).toEqual({ queued: true });
    expect(mocks.queueEmbeddedPiMessageDetailed).toHaveBeenCalledWith("session-123", "hi");
  });

  it.each(["not_streaming", "compacting", "no_active_run"] as const)(
    "propagates %s as the failure reason",
    async (reason) => {
      mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-123");
      mocks.queueEmbeddedPiMessageDetailed.mockReturnValue({ queued: false, reason });

      const result = await queueSubagentMessageInProcess({
        sessionKey: "agent:main:main",
        message: "hi",
      });

      expect(result).toEqual({ queued: false, reason });
    },
  );

  it("narrows an unexpected reason string to 'unknown'", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-123");
    mocks.queueEmbeddedPiMessageDetailed.mockReturnValue({
      queued: false,
      // Simulate a future reason the runner might return that this module
      // hasn't been taught about yet. The public SDK shape must stay narrow.
      reason: "something-new" as unknown as "no_active_run",
    });

    const result = await queueSubagentMessageInProcess({
      sessionKey: "agent:main:main",
      message: "hi",
    });

    expect(result).toEqual({ queued: false, reason: "unknown" });
  });
});
