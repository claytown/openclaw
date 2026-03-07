// Narrow plugin-sdk surface for the ECS extension plugin.
// Keep this list additive and scoped to symbols used under extensions/ecs.

export type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  PluginLogger,
} from "../plugins/types.js";
export type { SubagentRunResult } from "../plugins/runtime/types.js";
export { jsonResult, readStringParam } from "../agents/tools/common.js";
export { stringEnum } from "../agents/schema/typebox.js";
