import { describe, expect, it } from "vitest";
import {
  ActiveProfileStateSchema,
  ProfileIdSchema,
  ProfileSchema,
  ProfileScoringSignalSchema,
  TaskOverlaySchema,
} from "./profile.js";

describe("ProfileIdSchema", () => {
  it("accepts valid profile ids", () => {
    for (const id of [
      "builder",
      "developer",
      "integrator",
      "operator",
      "media_creator",
      "general",
    ]) {
      expect(ProfileIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it("rejects unknown profile ids", () => {
    expect(ProfileIdSchema.safeParse("admin").success).toBe(false);
    expect(ProfileIdSchema.safeParse("").success).toBe(false);
  });
});

describe("ProfileSchema", () => {
  const minimal = { id: "builder", label: "Builder" } as const;

  it("accepts a minimal profile", () => {
    expect(ProfileSchema.parse(minimal)).toEqual(minimal);
  });

  it("accepts a full profile", () => {
    const full = {
      id: "developer",
      label: "Developer",
      description: "Code and deploy specialist",
      defaultModel: "openai/gpt-4o",
      preferredTools: ["exec", "write"],
      preferredPublishTargets: ["github"],
      taskOverlays: [
        {
          id: "media-overlay",
          label: "Media tasks",
          parentProfile: "developer",
          toolHints: ["image-gen"],
        },
      ],
      riskCeiling: "high",
      priority: 10,
    };
    expect(ProfileSchema.parse(full)).toEqual(full);
  });

  it("rejects unknown fields (strict)", () => {
    const result = ProfileSchema.safeParse({ ...minimal, foo: "bar" });
    expect(result.success).toBe(false);
  });

  it("rejects empty label", () => {
    expect(ProfileSchema.safeParse({ id: "builder", label: "" }).success).toBe(false);
  });
});

describe("TaskOverlaySchema", () => {
  it("accepts a valid overlay", () => {
    const overlay = {
      id: "ocr-task",
      label: "OCR extraction",
      parentProfile: "builder",
    };
    expect(TaskOverlaySchema.parse(overlay)).toEqual(overlay);
  });

  it("rejects invalid parentProfile", () => {
    const bad = { id: "x", label: "X", parentProfile: "nonexistent" };
    expect(TaskOverlaySchema.safeParse(bad).success).toBe(false);
  });
});

describe("ProfileScoringSignalSchema", () => {
  it("accepts valid signal", () => {
    const signal = {
      source: "dialogue",
      profileId: "developer",
      weight: 0.8,
      reason: "user mentioned GitHub",
    };
    expect(ProfileScoringSignalSchema.parse(signal)).toEqual(signal);
  });

  it("rejects weight out of range", () => {
    expect(
      ProfileScoringSignalSchema.safeParse({
        source: "file",
        profileId: "builder",
        weight: 1.5,
      }).success,
    ).toBe(false);
  });
});

describe("ActiveProfileStateSchema", () => {
  it("accepts minimal state", () => {
    const state = { baseProfile: "general", confidence: 0.5 };
    expect(ActiveProfileStateSchema.parse(state)).toEqual(state);
  });

  it("accepts full state", () => {
    const state = {
      baseProfile: "builder",
      sessionProfile: "developer",
      taskOverlay: "media-overlay",
      confidence: 0.9,
      signals: [{ source: "channel" as const, profileId: "builder" as const, weight: 0.7 }],
    };
    expect(ActiveProfileStateSchema.parse(state)).toEqual(state);
  });

  it("rejects confidence out of range", () => {
    expect(
      ActiveProfileStateSchema.safeParse({ baseProfile: "general", confidence: -0.1 }).success,
    ).toBe(false);
  });
});
