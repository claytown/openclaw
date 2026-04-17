/**
 * Receives a task from the ECS API, spawns a subagent session via the plugin
 * runtime, and registers tracking.
 */

import type { SubagentRunResult } from "openclaw/plugin-sdk/ecs";
import type { EcsApiCallback } from "./api-callback.js";
import type { EcsDiscordChannels } from "./discord-channels.js";
import { setActivePersona } from "./persona-registry.js";
import { loadPersonaBootstrapFiles } from "./persona.js";
import type { EcsTaskTracker } from "./task-tracker.js";
import type { EcsTeamsChannels } from "./teams-channels.js";
import type { EcsTask, EcsTaskAck } from "./types.js";

export type SubagentRunner = {
  run: (params: {
    sessionKey: string;
    message: string;
    extraSystemPrompt?: string;
    deliver?: boolean;
    idempotencyKey?: string;
  }) => Promise<SubagentRunResult>;
};

export type TaskDispatcherDeps = {
  tracker: EcsTaskTracker;
  discord: EcsDiscordChannels;
  teams?: EcsTeamsChannels | null;
  callback: EcsApiCallback;
  subagent: SubagentRunner;
};

/**
 * Load persona bootstrap files and format them into a system prompt section.
 * Falls back to a bare label when the persona directory has no files.
 */
export async function buildPersonaSystemPrompt(personaName: string): Promise<string> {
  const files = await loadPersonaBootstrapFiles(personaName);
  if (files.length === 0) {
    return `Active persona: ${personaName}`;
  }

  const sections = files.map((f) => `## ${f.name}\n\n${f.content.trim()}`);
  return `# Persona: ${personaName}\n\n${sections.join("\n\n---\n\n")}`;
}

/**
 * Build the structured prompt for a spawned ECS agent.
 * Includes task context and ECS tool usage instructions.
 */
function buildAgentPrompt(task: EcsTask): string {
  const lines = [
    `You are executing ECS Agent Task #${task.taskId}.`,
    "",
    `## Task: ${task.title}`,
    "",
    task.description,
    "",
    "---",
    "",
    "## ECS Tools Available",
    "",
    "You have five ECS tools available. Use them throughout your work:",
    "",
    "1. **ecs_status_update** — Post progress updates (non-blocking).",
    '   Call this periodically to report your status (e.g., "running", progress %).',
    "",
    "2. **ecs_ask_question** — Ask a blocking question when you need clarification.",
    "   Your execution will pause until an answer is received.",
    "",
    "3. **ecs_raise_issue** — Escalate a blocker you cannot resolve.",
    "",
    "4. **ecs_thread_reply** — Reply to a human's message in the task thread.",
    "   Use this when you receive a [Teams thread reply from ...] message.",
    "",
    "5. **ecs_check_inbox** — Pull any human messages sent to the task thread",
    "   since your last check. Returns an array of {id, sender, content, ts}",
    "   or [] if empty. Atomically clears the inbox on read.",
    "",
    `**Important:** Always pass taskId: "${task.taskId}" when calling any ECS tool.`,
    "",
    "## Execution Protocol",
    "",
    '1. Call `ecs_status_update` with status "running" before you begin work.',
    "2. Complete the task described above. Work carefully and verify each step.",
    "3. Call `ecs_status_update` periodically with progress updates.",
    "4. If blocked, use `ecs_ask_question` or `ecs_raise_issue` as appropriate.",
    '5. When done, call `ecs_status_update` with status "complete" and a summary.',
    "",
    "**Important:** Always report your start and completion via the ECS tools.",
    "",
    "## Human Communication",
    "",
    "Poll for human messages during execution. Between major milestones (after",
    "a successful build, after running tests, after each acceptance-criteria",
    "item is done, or before starting a meaningfully new unit of work), call",
    "`ecs_check_inbox`. If it returns any messages, acknowledge each via",
    "`ecs_thread_reply` with a brief contextual reply (reference your actual",
    "current state: current file, last command run, current progress). Then",
    "continue your task. Do not abandon the task unless the user explicitly",
    "requests it. Do not call `ecs_check_inbox` more than once per tool-result",
    "cycle — once per milestone is enough.",
    "",
    "Messages may also arrive inline as `[Teams thread reply from ...]` with a",
    "trailing `[message_id=<uuid>]` marker. If you later see the same",
    "`message_id` in an `ecs_check_inbox` response, treat it as the same",
    "message and do not double-reply.",
  ];

  if (task.persona) {
    lines.push("", `**Active Persona:** ${task.persona}`);
  }

  if (task.priority === "critical") {
    lines.push("", "**Priority: CRITICAL** — This task requires immediate attention.");
  }

  return lines.join("\n");
}

