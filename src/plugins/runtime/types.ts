import type { PluginRuntimeChannel } from "./types-channel.js";
import type { PluginRuntimeCore, RuntimeLogger } from "./types-core.js";

export type { RuntimeLogger };

// ── Subagent runtime types ──────────────────────────────────────────

export type SubagentRunParams = {
  sessionKey: string;
  message: string;
  provider?: string;
  model?: string;
  extraSystemPrompt?: string;
  lane?: string;
  deliver?: boolean;
  idempotencyKey?: string;
};

export type SubagentRunResult = {
  runId: string;
};

export type SubagentWaitParams = {
  runId: string;
  timeoutMs?: number;
};

export type SubagentWaitResult = {
  status: "ok" | "error" | "timeout";
  error?: string;
};

export type SubagentGetSessionMessagesParams = {
  sessionKey: string;
  limit?: number;
};

export type SubagentGetSessionMessagesResult = {
  messages: unknown[];
};

/** @deprecated Use SubagentGetSessionMessagesParams. */
export type SubagentGetSessionParams = SubagentGetSessionMessagesParams;

/** @deprecated Use SubagentGetSessionMessagesResult. */
export type SubagentGetSessionResult = SubagentGetSessionMessagesResult;

export type SubagentDeleteSessionParams = {
  sessionKey: string;
  deleteTranscript?: boolean;
};

export type SubagentQueueMessageParams = {
  sessionKey: string;
  message: string;
};

export type SubagentQueueMessageReason =
  | "no_active_run"
  | "not_streaming"
  | "compacting"
  | "unknown";

export type SubagentQueueMessageResult = {
  queued: boolean;
  reason?: SubagentQueueMessageReason;
};

export type SubagentInterruptParams = {
  sessionKey: string;
};

export type SubagentInterruptResult = {
  /** `true` when an active run was aborted; `false` when there was nothing to
   * interrupt (no active run, or the session key does not resolve). */
  interrupted: boolean;
};

/** Trusted in-process runtime surface injected into native plugins. */
export type PluginRuntime = PluginRuntimeCore & {
  subagent: {
    run: (params: SubagentRunParams) => Promise<SubagentRunResult>;
    waitForRun: (params: SubagentWaitParams) => Promise<SubagentWaitResult>;
    /**
     * Inject a user message into an active agent session's in-flight run.
     *
     * Unlike `run`, this does not start a new dispatch — it appends to the
     * running attempt's pending-message queue so the next LLM turn sees it.
     * Returns `{ queued: false, reason }` when no streaming run is available.
     */
    queueMessage: (params: SubagentQueueMessageParams) => Promise<SubagentQueueMessageResult>;
    /**
     * Cancel the session's current embedded run.
     *
     * Intended for waking sessions that have accumulated queued messages but
     * are stuck in a long tool loop that never returns to the LLM (for
     * example, a coding agent running tests). The abort lands at the next
     * safe boundary — after the currently-executing tool call completes, not
     * mid-call — so tool state is not left dangling. Messages that arrived
     * via `queueMessage` surface on the next run that the session starts.
     *
     * No-op safe: calling this on a session with no active run returns
     * `{ interrupted: false }` rather than throwing. Purely in-process — it
     * operates on the embedded-run map without a gateway round-trip.
     */
    interrupt: (params: SubagentInterruptParams) => Promise<SubagentInterruptResult>;
    getSessionMessages: (
      params: SubagentGetSessionMessagesParams,
    ) => Promise<SubagentGetSessionMessagesResult>;
    /** @deprecated Use getSessionMessages. */
    getSession: (params: SubagentGetSessionParams) => Promise<SubagentGetSessionResult>;
    deleteSession: (params: SubagentDeleteSessionParams) => Promise<void>;
  };
  channel: PluginRuntimeChannel;
};

export type CreatePluginRuntimeOptions = {
  subagent?: PluginRuntime["subagent"];
  allowGatewaySubagentBinding?: boolean;
};
