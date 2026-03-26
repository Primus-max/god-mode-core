import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifactService, resetPlatformArtifactService } from "../artifacts/index.js";
import {
  captureDeveloperArtifactsFromLlmOutput,
  extractDeveloperArtifactPayloads,
  projectDeveloperArtifacts,
  resetCapturedDeveloperArtifacts,
  listCapturedDeveloperArtifacts,
} from "./index.js";

function readFixture(name: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, "__fixtures__", name), "utf8");
}

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dev-artifacts-"));
}

describe("developer artifact projection", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    resetCapturedDeveloperArtifacts();
    resetPlatformArtifactService();
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("extracts preview and release payloads from route-aware envelopes", () => {
    const previewPayloads = extractDeveloperArtifactPayloads([
      readFixture("preview-envelope.json"),
    ]);
    const releasePayloads = extractDeveloperArtifactPayloads([
      readFixture("release-envelope.json"),
    ]);
    const directPayloads = extractDeveloperArtifactPayloads([
      '{"type":"binary","label":"CLI bundle","path":"dist/openclaw.tgz"}',
    ]);

    expect(previewPayloads).toMatchObject([{ type: "preview", target: "vercel" }]);
    expect(releasePayloads).toMatchObject([{ type: "release", target: "github" }]);
    expect(directPayloads).toMatchObject([{ type: "binary", label: "CLI bundle" }]);
  });

  it("projects preview and release payloads into common artifact descriptors", () => {
    const stateDir = createTempStateDir();
    tempDirs.push(stateDir);
    const artifactService = createArtifactService({
      stateDir,
      gatewayBaseUrl: "http://127.0.0.1:18789",
    });
    const artifacts = projectDeveloperArtifacts({
      sessionId: "session-1",
      runId: "run-1",
      payloads: [
        ...extractDeveloperArtifactPayloads([readFixture("preview-envelope.json")]),
        ...extractDeveloperArtifactPayloads([readFixture("release-envelope.json")]),
      ],
      artifactService,
    });

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toMatchObject({
      kind: "site",
      lifecycle: "preview",
      publishTarget: "vercel",
      url: "https://preview.example.com/build-42",
    });
    expect(artifacts[0]?.path?.endsWith(".html")).toBe(true);
    expect(artifactService.get("session-1:run-1:developer:1")?.metadata).toMatchObject({
      materialization: {
        primary: expect.objectContaining({
          url: expect.stringContaining("/platform/artifacts/preview/"),
        }),
      },
    });
    expect(artifacts[1]).toMatchObject({
      kind: "release",
      lifecycle: "published",
      publishTarget: "github",
      url: "https://github.com/openclaw/openclaw/releases/tag/v1.4.2",
    });
    expect(artifacts[1]?.path?.endsWith(".html")).toBe(true);
    expect(artifacts[1]?.metadata).toMatchObject({
      developerArtifactType: "release",
      stage: "publish",
      materialization: {
        primary: expect.objectContaining({
          renderKind: "html",
        }),
      },
    });
  });

  it("preserves legacy projection when materialization is disabled", () => {
    const artifacts = projectDeveloperArtifacts({
      sessionId: "session-legacy",
      runId: "run-legacy",
      payloads: extractDeveloperArtifactPayloads([readFixture("release-envelope.json")]),
      materialize: false,
    });

    expect(artifacts[0]).toMatchObject({
      kind: "release",
      path: undefined,
      url: "https://github.com/openclaw/openclaw/releases/tag/v1.4.2",
    });
    expect(artifacts[0]?.metadata).not.toHaveProperty("materialization");
  });

  it("captures only publish recipe outputs into the developer artifact store", () => {
    const stateDir = createTempStateDir();
    tempDirs.push(stateDir);
    const artifactService = createArtifactService({
      stateDir,
      gatewayBaseUrl: "http://127.0.0.1:18789",
    });

    expect(
      captureDeveloperArtifactsFromLlmOutput({
        sessionId: "session-ignore",
        runId: "run-ignore",
        recipeId: "doc_ingest",
        assistantTexts: [readFixture("preview-envelope.json")],
        artifactService,
      }),
    ).toEqual([]);

    captureDeveloperArtifactsFromLlmOutput({
      sessionId: "session-2",
      runId: "run-2",
      recipeId: "code_build_publish",
      assistantTexts: [readFixture("preview-envelope.json")],
      artifactService,
    });

    expect(listCapturedDeveloperArtifacts()).toHaveLength(1);
    expect(artifactService.list()).toHaveLength(1);
  });
});
