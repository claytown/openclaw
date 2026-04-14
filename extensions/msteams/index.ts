import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { setMSTeamsRuntime } from "./runtime-api.js";

export default defineBundledChannelEntry({
  id: "msteams",
  name: "Microsoft Teams",
  description: "Microsoft Teams channel plugin (Bot Framework)",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "msteamsPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  // Set runtime eagerly through the main loader's module graph instead of
  // going through loadBundledEntryExportSync's separate jiti cache (which
  // creates a duplicate module instance in Node 24).
  registerFull(api) {
    setMSTeamsRuntime(api.runtime);
  },
});
