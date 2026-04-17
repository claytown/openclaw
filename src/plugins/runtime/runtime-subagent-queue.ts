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

// Lazy-load the session-store canonicalizer for the same reason — plugin
// discovery should not eagerly transitively pull in the full config loader.
async function loadSessionKeyCanonicalizer() {
  const [{ loadConfig }, { resolveSessionStoreKey }] = await Promise.all([
    import("../../config/config.js"),
    import("../../gateway/session-store-key.js"),
  ]);
  return (sessionKey: string): string | undefined => {
    try {
      const cfg = loadConfig();
      const canonical = resolveSessionStoreKey({ cfg, sessionKey });
      return canonical && canonical !== sessionKey ? canonical : undefined;
    } catch {
      return undefined;
    }
  };
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
 *
 * The gateway `agent` method canonicalizes `sessionKey` via
 * `resolveSessionStoreKey` when it dispatches a run, so the embedded runner is
 * registered under the canonical key (e.g. `agent:<agentId>:<rest>`). Callers
 * (like plugins tracking their own session identifiers) often have the raw
 * key — try the raw lookup first, then fall back to the canonical form so both
 * shapes resolve identically.
 */
export async function queueSubagentMessageInProcess(
  params: SubagentQueueMessageParams,
): Promise<SubagentQueueMessageResult> {
  const {
    resolveActiveEmbeddedRunSessionId,
    queueEmbeddedPiMessageDetailed,
    listActiveRunSessionKeys,
  } = await loadEmbeddedRunnerRuntime();

  const rawSessionId = resolveActiveEmbeddedRunSessionId(params.sessionKey);
  let sessionId = rawSessionId;
  let canonical: string | undefined;
  let canonicalSessionId: string | undefined;
  if (!sessionId) {
    const canonicalize = await loadSessionKeyCanonicalizer();
    canonical = canonicalize(params.sessionKey);
    if (canonical) {
      canonicalSessionId = resolveActiveEmbeddedRunSessionId(canonical);
      sessionId = canonicalSessionId;
    }
  }

  if (!sessionId) {
    const sample = listActiveRunSessionKeys(5);
    console.info(
      `[subagent-queue] no_active_run sessionKey=${params.sessionKey} rawHit=${rawSessionId ? "yes" : "no"} canonical=${canonical ?? "<none>"} canonicalHit=${canonicalSessionId ? "yes" : "no"} activeSampleKeys=${JSON.stringify(sample)}`,
    );
    return { queued: false, reason: "no_active_run" };
  }
  console.info(
    `[subagent-queue] resolved sessionKey=${params.sessionKey} sessionId=${sessionId} via=${rawSessionId ? "raw" : canonicalSessionId ? "canonical" : "unknown"}`,
  );
  const outcome = queueEmbeddedPiMessageDetailed(sessionId, params.message);
  if (outcome.queued) {
    return { queued: true };
  }
  console.info(
    `[subagent-queue] queued=false sessionKey=${params.sessionKey} sessionId=${sessionId} reason=${outcome.reason}`,
  );
  return { queued: false, reason: narrowReason(outcome.reason) };
}
