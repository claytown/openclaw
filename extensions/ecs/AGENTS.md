# ECS Extension Plugin

Inter-agent task orchestration via Discord with control plane callbacks.

## Build & Deploy

- Build: `pnpm build` from repo root (builds dist/plugin-sdk/ecs.js along with everything else)
- Deploy to miniclaw: `scripts/deploy-miniclaw.sh` (builds, rsyncs, restarts gateway)
- Tests: `pnpm test extensions/ecs`

## Adding a new plugin-sdk subpath (6-place checklist)

When adding a new `openclaw/plugin-sdk/<name>` entry, you must update ALL 6 files or you'll get subtle failures:

| #   | File                           | Array/Section                    | Failure if missing                                        |
| --- | ------------------------------ | -------------------------------- | --------------------------------------------------------- |
| 1   | `src/plugin-sdk/<name>.ts`     | (new file)                       | Nothing to build                                          |
| 2   | `package.json`                 | `exports["./plugin-sdk/<name>"]` | TypeScript can't resolve types                            |
| 3   | `tsconfig.plugin-sdk.dts.json` | `include`                        | No `.d.ts` emitted                                        |
| 4   | `tsdown.config.ts`             | `pluginSdkEntrypoints`           | No `.js` in dist (silent!)                                |
| 5   | `src/plugins/loader.ts`        | `pluginSdkScopedAliasEntries`    | Runtime crash: `Cannot find module root-alias.cjs/<name>` |
| 6   | `vitest.config.ts`             | `pluginSdkSubpaths`              | Tests can't resolve the import                            |

The most dangerous are #4 and #5: missing #4 silently skips the JS build, and missing #5 causes a runtime-only crash (jiti falls through to CJS resolution via `root-alias.cjs` and appends the subpath as a file path).

## Miniclaw Deploy Notes

- Gateway is managed by the Mac app (auto-respawns on kill)
- Real logs: `~/.openclaw/logs/gateway.log` on the openclaw user
- Config: `/Users/openclaw/.openclaw/openclaw.json` — ECS config lives at `plugins.entries.ecs.config`
- After deploy, the deploy script kills the gateway; the Mac app respawns it with the new dist
- If Mac app isn't running, start manually: `sudo su - openclaw -c 'cd /Users/openclaw/projects/openclaw-ecs && node dist/entry.js gateway run --bind loopback --port 18789 --verbose'`

## Architecture

```
ECS Control Plane ──POST /ecs/tasks──> OpenClaw Gateway (ECS Plugin)
       ^                                      │
       │ callbacks                    subagent.run()
       │                                      │
       │                              Subagent Session
       │                              (has 4 ECS tools)
       │                                      │
       └──────────────────────────── Discord Channels
                                    #ecs-status / #ecs-info / #ecs-issues
```

## Key Files

- `index.ts` — plugin registration (hooks, tools, HTTP route)
- `src/task-dispatcher.ts` — dispatches tasks via `api.runtime.subagent.run()`
- `src/tools.ts` — 4 agent tools (status_update, ask_question, raise_issue, set_persona)
- `src/api-handler.ts` — HTTP API handler for /ecs/\* routes
- `src/question-relay.ts` — Discord thread-based Q&A blocking
- `src/discord-channels.ts` — Discord REST client for status/info/issues channels
- `openclaw.plugin.json` — plugin manifest (required for discovery)
