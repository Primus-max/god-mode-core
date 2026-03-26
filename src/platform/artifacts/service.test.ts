import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMaterializationToDescriptor, materializeArtifact } from "../materialization/index.js";
import type { ArtifactDescriptor } from "../schemas/artifact.js";
import {
  getPlatformRuntimeCheckpointService,
  resetPlatformRuntimeCheckpointService,
} from "../runtime/index.js";
import { createArtifactService } from "./service.js";

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-artifact-service-"));
}

function buildDescriptor(overrides: Partial<ArtifactDescriptor> = {}): ArtifactDescriptor {
  return {
    id: "artifact-1",
    kind: "report",
    label: "Artifact 1",
    lifecycle: "draft",
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
    ...overrides,
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  resetPlatformRuntimeCheckpointService();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("artifact service", () => {
  it("persists materialized descriptors and rehydrates them after restart", () => {
    const stateDir = createTempStateDir();
    tempDirs.push(stateDir);
    const service = createArtifactService({
      stateDir,
      gatewayBaseUrl: "http://127.0.0.1:18789",
    });
    const outputDir = service.resolveOutputDir("artifact-preview");
    const registered = service.register(
      applyMaterializationToDescriptor({
        descriptor: buildDescriptor({
          id: "artifact-preview",
          kind: "site",
          label: "Artifact Preview",
          lifecycle: "preview",
        }),
        materialization: materializeArtifact({
          artifactId: "artifact-preview",
          label: "Artifact Preview",
          sourceDomain: "developer",
          renderKind: "site_preview",
          outputTarget: "preview",
          outputDir,
          payload: {
            title: "Artifact Preview",
            markdown: "# Preview",
          },
        }),
      }),
    );

    expect(registered.url).toContain("/platform/artifacts/preview/");
    const record = service.getRecord("artifact-preview");
    expect(record?.access.previewUrl).toBe(registered.url);
    expect(record?.access.contentUrl).toContain("/platform/artifacts/content/");

    const nextService = createArtifactService({
      stateDir,
      gatewayBaseUrl: "http://127.0.0.1:18789",
    });
    expect(nextService.rehydrate()).toBe(1);
    expect(nextService.get("artifact-preview")?.url).toBe(registered.url);
    expect(nextService.getDetail("artifact-preview")).toMatchObject({
      previewUrl: registered.url,
      descriptor: {
        id: "artifact-preview",
      },
    });
  });

  it("persists lifecycle transitions", () => {
    const stateDir = createTempStateDir();
    tempDirs.push(stateDir);
    const service = createArtifactService({
      stateDir,
      gatewayBaseUrl: "http://127.0.0.1:18789",
    });

    service.register(buildDescriptor({ id: "artifact-release", label: "Artifact Release" }));
    const transitioned = service.transition("artifact-release", "publish");

    expect(transitioned).toEqual({
      ok: true,
      descriptor: expect.objectContaining({ lifecycle: "published" }),
    });

    const nextService = createArtifactService({
      stateDir,
      gatewayBaseUrl: "http://127.0.0.1:18789",
    });
    nextService.rehydrate();
    expect(nextService.get("artifact-release")?.lifecycle).toBe("published");
  });

  it("denies publish transitions when the frozen decision posture does not allow publish", () => {
    const stateDir = createTempStateDir();
    tempDirs.push(stateDir);
    const service = createArtifactService({
      stateDir,
      gatewayBaseUrl: "http://127.0.0.1:18789",
    });

    service.register(
      buildDescriptor({
        id: "artifact-report",
        label: "Artifact Report",
        publishTarget: "github",
        metadata: {
          runId: "run-artifact-deny",
          platformExecution: {
            profileId: "developer",
            recipeId: "general_reasoning",
            intent: "general",
          },
        },
      }),
    );

    expect(service.transition("artifact-report", "publish")).toEqual({
      ok: false,
      code: "denied",
      reason: expect.stringContaining("requires publish intent"),
    });
    expect(getPlatformRuntimeCheckpointService().get("artifact-report:publish")).toEqual(
      expect.objectContaining({
        status: "blocked",
        boundary: "artifact_publish",
      }),
    );
  });

  it("skips corrupt persisted records during rehydration", () => {
    const stateDir = createTempStateDir();
    tempDirs.push(stateDir);
    const service = createArtifactService({
      stateDir,
      gatewayBaseUrl: "http://127.0.0.1:18789",
    });
    const artifactDir = service.resolveOutputDir("bad-artifact");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "meta.json"), "{not-json}", "utf8");

    expect(service.rehydrate()).toBe(0);
    expect(service.list()).toEqual([]);
  });
});
