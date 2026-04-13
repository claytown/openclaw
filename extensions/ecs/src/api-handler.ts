/**
 * HTTP endpoints for the ECS API, registered via registerHttpRoute().
 * - POST /ecs/tasks — Assign a new task
 * - GET /ecs/tasks/:taskId/status — Poll task status
 * - POST /ecs/tasks/:taskId/cancel — Cancel a running task
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EcsApiConfig } from "./config.js";
import type { ProjectChannelManager } from "./project-channel-manager.js";
import type { EcsQuestionRelay } from "./question-relay.js";
import { dispatchEcsTask, type TaskDispatcherDeps } from "./task-dispatcher.js";
import type { EcsTaskTracker } from "./task-tracker.js";
import type { EcsTask } from "./types.js";

/** Constant-time secret comparison (inlined to avoid core dependency). */
function safeEqualSecret(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(provided), hash(expected));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parsePathParams(url: string): {
  route: string;
  taskId?: string;
  projectId?: string;
  questionId?: string;
} {
  // /ecs/projects — list projects
  if (url === "/ecs/projects") {
    return { route: "projects" };
  }
  // /ecs/projects/:projectId/archive — archive project channels
  const projMatch = url.match(/^\/ecs\/projects\/([^/]+)\/archive$/);
  if (projMatch) {
    return { route: "project-archive", projectId: projMatch[1] };
  }
  // /ecs/questions/:questionId/answer — answer a pending question
  const questionMatch = url.match(/^\/ecs\/questions\/([^/]+)\/answer$/);
  if (questionMatch) {
    return { route: "question-answer", questionId: questionMatch[1] };
  }
  // /ecs/tasks, /ecs/tasks/:taskId/status, /ecs/tasks/:taskId/cancel
  const match = url.match(/^\/ecs\/tasks(?:\/([^/]+)(?:\/(status|cancel))?)?$/);
  if (!match) {
    return { route: "unknown" };
  }
  if (!match[1]) {
    return { route: "tasks" };
  }
  return { route: match[2] ?? "task", taskId: match[1] };
}

export type EcsApiHandlerDeps = TaskDispatcherDeps & {
  tracker: EcsTaskTracker;
  apiConfig: EcsApiConfig;
  projectManager?: ProjectChannelManager;
  questionRelay?: EcsQuestionRelay;
};

export function createEcsApiHandler(deps: EcsApiHandlerDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // Auth check: all ECS API requests require a valid Bearer token.
    if (deps.apiConfig.authToken) {
      const authHeader = req.headers.authorization ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!safeEqualSecret(token, deps.apiConfig.authToken)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
    }

    const { route, taskId, projectId, questionId } = parsePathParams(url);

    if (route === "tasks" && method === "POST") {
      await handleAssignTask(req, res, deps);
    } else if (route === "status" && taskId && method === "GET") {
      handleGetStatus(res, deps.tracker, taskId);
    } else if (route === "cancel" && taskId && method === "POST") {
      await handleCancelTask(res, deps, taskId);
    } else if (route === "projects" && method === "GET") {
      handleListProjects(res, deps);
    } else if (route === "project-archive" && projectId && method === "POST") {
      await handleArchiveProject(res, deps, projectId);
    } else if (route === "question-answer" && questionId && method === "POST") {
      await handleAnswerQuestion(req, res, questionId, deps);
    } else {
      sendJson(res, 404, { error: "Not found" });
    }
  };
}

async function handleAssignTask(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EcsApiHandlerDeps,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  // Validate required fields.
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
    sendJson(res, 400, { error: "taskId and title are required" });
    return;
  }

  const task: EcsTask = {
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
  };

  const ack = await dispatchEcsTask(task, deps, {
    agentId: typeof body.agentId === "string" ? body.agentId : undefined,
  });

  const status = ack.status === "accepted" ? 200 : 400;
  sendJson(res, status, ack);
}

function handleGetStatus(res: ServerResponse, tracker: EcsTaskTracker, taskId: string): void {
  const active = tracker.getByTaskId(taskId);
  if (!active) {
    sendJson(res, 404, { error: "Task not found", taskId });
    return;
  }

  sendJson(res, 200, {
    taskId,
    status: active.status,
    agentId: active.agentId,
    sessionKey: active.sessionKey,
    runId: active.runId,
    startedAt: active.startedAt,
    lastStatusUpdate: active.lastStatusUpdate,
    discordThreadId: active.discordThreadId,
  });
}

async function handleCancelTask(
  res: ServerResponse,
  deps: EcsApiHandlerDeps,
  taskId: string,
): Promise<void> {
  const active = deps.tracker.getByTaskId(taskId);
  if (!active) {
    sendJson(res, 404, { error: "Task not found", taskId });
    return;
  }

  deps.tracker.updateStatus(taskId, "error");
  deps.tracker.remove(taskId);

  // Report cancellation to ECS control plane.
  await deps.callback.reportError(taskId, "Task cancelled via API");

  // Echo to Discord.
  await deps.discord.postTaskCompleted(
    {
      taskId,
      agentId: active.agentId,
      status: "cancelled",
      summary: "Task was cancelled via API.",
      durationMs: Date.now() - active.startedAt,
    },
    active.task.projectId,
  );

  sendJson(res, 200, { taskId, status: "cancelled" });
}

function handleListProjects(res: ServerResponse, deps: EcsApiHandlerDeps): void {
  if (!deps.projectManager) {
    sendJson(res, 200, { projects: [] });
    return;
  }
  sendJson(res, 200, { projects: deps.projectManager.listProjects() });
}

async function handleArchiveProject(
  res: ServerResponse,
  deps: EcsApiHandlerDeps,
  projectId: string,
): Promise<void> {
  if (!deps.projectManager) {
    sendJson(res, 404, { error: "Project channel management not enabled" });
    return;
  }
  const archived = await deps.projectManager.archiveProject(projectId);
  if (!archived) {
    sendJson(res, 404, { error: "Project not found", projectId });
    return;
  }
  sendJson(res, 200, { projectId, archived: true });
}

async function handleAnswerQuestion(
  req: IncomingMessage,
  res: ServerResponse,
  questionId: string,
  deps: EcsApiHandlerDeps,
): Promise<void> {
  if (!deps.questionRelay) {
    sendJson(res, 404, { error: "Question relay not configured" });
    return;
  }

  let body: Record<string, unknown>;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const answerText = typeof body.answer_text === "string" ? body.answer_text : "";
  const answeredBy = typeof body.answered_by === "string" ? body.answered_by : "api";

  if (!answerText) {
    sendJson(res, 400, { error: "answer_text is required" });
    return;
  }

  const threadId = deps.questionRelay.getThreadIdByQuestionId(questionId);
  if (!threadId) {
    sendJson(res, 404, { error: "No pending question with that ID" });
    return;
  }

  const resolved = deps.questionRelay.resolveQuestion(threadId, answerText, answeredBy);
  if (!resolved) {
    sendJson(res, 404, { error: "Question already resolved or expired" });
    return;
  }

  sendJson(res, 200, { questionId, status: "resolved" });
}

function isValidPriority(v: unknown): v is "low" | "medium" | "high" | "critical" {
  return v === "low" || v === "medium" || v === "high" || v === "critical";
}
