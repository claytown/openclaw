// Narrow plugin-sdk surface for the MCP bridge extension plugin.
// Keep this list additive and scoped to symbols used under extensions/mcp-bridge.

export type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  PluginLogger,
} from "../plugins/types.js";
export { jsonResult } from "../agents/tools/common.js";
