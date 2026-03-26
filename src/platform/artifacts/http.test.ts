import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMaterializationToDescriptor, materializeArtifact } from "../materialization/index.js";
import type { ArtifactDescriptor } from "../schemas/artifact.js";
import { createArtifactHttpHandler } from "./http.js";
import { createArtifactService } from "./service.js";

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-artifact-http-"));
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

async function withServer<T>(
  handler: ReturnType<typeof createArtifactHttpHandler>,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("Not Found");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve test server address");
  }
  try {
    return await run(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("artifact http handler", () => {
  it("serves preview HTML and supports HEAD requests", async () => {
    const stateDir = createTempStateDir();
    tempDirs.push(stateDir);
    const service = createArtifactService({ stateDir, gatewayBaseUrl: "http://127.0.0.1:18789" });
    service.register(
      applyMaterializationToDescriptor({
        descriptor: buildDescriptor({
          id: "preview-1",
          kind: "site",
          label: "Preview 1",
          lifecycle: "preview",
        }),
        materialization: materializeArtifact({
          artifactId: "preview-1",
          label: "Preview 1",
          sourceDomain: "developer",
          renderKind: "site_preview",
          outputTarget: "preview",
          outputDir: service.resolveOutputDir("preview-1"),
          payload: {
            title: "Preview 1",
            markdown: "# Preview Body",
          },
        }),
      }),
    );
    const token = service.getRecord("preview-1")?.access.token;
    expect(token).toBeTruthy();

    await withServer(createArtifactHttpHandler({ service }), async (baseUrl) => {
      const previewUrl = `${baseUrl}/platform/artifacts/preview/preview-1/${encodeURIComponent(token ?? "")}`;
      const getResponse = await fetch(previewUrl);
      const html = await getResponse.text();
      expect(getResponse.status).toBe(200);
      expect(getResponse.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(html).toContain("Preview Body");

      const headResponse = await fetch(previewUrl, { method: "HEAD" });
      expect(headResponse.status).toBe(200);
      expect(await headResponse.text()).toBe("");
    });
  });

  it("rejects invalid tokens and blocks serving files outside the artifact root", async () => {
    const stateDir = createTempStateDir();
    tempDirs.push(stateDir);
    const service = createArtifactService({ stateDir, gatewayBaseUrl: "http://127.0.0.1:18789" });
    const outsidePath = path.join(stateDir, "..", "outside-artifact.bin");
    fs.writeFileSync(outsidePath, "outside", "utf8");
    service.register(
      buildDescriptor({
        id: "external-binary",
        kind: "binary",
        label: "External Binary",
        path: outsidePath,
      }),
    );
    const token = service.getRecord("external-binary")?.access.token;
    expect(token).toBeTruthy();

    await withServer(createArtifactHttpHandler({ service }), async (baseUrl) => {
      const invalidTokenResponse = await fetch(
        `${baseUrl}/platform/artifacts/content/external-binary/bad-token`,
      );
      expect(invalidTokenResponse.status).toBe(404);

      const contentResponse = await fetch(
        `${baseUrl}/platform/artifacts/content/external-binary/${encodeURIComponent(token ?? "")}`,
      );
      expect(contentResponse.status).toBe(400);
    });
  });
});
