import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMaterializationToDescriptor, materializeArtifact } from "../materialization/index.js";
import type { ArtifactDescriptor } from "../schemas/artifact.js";
import {
  createArtifactGetGatewayMethod,
  createArtifactListGatewayMethod,
  createArtifactTransitionGatewayMethod,
} from "./gateway.js";
import { createArtifactService } from "./service.js";

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-artifact-gateway-"));
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
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("artifact gateway methods", () => {
  it("lists and fetches artifact records", async () => {
    const stateDir = createTempStateDir();
    tempDirs.push(stateDir);
    const service = createArtifactService({ stateDir, gatewayBaseUrl: "http://127.0.0.1:18789" });
    service.register(
      applyMaterializationToDescriptor({
        descriptor: buildDescriptor({
          id: "artifact-report",
          label: "Artifact Report",
        }),
        materialization: materializeArtifact({
          artifactId: "artifact-report",
          label: "Artifact Report",
          sourceDomain: "document",
          renderKind: "html",
          outputTarget: "file",
          outputDir: service.resolveOutputDir("artifact-report"),
          payload: {
            title: "Artifact Report",
            markdown: "# Hello",
          },
        }),
      }),
    );

    const respond = vi.fn();
    await createArtifactListGatewayMethod(service)({
      params: {},
      req: { type: "req", method: "platform.artifacts.list", id: "req-1" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        artifacts: [expect.objectContaining({ id: "artifact-report" })],
      }),
    );

    const getRespond = vi.fn();
    await createArtifactGetGatewayMethod(service)({
      params: { artifactId: "artifact-report" },
      req: { type: "req", method: "platform.artifacts.get", id: "req-2" },
      client: null,
      isWebchatConnect: () => false,
      respond: getRespond,
      context: {} as never,
    });
    expect(getRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        descriptor: expect.objectContaining({ id: "artifact-report" }),
      }),
    );
  });

  it("transitions artifact lifecycle through the gateway method", async () => {
    const stateDir = createTempStateDir();
    tempDirs.push(stateDir);
    const service = createArtifactService({ stateDir, gatewayBaseUrl: "http://127.0.0.1:18789" });
    service.register(buildDescriptor({ id: "artifact-release", label: "Artifact Release" }));

    const respond = vi.fn();
    await createArtifactTransitionGatewayMethod(service)({
      params: { artifactId: "artifact-release", operation: "publish" },
      req: { type: "req", method: "platform.artifacts.transition", id: "req-3" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        descriptor: expect.objectContaining({ lifecycle: "published" }),
      }),
    );
  });
});
