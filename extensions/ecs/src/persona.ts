/**
 * Persona storage & loading: reads named persona directories from the state dir.
 * Each persona is a directory under ~/.openclaw/personas/<name>/ containing
 * workspace doc overrides (SOUL.md, TOOLS.md, AGENTS.md, IDENTITY.md, USER.md).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Recognized bootstrap filenames that personas may override. */
const PERSONA_BOOTSTRAP_NAMES: ReadonlySet<string> = new Set([
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
]);

export type PersonaBootstrapFile = {
  name: string;
  path: string;
  content: string;
  missing: boolean;
};

function resolveStateDir(env?: NodeJS.ProcessEnv): string {
  const e = env ?? process.env;
  return e.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw");
}

export function resolvePersonasBaseDir(env?: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "personas");
}

export function resolvePersonaDir(name: string, env?: NodeJS.ProcessEnv): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
  return path.join(resolvePersonasBaseDir(env), normalized);
}

export async function listPersonas(env?: NodeJS.ProcessEnv): Promise<string[]> {
  const baseDir = resolvePersonasBaseDir(env);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dirPath = path.join(baseDir, entry.name);
    const files = await fs.readdir(dirPath).catch(() => [] as string[]);
    if (files.some((f) => f.endsWith(".md"))) {
      results.push(entry.name);
    }
  }
  return results.toSorted();
}

export async function loadPersonaBootstrapFiles(
  name: string,
  env?: NodeJS.ProcessEnv,
): Promise<PersonaBootstrapFile[]> {
  const dir = resolvePersonaDir(name, env);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const results: PersonaBootstrapFile[] = [];
  for (const file of files) {
    if (!PERSONA_BOOTSTRAP_NAMES.has(file)) {
      continue;
    }
    const filePath = path.join(dir, file);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      results.push({
        name: file,
        path: filePath,
        content,
        missing: false,
      });
    } catch {
      // Skip unreadable files
    }
  }
  return results;
}

export async function validatePersona(
  name: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ valid: boolean; error?: string }> {
  const dir = resolvePersonaDir(name, env);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return { valid: false, error: `Persona directory not found: ${dir}` };
  }

  const hasMd = files.some((f) => PERSONA_BOOTSTRAP_NAMES.has(f));
  if (!hasMd) {
    return {
      valid: false,
      error: `Persona "${name}" has no recognized bootstrap files (${[...PERSONA_BOOTSTRAP_NAMES].join(", ")})`,
    };
  }

  return { valid: true };
}
