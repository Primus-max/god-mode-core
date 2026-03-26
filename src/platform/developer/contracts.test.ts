import { describe, expect, it } from "vitest";
import { DeveloperRuntimeExecutionPlanSchema, DeveloperRuntimeRequestSchema } from "./contracts.js";
import { DeveloperCredentialBindingSchema, resolveDeveloperCredentialGate } from "./credentials.js";

describe("developer runtime contracts", () => {
  it("accepts a publish-oriented developer runtime request", () => {
    const request = {
      intent: "publish",
      stages: ["analyze", "build", "test", "preview", "publish"],
      publishTargets: ["github", "vercel"],
      requestedArtifacts: ["preview", "binary", "release"],
    };
    expect(DeveloperRuntimeRequestSchema.parse(request)).toEqual(request);
  });

  it("accepts a materialized execution plan for code_build_publish", () => {
    const plan = {
      recipeId: "code_build_publish",
      intent: "publish",
      stages: ["analyze", "build", "test", "preview", "publish"],
      publishTargets: ["github", "npm"],
      requiredApproval: true,
    };
    expect(DeveloperRuntimeExecutionPlanSchema.parse(plan)).toEqual(plan);
  });
});

describe("developer credential bindings", () => {
  it("accepts runtime override bindings backed by secret refs", () => {
    const binding = DeveloperCredentialBindingSchema.parse({
      id: "vercel-preview",
      target: "vercel",
      credentialKind: "deploy_token",
      bindingScope: "runtime_override",
      source: "secret_ref",
      secretRef: {
        source: "env",
        provider: "default",
        id: "VERCEL_TOKEN",
      },
    });
    expect(resolveDeveloperCredentialGate(binding)).toEqual({
      requiresOwnerMutation: false,
      requiresExplicitApproval: true,
      policyIntent: "publish",
      publishTargets: ["vercel"],
    });
  });

  it("requires authProfileId for auth_profile bindings", () => {
    expect(
      DeveloperCredentialBindingSchema.safeParse({
        id: "github-release",
        target: "github",
        credentialKind: "oauth",
        bindingScope: "persistent",
        source: "auth_profile",
      }).success,
    ).toBe(false);
  });

  it("marks persistent bindings as owner-gated mutations", () => {
    const binding = DeveloperCredentialBindingSchema.parse({
      id: "npm-release",
      target: "npm",
      credentialKind: "registry_token",
      bindingScope: "persistent",
      source: "auth_profile",
      authProfileId: "npm-publish",
    });
    expect(resolveDeveloperCredentialGate(binding).requiresOwnerMutation).toBe(true);
  });
});
