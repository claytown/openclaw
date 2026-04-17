/**
 * OpenClaw ECS (Execution Control System) Plugin
 *
 * Inter-agent task orchestration layer that dispatches work to subagents,
 * tracks execution, provides blocking Q&A via Discord threads, and reports
 * back to an ECS control plane.
 */

import { randomBytes } from "node:crypto";
import { RequestClient } from "@buape/carbon";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/ecs";
import { EcsApiCallback } from "./src/api-callback.js";
import { createEcsApiHandler } from "./src/api-handler.js";
import { resolveEcsAgentsConfig, type EcsConfig } from "./src/config.js";
import { EcsDiscordChannels } from "./src/discord-channels.js";
import { normalizeDispatchPayload } from "./src/dispatch-payload.js";
import { clearActivePersona } from "./src/persona-registry.js";
import { ProjectChannelManager } from "./src/project-channel-manager.js";
import { getEcsQuestionRelay } from "./src/question-relay.js";
import { getEcsTaskTracker } from "./src/task-tracker.js";
import { EcsTeamsChannels } from "./src/teams-channels.js";
import { TeamsProjectChannelManager } from "./src/teams-project-channel-manager.js";
import {
  createEcsAskQuestionTool,
  createEcsRaiseIssueTool,
  createEcsSetPersonaTool,
  createEcsStatusUpdateTool,
  createEcsThreadReplyTool,
  type EcsToolDeps,
} from "./src/tools.js";

/** Extract raw channel/thread ID from a prefixed conversationId (strips "channel:" / "user:" / "conversation:" prefix). */
function extractRawId(conversationId: string | undefined): string | undefined {
  if (!conversationId) {
    return undefined;
  }
  const colonIdx = conversationId.indexOf(":");
  return colonIdx >= 0 ? conversationId.slice(colonIdx + 1) : conversationId;
}

/** Loopback-only request check: reject if there are any forwarded-for headers
 * or if the socket is not bound to a loopback address. We deliberately do not
 * rely on a trusted-proxy allowlist here because this endpoint is meant for
 * in-process gateway calls only. */
