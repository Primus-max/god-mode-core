import { describe, expect, it } from "vitest";
import type { ArtifactDescriptor } from "../schemas/artifact.js";
import type { CapabilityDescriptor } from "../schemas/capability.js";
import type { Profile } from "../schemas/profile.js";
import type { ExecutionRecipe } from "../schemas/recipe.js";
import { createArtifactStore } from "./artifact-store.js";
import { createCapabilityRegistry } from "./capability-registry.js";
import { createProfileRegistry } from "./profile-registry.js";
import { createRecipeRegistry } from "./recipe-registry.js";

const builderProfile: Profile = {
  id: "builder",
  label: "Builder",
  description: "Document and estimate specialist",
  riskCeiling: "medium",
};

const devProfile: Profile = {
  id: "developer",
  label: "Developer",
  preferredTools: ["exec", "write"],
};

const generalReasoning: ExecutionRecipe = {
  id: "general_reasoning",
  purpose: "General-purpose chat",
  acceptedInputs: [{ type: "text" }],
  riskLevel: "none",
};

const codeBuild: ExecutionRecipe = {
  id: "code_build_publish",
  purpose: "Build and publish code",
  acceptedInputs: [{ type: "text", required: true }],
  requiredCapabilities: ["node", "git"],
  allowedProfiles: ["developer"],
  riskLevel: "high",
};

const nodeCapability: CapabilityDescriptor = {
  id: "node",
  label: "Node.js",
  status: "available",
  trusted: true,
};

const gitCapability: CapabilityDescriptor = {
  id: "git",
  label: "Git",
  status: "available",
  trusted: true,
};

const missingCapability: CapabilityDescriptor = {
  id: "ollama",
  label: "Ollama",
  status: "missing",
  trusted: true,
};

const draftDoc: ArtifactDescriptor = {
  id: "doc-1",
  kind: "document",
  label: "Estimate v1",
  lifecycle: "draft",
};

describe("ProfileRegistry contract", () => {
  it("registers and retrieves profiles", () => {
    const reg = createProfileRegistry();
    reg.register(builderProfile);
    expect(reg.get("builder")).toEqual(builderProfile);
    expect(reg.get("developer")).toBeUndefined();
  });

  it("initializes with seed profiles", () => {
    const reg = createProfileRegistry([builderProfile, devProfile]);
    expect(reg.list()).toHaveLength(2);
  });

  it("overwrites on re-registration", () => {
    const reg = createProfileRegistry([builderProfile]);
    const updated = { ...builderProfile, description: "Updated" };
    reg.register(updated);
    expect(reg.get("builder")?.description).toBe("Updated");
    expect(reg.list()).toHaveLength(1);
  });

  it("rejects invalid profiles at registration", () => {
    const reg = createProfileRegistry();
    expect(() => reg.register({ id: "invalid" } as unknown as Profile)).toThrow();
  });
});

describe("RecipeRegistry contract", () => {
  it("registers and retrieves recipes", () => {
    const reg = createRecipeRegistry();
    reg.register(generalReasoning);
    expect(reg.get("general_reasoning")).toEqual(generalReasoning);
  });

  it("finds recipes by capability", () => {
    const reg = createRecipeRegistry([generalReasoning, codeBuild]);
    expect(reg.findByCapability("node")).toEqual([codeBuild]);
    expect(reg.findByCapability("unknown")).toEqual([]);
  });

  it("finds recipes by profile — unrestricted recipes match any profile", () => {
    const reg = createRecipeRegistry([generalReasoning, codeBuild]);
    const devRecipes = reg.findByProfile("developer");
    expect(devRecipes).toContainEqual(generalReasoning);
    expect(devRecipes).toContainEqual(codeBuild);
  });

  it("filters recipes by profile — restricted recipes excluded", () => {
    const reg = createRecipeRegistry([generalReasoning, codeBuild]);
    const builderRecipes = reg.findByProfile("builder");
    expect(builderRecipes).toContainEqual(generalReasoning);
    expect(builderRecipes).not.toContainEqual(codeBuild);
  });

  it("rejects invalid recipes at registration", () => {
    const reg = createRecipeRegistry();
    expect(() => reg.register({ id: "bad" } as ExecutionRecipe)).toThrow();
  });
});

describe("CapabilityRegistry contract", () => {
  it("registers and lists capabilities", () => {
    const reg = createCapabilityRegistry([nodeCapability, gitCapability, missingCapability]);
    expect(reg.list()).toHaveLength(3);
  });

  it("filters available vs missing", () => {
    const reg = createCapabilityRegistry([nodeCapability, gitCapability, missingCapability]);
    expect(reg.available()).toHaveLength(2);
    expect(reg.missing()).toHaveLength(1);
    expect(reg.missing()[0]?.id).toBe("ollama");
  });

  it("overwrites on re-registration", () => {
    const reg = createCapabilityRegistry([missingCapability]);
    reg.register({ ...missingCapability, status: "available" });
    expect(reg.available()).toHaveLength(1);
    expect(reg.missing()).toHaveLength(0);
  });
});

describe("ArtifactStore contract", () => {
  it("creates and retrieves artifacts", () => {
    const store = createArtifactStore();
    store.create(draftDoc);
    expect(store.get("doc-1")).toEqual(draftDoc);
  });

  it("updates artifact fields", () => {
    const store = createArtifactStore([draftDoc]);
    const updated = store.update("doc-1", { label: "Estimate v2" });
    expect(updated?.label).toBe("Estimate v2");
    expect(updated?.lifecycle).toBe("draft");
  });

  it("returns undefined when updating nonexistent artifact", () => {
    const store = createArtifactStore();
    expect(store.update("missing", { label: "x" })).toBeUndefined();
  });

  it("transitions lifecycle on publish", () => {
    const store = createArtifactStore([draftDoc]);
    const published = store.transition("doc-1", "publish");
    expect(published?.lifecycle).toBe("published");
  });

  it("transitions lifecycle on approve", () => {
    const store = createArtifactStore([draftDoc]);
    store.transition("doc-1", "publish");
    const approved = store.transition("doc-1", "approve");
    expect(approved?.lifecycle).toBe("approved");
  });

  it("transitions lifecycle on delete", () => {
    const store = createArtifactStore([draftDoc]);
    const deleted = store.transition("doc-1", "delete");
    expect(deleted?.lifecycle).toBe("deleted");
  });

  it("noop operations preserve current state", () => {
    const store = createArtifactStore([draftDoc]);
    const same = store.transition("doc-1", "update");
    expect(same?.lifecycle).toBe("draft");
  });

  it("returns undefined when transitioning nonexistent artifact", () => {
    const store = createArtifactStore();
    expect(store.transition("missing", "publish")).toBeUndefined();
  });

  it("lists all artifacts", () => {
    const store = createArtifactStore([draftDoc]);
    expect(store.list()).toHaveLength(1);
  });
});
