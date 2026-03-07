import { describe, expect, it, vi } from "vitest";
import {
  buildPersonaSystemPrompt,
  dispatchEcsTask,
  type TaskDispatcherDeps,
} from "../src/task-dispatcher.js";
import type { EcsTask } from "../src/types.js";

vi.mock("../src/persona.js", () => ({
  loadPersonaBootstrapFiles: vi.fn().mockResolvedValue([]),
}));

// Import the mocked module so we can control return values per test.
import { loadPersonaBootstrapFiles } from "../src/persona.js";
const mockLoadFiles = vi.mocked(loadPersonaBootstrapFiles);

function makeTask(overrides?: Partial<EcsTask>): EcsTask {
  return {
    taskId: "task-1",
    title: "Test task",
    description: "Do the thing",
    priority: "medium",
    ...overrides,
  };
}

function makeDeps(): TaskDispatcherDeps & { subagentCalls: Record<string, unknown>[] } {
  const subagentCalls: Record<string, unknown>[] = [];
  return {
    subagentCalls,
    tracker: {
      register: vi.fn(),
      setDiscordThread: vi.fn(),
    } as unknown as TaskDispatcherDeps["tracker"],
    discord: {
      postTaskAssigned: vi.fn().mockResolvedValue({}),
    } as unknown as TaskDispatcherDeps["discord"],
    callback: {
      reportStarted: vi.fn().mockResolvedValue(undefined),
      reportError: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskDispatcherDeps["callback"],
    subagent: {
      run: vi.fn(async (params: Record<string, unknown>) => {
        subagentCalls.push(params);
        return { runId: "run-1" };
      }),
    },
  };
}

describe("buildPersonaSystemPrompt", () => {
  it("returns bare label when persona has no files", async () => {
    mockLoadFiles.mockResolvedValueOnce([]);
    const result = await buildPersonaSystemPrompt("empty-persona");
    expect(result).toBe("Active persona: empty-persona");
  });

  it("formats file contents into a structured prompt", async () => {
    mockLoadFiles.mockResolvedValueOnce([
      {
        name: "IDENTITY.md",
        path: "/p/IDENTITY.md",
        content: "You are a specialist.",
        missing: false,
      },
      { name: "TOOLS.md", path: "/p/TOOLS.md", content: "Use xcode-build.", missing: false },
    ]);

    const result = await buildPersonaSystemPrompt("ios-developer");
    expect(result).toContain("# Persona: ios-developer");
    expect(result).toContain("## IDENTITY.md");
    expect(result).toContain("You are a specialist.");
    expect(result).toContain("## TOOLS.md");
    expect(result).toContain("Use xcode-build.");
    expect(result).toContain("---");
  });

  it("trims whitespace from file contents", async () => {
    mockLoadFiles.mockResolvedValueOnce([
      { name: "SOUL.md", path: "/p/SOUL.md", content: "  padded content  \n\n", missing: false },
    ]);

    const result = await buildPersonaSystemPrompt("trimmed");
    expect(result).toContain("padded content");
    expect(result).not.toContain("  padded content  \n\n");
  });
});

describe("dispatchEcsTask persona injection", () => {
  it("passes extraSystemPrompt with persona file contents", async () => {
    mockLoadFiles.mockResolvedValueOnce([
      { name: "IDENTITY.md", path: "/p/IDENTITY.md", content: "iOS expert", missing: false },
    ]);

    const deps = makeDeps();
    const task = makeTask({ persona: "ios-developer" });
    const ack = await dispatchEcsTask(task, deps);

    expect(ack.status).toBe("accepted");
    expect(deps.subagentCalls).toHaveLength(1);
    const call = deps.subagentCalls[0];
    expect(call.extraSystemPrompt).toContain("# Persona: ios-developer");
    expect(call.extraSystemPrompt).toContain("iOS expert");
  });

  it("passes undefined extraSystemPrompt when no persona", async () => {
    const callsBefore = mockLoadFiles.mock.calls.length;
    const deps = makeDeps();
    const task = makeTask({ persona: undefined });
    await dispatchEcsTask(task, deps);

    expect(deps.subagentCalls).toHaveLength(1);
    expect(deps.subagentCalls[0].extraSystemPrompt).toBeUndefined();
    // loadPersonaBootstrapFiles should not have been called for this dispatch.
    expect(mockLoadFiles.mock.calls.length).toBe(callsBefore);
  });

  it("falls back to bare label when persona dir is empty", async () => {
    mockLoadFiles.mockResolvedValueOnce([]);

    const deps = makeDeps();
    const task = makeTask({ persona: "ghost" });
    await dispatchEcsTask(task, deps);

    expect(deps.subagentCalls).toHaveLength(1);
    expect(deps.subagentCalls[0].extraSystemPrompt).toBe("Active persona: ghost");
  });
});