function isLoopbackRequest(req: {
  socket?: { remoteAddress?: string | undefined };
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  const addr = req.socket?.remoteAddress ?? "";
  const isLoopbackAddr =
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.");
  if (!isLoopbackAddr) {
    return false;
  }
  const forwardedHeaders = ["x-forwarded-for", "forwarded", "x-real-ip"] as const;
  for (const h of forwardedHeaders) {
    if (req.headers[h]) {
      return false;
    }
  }
  return true;
}

/** Read a JSON request body with a small hard size cap. */
async function readJsonBody(
  req: import("node:http").IncomingMessage,
  maxBytes = 64 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

/** Normalize a Discord bot token (strip env-var prefix, trim whitespace). */
function normalizeDiscordToken(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim().replace(/^DISCORD_BOT_TOKEN=/, "");
  return trimmed || undefined;
}

/** Resolve Discord token from env var or OpenClaw config. */
function resolveDiscordToken(config: Record<string, unknown>): string | undefined {
  const envToken = normalizeDiscordToken(process.env.DISCORD_BOT_TOKEN);
  if (envToken) {
    return envToken;
  }

  // Try from Discord channel config (first account token).
  const channels = config.channels as Record<string, unknown> | undefined;
  const discordConfig = channels?.discord as Record<string, unknown> | undefined;
  if (!discordConfig) {
    return undefined;
  }

  if (typeof discordConfig.token === "string") {
    return normalizeDiscordToken(discordConfig.token) ?? undefined;
  }

  const accounts = discordConfig.accounts as Record<string, { token?: string }> | undefined;
  if (accounts) {
    for (const account of Object.values(accounts)) {
      const t = normalizeDiscordToken(account.token);
      if (t) {
        return t;
      }
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
    const tracker = getEcsTaskTracker();
    const callback = new EcsApiCallback(pluginCfg.controlPlane ?? {});
    const discordCfg = pluginCfg.discord ?? {
      guildId: "",
      channels: { status: "", info: "", issues: "" },
    };

    // Project channel manager: auto-provisions per-project Discord categories.
    let projectManager: ProjectChannelManager | undefined;
    if (discordToken && discordCfg.guildId) {
      projectManager = new ProjectChannelManager(
        new RequestClient(discordToken),
        discordCfg.guildId,
        discordCfg.channels,
        {
          maxProjects: discordCfg.maxProjectChannels,
          projectChannels: discordCfg.projectChannels,
          log: (msg) => log.info(msg),
          onProjectProvisioned: (channelSet) => {
            void callback
              .reportProjectChannels({
                project_id: channelSet.projectId,
                category_id: channelSet.categoryId,
                status_channel_id: channelSet.statusChannelId,
                info_channel_id: channelSet.infoChannelId,
                issues_channel_id: channelSet.issuesChannelId,
              })
              .catch((err) => log.warn(`[ecs] project channels callback failed: ${err}`));
          },
        },
      );
      projectManager.load();
    }

    const discord = new EcsDiscordChannels(discordToken ?? "", discordCfg, projectManager);

    // Initialize Teams (parallel to Discord, if configured).
    let teams: EcsTeamsChannels | null = null;
    if (pluginCfg.teams && pluginCfg.teams.tenantId && pluginCfg.teams.appId) {
      const teamsCfg = pluginCfg.teams;
      const teamsCreds = {
        tenantId: teamsCfg.tenantId,
        appId: teamsCfg.appId,
        appPassword: teamsCfg.appPassword,
        serviceUrl: teamsCfg.serviceUrl,
      };

      let teamsProjectManager: TeamsProjectChannelManager | undefined;
      if (teamsCfg.teamId) {
        teamsProjectManager = new TeamsProjectChannelManager(
          { tenantId: teamsCfg.tenantId, appId: teamsCfg.appId, appPassword: teamsCfg.appPassword },
          teamsCfg.teamId,
          {
            maxProjects: teamsCfg.maxProjectChannels,
            log: (msg) => log.info(msg),
            onProvisioned: (projectId, channelId) => {
              void callback
                .reportProjectTeamsChannel({ project_id: projectId, teams_channel_id: channelId })
                .catch((err) => log.warn(`[ecs] teams channel callback failed: ${err}`));
            },
          },
        );
        teamsProjectManager.load();
      }

      teams = new EcsTeamsChannels(teamsCreds, teamsCfg, teamsProjectManager);

      // Seed statically-configured project channel IDs so isEcsChannel()
      // recognizes them even before we successfully post to any of them.
      // Without this, venture replies after a pod restart are rejected by
      // the ACL check (config.teams.projectChannels is consulted for outbound
      // routing but never added to the known-channels set).
      const seedChannels = teamsCfg.projectChannels ? Object.values(teamsCfg.projectChannels) : [];
      for (const chId of seedChannels) {
        teams.registerChannel(chId);
      }
      if (seedChannels.length > 0) {
        log.info(`[ecs] seeded ${seedChannels.length} project channel(s) from config`);
      }

      // Wire Teams posts to control plane.
      teams.setOnPost((info) => {
        void callback
          .reportMessage({
            channel_id: info.channelId,
            direction: "outbound",
            embed_title: info.title,
            content: info.content,
          })
          .catch((err) => log.warn(`[ecs] teams-post callback failed: ${err}`));
      });

      // When Teams reports a thread is gone, flag it so outbound replies stop
      // targeting it. Inbound routing by thread id is intentionally preserved
      // so human replies still reach the running session.
      teams.setOnDeadThread((info) => {
        const active = tracker.findByTeamsThread(info.replyToId);
        if (active) {
          tracker.markDeadThread(active.task.taskId);
        }
      });

      // When the 404 fallback lands a new root message, re-index it against
      // the same task. markDeadThread preserves the inbound byTeamsMessageId
      // entry for the original dead id, so findByTeamsThread(replyToId) still
      // resolves here. setTeamsMessage additionally clears teamsThreadIsDead
      // so outbound replies to the fresh root are permitted again.
      teams.setOnRootFallback(({ replyToId, newMessageId }) => {
        const active = tracker.findByTeamsThread(replyToId);
        if (active) {
          tracker.setTeamsMessage(active.task.taskId, newMessageId);
          log.info(
            `[ecs] root-fallback re-indexed taskId=${active.task.taskId} replyToId=${replyToId} newMessageId=${newMessageId}`,
          );
        } else {
          log.warn(
            `[ecs] root-fallback: no tracker entry for replyToId=${replyToId}; new thread ${newMessageId} not indexed`,
          );
        }
      });

      log.info(`[ecs] Teams configured (team: ${teamsCfg.teamId})`);
    }

    const agentsConfig = resolveEcsAgentsConfig(pluginCfg.agents);
    const questionRelay = getEcsQuestionRelay({
      discord,
      teams,
      defaultTimeoutMs: agentsConfig.questionTimeoutMs,
      escalateOnTimeout: agentsConfig.questionEscalateOnTimeout,
    });

    // Determine which rule (if any) accepts a Teams channel id for ECS.
    // Returns the path name so the message_received log shows why a
    // message was accepted, which makes debugging production drops easy.
    type TeamsAclPath = "default" | "projectChannels" | "registered" | "tracker" | null;
    const teamsAclPath = (id: string): TeamsAclPath => {
      if (!teams) {
        return null;
      }
      const teamsCfg = pluginCfg.teams;
      if (teamsCfg?.defaultChannel === id) {
        return "default";
      }
      if (teamsCfg?.projectChannels) {
        for (const chId of Object.values(teamsCfg.projectChannels)) {
          if (chId === id) {
            return "projectChannels";
          }
        }
      }
      if (teams.isEcsChannel(id)) {
        return "registered";
      }
      if (tracker.getByTeamsChannelId(id)) {
        return "tracker";
      }
      return null;
    };

    // Rehydrate the tracker on startup so replies to in-flight tasks route
    // correctly across a pod restart. Fire-and-forget: register() is sync;
    // logging the result is enough for operators.
    if (pluginCfg.controlPlane?.url) {
      void (async () => {
        try {
          const payloads = await callback.fetchActiveTasks();
          let rehydrated = 0;
          for (const payload of payloads) {
            const task = normalizeDispatchPayload(payload);
            if (!task) {
              continue;
            }
            const agentId = task.assignedAgentId ?? "coding";
            const sessionKey = `${agentId}-ecs-${task.taskId}`;
            tracker.register(task, sessionKey, undefined, agentId);
            if (task.teamsChannelId && teams) {
              teams.registerChannel(task.teamsChannelId);
            }
            if (task.teamsThreadId) {
              tracker.setTeamsMessage(task.taskId, task.teamsThreadId);
            }
            rehydrated++;
          }
          log.info(`[ecs] rehydrated ${rehydrated} active task(s) from control plane`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[ecs] tracker rehydrate failed: ${msg}`);
        }
      })();
    }

    // Sweep stale tracker entries so abandoned tasks don't accumulate Teams
    // thread indices that later 404 on status-update posts.
    const sweeperInterval = setInterval(
      () => {
        const pruned = tracker.pruneStale({
          maxAgeMs: 24 * 60 * 60 * 1000,
          idleMs: 60 * 60 * 1000,
        });
        if (pruned.length > 0) {
          log.info(`[ecs] sweeper pruned ${pruned.length} stale task(s): ${pruned.join(", ")}`);
        }
      },
      15 * 60 * 1000,
    );
    sweeperInterval.unref?.();

    // --- HTTP route: /ecs/* ---
    const apiHandler = createEcsApiHandler({
      tracker,
      discord,
      teams,
      callback,
      subagent: api.runtime.subagent,
      apiConfig: pluginCfg.api ?? {},
      projectManager,
      questionRelay,
    });

    api.registerHttpRoute({
      path: "/ecs",
      match: "prefix",
      auth: "gateway",
      handler: async (req, res) => {
        await apiHandler(req, res);
        return true;
      },
    });

    // --- Loopback-only inject endpoint ---
    //
    // Used by the before_dispatch forwarder when a human reply lands but the
    // target agent session is not currently streaming. The forwarder POSTs
    // through the loopback gateway so this handler runs with a legitimate
    // gateway request context and subagent.run() can attach a fresh run.
    // Calling subagent.run() directly from inside a hook on the same stack
    // that received the inbound message deadlocks on the session write lock
    // for coding sessions that were previously woken up this way.
    let injectPort = 0;
    const injectAuthToken = randomBytes(32).toString("hex");

    api.registerHttpRoute({
      path: "/__internal/ecs/inject",
      match: "exact",
      auth: "plugin",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return true;
        }
        if (!isLoopbackRequest(req)) {
          log.warn(
            `[ecs] /__internal/ecs/inject rejected non-loopback request remoteAddress=${req.socket?.remoteAddress ?? "<none>"}`,
          );
          res.statusCode = 403;
          res.end();
          return true;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          return true;
        }
        if (
          typeof body !== "object" ||
          body === null ||
          typeof (body as Record<string, unknown>).sessionKey !== "string" ||
          typeof (body as Record<string, unknown>).content !== "string" ||
          typeof (body as Record<string, unknown>).authToken !== "string" ||
          (body as Record<string, unknown>).role !== "user"
        ) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid body shape" }));
          return true;
        }
        const { sessionKey, content, authToken } = body as {
          sessionKey: string;
          content: string;
          authToken: string;
        };
        if (authToken !== injectAuthToken) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: "bad authToken" }));
          return true;
        }

        // Fire-and-forget: subagent.run acquires the session write lock and
        // can block for the duration of a turn. Resolving the HTTP response
        // first prevents the caller (the before_dispatch hook) from tying up
        // its own stack on this round-trip.
        res.statusCode = 202;
        res.end(JSON.stringify({ accepted: true }));

        void (async () => {
          try {
            const runResult = await api.runtime.subagent.run({
              sessionKey,
              message: content,
              deliver: false,
            });
            log.info(
              `[ecs] inject: run attached sessionKey=${sessionKey} runId=${runResult.runId}`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`[ecs] inject: run failed sessionKey=${sessionKey}: ${msg}`);
          }
        })();

        return true;
      },
    });

    // --- Tools ---
    const toolDeps: EcsToolDeps = { tracker, discord, teams, callback, questionRelay };

    api.registerTool(
      (ctx) => [
        createEcsStatusUpdateTool(toolDeps, { sessionKey: ctx.sessionKey, agentId: ctx.agentId }),
        createEcsAskQuestionTool(toolDeps, { sessionKey: ctx.sessionKey, agentId: ctx.agentId }),
        createEcsRaiseIssueTool(toolDeps, { sessionKey: ctx.sessionKey, agentId: ctx.agentId }),
        createEcsSetPersonaTool(toolDeps, { sessionKey: ctx.sessionKey, agentId: ctx.agentId }),
        createEcsThreadReplyTool(toolDeps, { sessionKey: ctx.sessionKey, agentId: ctx.agentId }),
      ],
      {
        names: [
          "ecs_status_update",
          "ecs_ask_question",
          "ecs_raise_issue",
          "ecs_set_persona",
          "ecs_thread_reply",
        ],
        optional: false,
      },
    );

    // --- Hooks ---

    // Hook: auto-report task completion when a subagent ends.
    api.on(
      "subagent_ended",
      async (event) => {
        const sessionKey = event.targetSessionKey;
        if (!sessionKey) {
          return;
        }

        const active = tracker.getBySessionKey(sessionKey);
        if (!active) {
          return;
        }

        const taskId = active.task.taskId;
        const isError = event.outcome === "error" || event.outcome === "timeout";
        const summary = event.reason ?? (isError ? "Task failed" : "Task completed");

        if (isError) {
          await callback.reportError(taskId, summary, { sessionId: sessionKey });
        } else {
          await callback.reportCompleted(taskId, summary, { sessionId: sessionKey });
        }

        const completion = {
          taskId,
          agentId: active.agentId,
          status: isError ? ("error" as const) : ("complete" as const),
          summary,
          durationMs: Date.now() - active.startedAt,
          threadId: active.discordThreadId,
        };

        await discord.postTaskCompleted(completion, active.task.projectId);
        if (teams) {
          await teams.postTaskCompleted(
            { ...completion, threadId: active.teamsMessageId },
            active.task.projectId,
          );
        }

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
        const rawId = extractRawId(ctx.conversationId);
        if (!rawId || !event.content) {
          return;
        }

        const isEcsDiscord = discord.isEcsChannel(rawId);
        const aclPath = teamsAclPath(rawId);
        const isEcsTeams = aclPath != null;

        // If the MSTeams channel plugin surfaces activity.serviceUrl on the
        // inbound event metadata, cache it per-channel so outbound replies
        // target the same regional Bot Framework endpoint that minted the
        // conversation. `event.metadata.serviceUrl` is not populated by core
        // today (only threadId is); this is a defensive read so we can land
        // the cache infrastructure first and plumb the metadata through in a
        // follow-up change to the MSTeams handler.
        if (isEcsTeams && teams) {
          const metaServiceUrl = event.metadata?.serviceUrl;
          if (typeof metaServiceUrl === "string" && metaServiceUrl.length > 0) {
            teams.recordInboundServiceUrl(rawId, metaServiceUrl);
          }
        }

        log.info(
          `[ecs] message_received: conversationId=${ctx.conversationId} rawId=${rawId} from=${event.from} isEcsDiscord=${isEcsDiscord} isEcsTeams=${isEcsTeams}${aclPath ? ` via=${aclPath}` : ""} hasPending=${questionRelay.hasPending(rawId)}`,
        );

        if (questionRelay.hasPending(rawId)) {
          const answeredBy = event.from ?? "unknown";
          questionRelay.resolveQuestion(rawId, event.content, answeredBy);
          log.info(`[ecs] question in thread/channel ${rawId} answered by ${answeredBy}`);
        } else {
          // Fallback: check threadId from metadata (Teams MessageThreadId is the
          // thread root message ID, registered as an alternate key in the relay).
          const threadId = event.metadata?.threadId;
          const threadIdStr = typeof threadId === "string" ? threadId : undefined;
          if (threadIdStr && questionRelay.hasPending(threadIdStr)) {
            const answeredBy = event.from ?? "unknown";
            questionRelay.resolveQuestion(threadIdStr, event.content, answeredBy);
            log.info(
              `[ecs] question in thread ${threadIdStr} answered by ${answeredBy} (via threadId)`,
            );
          }
        }

        // Forward ECS-channel messages to the control plane.
        if (isEcsDiscord || isEcsTeams) {
          void callback
            .reportMessage({
              channel_id: rawId,
              direction: "inbound",
              author: event.from,
              content: event.content,
            })
            .catch((err) => log.warn(`[ecs] inbound message callback failed: ${err}`));
        }
      },
      { priority: 50 },
    );

    // Hook: intercept thread replies in ECS task threads before they reach
    // the agent dispatch pipeline. Two paths:
    // 1. Pending question in the relay → resolve it and suppress dispatch.
    // 2. Active task in the tracker (by Teams message ID) → forward the
    //    message to the running agent session via subagent.run().
    // Both return { handled: true } to prevent a spurious fresh session.
    api.on(
      "before_dispatch",
      async (event, ctx) => {
        const sessionKey = ctx.sessionKey ?? event.sessionKey;
        if (!sessionKey || !event.content) {
          return undefined;
        }

        const threadMarker = ":thread:";
        const threadIdx = sessionKey.lastIndexOf(threadMarker);
        if (threadIdx < 0) {
          return undefined;
        }
        const threadId = sessionKey.slice(threadIdx + threadMarker.length);
        if (!threadId) {
          return undefined;
        }

        const lookupKey = threadId.toLowerCase();
        const activeMatch = tracker.findByTeamsThread(threadId);
        const trackerMatch = !!activeMatch;
        const teamsIndex = tracker.teamsIndexSize();
        // On a miss, dump a small sample of indexed keys so we can tell
        // "index was wiped" (size 0) from "key mismatch" (size > 0, our key
        // absent) without chasing partial logs.
        const teamsSample =
          trackerMatch || teamsIndex === 0
            ? ""
            : ` teamsSample=${JSON.stringify(tracker.teamsIndexSampleKeys(5))}`;
        log.info(
          `[ecs] before_dispatch: sessionKey=${sessionKey} threadId=${threadId} lookupKey=${lookupKey} hasPending=${questionRelay.hasPending(threadId)} trackerMatch=${trackerMatch} trackerSize=${tracker.size()} teamsIndex=${teamsIndex}${teamsSample}`,
        );

        // Path 1: pending question — resolve it.
        if (questionRelay.hasPending(threadId)) {
          const answeredBy = event.senderId ?? ctx.senderId ?? "unknown";
          questionRelay.resolveQuestion(threadId, event.content, answeredBy);
          log.info(
            `[ecs] question in thread ${threadId} answered by ${answeredBy} (before_dispatch)`,
          );
          return { handled: true };
        }

        // Path 2: active task whose Teams thread matches — forward the
        // human's message to the agent session so it has context.
        const activeTask = activeMatch;
        if (activeTask) {
          const sender = event.senderId ?? ctx.senderId ?? "unknown";
          log.info(
            `[ecs] forwarding thread reply to agent session ${activeTask.sessionKey} (task ${activeTask.task.taskId}, from ${sender})`,
          );
          const msg = `[Teams thread reply from ${sender}]\n${event.content}\n\nIMPORTANT: Use the ecs_thread_reply tool to respond to this message. The human is waiting for a reply in the task thread.`;

          // Prefer queueing into the active run so the next LLM turn picks up
          // the reply. When there is no active streaming run, POST to the
          // loopback /__internal/ecs/inject endpoint instead of calling
          // subagent.run() on this same stack: the hook is inside the gateway
          // dispatch path and subagent.run() contends on the session write
          // lock for coding-ecs-* sessions we previously woke up the same
          // way. The loopback handler is the boundary that detaches this
          // stack from the fresh run.
          void (async () => {
            const rawKey = activeTask.sessionKey;
            try {
              const canonicalGuess = `agent:main:${rawKey}`;
              log.info(
                `[ecs] queueMessage attempt sessionKey=${rawKey} canonicalGuess=${canonicalGuess}`,
              );
              const outcome = await api.runtime.subagent.queueMessage({
                sessionKey: rawKey,
                message: msg,
              });
              if (outcome.queued) {
                log.info(`[ecs] forward: method=bus sessionKey=${rawKey} status=ok`);
                return;
              }
              log.info(
                `[ecs] subagent.queueMessage not queued (reason=${outcome.reason ?? "unknown"}) sessionKey=${rawKey} canonicalGuess=${canonicalGuess} trackerSize=${tracker.size()}; falling back to loopback inject`,
              );
              if (injectPort <= 0) {
                log.warn(
                  `[ecs] forward: method=http sessionKey=${rawKey} status=err (gateway port not yet captured)`,
                );
                return;
              }
              try {
                const resp = await fetch(`http://127.0.0.1:${injectPort}/__internal/ecs/inject`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    sessionKey: rawKey,
                    role: "user",
                    content: msg,
                    authToken: injectAuthToken,
                  }),
                  signal: AbortSignal.timeout(5_000),
                });
                log.info(`[ecs] forward: method=http sessionKey=${rawKey} status=${resp.status}`);
              } catch (httpErr) {
                const httpMsg = httpErr instanceof Error ? httpErr.message : String(httpErr);
                log.warn(
                  `[ecs] forward: method=http sessionKey=${rawKey} status=err err=${httpMsg}`,
                );
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              log.warn(`[ecs] forward failed via queueMessage sessionKey=${rawKey}: ${errMsg}`);
            }
          })();

          // Immediate thread ACK so the human sees the message landed even if
          // the agent's reply is delayed by lock contention or a long turn.
          // Skip when the thread has been flagged dead for outbound posts —
          // replying to a dead thread would just 404 again. The agent's own
          // reply will land through whatever outbound path still works.
          if (teams && activeTask.teamsMessageId && !activeTask.teamsThreadIsDead) {
            void teams
              .postReplyToThread(
                "_Got it — working on a reply._",
                activeTask.task.projectId,
                activeTask.teamsMessageId,
              )
              .catch((err) => log.warn(`[ecs] thread ack post failed: ${err}`));
          }
          return { handled: true };
        }

        return undefined;
      },
      { priority: 50 },
    );

    // Hook: forward outbound auto-reply messages to control plane.
    api.on(
      "message_sent",
      async (event, ctx) => {
        const rawId = extractRawId(ctx.conversationId);
        if (!rawId || !event.success) {
          return;
        }
        if (discord.isEcsChannel(rawId)) {
          void callback
            .reportMessage({
              channel_id: rawId,
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

    // Hook: gateway started — post a heartbeat. Also captures the gateway
    // HTTP port so the forwarder can POST to /__internal/ecs/inject over
    // loopback when an active session is not streaming.
    api.on(
      "gateway_start",
      async (event) => {
        if (typeof event.port === "number" && event.port > 0) {
          injectPort = event.port;
        }
        const sysEvent = {
          title: "Gateway Online",
          description: `Gateway started on port ${event.port}.`,
          color: 0x2ecc71, // green
        };
        await discord.postSystemEvent(sysEvent);
        if (teams) {
          await teams.postSystemEvent(sysEvent);
        }
      },
      { priority: 200 },
    );

    // Hook: subagent spawned — track when a new agent session starts.
    api.on(
      "subagent_spawned",
      async (event) => {
        const ecsTask = tracker.getBySessionKey(event.childSessionKey);
        // Only post for ECS-managed tasks (not random subagents).
        if (!ecsTask) {
          return;
        }
        const sysEvent = {
          title: "Agent Session Started",
          color: 0x3498db, // blue
          fields: [
            { name: "Task", value: ecsTask.task.title, inline: true },
            { name: "Agent", value: event.agentId, inline: true },
            { name: "Mode", value: event.mode, inline: true },
          ],
        };
        await discord.postSystemEvent(sysEvent, ecsTask.task.projectId);
        if (teams) {
          await teams.postSystemEvent(sysEvent, ecsTask.task.projectId);
        }
      },
      { priority: 200 },
    );

    log.info("[ecs] plugin initialized");
  },
};

export default ecsPlugin;
// rebuild 1776125096
