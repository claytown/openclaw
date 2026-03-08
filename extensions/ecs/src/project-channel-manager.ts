/**
 * Auto-provisions per-project Discord categories + channels for ECS task routing.
 * Falls back to shared defaults on error or when no projectId is provided.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RequestClient } from "@buape/carbon";
import type { EcsDiscordChannelsConfig } from "./config.js";

export type ProjectChannelSet = {
  projectId: string;
  categoryId: string;
  statusChannelId: string;
  infoChannelId: string;
  issuesChannelId: string;
  createdAt: number;
};

type PersistedData = {
  projects: Record<string, ProjectChannelSet>;
};

const DEFAULT_PERSIST_PATH = join(homedir(), ".openclaw", "ecs", "project-channels.json");
const DEFAULT_MAX_PROJECTS = 100;

// Discord channel types.
const GUILD_CATEGORY = 4;
const GUILD_TEXT = 0;

/** Slugify a project ID for Discord channel names. */
function slugify(projectId: string): string {
  return projectId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export class ProjectChannelManager {
  private rest: RequestClient;
  private guildId: string;
  private defaultChannels: EcsDiscordChannelsConfig;
  private persistPath: string;
  private maxProjects: number;
  private configOverrides: Record<string, EcsDiscordChannelsConfig>;

  private projects = new Map<string, ProjectChannelSet>();
  /** Dedup in-flight provisions: projectId → pending promise. */
  private inflight = new Map<string, Promise<ProjectChannelSet | null>>();

  private log: (msg: string) => void;
  private onProjectProvisioned?: (channelSet: ProjectChannelSet) => void;

  constructor(
    rest: RequestClient,
    guildId: string,
    defaultChannels: EcsDiscordChannelsConfig,
    opts?: {
      persistPath?: string;
      maxProjects?: number;
      projectChannels?: Record<string, EcsDiscordChannelsConfig>;
      log?: (msg: string) => void;
      onProjectProvisioned?: (channelSet: ProjectChannelSet) => void;
    },
  ) {
    this.rest = rest;
    this.guildId = guildId;
    this.defaultChannels = defaultChannels;
    this.persistPath = opts?.persistPath ?? DEFAULT_PERSIST_PATH;
    this.maxProjects = opts?.maxProjects ?? DEFAULT_MAX_PROJECTS;
    this.configOverrides = opts?.projectChannels ?? {};
    this.log = opts?.log ?? (() => {});
    this.onProjectProvisioned = opts?.onProjectProvisioned;
  }

  /** Load persisted project-channel mappings from disk. */
  load(): void {
    try {
      if (!existsSync(this.persistPath)) return;
      const raw = readFileSync(this.persistPath, "utf8");
      const data = JSON.parse(raw) as PersistedData;
      if (data.projects && typeof data.projects === "object") {
        for (const [id, set] of Object.entries(data.projects)) {
          this.projects.set(id, set);
        }
      }
      this.log(`[ecs] loaded ${this.projects.size} project channel mappings`);
    } catch {
      // Corrupted JSON or read error — start fresh.
      this.log("[ecs] project-channels.json corrupted or unreadable, starting fresh");
    }
  }

  /** Main routing: resolve channel IDs for a given projectId. */
  async resolveChannels(projectId?: string): Promise<EcsDiscordChannelsConfig> {
    if (!projectId) return this.defaultChannels;

    // Config-level overrides take priority.
    const override = this.configOverrides[projectId];
    if (override) return override;

    // Already provisioned?
    const existing = this.projects.get(projectId);
    if (existing) {
      return {
        status: existing.statusChannelId,
        info: existing.infoChannelId,
        issues: existing.issuesChannelId,
      };
    }

    // Provision new channels.
    const result = await this.provisionProject(projectId);
    if (!result) return this.defaultChannels;

    return {
      status: result.statusChannelId,
      info: result.infoChannelId,
      issues: result.issuesChannelId,
    };
  }

  /** Deduped provisioning — concurrent callers for the same projectId share one promise. */
  private provisionProject(projectId: string): Promise<ProjectChannelSet | null> {
    const existing = this.inflight.get(projectId);
    if (existing) return existing;

    const promise = this.doProvision(projectId).finally(() => {
      this.inflight.delete(projectId);
    });
    this.inflight.set(projectId, promise);
    return promise;
  }

  private async doProvision(projectId: string): Promise<ProjectChannelSet | null> {
    if (this.projects.size >= this.maxProjects) {
      this.log(
        `[ecs] project channel limit (${this.maxProjects}) reached, using defaults for ${projectId}`,
      );
      return null;
    }

    const slug = slugify(projectId);
    const route = `/guilds/${this.guildId}/channels`;

    try {
      // Create category.
      const category = (await this.rest.post(route, {
        body: { name: `ECS: ${projectId}`, type: GUILD_CATEGORY },
      })) as { id: string };

      // Create 3 text channels under the category.
      const [statusCh, infoCh, issuesCh] = (await Promise.all([
        this.rest.post(route, {
          body: { name: `ecs-${slug}-status`, type: GUILD_TEXT, parent_id: category.id },
        }),
        this.rest.post(route, {
          body: { name: `ecs-${slug}-info`, type: GUILD_TEXT, parent_id: category.id },
        }),
        this.rest.post(route, {
          body: { name: `ecs-${slug}-issues`, type: GUILD_TEXT, parent_id: category.id },
        }),
      ])) as [{ id: string }, { id: string }, { id: string }];

      const channelSet: ProjectChannelSet = {
        projectId,
        categoryId: category.id,
        statusChannelId: statusCh.id,
        infoChannelId: infoCh.id,
        issuesChannelId: issuesCh.id,
        createdAt: Date.now(),
      };

      this.projects.set(projectId, channelSet);
      this.persist();
      try {
        this.onProjectProvisioned?.(channelSet);
      } catch (cbErr) {
        this.log(`[ecs] onProjectProvisioned callback error: ${cbErr}`);
      }

      this.log(
        `[ecs] provisioned Discord channels for project "${projectId}" (category ${category.id})`,
      );
      return channelSet;
    } catch (err: unknown) {
      // 403 = missing Manage Channels permission.
      const status = (err as { status?: number }).status;
      if (status === 403) {
        this.log(
          "[ecs] 403: bot lacks Manage Channels permission — falling back to default channels",
        );
      } else {
        this.log(`[ecs] failed to provision channels for "${projectId}": ${err}`);
      }
      return null;
    }
  }

  /** Archive a project's channels (rename with [archived] prefix). */
  async archiveProject(projectId: string): Promise<boolean> {
    const set = this.projects.get(projectId);
    if (!set) return false;

    const channelIds = [set.statusChannelId, set.infoChannelId, set.issuesChannelId];
    try {
      await Promise.all(
        channelIds.map((id) =>
          this.rest.patch(`/channels/${id}`, {
            body: { name: `archived-${id}` },
          }),
        ),
      );
      // Also rename category.
      await this.rest.patch(`/channels/${set.categoryId}`, {
        body: { name: `[Archived] ECS: ${projectId}` },
      });
    } catch (err) {
      this.log(`[ecs] failed to archive channels for "${projectId}": ${err}`);
    }

    this.projects.delete(projectId);
    this.persist();
    return true;
  }

  /** All known project channel IDs (for isEcsChannel checks). */
  getProjectChannelIds(): Set<string> {
    const ids = new Set<string>();
    for (const set of this.projects.values()) {
      ids.add(set.statusChannelId);
      ids.add(set.infoChannelId);
      ids.add(set.issuesChannelId);
    }
    return ids;
  }

  /** List all provisioned project mappings. */
  listProjects(): ProjectChannelSet[] {
    return [...this.projects.values()];
  }

  private persist(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data: PersistedData = {
        projects: Object.fromEntries(this.projects),
      };
      const tmpPath = this.persistPath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      renameSync(tmpPath, this.persistPath);
    } catch (err) {
      this.log(`[ecs] failed to persist project channels: ${err}`);
    }
  }
}
