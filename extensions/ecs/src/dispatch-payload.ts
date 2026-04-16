/**
 * Shared parser for ECS dispatch payloads. The control plane uses the same
 * body shape for:
 *   - `POST /ecs/tasks` (openclaw receives a dispatch)
 *   - `GET /agent_tasks_active` (openclaw rehydrates active tasks on startup)
 *
 * Keeping this mapping in one place prevents drift between the two codepaths.
 */

import type { EcsTask, EcsTaskPriority } from "./types.js";

function isValidPriority(v: unknown): v is EcsTaskPriority {
  return v === "low" || v === "medium" || v === "high" || v === "critical";
}

/**
 * Map a control-plane dispatch payload to an `EcsTask`. Returns `null` when
 * the payload lacks the fields required to run a task (taskId + title).
 */
export function normalizeDispatchPayload(body: Record<string, unknown>): EcsTask | null {
  const rawTaskId = body.agent_task_id;
  const taskId =
    typeof body.taskId === "string"
      ? body.taskId
      : typeof rawTaskId === "string"
        ? rawTaskId
        : typeof rawTaskId === "number"
          ? String(rawTaskId)
          : "";
  const title = typeof body.title === "string" ? body.title : "";
  const description = typeof body.description === "string" ? body.description : "";

  if (!taskId || !title) {
    return null;
  }

  return {
    taskId,
    epicId: typeof body.epicId === "string" ? body.epicId : undefined,
    projectId: typeof body.projectId === "string" ? body.projectId : undefined,
    title,
    description,
    assignedAgentId: typeof body.assignedAgentId === "string" ? body.assignedAgentId : undefined,
    priority: isValidPriority(body.priority) ? body.priority : "medium",
    deadline: typeof body.deadline === "string" ? body.deadline : undefined,
    metadata:
      typeof body.metadata === "object" && body.metadata !== null
        ? (body.metadata as Record<string, unknown>)
        : undefined,
    persona: typeof body.persona === "string" ? body.persona : undefined,
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
    teamsChannelId: typeof body.teams_channel_id === "string" ? body.teams_channel_id : undefined,
    teamsThreadId: typeof body.teams_thread_id === "string" ? body.teams_thread_id : undefined,
  };
}

export function extractAgentIdOverride(body: Record<string, unknown>): string | undefined {
  return typeof body.agentId === "string" ? body.agentId : undefined;
}
