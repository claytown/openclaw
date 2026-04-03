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
  if (botToken && now < botTokenExpiresAt) return botToken;

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
  const url = `${base}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;

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
  if (secs < 60) return `${secs}s`;
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

// --- Main class ---

export class EcsTeamsChannels {
  private creds: TeamsCreds;
  private config: EcsTeamsConfig;
  private projectManager?: TeamsProjectChannelManager;
  private onPostCallback?: (info: TeamsPostInfo) => void;
  private knownChannelIds = new Set<string>();

  constructor(
    creds: TeamsCreds,
    config: EcsTeamsConfig,
    projectManager?: TeamsProjectChannelManager,
  ) {
    this.creds = creds;
    this.config = config;
    this.projectManager = projectManager;
    if (config.defaultChannel) {
      this.knownChannelIds.add(config.defaultChannel);
    }
  }

  setOnPost(cb: (info: TeamsPostInfo) => void): void {
    this.onPostCallback = cb;
  }

  isEcsChannel(id: string): boolean {
    if (this.knownChannelIds.has(id)) return true;
    if (this.projectManager) return this.projectManager.getChannelIds().has(id);
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
        if (ch) return ch;
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
      console.warn(`[ecs-teams] post failed: ${err instanceof Error ? err.message : err}`);
      return {};
    }
  }

  // --- Task lifecycle ---

  async postTaskAssigned(task: EcsTask, projectId?: string): Promise<TeamsPostResult> {
    const channelId = await this.resolveChannel(projectId ?? task.projectId);
    const text = [
      `**Task Assigned** | \`${task.taskId}\``,
      "---",
      `**Title:** ${task.title}`,
      `**Priority:** ${task.priority}${task.assignedAgentId ? ` | **Agent:** ${task.assignedAgentId}` : ""}${task.projectId ? ` | **Project:** ${task.projectId}` : ""}`,
      "",
      truncate(task.description, 800),
    ].join("\n");
    return this.post(channelId, text, `Task Assigned: ${task.title}`);
  }

  async postStatusUpdate(update: EcsStatusUpdate, projectId?: string): Promise<TeamsPostResult> {
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
    return this.post(channelId, text, `Status: ${update.status}`);
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

    const result = await this.post(channelId, text, `Task ${label}: ${completion.taskId}`);

    // Also post to the task's thread if we have a root message ID.
    if (completion.threadId) {
      await this.postToThread(
        channelId,
        completion.threadId,
        `${icon} ${label}: ${completion.summary}`,
      );
    }

    return result;
  }

  async postQuestion(question: EcsQuestion, projectId?: string): Promise<TeamsPostResult> {
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
    return this.post(channelId, text, "Question");
  }

  async postQuestionTimeout(question: EcsQuestion, projectId?: string): Promise<TeamsPostResult> {
    const channelId = await this.resolveChannel(projectId);
    const text = [
      `**⚠️ Unanswered Question Escalation** | \`${question.taskId}\``,
      "---",
      `Question timed out without an answer.`,
      "",
      `> ${truncate(question.question, 600)}`,
    ].join("\n");
    return this.post(channelId, text, "Question Timeout");
  }

  async postIssue(issue: EcsIssue, projectId?: string): Promise<TeamsPostResult> {
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
    return this.post(channelId, text, `Issue: ${issue.title}`);
  }

  async postToThread(channelId: string, messageId: string, text: string): Promise<TeamsPostResult> {
    return this.post(channelId, truncate(text, 2000), undefined, messageId);
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
    if (params.description) lines.push(params.description);
    if (params.fields) {
      lines.push(params.fields.map((f) => `**${f.name}:** ${f.value}`).join(" | "));
    }
    return this.post(channelId, lines.join("\n"), params.title);
  }
}
