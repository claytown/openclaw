/**
 * ECS agent tools: ecs_status_update, ecs_ask_question, ecs_raise_issue, ecs_set_persona.
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/ecs";
import { jsonResult, readStringParam, stringEnum } from "openclaw/plugin-sdk/ecs";
import type { EcsApiCallback } from "./api-callback.js";
import type { EcsDiscordChannels } from "./discord-channels.js";
import { setActivePersona } from "./persona-registry.js";
import { validatePersona } from "./persona.js";
import type { EcsQuestionRelay } from "./question-relay.js";
import type { EcsTaskTracker } from "./task-tracker.js";
import type { EcsIssueSeverity, EcsQuestion, EcsStatusUpdate, EcsTaskStatus } from "./types.js";

const ECS_TASK_STATUSES = ["accepted", "running", "blocked", "complete", "error"] as const;
const ECS_ISSUE_SEVERITIES = ["warn", "error", "critical"] as const;

// --- ecs_status_update ---

const EcsStatusUpdateSchema = Type.Object({
  status: stringEnum(ECS_TASK_STATUSES, {
    description: "Current task status",
  }),
  progressPct: Type.Optional(
    Type.Number({ minimum: 0, maximum: 100, description: "Progress percentage (0-100)" }),
  ),
  summary: Type.String({ description: "Brief summary of current progress" }),
  details: Type.Optional(Type.String({ description: "Additional details" })),
});

// --- ecs_ask_question ---

const EcsAskQuestionSchema = Type.Object({
  question: Type.String({ description: "The question to ask" }),
  toAgentId: Type.Optional(
    Type.String({ description: "Target agent ID (omit to ask the coordinator)" }),
  ),
  context: Type.Optional(Type.String({ description: "Additional context for the question" })),
  timeoutMs: Type.Optional(
    Type.Number({
      minimum: 5000,
      maximum: 3_600_000,
      description: "Timeout in ms before auto-escalation (default: 5min)",
    }),
  ),
});

// --- ecs_raise_issue ---

const EcsRaiseIssueSchema = Type.Object({
  severity: stringEnum(ECS_ISSUE_SEVERITIES, {
    description: "Issue severity level",
  }),
  title: Type.String({ description: "Short issue title" }),
  description: Type.String({ description: "Detailed description of the issue" }),
  attempted: Type.Array(Type.String(), { description: "List of things already attempted" }),
});

export type EcsToolDeps = {
  tracker: EcsTaskTracker;
  discord: EcsDiscordChannels;
  callback: EcsApiCallback;
  questionRelay: EcsQuestionRelay;
};

export type EcsToolContext = {
  sessionKey?: string;
  agentId?: string;
};

export function createEcsStatusUpdateTool(deps: EcsToolDeps, ctx: EcsToolContext): AnyAgentTool {
  return {
    label: "ECS",
    name: "ecs_status_update",
    description:
      "Post a progress/status update for the current ECS task. Non-blocking. Updates are echoed to the #ecs-status Discord channel and reported to the ECS control plane.",
    parameters: EcsStatusUpdateSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const status = readStringParam(params, "status", { required: true }) as EcsTaskStatus;
      const summary = readStringParam(params, "summary", { required: true });
      const details = readStringParam(params, "details");
      const progressPct = typeof params.progressPct === "number" ? params.progressPct : undefined;

      // Find the active task for this session.
      const active = ctx.sessionKey ? deps.tracker.getBySessionKey(ctx.sessionKey) : undefined;
      const taskId = active?.task.taskId ?? "unknown";

      // Update tracker.
      if (active) {
        deps.tracker.updateStatus(taskId, status);
      }

      const update: EcsStatusUpdate = {
        taskId,
        agentId: ctx.agentId ?? active?.agentId,
        status,
        progressPct,
        summary,
        details,
        timestamp: Date.now(),
      };

      // Post to Discord and callback to ECS (fire-and-forget).
      const [discordResult] = await Promise.all([
        deps.discord.postStatusUpdate(update, active?.task.projectId),
        deps.callback.reportStatus(taskId, summary, {
          sessionId: ctx.sessionKey,
          agentId: ctx.agentId,
        }),
      ]);

      return jsonResult({
        posted: true,
        taskId,
        status,
        discordMessageId: discordResult.messageId ?? null,
      });
    },
  };
}

export function createEcsAskQuestionTool(deps: EcsToolDeps, ctx: EcsToolContext): AnyAgentTool {
  return {
    label: "ECS",
    name: "ecs_ask_question",
    description:
      "Ask a blocking question via the #ecs-info Discord channel. Execution suspends until an answer is received or the question times out. On timeout, the question auto-escalates to #ecs-issues.",
    parameters: EcsAskQuestionSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const questionText = readStringParam(params, "question", { required: true });
      const toAgentId = readStringParam(params, "toAgentId");
      const context = readStringParam(params, "context");
      const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;

      const active = ctx.sessionKey ? deps.tracker.getBySessionKey(ctx.sessionKey) : undefined;
      const taskId = active?.task.taskId ?? "unknown";

      const question: EcsQuestion = {
        questionId: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        fromAgentId: ctx.agentId,
        toAgentId,
        taskId,
        question: questionText,
        context,
        timeoutMs,
      };

      // Post question to Discord and create thread.
      const discordResult = await deps.discord.postQuestion(question, active?.task.projectId);
      const threadId = discordResult.threadId;

      if (!threadId) {
        return jsonResult({
          answer: null,
          timedOut: false,
          escalatedToIssues: false,
          error: "Failed to create Discord thread for question",
        });
      }

      // Fire-and-forget: notify control plane about the question.
      deps.callback
        .reportQuestion({
          question_id: question.questionId,
          agent_task_id: question.taskId ?? null,
          question_text: question.question,
          context: question.context ?? null,
          asked_by: question.fromAgentId ?? null,
          discord_thread_id: threadId,
          discord_channel: "info",
        })
        .catch(() => {});

      // Block on the question relay promise.
      const result = await deps.questionRelay.registerPendingQuestion(
        question,
        threadId,
        active?.task.projectId,
      );

      return jsonResult(result);
    },
  };
}

export function createEcsRaiseIssueTool(deps: EcsToolDeps, ctx: EcsToolContext): AnyAgentTool {
  return {
    label: "ECS",
    name: "ecs_raise_issue",
    description:
      "Escalate a blocker or issue to #ecs-issues for human or coordinator intervention. Non-blocking.",
    parameters: EcsRaiseIssueSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const severity = readStringParam(params, "severity", {
        required: true,
      }) as EcsIssueSeverity;
      const title = readStringParam(params, "title", { required: true });
      const description = readStringParam(params, "description", { required: true });
      const attempted = Array.isArray(params.attempted)
        ? (params.attempted as string[]).map(String)
        : [];

      const active = ctx.sessionKey ? deps.tracker.getBySessionKey(ctx.sessionKey) : undefined;
      const taskId = active?.task.taskId ?? "unknown";

      const issue = {
        issueId: `iss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        taskId,
        agentId: ctx.agentId,
        severity,
        title,
        description,
        attempted,
        needsHuman: severity === "critical",
      };

      const discordResult = await deps.discord.postIssue(issue, active?.task.projectId);

      return jsonResult({
        posted: true,
        issueId: issue.issueId,
        taskId,
        severity,
        discordMessageId: discordResult.messageId ?? null,
      });
    },
  };
}

// --- ecs_set_persona ---

const EcsSetPersonaSchema = Type.Object({
  persona: Type.String({
    description: "Name of the persona to activate (must exist in ~/.openclaw/personas/)",
  }),
});

export function createEcsSetPersonaTool(_deps: EcsToolDeps, ctx: EcsToolContext): AnyAgentTool {
  return {
    label: "ECS",
    name: "ecs_set_persona",
    description:
      "Switch this agent's active persona. The persona must exist as a directory under ~/.openclaw/personas/ with at least one recognized .md file. Takes effect on the next bootstrap cycle.",
    parameters: EcsSetPersonaSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const persona = readStringParam(params, "persona", { required: true });

      if (!ctx.sessionKey) {
        return jsonResult({ success: false, error: "No session key available" });
      }

      const validation = await validatePersona(persona);
      if (!validation.valid) {
        return jsonResult({ success: false, error: validation.error });
      }

      setActivePersona(ctx.sessionKey, persona);

      return jsonResult({
        success: true,
        persona,
        sessionKey: ctx.sessionKey,
      });
    },
  };
}
