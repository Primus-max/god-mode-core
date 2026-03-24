import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

describe("developer artifact projection", () => {
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
    const artifacts = projectDeveloperArtifacts({
      sessionId: "session-1",
      runId: "run-1",
      payloads: [
        ...extractDeveloperArtifactPayloads([readFixture("preview-envelope.json")]),
        ...extractDeveloperArtifactPayloads([readFixture("release-envelope.json")]),
      ],
    });

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toMatchObject({
      kind: "site",
      lifecycle: "preview",
      publishTarget: "vercel",
      url: "https://preview.example.com/build-42",
    });
    expect(artifacts[1]).toMatchObject({
      kind: "release",
      lifecycle: "published",
      publishTarget: "github",
      url: "https://github.com/openclaw/openclaw/releases/tag/v1.4.2",
    });
    expect(artifacts[1]?.metadata).toMatchObject({
      developerArtifactType: "release",
      stage: "publish",
    });
  });

  it("captures only publish recipe outputs into the developer artifact store", () => {
    resetCapturedDeveloperArtifacts();

    expect(
      captureDeveloperArtifactsFromLlmOutput({
        sessionId: "session-ignore",
        runId: "run-ignore",
        recipeId: "doc_ingest",
        assistantTexts: [readFixture("preview-envelope.json")],
      }),
    ).toEqual([]);

    captureDeveloperArtifactsFromLlmOutput({
      sessionId: "session-2",
      runId: "run-2",
      recipeId: "code_build_publish",
      assistantTexts: [readFixture("preview-envelope.json")],
    });

    expect(listCapturedDeveloperArtifacts()).toHaveLength(1);
  });
});
