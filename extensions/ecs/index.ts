/**
 * OpenClaw ECS (Execution Control System) Plugin
 *
 * Inter-agent task orchestration layer that dispatches work to subagents,
 * tracks execution, provides blocking Q&A via Discord threads, and reports
 * back to an ECS control plane.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/ecs";
import { EcsApiCallback } from "./src/api-callback.js";
import { createEcsApiHandler } from "./src/api-handler.js";
import { resolveEcsAgentsConfig, type EcsConfig } from "./src/config.js";
import { EcsDiscordChannels } from "./src/discord-channels.js";
import { clearActivePersona } from "./src/persona-registry.js";
import { EcsQuestionRelay } from "./src/question-relay.js";
import { EcsTaskTracker } from "./src/task-tracker.js";
import {
  createEcsAskQuestionTool,
  createEcsRaiseIssueTool,
  createEcsSetPersonaTool,
  createEcsStatusUpdateTool,
  type EcsToolDeps,
} from "./src/tools.js";

/** Normalize a Discord bot token (strip env-var prefix, trim whitespace). */
function normalizeDiscordToken(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^DISCORD_BOT_TOKEN=/, "");
  return trimmed || undefined;
}

/** Resolve Discord token from env var or OpenClaw config. */
function resolveDiscordToken(config: Record<string, unknown>): string | undefined {
  const envToken = normalizeDiscordToken(process.env.DISCORD_BOT_TOKEN);
  if (envToken) return envToken;

  // Try from Discord channel config (first account token).
  const channels = config.channels as Record<string, unknown> | undefined;
  const discordConfig = channels?.discord as Record<string, unknown> | undefined;
  if (!discordConfig) return undefined;

  if (typeof discordConfig.token === "string") {
    return normalizeDiscordToken(discordConfig.token) ?? undefined;
  }

  const accounts = discordConfig.accounts as Record<string, { token?: string }> | undefined;
  if (accounts) {
    for (const account of Object.values(accounts)) {
      const t = normalizeDiscordToken(account.token);
      if (t) return t;
    }
  }

  return undefined;
}

