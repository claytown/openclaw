/**
 * Microsoft Teams posting layer for ECS task lifecycle events.
 * Sends via Bot Framework proactive messaging (RSC-scoped).
 * Reads via Graph API (RSC-scoped).
 * Parallel to discord-channels.ts — same method signatures, different transport.
 */

import type { EcsTeamsConfig } from "./config.js";
import type { TeamsProjectChannelManager } from "./teams-project-channel-manager.js";
import type {
  EcsIssue,
  EcsQuestion,
  EcsStatusUpdate,
  EcsTask,
  EcsTaskCompletion,
} from "./types.js";

const LOGIN_BASE = "https://login.microsoftonline.com";

/**
 * When a reply 404s with ActivityNotFoundInConversation AND the alternate-id
 * retry ladder has exhausted, the legacy behavior was to post the status
 * update as a fresh root message and re-index the tracker against it. Once
 * OpenClaw owns root-message creation for every task, all replies target a
 * messageId we ourselves just minted, so a 404 here is a real symptom rather
 * than an expected control-plane/opensource-fork mismatch. Keep the legacy
 * path available via env flag so we can flip it back on during rollout if
 * unknown Teams thread lifecycle edges show up.
 */
function fallbackRootOn404Enabled(): boolean {
  return process.env.ECS_TEAMS_FALLBACK_ROOT_ON_404 === "true";
}

// --- Token cache ---

let botToken: string | null = null;
let botTokenExpiresAt = 0;

type TeamsCreds = {
  tenantId: string;
  appId: string;
  appPassword: string;
  serviceUrl: string;
};

async function getBotToken(creds: TeamsCreds): Promise<string> {
  const now = Date.now();
  if (botToken && now < botTokenExpiresAt) {
    return botToken;
  }

  const body = new URLSearchParams({
    client_id: creds.appId,
    client_secret: creds.appPassword,
    scope: "https://api.botframework.com/.default",
    grant_type: "client_credentials",
  });

  const res = await fetch(`${LOGIN_BASE}/${creds.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Teams bot token request failed ${res.status}: ${text}`);
  }

  const json = JSON.parse(text);
  botToken = json.access_token as string;
  botTokenExpiresAt = now + (json.expires_in as number) * 1000 - 100_000;
  return botToken;
}

// --- Bot Framework send ---

/**
 * Shape of a Bot Framework activity response. Only `id` is guaranteed; Teams
 * may also populate `channelData.teamsMessageId` and related fields that serve
 * as alternate selectors for later thread replies.
 */
