/**
 * MCP Bridge plugin for OpenClaw.
 *
 * Spawns configured MCP servers via stdio, discovers their tools, and registers
 * them as first-class OpenClaw agent tools with {prefix}__{toolName} naming.
 *
 * Config example (openclaw.json → plugins.entries.mcp-bridge):
 *
 *   {
 *     "servers": {
 *       "mobile-mcp": {
 *         "command": "npx",
 *         "args": ["-y", "@mobilenext/mobile-mcp@latest"],
 *         "toolPrefix": "mobile-mcp"
 *       }
 *     }
 *   }
 */

import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/mcp-bridge";
import type { McpServerConfig, McpServerConnection } from "./src/client.js";
import { connectServer, disconnectServer } from "./src/client.js";
import { buildToolsFromConnections } from "./src/tools.js";

type McpBridgeConfig = {
  servers?: Record<string, McpServerConfig>;
};

const plugin = {
  id: "mcp-bridge",
  name: "MCP Bridge",
  description:
    "Spawns MCP servers via stdio and exposes their tools as native OpenClaw agent tools.",

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as McpBridgeConfig;
    const serverEntries = Object.entries(cfg.servers ?? {});

    if (serverEntries.length === 0) {
      api.logger.info("mcp-bridge: no servers configured, skipping");
      return;
    }

    // Shared state populated by the service, consumed by the tool factory.
    const connections: McpServerConnection[] = [];
    let discoveredTools: AnyAgentTool[] = [];

    // Register a tool factory that returns discovered MCP tools.
    // The factory is synchronous — it returns whatever tools have been discovered
    // by the time an agent session starts. The service (below) populates them.
    api.registerTool(() => discoveredTools);

    // Service lifecycle: connect to MCP servers on start, disconnect on stop.
    api.registerService({
      id: "mcp-bridge",

      start: async () => {
        api.logger.info(`mcp-bridge: connecting to ${serverEntries.length} MCP server(s)...`);

        const results = await Promise.allSettled(
          serverEntries.map(([key, config]) => connectServer(key, config, api.logger)),
        );

        for (const result of results) {
          if (result.status === "fulfilled") {
            connections.push(result.value);
          } else {
            api.logger.warn(`mcp-bridge: server failed to connect: ${result.reason}`);
          }
        }

        // Build tools from all successful connections.
        discoveredTools = buildToolsFromConnections(connections, api.logger);

        const totalTools = discoveredTools.length;
        const totalServers = connections.length;
        api.logger.info(
          `mcp-bridge: registered ${totalTools} tools from ${totalServers} MCP server(s)`,
        );
      },

      stop: async () => {
        api.logger.info("mcp-bridge: shutting down MCP servers...");
        await Promise.allSettled(connections.map((conn) => disconnectServer(conn, api.logger)));
        connections.length = 0;
        discoveredTools = [];
      },
    });
  },
};

export default plugin;
