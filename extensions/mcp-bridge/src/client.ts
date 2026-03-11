/**
 * MCP client wrapper: spawns an MCP server via stdio, discovers tools, and
 * proxies tool calls through the MCP protocol.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { PluginLogger } from "openclaw/plugin-sdk/mcp-bridge";

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  toolPrefix?: string;
  connectTimeoutMs?: number;
};

export type McpToolInfo = {
  /** Original tool name from the MCP server. */
  name: string;
  /** Prefixed tool name for OpenClaw registration. */
  qualifiedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpServerConnection = {
  serverKey: string;
  prefix: string;
  client: Client;
  transport: StdioClientTransport;
  tools: McpToolInfo[];
};

const DEFAULT_CONNECT_TIMEOUT = 30_000;

export async function connectServer(
  serverKey: string,
  config: McpServerConfig,
  logger: PluginLogger,
): Promise<McpServerConnection> {
  const prefix = config.toolPrefix ?? serverKey;
  const timeout = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;

  const client = new Client({ name: `openclaw-mcp-bridge/${serverKey}`, version: "1.0.0" });

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
  });

  // Connect with timeout.
  const connectPromise = client.connect(transport);
  const timer = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`MCP server "${serverKey}" connect timed out after ${timeout}ms`)),
      timeout,
    ),
  );
  await Promise.race([connectPromise, timer]);

  // Discover tools.
  const response = await client.listTools();
  const tools: McpToolInfo[] = (response.tools ?? []).map((t) => ({
    name: t.name,
    qualifiedName: `${prefix}__${t.name}`,
    description: t.description ?? `MCP tool ${t.name} from ${serverKey}`,
    inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
  }));

  logger.info(`mcp-bridge: registered ${tools.length} tools from server "${serverKey}"`);

  return { serverKey, prefix, client, transport, tools };
}

export async function callTool(
  conn: McpServerConnection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await conn.client.callTool({ name: toolName, arguments: args });

  // Handle error responses.
  if ("isError" in result && result.isError) {
    const text = extractText(result);
    throw new Error(text || "MCP tool call failed");
  }

  return extractText(result);
}

function extractText(result: unknown): string {
  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray((result as Record<string, unknown>).content)
  ) {
    const content = (result as Record<string, unknown>).content as Array<Record<string, unknown>>;
    return content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
  }
  return JSON.stringify(result);
}

export async function disconnectServer(
  conn: McpServerConnection,
  logger: PluginLogger,
): Promise<void> {
  try {
    await conn.transport.close();
  } catch (err) {
    logger.warn(`mcp-bridge: error closing server "${conn.serverKey}": ${err}`);
  }
}
