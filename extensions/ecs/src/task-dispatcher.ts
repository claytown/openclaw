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
import type { EcsTask, EcsTaskAck } from "./types.js";

export type SubagentRunner = {
  run: (params: {
    sessionKey: string;
    message: string;
    extraSystemPrompt?: string;
    deliver?: boolean;
  }) => Promise<SubagentRunResult>;
};

export type TaskDispatcherDeps = {
  tracker: EcsTaskTracker;
  discord: EcsDiscordChannels;
  callback: EcsApiCallback;
  subagent: SubagentRunner;
};

/**
 * Load persona bootstrap files and format them into a system prompt section.
 * Falls back to a bare label when the persona directory has no files.
 */
export async function buildPersonaSystemPrompt(personaName: string): Promise<string> {
  const files = await loadPersonaBootstrapFiles(personaName);
  if (files.length === 0) return `Active persona: ${personaName}`;

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
    "You have three ECS tools available. Use them throughout your work:",
    "",
    "1. **ecs_status_update** — Post progress updates (non-blocking).",
    '   Call this periodically to report your status (e.g., "running", progress %).',
    "",
    "2. **ecs_ask_question** — Ask a blocking question when you need clarification.",
    "   Your execution will pause until an answer is received.",
    "",
    "3. **ecs_raise_issue** — Escalate a blocker you cannot resolve.",
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

    const result = await deps.subagent.run({
      sessionKey,
      message: prompt,
      extraSystemPrompt,
      deliver: false, // headless, no external delivery
    });

    // Register in tracker.
    deps.tracker.register(task, sessionKey, result.runId, agentId);

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
