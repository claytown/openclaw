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
}));

vi.mock("../../agents/pi-embedded-runner/runs.js", () => ({
  resolveActiveEmbeddedRunSessionId: (key: string) => mocks.resolveActiveEmbeddedRunSessionId(key),
  queueEmbeddedPiMessageDetailed: (sessionId: string, text: string) =>
    mocks.queueEmbeddedPiMessageDetailed(sessionId, text),
}));

import { queueSubagentMessageInProcess } from "./runtime-subagent-queue.js";

describe("queueSubagentMessageInProcess", () => {
  beforeEach(() => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReset();
    mocks.queueEmbeddedPiMessageDetailed.mockReset();
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
