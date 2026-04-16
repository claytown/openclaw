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

async function botSend(
  creds: TeamsCreds,
  conversationId: string,
  text: string,
  replyToId?: string,
): Promise<{ id: string }> {
  const token = await getBotToken(creds);
  const base = creds.serviceUrl.replace(/\/$/, "");

  // For Teams channel thread replies, the conversation URL must include
  // `;messageid=<rootMessageId>` — setting replyToId on the activity body
  // alone does NOT create a thread reply in Teams channels.
  const effectiveConversationId = replyToId
    ? `${conversationId};messageid=${replyToId}`
    : conversationId;
  const url = `${base}/v3/conversations/${encodeURIComponent(effectiveConversationId)}/activities`;

  const activity: Record<string, unknown> = {
    type: "message",
    text,
    textFormat: "markdown",
  };
  if (replyToId) {
    activity.replyToId = replyToId;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(activity),
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return botSend(creds, conversationId, text, replyToId);
  }

  const respText = await res.text();
  if (!res.ok) {
    throw new Error(`Bot Framework send ${res.status}: ${respText}`);
  }

  return JSON.parse(respText) as { id: string };
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

const THREAD_NOT_FOUND_MARKER = "ActivityNotFoundInConversation";
const DEAD_THREAD_LOG_DEDUPE_MS = 5 * 60 * 1000;

export class EcsTeamsChannels {
  private creds: TeamsCreds;
  private config: EcsTeamsConfig;
  private projectManager?: TeamsProjectChannelManager;
  private onPostCallback?: (info: TeamsPostInfo) => void;
  private onDeadThreadCallback?: (info: TeamsDeadThreadInfo) => void;
  private recentlyLoggedDeadThreads = new Map<string, number>();

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

  /** Eagerly register a channel ID so isEcsChannel() recognizes it. */
  registerChannel(channelId: string): void {
    getKnownTeamsChannelIds().add(channelId);
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

  private async post(
    channelId: string,
    text: string,
    title?: string,
    replyToId?: string,
  ): Promise<TeamsPostResult> {
    try {
      const result = await botSend(this.creds, channelId, text, replyToId);
      // Dynamically register any channel we successfully post to so
      // isEcsChannel() recognizes project/venture channels across all instances.
      getKnownTeamsChannelIds().add(channelId);
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
        this.handleDeadThread(channelId, replyToId, message);
        // Retry once as a root post so the status update still lands in the channel.
        try {
          const result = await botSend(this.creds, channelId, text);
          getKnownTeamsChannelIds().add(channelId);
          if (this.onPostCallback) {
            this.onPostCallback({
              channelId,
              messageId: result.id,
              title,
              content: text,
            });
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
