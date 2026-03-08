import { createServer, type Server } from "node:http";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { createEcsApiHandler, type EcsApiHandlerDeps } from "../src/api-handler.js";
import { EcsQuestionRelay } from "../src/question-relay.js";
import { EcsTaskTracker } from "../src/task-tracker.js";

function makeDeps(questionRelay: EcsQuestionRelay): EcsApiHandlerDeps {
  return {
    tracker: new EcsTaskTracker(),
    discord: {} as never,
    callback: {
      report: vi.fn().mockResolvedValue({ ok: true }),
      reportError: vi.fn().mockResolvedValue({ ok: true }),
    } as never,
    subagent: {} as never,
    apiConfig: {},
    questionRelay,
  };
}

function makeRelay(): EcsQuestionRelay {
  return new EcsQuestionRelay({
    discord: { postQuestionTimeout: vi.fn() } as never,
    defaultTimeoutMs: 60_000,
    escalateOnTimeout: false,
  });
}

async function request(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: (await resp.json()) as Record<string, unknown> };
}

describe("POST /ecs/questions/:questionId/answer", () => {
  let server: Server;
  let port: number;
  let relay: EcsQuestionRelay;

  beforeAll(async () => {
    relay = makeRelay();
    const handler = createEcsApiHandler(makeDeps(relay));
    server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
  });

  afterAll(() => {
    server.close();
  });

  it("returns 400 when answer_text is missing", async () => {
    const res = await request(port, "/ecs/questions/q-1/answer", {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("answer_text is required");
  });

  it("returns 404 for unknown question ID", async () => {
    const res = await request(port, "/ecs/questions/q-nonexistent/answer", {
      answer_text: "hello",
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("No pending question with that ID");
  });

  it("resolves a pending question and returns 200", async () => {
    // Register a pending question (non-blocking — we'll resolve it via the endpoint).
    const questionPromise = relay.registerPendingQuestion(
      {
        questionId: "q-test-1",
        question: "What is 2+2?",
        taskId: "task-1",
      },
      "thread-abc",
    );

    const res = await request(port, "/ecs/questions/q-test-1/answer", {
      answer_text: "4",
      answered_by: "human-user",
    });

    expect(res.status).toBe(200);
    expect(res.body.questionId).toBe("q-test-1");
    expect(res.body.status).toBe("resolved");

    // The pending promise should now resolve with the answer.
    const result = await questionPromise;
    expect(result.answer).toBe("4");
    expect(result.answeredBy).toBe("human-user");
    expect(result.timedOut).toBe(false);
  });

  it("returns 404 when question is already resolved (idempotent)", async () => {
    // Register and immediately resolve.
    void relay.registerPendingQuestion({ questionId: "q-test-2", question: "x?" }, "thread-def");

    // First answer succeeds.
    const first = await request(port, "/ecs/questions/q-test-2/answer", {
      answer_text: "yes",
    });
    expect(first.status).toBe(200);

    // Second answer for same question returns 404 (already resolved).
    const second = await request(port, "/ecs/questions/q-test-2/answer", {
      answer_text: "no",
    });
    expect(second.status).toBe(404);
  });

  it("defaults answered_by to 'api' when not provided", async () => {
    const questionPromise = relay.registerPendingQuestion(
      { questionId: "q-test-3", question: "default test" },
      "thread-ghi",
    );

    await request(port, "/ecs/questions/q-test-3/answer", {
      answer_text: "answer",
    });

    const result = await questionPromise;
    expect(result.answeredBy).toBe("api");
  });
});
