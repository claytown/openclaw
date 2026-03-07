/**
 * Discord REST posting to the three ECS intent channels.
 * Uses @buape/carbon RequestClient (same pattern as core Discord send).
 */

import { RequestClient } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import type { EcsDiscordConfig } from "./config.js";
import type {
  EcsIssue,
  EcsIssueSeverity,
  EcsQuestion,
  EcsStatusUpdate,
  EcsTask,
  EcsTaskCompletion,
} from "./types.js";

// Embed sidebar colors by intent/severity.
const COLOR_STATUS = 0x3498db; // blue
const COLOR_INFO = 0xf39c12; // orange
const COLOR_ISSUE_WARN = 0xf1c40f; // yellow
const COLOR_ISSUE_ERROR = 0xe74c3c; // red
const COLOR_ISSUE_CRITICAL = 0x8b0000; // dark red
const COLOR_COMPLETE = 0x2ecc71; // green
const COLOR_ERROR = 0xe74c3c; // red

const SEVERITY_COLORS: Record<EcsIssueSeverity, number> = {
  warn: COLOR_ISSUE_WARN,
  error: COLOR_ISSUE_ERROR,
  critical: COLOR_ISSUE_CRITICAL,
};

export type DiscordPostResult = {
  messageId?: string;
  channelId?: string;
  threadId?: string;
};

export type EcsPostInfo = {
  channelId: string;
  messageId?: string;
  embedTitle?: string;
  content?: string;
};

export class EcsDiscordChannels {
  private rest: RequestClient;
  private channels: EcsDiscordConfig["channels"];
  private guildId: string;
  private channelIdSet: Set<string>;
  private onPostCallback?: (info: EcsPostInfo) => void;

  constructor(token: string, config: EcsDiscordConfig) {
    this.rest = new RequestClient(token);
    this.channels = config.channels;
    this.guildId = config.guildId;
    this.channelIdSet = new Set(
      [config.channels.status, config.channels.info, config.channels.issues].filter(Boolean),
    );
  }

  /** Returns the set of ECS channel IDs. */
  getChannelIds(): Set<string> {
    return this.channelIdSet;
  }

  /** Check if a channel/thread ID is one of the ECS channels. */
  isEcsChannel(id: string): boolean {
    return this.channelIdSet.has(id);
  }

  /** Register a callback that fires after every successful post. */
  setOnPost(cb: (info: EcsPostInfo) => void): void {
    this.onPostCallback = cb;
  }

  /** Post a task assignment notification to #ecs-status. */
  async postTaskAssigned(task: EcsTask): Promise<DiscordPostResult> {
    const embed = {
      title: `Task Assigned: ${task.title}`,
      description: truncate(task.description, 1000),
      color: COLOR_STATUS,
      fields: [
        { name: "Task ID", value: task.taskId, inline: true },
        { name: "Priority", value: task.priority, inline: true },
        ...(task.assignedAgentId
          ? [{ name: "Agent", value: task.assignedAgentId, inline: true }]
          : []),
      ],
      timestamp: new Date().toISOString(),
    };

    return this.postEmbed(this.channels.status, embed);
  }

  /** Post a status update to #ecs-status. */
  async postStatusUpdate(update: EcsStatusUpdate): Promise<DiscordPostResult> {
    const fields = [
      { name: "Task ID", value: update.taskId, inline: true },
      { name: "Status", value: update.status, inline: true },
    ];
    if (update.progressPct !== undefined) {
      fields.push({ name: "Progress", value: `${update.progressPct}%`, inline: true });
    }
    if (update.agentId) {
      fields.push({ name: "Agent", value: update.agentId, inline: true });
    }

    const embed = {
      title: "Status Update",
      description: truncate(update.summary, 1000),
      color: COLOR_STATUS,
      fields,
      timestamp: new Date(update.timestamp).toISOString(),
    };

    return this.postEmbed(this.channels.status, embed);
  }

  /** Post a task completion to #ecs-status. */
  async postTaskCompleted(completion: EcsTaskCompletion): Promise<DiscordPostResult> {
    const isError = completion.status === "error" || completion.status === "cancelled";
    const embed = {
      title: `Task ${completion.status === "complete" ? "Completed" : completion.status === "error" ? "Failed" : "Cancelled"}`,
      description: truncate(completion.summary, 1000),
      color: isError ? COLOR_ERROR : COLOR_COMPLETE,
      fields: [
        { name: "Task ID", value: completion.taskId, inline: true },
        { name: "Duration", value: formatDuration(completion.durationMs), inline: true },
        ...(completion.agentId ? [{ name: "Agent", value: completion.agentId, inline: true }] : []),
      ],
      timestamp: new Date().toISOString(),
    };

    const result = await this.postEmbed(this.channels.status, embed);

    // Also post a summary to the task's Discord thread if available.
    if (completion.threadId) {
      const label = completion.status === "complete" ? "completed" : completion.status;
      await this.postToThread(
        completion.threadId,
        `**Task ${label}** — ${truncate(completion.summary, 500)}`,
      );
    }

    return result;
  }

