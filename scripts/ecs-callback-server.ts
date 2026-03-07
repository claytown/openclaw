/**
 * Simple ECS callback listener.
 * Receives task status updates from miniclaw's OpenClaw gateway.
 *
 * Usage: npx tsx scripts/ecs-callback-server.ts
 * Listens on port 18800 by default.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.ECS_CALLBACK_PORT ?? 18800);
const SECRET =
  process.env.OPENCLAW_CALLBACK_SECRET ??
  "4215429347a2403618f0893f0057c480f6a726ea736ef62e54b825faadf60a50";

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/agent_task_callback") {
    // Auth check
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (token !== SECRET) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    // Log the callback
    const timestamp = new Date().toISOString();
    const event = body.event ?? "unknown";
    const taskId = body.agent_task_id ?? "?";
    const summary = body.result?.summary ?? body.error ?? body.output ?? "";

    console.log(`\n[${timestamp}] ECS Callback: ${event.toUpperCase()}`);
    console.log(`  Task: ${taskId}`);
    if (body.agent_id) {
      console.log(`  Agent: ${body.agent_id}`);
    }
    if (body.session_id) {
      console.log(`  Session: ${body.session_id}`);
    }
    if (summary) {
      console.log(`  Detail: ${summary}`);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ECS callback server listening on http://0.0.0.0:${PORT}/agent_task_callback`);
  console.log(`Waiting for callbacks from miniclaw...`);
});