export type BotFrameworkActivityResponse = {
  id: string;
  channelData?: {
    teamsMessageId?: string;
    messageid?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

function normalizeServiceUrl(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/$/, "");
}

async function botSend(
  creds: TeamsCreds,
  conversationId: string,
  text: string,
  replyToId: string | undefined,
  overrideServiceUrl: string | undefined,
): Promise<BotFrameworkActivityResponse> {
  const token = await getBotToken(creds);
  // The Bot Framework's regional Traffic Manager endpoints
  // (`smba.trafficmanager.net/{emea,amer,...}`) are NOT interchangeable for
  // reply lookups: a replyToId minted behind one regional endpoint 404s when
  // posted to another. When we have a cached inbound serviceUrl for the
  // conversation (learned from activity.serviceUrl on an earlier inbound
  // activity), prefer it; otherwise fall back to the configured default.
  const base = overrideServiceUrl ?? normalizeServiceUrl(creds.serviceUrl) ?? "";
  const source = overrideServiceUrl ? "cache" : "env";
  console.info(`[ecs-teams] outbound using serviceUrl=${base} source=${source}`);

  // Teams channel thread replies work reliably only when posted to the
  // SAME conversation URL as the root activity, with replyToId in the body
  // (matching the working MCP client pattern). The legacy
  // `;messageid=<rootMessageId>` URL suffix is a Bot Framework
  // proactive-messaging shape that does NOT locate the activity reliably in
  // Teams channels — it surfaces as ActivityNotFoundInConversation 404s on
  // every reply. Always use the plain conversationId URL.
  const url = `${base}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;

  const activity: Record<string, unknown> = {
    type: "message",
    text,
    textFormat: "markdown",
  };
  if (replyToId) {
    activity.replyToId = replyToId;
  }
  const bodyStr = JSON.stringify(activity);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: bodyStr,
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return botSend(creds, conversationId, text, replyToId, overrideServiceUrl);
  }

  const respText = await res.text();
  if (!res.ok) {
    // Log enough to diagnose 404 ActivityNotFoundInConversation vs. perms vs.
    // bad payload without chasing partial logs. Body is the activity we sent
    // (token is NOT in the body — it's in the Authorization header above).
    console.warn(
      `[ecs-teams] botSend non-OK: status=${res.status} url=${url} replyToId=${replyToId ?? "<none>"} reqBody=${bodyStr} respBody=${respText}`,
    );
    throw new Error(`Bot Framework send ${res.status}: ${respText}`);
  }

  return JSON.parse(respText) as BotFrameworkActivityResponse;
}

/**
 * Given a Bot Framework POST response, collect selector candidates Teams
 * might accept as `replyToId` on later replies. Ordered from "most likely
 * correct" to "least": channelData.teamsMessageId first (if Teams populated
 * it), channelData.messageid second, then the top-level activity id.
 */
function collectReplyCandidates(
  resp: BotFrameworkActivityResponse,
): Array<{ via: string; value: string }> {
  const out: Array<{ via: string; value: string }> = [];
  const tmid = resp.channelData?.teamsMessageId;
  if (typeof tmid === "string" && tmid.length > 0) {
    out.push({ via: "channelData.teamsMessageId", value: tmid });
  }
  const cmid = resp.channelData?.messageid;
  if (typeof cmid === "string" && cmid.length > 0) {
    out.push({ via: "channelData.messageid", value: cmid });
  }
  if (typeof resp.id === "string" && resp.id.length > 0) {
    out.push({ via: "id", value: resp.id });
  }
  return out;
}

// --- Helpers ---

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) {
    return `${secs}s`;
  }
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
}

// --- Result type ---

export type TeamsPostResult = {
  messageId?: string;
  channelId?: string;
};

export type TeamsPostInfo = {
  channelId: string;
  messageId?: string;
  title?: string;
  content?: string;
};

// --- Shared channel set (survives multi-instance plugin loading) ---

const TEAMS_CHANNELS_KEY = Symbol.for("openclaw.ecsTeamsKnownChannels");

function getKnownTeamsChannelIds(): Set<string> {
  const g = globalThis as typeof globalThis & { [TEAMS_CHANNELS_KEY]?: Set<string> };
  if (!g[TEAMS_CHANNELS_KEY]) {
    g[TEAMS_CHANNELS_KEY] = new Set();
  }
  return g[TEAMS_CHANNELS_KEY];
}

// --- Main class ---

export type TeamsDeadThreadInfo = {
  channelId: string;
  replyToId: string;
};

export type TeamsRootFallbackInfo = {
  channelId: string;
  replyToId: string;
  newMessageId: string;
};

const THREAD_NOT_FOUND_MARKER = "ActivityNotFoundInConversation";
const DEAD_THREAD_LOG_DEDUPE_MS = 5 * 60 * 1000;

export class EcsTeamsChannels {
  private creds: TeamsCreds;
  private config: EcsTeamsConfig;
  private projectManager?: TeamsProjectChannelManager;
  private onPostCallback?: (info: TeamsPostInfo) => void;
  private onDeadThreadCallback?: (info: TeamsDeadThreadInfo) => void;
  private onRootFallbackCallback?: (info: TeamsRootFallbackInfo) => void;
  private recentlyLoggedDeadThreads = new Map<string, number>();
  // Per-thread-root alternate id list harvested from Bot Framework POST
  // responses. On a reply 404, we walk these in order before declaring the
  // thread dead. Bounded to the N most recent roots so memory stays flat.
  private replyCandidatesByPrimary = new Map<string, string[]>();
  private static REPLY_CANDIDATES_MAX_ENTRIES = 256;
  // Per-channel inbound serviceUrl cache. Populated from activity.serviceUrl
  // observed on inbound activities; consulted on outbound posts so replies
  // go to the same regional Bot Framework endpoint that minted the
  // conversation. Falls back to creds.serviceUrl when a channel is unknown.
  private channelServiceUrls = new Map<string, string>();
  private static CHANNEL_SERVICE_URL_MAX_ENTRIES = 512;

  constructor(
    creds: TeamsCreds,
    config: EcsTeamsConfig,
    projectManager?: TeamsProjectChannelManager,
  ) {
    this.creds = creds;
    this.config = config;
    this.projectManager = projectManager;
    if (config.defaultChannel) {
      getKnownTeamsChannelIds().add(config.defaultChannel);
    }
  }

  setOnPost(cb: (info: TeamsPostInfo) => void): void {
    this.onPostCallback = cb;
  }

  /**
   * Notified when Teams returns `ActivityNotFoundInConversation` for a thread
   * reply. The caller typically clears the dead thread id from its index so
   * subsequent posts don't keep failing against the same message.
   */
  setOnDeadThread(cb: (info: TeamsDeadThreadInfo) => void): void {
    this.onDeadThreadCallback = cb;
  }

  /**
   * Notified after a 404-triggered root-post fallback successfully creates a
   * new thread root. The caller typically re-indexes the new messageId against
   * the same task so inbound replies to the fresh thread route correctly.
   */
  setOnRootFallback(cb: (info: TeamsRootFallbackInfo) => void): void {
    this.onRootFallbackCallback = cb;
  }

  /** Eagerly register a channel ID so isEcsChannel() recognizes it. */
  registerChannel(channelId: string): void {
    getKnownTeamsChannelIds().add(channelId);
  }

  /**
   * Record the serviceUrl we observed on an inbound activity for this
   * channel/conversation. On the next outbound post to the same conversation,
   * we will post against this serviceUrl instead of the configured default so
   * reply lookups hit the same regional Bot Framework endpoint.
   */
  recordInboundServiceUrl(channelId: string, serviceUrl: string | undefined): void {
    const normalized = normalizeServiceUrl(serviceUrl);
    if (!normalized || !channelId) {
      return;
    }
    const existing = this.channelServiceUrls.get(channelId);
    if (existing === normalized) {
      return;
    }
    this.channelServiceUrls.set(channelId, normalized);
    if (this.channelServiceUrls.size > EcsTeamsChannels.CHANNEL_SERVICE_URL_MAX_ENTRIES) {
      const firstKey = this.channelServiceUrls.keys().next().value;
      if (firstKey !== undefined) {
        this.channelServiceUrls.delete(firstKey);
      }
    }
    console.info(`[ecs-teams] inboundServiceUrl channelId=${channelId} serviceUrl=${normalized}`);
  }

  /** Return the cached inbound serviceUrl for a channel, if any. */
  private resolveServiceUrlFor(channelId: string): string | undefined {
    return this.channelServiceUrls.get(channelId);
  }

  isEcsChannel(id: string): boolean {
    if (getKnownTeamsChannelIds().has(id)) {
      return true;
    }
    if (this.projectManager) {
      return this.projectManager.getChannelIds().has(id);
    }
    return false;
  }

  private async resolveChannel(projectId?: string): Promise<string> {
    if (projectId) {
      // Check config overrides first.
      if (this.config.projectChannels?.[projectId]) {
        return this.config.projectChannels[projectId];
      }
      // Try auto-provisioned channel.
      if (this.projectManager) {
        const ch = await this.projectManager.resolveChannel(projectId);
        if (ch) {
          return ch;
        }
      }
    }
    return this.config.defaultChannel;
  }

  /**
   * Cache the alternate reply selectors that Bot Framework returned alongside
   * the activity we just posted. On a later 404 against `primary`, we walk
   * these alternates in order before declaring the thread dead.
   */
  private rememberReplyCandidates(primary: string, resp: BotFrameworkActivityResponse): void {
    const alternates = collectReplyCandidates(resp)
      .filter((c) => c.value !== primary)
      .map((c) => c.value);
    if (alternates.length === 0) {
      return;
    }
    this.replyCandidatesByPrimary.set(primary, alternates);
    if (this.replyCandidatesByPrimary.size > EcsTeamsChannels.REPLY_CANDIDATES_MAX_ENTRIES) {
      // Evict the oldest entry (Map preserves insertion order) to cap memory.
      const firstKey = this.replyCandidatesByPrimary.keys().next().value;
      if (firstKey !== undefined) {
        this.replyCandidatesByPrimary.delete(firstKey);
      }
    }
  }

  private async post(
    channelId: string,
    text: string,
    title?: string,
    replyToId?: string,
  ): Promise<TeamsPostResult> {
    const serviceUrl = this.resolveServiceUrlFor(channelId);
    try {
      const result = await botSend(this.creds, channelId, text, replyToId, serviceUrl);
      // Dynamically register any channel we successfully post to so
      // isEcsChannel() recognizes project/venture channels across all instances.
      getKnownTeamsChannelIds().add(channelId);
      this.rememberReplyCandidates(result.id, result);
      if (this.onPostCallback) {
        this.onPostCallback({
          channelId,
          messageId: result.id,
          title,
          content: text,
        });
      }
      return { messageId: result.id, channelId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (replyToId && message.includes(THREAD_NOT_FOUND_MARKER)) {
        // Retry ladder: before declaring the thread dead, try any alternate
        // selectors Teams returned in channelData when we first posted the
        // root. If one works, log which shape won so we can pin it later.
        const alternates = this.replyCandidatesByPrimary.get(replyToId) ?? [];
        for (const alt of alternates) {
          try {
            const altResult = await botSend(this.creds, channelId, text, alt, serviceUrl);
            console.info(`[ecs-teams] reply ok via alternate=${alt} (primary=${replyToId} 404'd)`);
            getKnownTeamsChannelIds().add(channelId);
            this.rememberReplyCandidates(altResult.id, altResult);
            if (this.onPostCallback) {
              this.onPostCallback({
                channelId,
                messageId: altResult.id,
                title,
                content: text,
              });
            }
            return { messageId: altResult.id, channelId };
          } catch (altErr) {
            const altMsg = altErr instanceof Error ? altErr.message : String(altErr);
            console.warn(
              `[ecs-teams] alternate=${alt} also failed for replyToId=${replyToId}: ${altMsg}`,
            );
          }
        }

        // With fallback-root OFF (default), log the full diagnostic and
        // bubble the error. The markDeadThread/onRootFallback wiring is only
        // used when the flag is explicitly enabled. Replies should now
        // always target a messageId OpenClaw itself posted as root, so a
        // legitimate 404 here is a real symptom we want surfaced, not
        // papered over by posting a fresh root and re-indexing.
        if (!fallbackRootOn404Enabled()) {
          const base = serviceUrl ?? normalizeServiceUrl(this.creds.serviceUrl) ?? "";
          const replyUrl = `${base}/v3/conversations/${encodeURIComponent(channelId)}/activities`;
          console.warn(
            `[ecs-teams] reply 404 and fallback-root disabled: replyUrl=${replyUrl} replyToId=${replyToId} configuredServiceUrl=${this.creds.serviceUrl} cachedServiceUrl=${serviceUrl ?? "<none>"} respBody=${message}`,
          );
          throw err;
        }

        this.handleDeadThread(channelId, replyToId, message);
        // Retry once as a root post so the status update still lands in the channel.
        try {
          const result = await botSend(this.creds, channelId, text, undefined, serviceUrl);
          getKnownTeamsChannelIds().add(channelId);
          this.rememberReplyCandidates(result.id, result);
          if (this.onPostCallback) {
            this.onPostCallback({
              channelId,
              messageId: result.id,
              title,
              content: text,
            });
          }
          if (this.onRootFallbackCallback) {
            try {
              this.onRootFallbackCallback({
                channelId,
                replyToId,
                newMessageId: result.id,
              });
            } catch (cbErr) {
              console.warn(
                `[ecs-teams] onRootFallback callback failed: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
              );
            }
          }
          return { messageId: result.id, channelId };
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.warn(`[ecs-teams] root-post retry failed: ${retryMsg}`);
          return {};
        }
      }
      console.warn(`[ecs-teams] post failed: ${message}`);
      return {};
    }
  }

  private handleDeadThread(channelId: string, replyToId: string, details: string): void {
    const now = Date.now();
    const lastLogged = this.recentlyLoggedDeadThreads.get(replyToId);
    if (lastLogged === undefined || now - lastLogged > DEAD_THREAD_LOG_DEDUPE_MS) {
      console.info(
        `[ecs-teams] thread ${replyToId} is no longer available; posting as root instead (${details})`,
      );
      this.recentlyLoggedDeadThreads.set(replyToId, now);
      if (this.recentlyLoggedDeadThreads.size > 128) {
        // Trim oldest entries to keep the dedupe map bounded.
        const cutoff = now - DEAD_THREAD_LOG_DEDUPE_MS;
        for (const [id, ts] of this.recentlyLoggedDeadThreads) {
          if (ts < cutoff) {
            this.recentlyLoggedDeadThreads.delete(id);
          }
        }
      }
    }
    if (this.onDeadThreadCallback) {
      try {
        this.onDeadThreadCallback({ channelId, replyToId });
      } catch (cbErr) {
        console.warn(
          `[ecs-teams] onDeadThread callback failed: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
        );
      }
    }
  }

  // --- Task lifecycle ---

  async postTaskAssigned(
    task: EcsTask,
    projectId?: string,
    threadId?: string,
  ): Promise<TeamsPostResult> {
    const channelId =
      task.teamsChannelId ?? (await this.resolveChannel(projectId ?? task.projectId));
    const text = [
      `**Task Assigned** | \`${task.taskId}\``,
      "---",
      `**Title:** ${task.title}`,
      `**Priority:** ${task.priority}${task.assignedAgentId ? ` | **Agent:** ${task.assignedAgentId}` : ""}${task.projectId ? ` | **Project:** ${task.projectId}` : ""}`,
      "",
      truncate(task.description, 800),
    ].join("\n");
    return this.post(channelId, text, `Task Assigned: ${task.title}`, threadId);
  }

  async postStatusUpdate(
    update: EcsStatusUpdate,
    projectId?: string,
    threadId?: string,
  ): Promise<TeamsPostResult> {
    const channelId = await this.resolveChannel(projectId);
    const pct = update.progressPct !== undefined ? ` (${update.progressPct}%)` : "";
    const text = [
      `**Status Update** | \`${update.taskId}\` | ${update.status}${pct}`,
      "---",
      truncate(update.summary, 800),
      update.details ? `\n${truncate(update.details, 400)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return this.post(channelId, text, `Status: ${update.status}`, threadId);
  }

  async postTaskCompleted(
    completion: EcsTaskCompletion,
    projectId?: string,
  ): Promise<TeamsPostResult> {
    const channelId = await this.resolveChannel(projectId);
    const isError = completion.status === "error" || completion.status === "cancelled";
    const icon = isError ? "🔴" : "🟢";
    const label = isError ? "Failed" : "Completed";
    const text = [
      `${icon} **Task ${label}** | \`${completion.taskId}\``,
      "---",
      `**Duration:** ${formatDuration(completion.durationMs)}${completion.agentId ? ` | **Agent:** ${completion.agentId}` : ""}`,
      "",
      truncate(completion.summary, 800),
    ].join("\n");

    // Reply in the existing thread when available; otherwise post as root.
    if (completion.threadId) {
      return this.postToThread(channelId, completion.threadId, text);
    }
    return this.post(channelId, text, `Task ${label}: ${completion.taskId}`);
  }

  async postQuestion(
    question: EcsQuestion,
    projectId?: string,
    threadId?: string,
  ): Promise<TeamsPostResult> {
    const channelId = await this.resolveChannel(projectId);
    const text = [
      `**❓ Question** | \`${question.taskId}\``,
      "---",
      question.question,
      question.context ? `\n**Context:** ${truncate(question.context, 400)}` : "",
      "",
      "_Reply to this message to answer the question._",
    ]
      .filter(Boolean)
      .join("\n");
    return this.post(channelId, text, "Question", threadId);
  }

  async postQuestionTimeout(
    question: EcsQuestion,
    projectId?: string,
    threadId?: string,
  ): Promise<TeamsPostResult> {
    const channelId = await this.resolveChannel(projectId);
    const text = [
      `**⚠️ Unanswered Question Escalation** | \`${question.taskId}\``,
      "---",
      `Question timed out without an answer.`,
      "",
      `> ${truncate(question.question, 600)}`,
    ].join("\n");
    return this.post(channelId, text, "Question Timeout", threadId);
  }

  async postIssue(
    issue: EcsIssue,
    projectId?: string,
    threadId?: string,
  ): Promise<TeamsPostResult> {
    const channelId = await this.resolveChannel(projectId);
    const icon = issue.severity === "critical" ? "🔴" : issue.severity === "error" ? "🟠" : "🟡";
    const text = [
      `${icon} **Issue: ${issue.title}** | \`${issue.taskId}\` | ${issue.severity}`,
      "---",
      truncate(issue.description, 600),
      "",
      issue.attempted.length > 0
        ? `**Attempted:**\n${issue.attempted.map((a) => `- ${a}`).join("\n")}`
        : "",
      issue.needsHuman ? "\n**⚠️ Needs human intervention**" : "",
    ]
      .filter(Boolean)
      .join("\n");
    return this.post(channelId, text, `Issue: ${issue.title}`, threadId);
  }

  async postToThread(channelId: string, messageId: string, text: string): Promise<TeamsPostResult> {
    return this.post(channelId, truncate(text, 2000), undefined, messageId);
  }

  async postReplyToThread(
    text: string,
    projectId?: string,
    threadId?: string,
  ): Promise<TeamsPostResult> {
    if (!threadId) {
      return {};
    }
    const channelId = await this.resolveChannel(projectId);
    return this.postToThread(channelId, threadId, text);
  }

  async postSystemEvent(
    params: {
      title: string;
      description?: string;
      fields?: Array<{ name: string; value: string }>;
    },
    projectId?: string,
  ): Promise<TeamsPostResult> {
    const channelId = await this.resolveChannel(projectId);
    const lines = [`**${params.title}**`];
    if (params.description) {
      lines.push(params.description);
    }
    if (params.fields) {
      lines.push(params.fields.map((f) => `**${f.name}:** ${f.value}`).join(" | "));
    }
    return this.post(channelId, lines.join("\n"), params.title);
  }
}
