import { afterEach, describe, expect, it } from "vitest";
import {
  __testing,
  clearActivePersona,
  getActivePersona,
  setActivePersona,
} from "../src/persona-registry.js";

describe("persona-registry", () => {
  afterEach(() => {
    __testing.clear();
  });

  it("set and get persona for a session", () => {
    setActivePersona("session-1", "js-dev");
    expect(getActivePersona("session-1")).toBe("js-dev");
  });

  it("returns undefined for unknown session", () => {
    expect(getActivePersona("unknown")).toBeUndefined();
  });

  it("clears persona for a session", () => {
    setActivePersona("session-1", "ios-dev");
    clearActivePersona("session-1");
    expect(getActivePersona("session-1")).toBeUndefined();
  });

  it("tracks multiple sessions independently", () => {
    setActivePersona("session-a", "js-dev");
    setActivePersona("session-b", "ios-dev");
    expect(getActivePersona("session-a")).toBe("js-dev");
    expect(getActivePersona("session-b")).toBe("ios-dev");
  });

  it("overwrites persona for same session", () => {
    setActivePersona("session-1", "js-dev");
    setActivePersona("session-1", "ios-dev");
    expect(getActivePersona("session-1")).toBe("ios-dev");
  });
});