export async function dispatchEcsTask(
  task: EcsTask,
  deps: TaskDispatcherDeps,
  opts?: {
    agentId?: string;
  },
): Promise<EcsTaskAck> {
  const prompt = buildAgentPrompt(task);
  const agentId = task.assignedAgentId ?? opts?.agentId ?? "coding";
  // Session key format: <agentId>-ecs-<taskId> — the gateway infers agent ID from the prefix.
  const sessionKey = `${agentId}-ecs-${task.taskId}`;

  try {
    const extraSystemPrompt = task.persona
      ? await buildPersonaSystemPrompt(task.persona)
      : undefined;

    // Register BEFORE spawning so tools see the task immediately,
    // even if the plugin registry resolves a separate instance.
    const active = deps.tracker.register(task, sessionKey, undefined, agentId);

    let result: SubagentRunResult;
    try {
      result = await deps.subagent.run({
        sessionKey,
        message: prompt,
        extraSystemPrompt,
        deliver: false, // headless, no external delivery
        idempotencyKey: task.idempotencyKey,
      });
    } catch (err) {
      // Clean up orphaned tracker entry on spawn failure.
      deps.tracker.remove(task.taskId);
      throw err;
    }

    // Log a source-tagged registration line so prod can line up the ECS
    // spawn with the core [subagent] session registered log emitted by
    // setActiveEmbeddedRun. If they disagree on sessionKey shape, that is
    // the canonicalization gap the forwarder trips on.
    console.info(
      `[subagent] session registered key=${sessionKey} id=${result.runId} source=ecs-dispatch`,
    );

    // Backfill runId now that we have it.
    active.runId = result.runId;

    // Activate persona for this session so the bootstrap hook can overlay files.
    if (task.persona) {
      setActivePersona(sessionKey, task.persona);
    }

    // Report started to ECS control plane.
    await deps.callback.reportStarted(task.taskId, sessionKey, agentId);

    // Echo task assignment to Discord.
    const discordResult = await deps.discord.postTaskAssigned(task);
    if (discordResult.threadId) {
      deps.tracker.setDiscordThread(task.taskId, discordResult.threadId);
    }

    // Eagerly register the venture channel so isEcsChannel() recognizes
    // inbound messages even if the postTaskAssigned call below fails.
    // (tracker.register already stores task.teamsChannelId on the active entry.)
    if (task.teamsChannelId && deps.teams) {
      deps.teams.registerChannel(task.teamsChannelId);
    }

    // OpenClaw owns Teams thread creation end-to-end: we post the "Task
    // Assigned" card as a new root, capture the messageId we minted, index
    // it on the tracker, and notify the ECS control plane so the dashboard
    // can deep-link. This replaces the prior "reply to control-plane's
    // teamsThreadId" path, which reliably 404s when the control plane's
    // thread was minted at a different regional Bot Framework endpoint
    // than our outbound creds.serviceUrl.
    if (deps.teams) {
      let teamsResult = await deps.teams.postTaskAssigned(task, undefined, undefined);
      if (!teamsResult.messageId) {
        // Azure production bug (MS-Teams-Samples #1561) occasionally returns
        // a 2xx with an empty body for proactive activity POSTs. Retry once;
        // a second empty response is almost certainly terminal so we log
        // and continue without indexing.
        console.warn(
          `[ecs] Task Assigned root returned empty messageId for taskId=${task.taskId}; retrying once`,
        );
        teamsResult = await deps.teams.postTaskAssigned(task, undefined, undefined);
      }
      if (teamsResult.messageId) {
        deps.tracker.setTeamsMessage(task.taskId, teamsResult.messageId);
        if (teamsResult.channelId) {
          await deps.callback.reportTeamsThreadCreated({
            agent_task_id: task.taskId,
            teams_thread_id: teamsResult.messageId,
            teams_channel_id: teamsResult.channelId,
          });
        }
      } else {
        console.warn(
          `[ecs] Task Assigned root returned empty messageId after retry for taskId=${task.taskId}; thread will be unindexed until a later activity`,
        );
      }
    }

    return {
      taskId: task.taskId,
      status: "accepted",
      agentSessionKey: sessionKey,
      runId: result.runId,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    await deps.callback.reportError(task.taskId, errorMessage);

    return {
      taskId: task.taskId,
      status: "rejected",
      reason: errorMessage,
    };
  }
}
