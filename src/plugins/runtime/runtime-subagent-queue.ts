import type {
  SubagentQueueMessageParams,
  SubagentQueueMessageReason,
  SubagentQueueMessageResult,
} from "./types.js";

// Lazy-load the embedded runner to keep `src/plugins/runtime` cheap at module
// load time. Plugin discovery / manifest validation should not transitively
// pull in the pi-embedded-runner graph.
async function loadEmbeddedRunnerRuntime() {
  return await import("../../agents/pi-embedded-runner/runs.js");
}

function narrowReason(reason: string | undefined): SubagentQueueMessageReason {
  if (reason === "no_active_run" || reason === "not_streaming" || reason === "compacting") {
    return reason;
  }
  return "unknown";
}

/**
 * Inject a user message into the active embedded run for `sessionKey`.
 *
 * This is the gateway-request-agnostic primitive behind `subagent.queueMessage`.
 * It operates directly on the process-global embedded run map, so it works from
 * any async context — including channel webhook handlers that run outside a
 * gateway request scope.
 */
export async function queueSubagentMessageInProcess(
  params: SubagentQueueMessageParams,
): Promise<SubagentQueueMessageResult> {
  const { resolveActiveEmbeddedRunSessionId, queueEmbeddedPiMessageDetailed } =
    await loadEmbeddedRunnerRuntime();
  const sessionId = resolveActiveEmbeddedRunSessionId(params.sessionKey);
  if (!sessionId) {
    return { queued: false, reason: "no_active_run" };
  }
  const outcome = queueEmbeddedPiMessageDetailed(sessionId, params.message);
  if (outcome.queued) {
    return { queued: true };
  }
  return { queued: false, reason: narrowReason(outcome.reason) };
}
