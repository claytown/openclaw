import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listPersonas,
  loadPersonaBootstrapFiles,
  resolvePersonaDir,
  resolvePersonasBaseDir,
  validatePersona,
} from "../src/persona.js";

describe("persona", () => {
  let tmpHome: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-persona-test-"));
    const stateDir = path.join(tmpHome, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    env = { OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  describe("resolvePersonasBaseDir", () => {
    it("returns personas dir under state dir", () => {
      const base = resolvePersonasBaseDir(env);
      expect(base).toBe(path.join(tmpHome, ".openclaw", "personas"));
    });
  });

  describe("resolvePersonaDir", () => {
    it("normalizes persona name", () => {
      const dir = resolvePersonaDir("iOS Developer!", env);
      expect(path.basename(dir)).toBe("ios-developer-");
    });
  });

  describe("listPersonas", () => {
    it("returns empty array when no personas dir", async () => {
      const result = await listPersonas(env);
      expect(result).toEqual([]);
    });

    it("lists directories with .md files", async () => {
      const baseDir = resolvePersonasBaseDir(env);
      const personaDir = path.join(baseDir, "js-dev");
      await fs.mkdir(personaDir, { recursive: true });
      await fs.writeFile(path.join(personaDir, "SOUL.md"), "You are a JS dev.");

      // Create a dir without .md files (should be excluded)
      const emptyDir = path.join(baseDir, "empty");
      await fs.mkdir(emptyDir, { recursive: true });
      await fs.writeFile(path.join(emptyDir, "notes.txt"), "not a persona");

      const result = await listPersonas(env);
      expect(result).toEqual(["js-dev"]);
    });
  });

  describe("loadPersonaBootstrapFiles", () => {
    it("loads recognized .md files from persona dir", async () => {
      const personaDir = resolvePersonaDir("test-persona", env);
      await fs.mkdir(personaDir, { recursive: true });
      await fs.writeFile(path.join(personaDir, "SOUL.md"), "soul content");
      await fs.writeFile(path.join(personaDir, "TOOLS.md"), "tools content");
      // Non-recognized file should be ignored
      await fs.writeFile(path.join(personaDir, "NOTES.md"), "ignored");

      const files = await loadPersonaBootstrapFiles("test-persona", env);
      expect(files).toHaveLength(2);
      expect(files.map((f) => f.name).toSorted()).toEqual(["SOUL.md", "TOOLS.md"]);
      expect(files.find((f) => f.name === "SOUL.md")?.content).toBe("soul content");
      expect(files.every((f) => !f.missing)).toBe(true);
    });

    it("returns empty array for missing persona", async () => {
      const files = await loadPersonaBootstrapFiles("nonexistent", env);
      expect(files).toEqual([]);
    });
  });

  describe("validatePersona", () => {
    it("returns valid for persona with recognized files", async () => {
      const personaDir = resolvePersonaDir("valid-persona", env);
      await fs.mkdir(personaDir, { recursive: true });
      await fs.writeFile(path.join(personaDir, "AGENTS.md"), "agents");

      const result = await validatePersona("valid-persona", env);
      expect(result).toEqual({ valid: true });
    });

    it("returns invalid for missing directory", async () => {
      const result = await validatePersona("missing", env);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("returns invalid for dir without recognized .md files", async () => {
      const personaDir = resolvePersonaDir("no-md", env);
      await fs.mkdir(personaDir, { recursive: true });
      await fs.writeFile(path.join(personaDir, "README.md"), "not recognized");

      const result = await validatePersona("no-md", env);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("no recognized bootstrap files");
    });
  });
});
