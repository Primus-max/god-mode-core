import { describe, expect, it } from "vitest";
import type { TaskCapabilityId } from "./capability-catalog.js";
import {
  TASK_TOOL_REGISTRY,
  deriveRequestedTools,
  listToolsForCapability,
} from "./tool-registry.js";

function caps(ids: TaskCapabilityId[]): Set<TaskCapabilityId> {
  return new Set(ids);
}

describe("tool registry", () => {
  it("registers each tool name only once", () => {
    const names = TASK_TOOL_REGISTRY.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("describes tools in abstract terms (no vendor branding)", () => {
    for (const entry of TASK_TOOL_REGISTRY) {
      expect(entry.intent).not.toMatch(/openai|anthropic|playwright|chromium/i);
    }
  });

  it("returns the tools that satisfy a capability", () => {
    expect(listToolsForCapability("needs_repo_execution").map((entry) => entry.name)).toEqual([
      "exec",
    ]);
    expect(
      listToolsForCapability("needs_visual_composition").map((entry) => entry.name),
    ).toEqual(["image_generate"]);
  });
});

describe("deriveRequestedTools", () => {
  it("derives exec from needs_repo_execution and apply_patch from needs_workspace_mutation", () => {
    expect(
      deriveRequestedTools({
        capabilities: caps(["needs_repo_execution", "needs_workspace_mutation"]),
        deliverable: { kind: "code_change", acceptedFormats: ["patch"] },
      }),
    ).toEqual(["exec", "apply_patch"]);
  });

  it("suppresses apply_patch when the deliverable is a repo_operation", () => {
    // The classifier may still emit needs_workspace_mutation alongside a
    // repo_operation deliverable; the registry guard keeps the requested-tools
    // bridge from forcing apply_patch onto a `git commit` / `run tests` flow.
    expect(
      deriveRequestedTools({
        capabilities: caps(["needs_workspace_mutation", "needs_repo_execution"]),
        deliverable: { kind: "repo_operation", acceptedFormats: ["exec"] },
      }),
    ).toEqual(["exec"]);
  });

  it("derives image_generate for both visual and multimodal authoring intents", () => {
    expect(
      deriveRequestedTools({
        capabilities: caps(["needs_visual_composition"]),
        deliverable: { kind: "image", acceptedFormats: ["png"] },
      }),
    ).toEqual(["image_generate"]);
    expect(
      deriveRequestedTools({
        capabilities: caps(["needs_multimodal_authoring"]),
        deliverable: { kind: "document", acceptedFormats: ["pdf"] },
      }),
    ).toEqual(["image_generate", "pdf"]);
  });

  it("appends producer-resolved tools for the deliverable", () => {
    expect(
      deriveRequestedTools({
        capabilities: caps([]),
        deliverable: { kind: "data", acceptedFormats: ["xlsx"], preferredFormat: "xlsx" },
      }),
    ).toEqual(["xlsx_write"]);
  });

  it("appends the constraints.tool escape hatch (cron/reminder flow)", () => {
    expect(
      deriveRequestedTools({
        capabilities: caps([]),
        deliverable: {
          kind: "answer",
          acceptedFormats: ["text"],
          constraints: { tool: "cron" },
        },
      }),
    ).toEqual(["cron"]);
  });

  it("deduplicates a tool requested via both capability and producer", () => {
    expect(
      deriveRequestedTools({
        capabilities: caps(["needs_workspace_mutation"]),
        deliverable: { kind: "code_change", acceptedFormats: ["patch", "edit"] },
      }),
    ).toEqual(["apply_patch"]);
  });

  it("returns an empty list when nothing requests a tool", () => {
    expect(
      deriveRequestedTools({
        capabilities: caps([]),
        deliverable: { kind: "answer", acceptedFormats: ["text"] },
      }),
    ).toEqual([]);
  });
});
