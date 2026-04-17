/**
 * HTTP client for calling the ECS control plane's agent_task_callback endpoint.
 * Replaces the fragile curl-in-prompt pattern with reliable server-side callbacks.
 */

import type { EcsControlPlaneConfig } from "./config.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type EcsCallbackEvent = "started" | "completed" | "error" | "status";

export type EcsCallbackPayload = {
  agent_task_id: string;
  event: EcsCallbackEvent;
  session_id?: string;
  agent_id?: string;
  result?: { summary: string };
  output?: string;
  error?: string;
  timestamp?: string;
};

export class EcsApiCallback {
  private baseUrl: string;
  private apiKey: string | undefined;

  constructor(config: EcsControlPlaneConfig) {
    this.baseUrl = (config.url ?? "").replace(/\/+$/, "");
    this.apiKey = config.apiKey;
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; status?: number }> {
    const event = typeof body.event === "string" ? body.event : "<none>";
    if (!this.baseUrl) {
      console.info(`[ecs-callback] path=${path} event=${event} status=skip (no baseUrl)`);
      return { ok: false };
    }

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...body,
          timestamp: (body.timestamp as string) ?? new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      // Always log the callback outcome so prod logs can distinguish
      // "OpenClaw never posted" from "control plane rejected" without
      // reading the control-plane side. Include the event name because
      // a single path handles many event types.
      if (resp.ok) {
        console.info(`[ecs-callback] path=${path} event=${event} status=${resp.status}`);
      } else {
        let respBody = "";
        try {
          respBody = (await resp.text()).slice(0, 500);
        } catch {
          // Ignore body-read errors — the status code is still useful.
        }
        console.warn(
          `[ecs-callback] path=${path} event=${event} status=${resp.status} body=${respBody}`,
        );
      }
      return { ok: resp.ok, status: resp.status };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ecs-callback] path=${path} event=${event} status=err err=${msg}`);
      return { ok: false };
    }
  }

  /**
   * Fetch dispatch payloads for tasks the control plane considers active
   * (status in (queued, running) with a non-null dispatch_payload). Used by
   * the plugin on startup to repopulate the in-memory task tracker after a
   * pod restart. Returns [] on any transport/parse failure so callers can
   * treat this as best-effort.
   */
  async fetchActiveTasks(): Promise<Array<Record<string, unknown>>> {
    if (!this.baseUrl) {
      return [];
    }

    const url = `${this.baseUrl}/agent_tasks_active`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    try {
      const resp = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        console.warn(`[ecs] fetchActiveTasks ${url} returned ${resp.status}`);
        return [];
      }
      const parsed = (await resp.json()) as unknown;
      // Accept either a bare array or `{ tasks: [...] }` wrapper so the
      // control-plane implementer has some flexibility.
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is Record<string, unknown> => isRecord(x));
      }
      if (isRecord(parsed) && Array.isArray(parsed.tasks)) {
        return parsed.tasks.filter((x: unknown): x is Record<string, unknown> => isRecord(x));
      }
      return [];
    } catch (err) {
      console.warn(
        `[ecs] fetchActiveTasks ${url} failed:`,
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }

  async report(payload: EcsCallbackPayload): Promise<{ ok: boolean; status?: number }> {
    return this.post("/agent_task_callback", payload);
  }

  async reportStarted(
    agentTaskId: string,
    sessionId?: string,
    agentId?: string,
  ): Promise<{ ok: boolean }> {
    return this.report({
      agent_task_id: agentTaskId,
      event: "started",
      session_id: sessionId,
      agent_id: agentId,
    });
  }

  async reportCompleted(
    agentTaskId: string,
    summary: string,
    opts?: { sessionId?: string; agentId?: string; output?: string },
  ): Promise<{ ok: boolean }> {
    return this.report({
      agent_task_id: agentTaskId,
      event: "completed",
      result: { summary },
      session_id: opts?.sessionId,
      agent_id: opts?.agentId,
      output: opts?.output,
    });
  }

  async reportError(
    agentTaskId: string,
    error: string,
    opts?: { sessionId?: string; agentId?: string },
  ): Promise<{ ok: boolean }> {
    return this.report({
      agent_task_id: agentTaskId,
      event: "error",
      error,
      session_id: opts?.sessionId,
      agent_id: opts?.agentId,
    });
  }

  async reportStatus(
    agentTaskId: string,
    summary: string,
    opts?: { sessionId?: string; agentId?: string; progressPct?: number; details?: string },
  ): Promise<{ ok: boolean }> {
    return this.report({
      agent_task_id: agentTaskId,
      event: "status",
      result: {
        summary,
        ...(opts?.progressPct !== undefined ? { progressPct: opts.progressPct } : {}),
        ...(opts?.details ? { details: opts.details } : {}),
      },
      session_id: opts?.sessionId,
      agent_id: opts?.agentId,
    });
  }

  async reportProjectChannels(payload: {
    project_id: string;
    category_id: string;
    status_channel_id: string;
    info_channel_id: string;
    issues_channel_id: string;
  }): Promise<{ ok: boolean }> {
    return this.post("/agent_project_channels_callback", {
      ...payload,
      event: "channels_provisioned",
    });
  }

  async reportProjectTeamsChannel(payload: {
    project_id: string;
    teams_channel_id: string;
  }): Promise<{ ok: boolean }> {
    return this.post("/agent_project_channels_callback", {
      ...payload,
      event: "teams_channel_provisioned",
    });
  }

  /**
   * Notify the control plane that OpenClaw just created the Teams thread
   * root for a task. Lets the dashboard deep-link to the thread. Fire-and-
   * forget — dispatch still succeeds if the control plane has not yet
   * implemented the handler for this event.
   */
  async reportTeamsThreadCreated(payload: {
    agent_task_id: string;
    teams_thread_id: string;
    teams_channel_id: string;
  }): Promise<{ ok: boolean; status?: number }> {
    return this.post("/agent_task_callback", {
      ...payload,
      event: "teams_thread_created",
    });
  }

  async reportQuestion(payload: {
    question_id: string;
    agent_task_id: string | null;
    question_text: string;
    context: string | null;
    asked_by: string | null;
    discord_thread_id: string;
    discord_channel: string;
  }): Promise<{ ok: boolean }> {
    return this.post("/agent_question_callback", {
      ...payload,
      event: "question_asked",
    });
  }

  /**
   * Persist a forwarded Teams thread reply so it survives even if the
   * in-memory subagent bus never drains it (idle session, between turns,
   * etc.). Paired with checkInbox on the agent side for belt-and-suspenders
   * delivery: every message flows through queueMessage AND lands here.
   */
  async reportUserMessageQueued(payload: {
    agent_task_id: string;
    message_id: string;
    sender: string;
    content: string;
    teams_thread_id: string;
  }): Promise<{ ok: boolean; status?: number }> {
    return this.post("/agent_task_callback", {
      ...payload,
      event: "user_message_queued",
    });
  }

  /**
   * Atomically drain pending_user_messages for a task. Returns {messages:
   * []} on any transport/parse failure so the agent tool call degrades
   * quietly rather than throwing mid-turn.
   */
  async checkInbox(agentTaskId: string): Promise<{
    messages: Array<{ id: string; sender: string; content: string; ts: string }>;
  }> {
    if (!this.baseUrl) {
      return { messages: [] };
    }
    const url = `${this.baseUrl}/check_agent_inbox`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ agent_task_id: agentTaskId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        console.warn(`[ecs] checkInbox ${url} returned ${resp.status}`);
        return { messages: [] };
      }
      const parsed = (await resp.json()) as unknown;
      // Accept { messages: [...] } or a bare array so the control-plane
      // implementer has some flexibility.
      const raw = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.messages)
          ? parsed.messages
          : [];
      const pickString = (v: unknown, fallback: string): string =>
        typeof v === "string" ? v : fallback;
      const messages = raw
        .filter((x: unknown): x is Record<string, unknown> => isRecord(x))
        .map((m) => ({
          id: pickString(m.id, ""),
          sender: pickString(m.sender, "unknown"),
          content: pickString(m.content, ""),
          ts: pickString(m.ts, ""),
        }));
      return { messages };
    } catch (err) {
      console.warn(`[ecs] checkInbox ${url} failed:`, err instanceof Error ? err.message : err);
      return { messages: [] };
    }
  }
}
