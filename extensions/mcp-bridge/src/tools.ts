/**
 * Convert discovered MCP tools into OpenClaw agent tool definitions.
 */

import type { AnyAgentTool, PluginLogger } from "openclaw/plugin-sdk/mcp-bridge";
import { jsonResult } from "openclaw/plugin-sdk/mcp-bridge";
import type { McpServerConnection, McpToolInfo } from "./client.js";
import { callTool } from "./client.js";

/**
 * Build a single OpenClaw tool from an MCP tool descriptor.
 *
 * The inputSchema from the MCP server is passed directly as the TypeBox-compatible
 * `parameters` object. OpenClaw's agent runtime accepts raw JSON Schema here.
 */
function createMcpTool(
  conn: McpServerConnection,
  tool: McpToolInfo,
  logger: PluginLogger,
): AnyAgentTool {
  return {
    label: `MCP/${conn.prefix}`,
    name: tool.qualifiedName,
    description: tool.description,
    parameters: tool.inputSchema as AnyAgentTool["parameters"],
    execute: async (_toolCallId: string, args: unknown) => {
      const params = (args ?? {}) as Record<string, unknown>;
      try {
        const result = await callTool(conn, tool.name, params);
        return jsonResult({ success: true, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`mcp-bridge: tool ${tool.qualifiedName} failed: ${message}`);
        return jsonResult({ success: false, error: message });
      }
    },
  };
}

/**
 * Build all OpenClaw tools from a set of MCP server connections.
 */
export function buildToolsFromConnections(
  connections: McpServerConnection[],
  logger: PluginLogger,
): AnyAgentTool[] {
  const tools: AnyAgentTool[] = [];
  for (const conn of connections) {
    for (const tool of conn.tools) {
      tools.push(createMcpTool(conn, tool, logger));
    }
  }
  return tools;
}