  /** Post a question to #ecs-info and create a thread for discussion. */
  async postQuestion(question: EcsQuestion): Promise<DiscordPostResult> {
    const embed = {
      title: "Question",
      description: truncate(question.question, 1000),
      color: COLOR_INFO,
      fields: [
        { name: "Task ID", value: question.taskId, inline: true },
        { name: "Question ID", value: question.questionId, inline: true },
        ...(question.toAgentId ? [{ name: "To", value: question.toAgentId, inline: true }] : []),
        ...(question.context ? [{ name: "Context", value: truncate(question.context, 256) }] : []),
      ],
      timestamp: new Date().toISOString(),
    };

    // Post the embed to #ecs-info.
    const result = await this.postEmbed(this.channels.info, embed);
    if (!result.messageId) {
      return result;
    }

    // Create a thread on the message for discussion.
    try {
      const threadName = `Q: ${truncate(question.question, 80)}`;
      const thread = (await this.rest.post(Routes.threads(this.channels.info, result.messageId), {
        body: { name: threadName, auto_archive_duration: 1440 },
      })) as { id: string };
      return { ...result, threadId: thread.id };
    } catch {
      // Thread creation failed; return without threadId.
      return result;
    }
  }

  /** Post an issue to #ecs-issues. */
  async postIssue(issue: EcsIssue): Promise<DiscordPostResult> {
    const embed = {
      title: `[${issue.severity.toUpperCase()}] ${issue.title}`,
      description: truncate(issue.description, 1000),
      color: SEVERITY_COLORS[issue.severity],
      fields: [
        { name: "Task ID", value: issue.taskId, inline: true },
        { name: "Severity", value: issue.severity, inline: true },
        { name: "Needs Human", value: issue.needsHuman ? "Yes" : "No", inline: true },
        ...(issue.attempted.length > 0
          ? [{ name: "Attempted", value: truncate(issue.attempted.join("\n"), 512) }]
          : []),
      ],
      timestamp: new Date().toISOString(),
    };

    return this.postEmbed(this.channels.issues, embed);
  }

  /** Post a timeout escalation to #ecs-issues when a question goes unanswered. */
  async postQuestionTimeout(question: EcsQuestion): Promise<DiscordPostResult> {
    const embed = {
      title: "[WARN] Unanswered Question Escalation",
      description: `Question timed out and was auto-escalated.\n\n**Question:** ${truncate(question.question, 800)}`,
      color: COLOR_ISSUE_WARN,
      fields: [
        { name: "Task ID", value: question.taskId, inline: true },
        { name: "Question ID", value: question.questionId, inline: true },
        ...(question.fromAgentId
          ? [{ name: "From", value: question.fromAgentId, inline: true }]
          : []),
      ],
      timestamp: new Date().toISOString(),
    };

    return this.postEmbed(this.channels.issues, embed);
  }

  /** Post a message to a specific thread (e.g., for answers to questions). */
  async postToThread(threadId: string, text: string): Promise<DiscordPostResult> {
    try {
      const msg = (await this.rest.post(Routes.channelMessages(threadId), {
        body: { content: truncate(text, 2000) },
      })) as { id: string; channel_id: string };
      this.onPostCallback?.({
        channelId: msg.channel_id,
        messageId: msg.id,
        content: truncate(text, 2000),
      });
      return { messageId: msg.id, channelId: msg.channel_id };
    } catch {
      return {};
    }
  }

  /** Post a lightweight system-level event to #ecs-status (zero token cost). */
  async postSystemEvent(params: {
    title: string;
    description?: string;
    color?: number;
    fields?: { name: string; value: string; inline?: boolean }[];
  }): Promise<DiscordPostResult> {
    const embed = {
      title: params.title,
      description: params.description,
      color: params.color ?? 0x95a5a6, // grey
      fields: params.fields,
      timestamp: new Date().toISOString(),
    };
    return this.postEmbed(this.channels.status, embed);
  }

  private async postEmbed(
    channelId: string,
    embed: Record<string, unknown>,
  ): Promise<DiscordPostResult> {
    try {
      const msg = (await this.rest.post(Routes.channelMessages(channelId), {
        body: { embeds: [embed] },
      })) as { id: string; channel_id: string };
      this.onPostCallback?.({
        channelId: msg.channel_id,
        messageId: msg.id,
        embedTitle: embed.title as string | undefined,
      });
      return { messageId: msg.id, channelId: msg.channel_id };
    } catch {
      return {};
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return s.slice(0, max - 3) + "...";
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) {
    return `${sec}s`;
  }
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) {
    return `${min}m ${remSec}s`;
  }
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}
