/**
 * HTTP client for calling the ECS control plane's agent_task_callback endpoint.
 * Replaces the fragile curl-in-prompt pattern with reliable server-side callbacks.
 */

import type { EcsControlPlaneConfig } from "./config.js";

export type EcsCallbackEvent = "started" | "completed" | "error" | "status" | "message";

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
    if (!this.baseUrl) {
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
      return { ok: resp.ok, status: resp.status };
    } catch (err) {
      console.warn(`[ecs] callback to ${url} failed:`, err instanceof Error ? err.message : err);
      return { ok: false };
    }
  }

  async report(payload: EcsCallbackPayload): Promise<{ ok: boolean; status?: number }> {
    return this.post("/agent_task_callback", payload);
  }

  async reportMessage(msg: {
    channel_id: string;
    direction: "inbound" | "outbound";
    author?: string;
    content?: string;
    embed_title?: string;
  }): Promise<{ ok: boolean; status?: number }> {
    return this.post("/agent_message_callback", {
      event: "message" as const,
      ...msg,
    });
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
    opts?: { sessionId?: string; agentId?: string },
  ): Promise<{ ok: boolean }> {
    return this.report({
      agent_task_id: agentTaskId,
      event: "status",
      result: { summary },
      session_id: opts?.sessionId,
      agent_id: opts?.agentId,
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
}