const ecsPlugin = {
  id: "ecs",
  name: "ECS (Execution Control System)",
  description: "Inter-agent task orchestration via Discord with control plane callbacks",

  register(api: OpenClawPluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as EcsConfig;
    if (!pluginCfg.enabled) {
      api.logger.info("[ecs] plugin loaded but not enabled");
      return;
    }

    const log = api.logger;
    log.info("[ecs] initializing ECS plugin");

    // Resolve Discord token.
    const discordToken = resolveDiscordToken(api.config as unknown as Record<string, unknown>);
    if (!discordToken) {
      log.warn("[ecs] no Discord bot token found; Discord posting will fail");
    }
    if (!pluginCfg.discord) {
      log.warn("[ecs] ecs.discord config missing; Discord channels not configured");
    }

    // Initialize modules.
    const tracker = new EcsTaskTracker();
    const callback = new EcsApiCallback(pluginCfg.controlPlane ?? {});
    const discord = new EcsDiscordChannels(
      discordToken ?? "",
      pluginCfg.discord ?? { guildId: "", channels: { status: "", info: "", issues: "" } },
    );
    const agentsConfig = resolveEcsAgentsConfig(pluginCfg.agents);
    const questionRelay = new EcsQuestionRelay({
      discord,
      defaultTimeoutMs: agentsConfig.questionTimeoutMs,
      escalateOnTimeout: agentsConfig.questionEscalateOnTimeout,
    });

    // --- HTTP route: /ecs/* ---
    const apiHandler = createEcsApiHandler({
      tracker,
      discord,
      callback,
      subagent: api.runtime.subagent,
      apiConfig: pluginCfg.api ?? {},
    });

    api.registerHttpRoute({
      path: "/ecs",
      match: "prefix",
      auth: "plugin",
      handler: async (req, res) => {
        await apiHandler(req, res);
        return true;
      },
    });

    // --- Tools ---
    const toolDeps: EcsToolDeps = { tracker, discord, callback, questionRelay };

    api.registerTool(
      (ctx) => [
        createEcsStatusUpdateTool(toolDeps, { sessionKey: ctx.sessionKey, agentId: ctx.agentId }),
        createEcsAskQuestionTool(toolDeps, { sessionKey: ctx.sessionKey, agentId: ctx.agentId }),
        createEcsRaiseIssueTool(toolDeps, { sessionKey: ctx.sessionKey, agentId: ctx.agentId }),
        createEcsSetPersonaTool(toolDeps, { sessionKey: ctx.sessionKey, agentId: ctx.agentId }),
      ],
      {
        names: ["ecs_status_update", "ecs_ask_question", "ecs_raise_issue", "ecs_set_persona"],
        optional: false,
      },
    );

    // --- Hooks ---

    // Hook: auto-report task completion when a subagent ends.
    api.on(
      "subagent_ended",
      async (event) => {
        const sessionKey = event.targetSessionKey;
        if (!sessionKey) return;

        const active = tracker.getBySessionKey(sessionKey);
        if (!active) return;

        const taskId = active.task.taskId;
        const isError = event.outcome === "error" || event.outcome === "timeout";
        const summary = event.reason ?? (isError ? "Task failed" : "Task completed");

        if (isError) {
          await callback.reportError(taskId, summary, { sessionId: sessionKey });
        } else {
          await callback.reportCompleted(taskId, summary, { sessionId: sessionKey });
        }

        await discord.postTaskCompleted({
          taskId,
          agentId: active.agentId,
          status: isError ? "error" : "complete",
          summary,
          durationMs: Date.now() - active.startedAt,
          threadId: active.discordThreadId,
        });

        tracker.remove(taskId);
        clearActivePersona(sessionKey);
        log.info(`[ecs] task ${taskId} ended: ${event.outcome ?? "unknown"}`);
      },
      { priority: 100 },
    );

    // Hook: detect replies in ECS info threads to resolve pending questions.
    api.on(
      "message_received",
      async (event, ctx) => {
        const threadId = ctx.conversationId;
        if (!threadId || !event.content) return;

        if (questionRelay.hasPending(threadId)) {
          const answeredBy = event.from ?? "unknown";
          questionRelay.resolveQuestion(threadId, event.content, answeredBy);
          log.info(`[ecs] question in thread ${threadId} answered by ${answeredBy}`);
        }

        // Forward ECS-channel messages to the control plane.
        if (discord.isEcsChannel(threadId)) {
          void callback
            .reportMessage({
              channel_id: threadId,
              direction: "inbound",
              author: event.from,
              content: event.content,
            })
            .catch((err) => log.warn(`[ecs] inbound message callback failed: ${err}`));
        }
      },
      { priority: 50 },
    );

    // Hook: forward outbound auto-reply messages to control plane.
    api.on(
      "message_sent",
      async (event, ctx) => {
        if (!ctx.conversationId || !event.success) return;
        if (discord.isEcsChannel(ctx.conversationId)) {
          void callback
            .reportMessage({
              channel_id: ctx.conversationId,
              direction: "outbound",
              content: event.content,
            })
            .catch((err) => log.warn(`[ecs] outbound message callback failed: ${err}`));
        }
      },
      { priority: 50 },
    );

    // Wire ECS system posts (embeds) to control plane.
    discord.setOnPost((info) => {
      void callback
        .reportMessage({
          channel_id: info.channelId,
          direction: "outbound",
          embed_title: info.embedTitle,
          content: info.content,
        })
        .catch((err) => log.warn(`[ecs] ecs-post callback failed: ${err}`));
    });

    // Hook: gateway started — post a heartbeat embed.
    api.on(
      "gateway_start",
      async (event) => {
        await discord.postSystemEvent({
          title: "Gateway Online",
          description: `Gateway started on port ${event.port}.`,
          color: 0x2ecc71, // green
        });
      },
      { priority: 200 },
    );

    // Hook: subagent spawned — track when a new agent session starts.
    api.on(
      "subagent_spawned",
      async (event) => {
        const ecsTask = tracker.getBySessionKey(event.childSessionKey);
        // Only post for ECS-managed tasks (not random subagents).
        if (!ecsTask) return;
        await discord.postSystemEvent({
          title: "Agent Session Started",
          color: 0x3498db, // blue
          fields: [
            { name: "Task", value: ecsTask.task.title, inline: true },
            { name: "Agent", value: event.agentId, inline: true },
            { name: "Mode", value: event.mode, inline: true },
          ],
        });
      },
      { priority: 200 },
    );

    log.info("[ecs] plugin initialized");
  },
};

export default ecsPlugin;
