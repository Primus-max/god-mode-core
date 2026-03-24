import { describe, expect, it } from "vitest";
import type { Profile } from "./profile.js";
import type { ExecutionRecipe } from "./recipe.js";
import type { CapabilityDescriptor } from "./capability.js";
import type { ArtifactDescriptor } from "./artifact.js";
import {
  ProfileSchema,
  ExecutionRecipeSchema,
  CapabilityDescriptorSchema,
  ArtifactDescriptorSchema,
} from "./index.js";

const BASELINE_PROFILES: Profile[] = [
  {
    id: "builder",
    label: "Builder",
    description: "Document, estimate, and structured output specialist",
    riskCeiling: "medium",
    preferredTools: ["read", "write", "edit"],
    preferredPublishTargets: ["pdf", "email"],
  },
  {
    id: "developer",
    label: "Developer",
    description: "Code, build, test, and deploy specialist",
    riskCeiling: "high",
    preferredTools: ["exec", "write", "edit", "process"],
    preferredPublishTargets: ["github", "npm"],
  },
  {
    id: "integrator",
    label: "Integrator",
    description: "API, webhook, and system integration specialist",
    riskCeiling: "medium",
    preferredTools: ["exec", "read", "write"],
  },
  {
    id: "operator",
    label: "Operator",
    description: "Infrastructure and operations specialist",
    riskCeiling: "high",
    preferredTools: ["exec", "process"],
  },
  {
    id: "media_creator",
    label: "Media Creator",
    description: "Image, video, and audio generation specialist",
    riskCeiling: "low",
    preferredTools: ["canvas", "browser"],
  },
  {
    id: "general",
    label: "General",
    description: "General-purpose assistant for chat and reasoning",
    riskCeiling: "low",
    priority: 0,
  },
];

const BASELINE_RECIPES: ExecutionRecipe[] = [
  {
    id: "general_reasoning",
    purpose: "General-purpose chat and reasoning",
    acceptedInputs: [{ type: "text" }],
    riskLevel: "none",
  },
  {
    id: "doc_ingest",
    purpose: "Ingest, parse, and extract structured data from documents",
    acceptedInputs: [
      { type: "file", required: true, description: "Document to process" },
      { type: "text", description: "Extraction instructions" },
    ],
    producedArtifacts: [{ type: "data", description: "Extracted structured data" }],
    requiredCapabilities: ["pdf-parser"],
    riskLevel: "low",
  },
  {
    id: "code_build_publish",
    purpose: "Build, test, and publish code artifacts",
    acceptedInputs: [{ type: "text", required: true }],
    producedArtifacts: [
      { type: "binary", description: "Built artifact" },
      { type: "release", description: "Published release" },
    ],
    requiredCapabilities: ["node", "git"],
    allowedProfiles: ["developer", "integrator"],
    riskLevel: "high",
    publishTargets: ["github", "npm"],
  },
];

const BASELINE_CAPABILITIES: CapabilityDescriptor[] = [
  { id: "node", label: "Node.js", status: "available", trusted: true },
  { id: "git", label: "Git", status: "available", trusted: true },
  { id: "pdf-parser", label: "PDF Parser", status: "missing", trusted: true, installMethod: "node" },
];

const BASELINE_ARTIFACTS: ArtifactDescriptor[] = [
  { id: "example-doc", kind: "document", label: "Example Document", lifecycle: "draft" },
  { id: "example-release", kind: "release", label: "Example Release", lifecycle: "published", version: 1 },
];

describe("baseline profile descriptors", () => {
  it.each(BASELINE_PROFILES)("$id validates against ProfileSchema", (profile) => {
    expect(ProfileSchema.parse(profile)).toEqual(profile);
  });

  it("snapshot: baseline profile set", () => {
    expect(BASELINE_PROFILES.map((p) => p.id)).toMatchInlineSnapshot(`
      [
        "builder",
        "developer",
        "integrator",
        "operator",
        "media_creator",
        "general",
      ]
    `);
  });
});

describe("baseline recipe descriptors", () => {
  it.each(BASELINE_RECIPES)("$id validates against ExecutionRecipeSchema", (recipe) => {
    expect(ExecutionRecipeSchema.parse(recipe)).toEqual(recipe);
  });

  it("snapshot: baseline recipe set", () => {
    expect(BASELINE_RECIPES.map((r) => r.id)).toMatchInlineSnapshot(`
      [
        "general_reasoning",
        "doc_ingest",
        "code_build_publish",
      ]
    `);
  });
});

describe("baseline capability descriptors", () => {
  it.each(BASELINE_CAPABILITIES)("$id validates against CapabilityDescriptorSchema", (cap) => {
    expect(CapabilityDescriptorSchema.parse(cap)).toEqual(cap);
  });

  it("snapshot: baseline capability set", () => {
    expect(BASELINE_CAPABILITIES.map((c) => `${c.id}:${c.status}`)).toMatchInlineSnapshot(`
      [
        "node:available",
        "git:available",
        "pdf-parser:missing",
      ]
    `);
  });
});

describe("baseline artifact descriptors", () => {
  it.each(BASELINE_ARTIFACTS)("$id validates against ArtifactDescriptorSchema", (art) => {
    expect(ArtifactDescriptorSchema.parse(art)).toEqual(art);
  });

  it("snapshot: baseline artifact set", () => {
    expect(BASELINE_ARTIFACTS.map((a) => `${a.id}:${a.lifecycle}`)).toMatchInlineSnapshot(`
      [
        "example-doc:draft",
        "example-release:published",
      ]
    `);
  });
});
