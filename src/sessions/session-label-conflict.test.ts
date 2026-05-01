import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { classifyLabelConflict } from "./session-label-conflict.js";

const baseEntry = (label: string, updatedAt = 1000): SessionEntry => ({
  sessionId: `sid-${label}`,
  updatedAt,
  label,
});

describe("classifyLabelConflict", () => {
  it("returns none when no entry carries the label", () => {
    const store: Record<string, SessionEntry> = {
      "agent:dev:subagent:aaaa": baseEntry("Alice"),
    };
    const result = classifyLabelConflict({
      store,
      storeKey: "agent:dev:subagent:bbbb",
      label: "Валера",
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("returns none on empty / whitespace label", () => {
    const store: Record<string, SessionEntry> = {
      "agent:dev:subagent:aaaa": baseEntry("Валера"),
    };
    const result = classifyLabelConflict({
      store,
      storeKey: "agent:dev:subagent:bbbb",
      label: "   ",
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("classifies subagent-vs-subagent collision under same agentId as same_logical_session (G3 extension)", () => {
    const store: Record<string, SessionEntry> = {
      "agent:dev:subagent:b857": baseEntry("Валера"),
    };
    const result = classifyLabelConflict({
      store,
      storeKey: "agent:dev:subagent:c123",
      label: "Валера",
    });
    expect(result).toEqual({
      kind: "same_logical_session",
      conflictKey: "agent:dev:subagent:b857",
    });
  });

  it("classifies cross-agentId subagent collision as hard conflict", () => {
    const store: Record<string, SessionEntry> = {
      "agent:other:subagent:b857": baseEntry("Валера"),
    };
    const result = classifyLabelConflict({
      store,
      storeKey: "agent:dev:subagent:c123",
      label: "Валера",
    });
    expect(result).toEqual({
      kind: "conflict",
      conflictKey: "agent:other:subagent:b857",
    });
  });

  it("classifies main-session vs subagent collision as hard conflict (broader scope, never silent)", () => {
    const store: Record<string, SessionEntry> = {
      "agent:dev:main": baseEntry("Валера"),
    };
    const result = classifyLabelConflict({
      store,
      storeKey: "agent:dev:subagent:c123",
      label: "Валера",
    });
    expect(result).toEqual({
      kind: "conflict",
      conflictKey: "agent:dev:main",
    });
  });

  it("ignores own storeKey when scanning the store", () => {
    const store: Record<string, SessionEntry> = {
      "agent:dev:subagent:c123": baseEntry("Валера"),
    };
    const result = classifyLabelConflict({
      store,
      storeKey: "agent:dev:subagent:c123",
      label: "Валера",
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("treats trimmed labels as equal", () => {
    const store: Record<string, SessionEntry> = {
      "agent:dev:subagent:b857": baseEntry("Валера "),
    };
    const result = classifyLabelConflict({
      store,
      storeKey: "agent:dev:subagent:c123",
      label: " Валера",
    });
    expect(result.kind).toBe("same_logical_session");
  });
});
