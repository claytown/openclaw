/**
 * Auto-provisions per-project Teams channels for ECS task routing.
 * One standard channel per project (all team members have access via RSC).
 * Falls back to default channel on error or when no projectId is provided.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOGIN_BASE = "https://login.microsoftonline.com";
const GRAPH_API = "https://graph.microsoft.com/v1.0";
const DEFAULT_PERSIST_PATH = join(homedir(), ".openclaw", "ecs", "teams-project-channels.json");
const DEFAULT_MAX_PROJECTS = 100;

type TeamsCreds = {
  tenantId: string;
  appId: string;
  appPassword: string;
};

type PersistedData = {
  projects: Record<string, { channelId: string; createdAt: number }>;
};

// --- Graph API token (separate from Bot Framework token in teams-channels.ts) ---

let graphToken: string | null = null;
let graphTokenExpiresAt = 0;

async function getGraphToken(creds: TeamsCreds): Promise<string> {
  const now = Date.now();
  if (graphToken && now < graphTokenExpiresAt) return graphToken;

  const body = new URLSearchParams({
    client_id: creds.appId,
    client_secret: creds.appPassword,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const res = await fetch(`${LOGIN_BASE}/${creds.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    body,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Graph token failed ${res.status}: ${text}`);

  const json = JSON.parse(text);
  graphToken = json.access_token as string;
  graphTokenExpiresAt = now + (json.expires_in as number) * 1000 - 100_000;
  return graphToken;
}

function slugify(projectId: string): string {
  return projectId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export class TeamsProjectChannelManager {
  private creds: TeamsCreds;
  private teamId: string;
  private persistPath: string;
  private maxProjects: number;
  private projects = new Map<string, string>(); // projectId → channelId
  private inflight = new Map<string, Promise<string | null>>();
  private log: (msg: string) => void;
  private onProvisioned?: (projectId: string, channelId: string) => void;

  constructor(
    creds: TeamsCreds,
    teamId: string,
    opts?: {
      persistPath?: string;
      maxProjects?: number;
      log?: (msg: string) => void;
      onProvisioned?: (projectId: string, channelId: string) => void;
    },
  ) {
    this.creds = creds;
    this.teamId = teamId;
    this.persistPath = opts?.persistPath ?? DEFAULT_PERSIST_PATH;
    this.maxProjects = opts?.maxProjects ?? DEFAULT_MAX_PROJECTS;
    this.log = opts?.log ?? (() => {});
    this.onProvisioned = opts?.onProvisioned;
  }

  load(): void {
    if (!existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, "utf-8");
      const data = JSON.parse(raw) as PersistedData;
      for (const [pid, entry] of Object.entries(data.projects)) {
        this.projects.set(pid, entry.channelId);
      }
      this.log(`[ecs-teams] loaded ${this.projects.size} project channels from disk`);
    } catch (err) {
      this.log(
        `[ecs-teams] corrupted persist file, starting fresh: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private save(): void {
    const data: PersistedData = { projects: {} };
    for (const [pid, channelId] of this.projects) {
      data.projects[pid] = { channelId, createdAt: Date.now() };
    }
    const dir = dirname(this.persistPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
  }

  async resolveChannel(projectId: string): Promise<string | null> {
    const cached = this.projects.get(projectId);
    if (cached) return cached;

    // Dedup concurrent provisions.
    const existing = this.inflight.get(projectId);
    if (existing) return existing;

    const promise = this.provision(projectId);
    this.inflight.set(projectId, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(projectId);
    }
  }

  private async provision(projectId: string): Promise<string | null> {
    if (this.projects.size >= this.maxProjects) {
      this.log(`[ecs-teams] max projects (${this.maxProjects}) reached, using default`);
      return null;
    }

    try {
      const token = await getGraphToken(this.creds);
      const slug = slugify(projectId);
      const displayName = `ecs-${slug}`;

      const res = await fetch(`${GRAPH_API}/teams/${this.teamId}/channels`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName,
          description: `ECS venture channel: ${projectId}`,
          membershipType: "standard",
        }),
      });

      const text = await res.text();
      if (!res.ok) {
        this.log(`[ecs-teams] channel creation failed ${res.status}: ${text}`);
        return null;
      }

      const channel = JSON.parse(text) as { id: string };
      this.projects.set(projectId, channel.id);
      this.save();
      this.log(`[ecs-teams] provisioned channel "${displayName}" → ${channel.id}`);

      if (this.onProvisioned) {
        this.onProvisioned(projectId, channel.id);
      }

      return channel.id;
    } catch (err) {
      this.log(`[ecs-teams] provision failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  getChannelIds(): Set<string> {
    return new Set(this.projects.values());
  }
}
