/** ECS configuration type and defaults. */

export type EcsDiscordChannelsConfig = {
  /** Discord channel ID for status/progress broadcasts. */
  status: string;
  /** Discord channel ID for blocking Q&A between agents. */
  info: string;
  /** Discord channel ID for issue escalation. */
  issues: string;
};

export type EcsDiscordConfig = {
  /** Discord guild (server) ID hosting the ECS channels. */
  guildId: string;
  /** Channel IDs for the three intent channels. */
  channels: EcsDiscordChannelsConfig;
  /** Pre-mapped project IDs to existing channel IDs (skip auto-creation). */
  projectChannels?: Record<string, EcsDiscordChannelsConfig>;
  /** Max projects with auto-created channels. Default: 100. */
  maxProjectChannels?: number;
};

export type EcsApiConfig = {
  /** Bearer token for authenticating inbound ECS API requests. */
  authToken?: string;
};

export type EcsControlPlaneConfig = {
  /** Base URL of the ECS control plane (Supabase functions or custom API). */
  url?: string;
  /** API key or bearer token for authenticating callbacks to the control plane. */
  apiKey?: string;
};

export type EcsAgentsConfig = {
  /** Interval in seconds for periodic status heartbeats. Default: 30. */
  statusIntervalSec?: number;
  /** Timeout in ms before an unanswered question auto-escalates. Default: 300000. */
  questionTimeoutMs?: number;
  /** If true, unanswered questions escalate to #ecs-issues on timeout. Default: true. */
  questionEscalateOnTimeout?: boolean;
};

export type EcsTeamsConfig = {
  /** Azure AD tenant ID. */
  tenantId: string;
  /** Azure Bot App ID. */
  appId: string;
  /** Azure Bot Client Secret. */
  appPassword: string;
  /** Microsoft Teams team (group) ID. */
  teamId: string;
  /** Bot Framework service URL. */
  serviceUrl: string;
  /** Default pipeline channel ID for non-project messages. */
  defaultChannel: string;
  /** Pre-mapped project IDs to existing Teams channel IDs. */
  projectChannels?: Record<string, string>;
  /** Max projects with auto-created channels. Default: 100. */
  maxProjectChannels?: number;
};

export type EcsConfig = {
  /** Enable the ECS integration. Default: false. */
  enabled?: boolean;
  /** Discord channel configuration for the three intent channels. */
  discord?: EcsDiscordConfig;
  /** Microsoft Teams channel configuration (one channel per project). */
  teams?: EcsTeamsConfig;
  /** API authentication configuration. */
  api?: EcsApiConfig;
  /** ECS control plane connection configuration. */
  controlPlane?: EcsControlPlaneConfig;
  /** Agent behavior configuration. */
  agents?: EcsAgentsConfig;
};

export const ECS_DEFAULTS = {
  statusIntervalSec: 30,
  questionTimeoutMs: 300_000,
  questionEscalateOnTimeout: true,
} as const;

export function resolveEcsAgentsConfig(cfg?: EcsAgentsConfig): Required<EcsAgentsConfig> {
  return {
    statusIntervalSec: cfg?.statusIntervalSec ?? ECS_DEFAULTS.statusIntervalSec,
    questionTimeoutMs: cfg?.questionTimeoutMs ?? ECS_DEFAULTS.questionTimeoutMs,
    questionEscalateOnTimeout:
      cfg?.questionEscalateOnTimeout ?? ECS_DEFAULTS.questionEscalateOnTimeout,
  };
}
