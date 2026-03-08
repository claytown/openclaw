import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EcsDiscordChannelsConfig } from "../src/config.js";
import { ProjectChannelManager } from "../src/project-channel-manager.js";

const defaultChannels: EcsDiscordChannelsConfig = {
  status: "default-status-id",
  info: "default-info-id",
  issues: "default-issues-id",
};

let tmpDir: string;
let persistPath: string;
let postCalls: { route: string; body: Record<string, unknown> }[];
let mockRest: { post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> };

function makeMockRest() {
  let channelCounter = 0;
  postCalls = [];

  const post = vi.fn(async (route: string, opts: { body: Record<string, unknown> }) => {
    postCalls.push({ route, body: opts.body });
    channelCounter++;
    return { id: `ch-${channelCounter}` };
  });

  const patch = vi.fn(async () => ({}));

  return { post, patch } as unknown as {
    post: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
  };
}

function makeManager(opts?: {
  maxProjects?: number;
  projectChannels?: Record<string, EcsDiscordChannelsConfig>;
  onProjectProvisioned?: (
    channelSet: import("../src/project-channel-manager.js").ProjectChannelSet,
  ) => void;
}) {
  return new ProjectChannelManager(mockRest as never, "guild-1", defaultChannels, {
    persistPath,
    maxProjects: opts?.maxProjects,
    projectChannels: opts?.projectChannels,
    onProjectProvisioned: opts?.onProjectProvisioned,
    log: () => {},
  });
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `ecs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  persistPath = join(tmpDir, "project-channels.json");
  mockRest = makeMockRest();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ProjectChannelManager", () => {
  describe("resolveChannels", () => {
    it("returns default channels when no projectId", async () => {
      const manager = makeManager();
      const result = await manager.resolveChannels();
      expect(result).toEqual(defaultChannels);
    });

    it("returns default channels for undefined projectId", async () => {
      const manager = makeManager();
      const result = await manager.resolveChannels(undefined);
      expect(result).toEqual(defaultChannels);
    });

    it("returns config overrides when present", async () => {
      const override: EcsDiscordChannelsConfig = {
        status: "override-status",
        info: "override-info",
        issues: "override-issues",
      };
      const manager = makeManager({ projectChannels: { "my-project": override } });
      const result = await manager.resolveChannels("my-project");
      expect(result).toEqual(override);
      // No Discord API calls should be made.
      expect(mockRest.post).not.toHaveBeenCalled();
    });

    it("provisions new channels for unknown project", async () => {
      const manager = makeManager();
      const result = await manager.resolveChannels("alpha");

      // Should have created 1 category + 3 text channels = 4 API calls.
      expect(mockRest.post).toHaveBeenCalledTimes(4);

      // Category call.
      expect(postCalls[0].body).toEqual({
        name: "ECS: alpha",
        type: 4, // GuildCategory
      });

      // Text channels under the category.
      expect(postCalls[1].body).toEqual({
        name: "ecs-alpha-status",
        type: 0,
        parent_id: "ch-1", // category ID
      });
      expect(postCalls[2].body).toEqual({
        name: "ecs-alpha-info",
        type: 0,
        parent_id: "ch-1",
      });
      expect(postCalls[3].body).toEqual({
        name: "ecs-alpha-issues",
        type: 0,
        parent_id: "ch-1",
      });

      expect(result).toEqual({
        status: "ch-2",
        info: "ch-3",
        issues: "ch-4",
      });
    });

    it("reuses cached channels on second call", async () => {
      const manager = makeManager();
      const first = await manager.resolveChannels("alpha");
      const second = await manager.resolveChannels("alpha");

      expect(first).toEqual(second);
      // Only 4 calls total (no extra provisioning).
      expect(mockRest.post).toHaveBeenCalledTimes(4);
    });
  });

  describe("concurrency dedup", () => {
    it("deduplicates concurrent provisions for the same project", async () => {
      const manager = makeManager();
      const [r1, r2] = await Promise.all([
        manager.resolveChannels("beta"),
        manager.resolveChannels("beta"),
      ]);

      expect(r1).toEqual(r2);
      // Should still be only 4 API calls (one provision).
      expect(mockRest.post).toHaveBeenCalledTimes(4);
    });

    it("provisions separately for different projects", async () => {
      const manager = makeManager();
      const [r1, r2] = await Promise.all([
        manager.resolveChannels("alpha"),
        manager.resolveChannels("beta"),
      ]);

      expect(r1).not.toEqual(r2);
      // 4 calls per project = 8 total.
      expect(mockRest.post).toHaveBeenCalledTimes(8);
    });
  });

  describe("limit enforcement", () => {
    it("falls back to defaults when limit is reached", async () => {
      const manager = makeManager({ maxProjects: 1 });

      // First project succeeds.
      const first = await manager.resolveChannels("alpha");
      expect(first.status).toBe("ch-2");

      // Second project hits the limit — falls back to defaults.
      const second = await manager.resolveChannels("beta");
      expect(second).toEqual(defaultChannels);
      // Only 4 API calls from the first project.
      expect(mockRest.post).toHaveBeenCalledTimes(4);
    });
  });

  describe("persistence", () => {
    it("writes to disk after provisioning", async () => {
      const manager = makeManager();
      await manager.resolveChannels("alpha");

      expect(existsSync(persistPath)).toBe(true);
      const data = JSON.parse(readFileSync(persistPath, "utf8"));
      expect(data.projects.alpha).toBeDefined();
      expect(data.projects.alpha.categoryId).toBe("ch-1");
      expect(data.projects.alpha.statusChannelId).toBe("ch-2");
    });

    it("loads persisted data on startup", async () => {
      // Write persisted data.
      const dir = join(tmpDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        persistPath,
        JSON.stringify({
          projects: {
            "saved-proj": {
              projectId: "saved-proj",
              categoryId: "cat-1",
              statusChannelId: "s-1",
              infoChannelId: "i-1",
              issuesChannelId: "iss-1",
              createdAt: 1000,
            },
          },
        }),
      );

      const manager = makeManager();
      manager.load();

      const result = await manager.resolveChannels("saved-proj");
      expect(result).toEqual({ status: "s-1", info: "i-1", issues: "iss-1" });
      // No API calls — loaded from disk.
      expect(mockRest.post).not.toHaveBeenCalled();
    });

    it("handles corrupted JSON gracefully", () => {
      writeFileSync(persistPath, "not-json{{{");
      const manager = makeManager();
      // Should not throw.
      manager.load();
      expect(manager.listProjects()).toEqual([]);
    });

    it("handles missing file gracefully", () => {
      const manager = makeManager();
      manager.load();
      expect(manager.listProjects()).toEqual([]);
    });
  });

  describe("error handling", () => {
    it("falls back to defaults on 403", async () => {
      const err = new Error("Forbidden") as Error & { status: number };
      err.status = 403;
      mockRest.post.mockRejectedValueOnce(err);

      const manager = makeManager();
      const result = await manager.resolveChannels("locked-project");
      expect(result).toEqual(defaultChannels);
    });

    it("falls back to defaults on generic error", async () => {
      mockRest.post.mockRejectedValueOnce(new Error("Network error"));

      const manager = makeManager();
      const result = await manager.resolveChannels("broken-project");
      expect(result).toEqual(defaultChannels);
    });
  });

  describe("slugify", () => {
    it("handles special characters in project names", async () => {
      const manager = makeManager();
      await manager.resolveChannels("My Cool Project! v2.0");

      // Check the category name and slugified channel name.
      expect(postCalls[0].body.name).toBe("ECS: My Cool Project! v2.0");
      expect(postCalls[1].body.name).toBe("ecs-my-cool-project-v2-0-status");
    });
  });

  describe("archiveProject", () => {
    it("renames channels and removes from memory", async () => {
      const manager = makeManager();
      await manager.resolveChannels("alpha");
      expect(manager.listProjects()).toHaveLength(1);

      const archived = await manager.archiveProject("alpha");
      expect(archived).toBe(true);
      expect(manager.listProjects()).toHaveLength(0);

      // Patch calls for 3 channels + 1 category = 4 calls.
      expect(mockRest.patch).toHaveBeenCalledTimes(4);
    });

    it("returns false for unknown project", async () => {
      const manager = makeManager();
      const result = await manager.archiveProject("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("onProjectProvisioned callback", () => {
    it("fires after successful provisioning with the correct channel set", async () => {
      const cb = vi.fn();
      const manager = makeManager({ onProjectProvisioned: cb });
      await manager.resolveChannels("alpha");

      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith({
        projectId: "alpha",
        categoryId: "ch-1",
        statusChannelId: "ch-2",
        infoChannelId: "ch-3",
        issuesChannelId: "ch-4",
        createdAt: expect.any(Number),
      });
    });

    it("does not fire when provisioning fails", async () => {
      mockRest.post.mockRejectedValueOnce(new Error("boom"));
      const cb = vi.fn();
      const manager = makeManager({ onProjectProvisioned: cb });
      await manager.resolveChannels("broken");

      expect(cb).not.toHaveBeenCalled();
    });

    it("provisioning succeeds even if callback throws", async () => {
      const cb = vi.fn(() => {
        throw new Error("callback exploded");
      });
      const manager = makeManager({ onProjectProvisioned: cb });
      const result = await manager.resolveChannels("alpha");

      expect(cb).toHaveBeenCalledOnce();
      expect(result).toEqual({
        status: "ch-2",
        info: "ch-3",
        issues: "ch-4",
      });
    });
  });

  describe("getProjectChannelIds", () => {
    it("returns all provisioned channel IDs", async () => {
      const manager = makeManager();
      await manager.resolveChannels("alpha");

      const ids = manager.getProjectChannelIds();
      expect(ids.size).toBe(3);
      expect(ids.has("ch-2")).toBe(true); // status
      expect(ids.has("ch-3")).toBe(true); // info
      expect(ids.has("ch-4")).toBe(true); // issues
    });

    it("returns empty set when no projects provisioned", () => {
      const manager = makeManager();
      expect(manager.getProjectChannelIds().size).toBe(0);
    });
  });
});
