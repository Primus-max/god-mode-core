import { describe, expect, it } from "vitest";
import { ArtifactDescriptorSchema, ArtifactOperationSchema } from "./artifact.js";

describe("ArtifactDescriptorSchema", () => {
  const minimal = {
    id: "doc-1",
    kind: "document",
    label: "Project Estimate",
    lifecycle: "draft",
  } as const;

  it("accepts a minimal artifact", () => {
    expect(ArtifactDescriptorSchema.parse(minimal)).toEqual(minimal);
  });

  it("accepts a full artifact", () => {
    const full = {
      id: "release-42",
      kind: "release",
      label: "v1.0.0 Release",
      lifecycle: "published",
      version: 3,
      mimeType: "application/zip",
      sizeBytes: 1024000,
      path: "/dist/release-42.zip",
      url: "https://example.com/releases/42",
      createdAt: "2026-03-23T12:00:00.000Z",
      updatedAt: "2026-03-23T14:00:00.000Z",
      sourceRecipeId: "code_build_publish",
      publishTarget: "github",
      metadata: { commitSha: "abc123", branch: "main" },
    };
    expect(ArtifactDescriptorSchema.parse(full)).toEqual(full);
  });

  it("rejects unknown kind", () => {
    expect(
      ArtifactDescriptorSchema.safeParse({ ...minimal, kind: "spreadsheet" }).success,
    ).toBe(false);
  });

  it("rejects invalid lifecycle", () => {
    expect(
      ArtifactDescriptorSchema.safeParse({ ...minimal, lifecycle: "pending" }).success,
    ).toBe(false);
  });

  it("rejects invalid url", () => {
    expect(
      ArtifactDescriptorSchema.safeParse({ ...minimal, url: "not-a-url" }).success,
    ).toBe(false);
  });

  it("rejects negative sizeBytes", () => {
    expect(
      ArtifactDescriptorSchema.safeParse({ ...minimal, sizeBytes: -1 }).success,
    ).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      ArtifactDescriptorSchema.safeParse({ ...minimal, bonus: true }).success,
    ).toBe(false);
  });
});

describe("ArtifactOperationSchema", () => {
  it("accepts all valid operations", () => {
    for (const op of ["create", "update", "version", "preview", "publish", "approve", "retain", "delete"]) {
      expect(ArtifactOperationSchema.safeParse(op).success).toBe(true);
    }
  });

  it("rejects unknown operation", () => {
    expect(ArtifactOperationSchema.safeParse("rollback").success).toBe(false);
  });
});
