import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPlatformRuntimeCheckpointService,
  resetPlatformRuntimeCheckpointService,
} from "../runtime/index.js";

const fetchBootstrapDownloadArtifactMock = vi.hoisted(() => vi.fn());
const withExtractedArchiveRootMock = vi.hoisted(() => vi.fn());
const installPackageDirWithManifestDepsMock = vi.hoisted(() => vi.fn());

vi.mock("./download-fetch.js", () => ({
  fetchBootstrapDownloadArtifact: (...args: unknown[]) =>
    fetchBootstrapDownloadArtifactMock(...args),
}));

vi.mock("../../infra/install-flow.js", () => ({
  withExtractedArchiveRoot: (...args: unknown[]) => withExtractedArchiveRootMock(...args),
}));

vi.mock("../../infra/install-package-dir.js", () => ({
  installPackageDirWithManifestDeps: (...args: unknown[]) =>
    installPackageDirWithManifestDepsMock(...args),
}));

import type { BootstrapRequest } from "./contracts.js";
import { createBootstrapRequestService } from "./service.js";

function installBootstrapContinuationNoop() {
  getPlatformRuntimeCheckpointService().registerContinuationHandler(
    "bootstrap_run",
    async () => {},
  );
}

function buildDownloadRequest(): BootstrapRequest {
  return {
    capabilityId: "download-installer-smoke",
    installMethod: "download",
    rollbackStrategy: "restore_previous",
    reason: "renderer_unavailable",
    sourceDomain: "developer",
    approvalMode: "explicit",
    catalogEntry: {
      capability: {
        id: "download-installer-smoke",
        label: "Download Installer Smoke",
        status: "missing",
        trusted: true,
        requiredBins: ["bin/playwright"],
      },
      source: "catalog",
      install: {
        method: "download",
        packageRef: "playwright-pdf-renderer@1.2.3",
        integrity: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        downloadUrl: "https://openclaw.ai/bootstrap/playwright-pdf-renderer-1.2.3.tgz",
        archiveKind: "tar",
        rootMarkers: ["bin"],
        rollbackStrategy: "restore_previous",
      },
    },
  };
}

describe("bootstrap request service download installer", () => {
  let tempRoot = "";

  afterEach(async () => {
    vi.clearAllMocks();
    resetPlatformRuntimeCheckpointService();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = "";
    }
  });

  it("runs the default download installer through approve, install, verify, and register", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bootstrap-download-service-"));
    const sourceDir = path.join(tempRoot, "source");
    await fs.mkdir(path.join(sourceDir, "bin"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "bin", "playwright"), "#!/bin/sh\n", "utf-8");

    fetchBootstrapDownloadArtifactMock.mockResolvedValue({
      ok: true,
      archivePath: path.join(tempRoot, "renderer.tgz"),
      bytes: 128,
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    withExtractedArchiveRootMock.mockImplementation(
      async ({ onExtracted }) => await onExtracted(sourceDir),
    );
    installPackageDirWithManifestDepsMock.mockImplementation(
      async ({ sourceDir: extractedDir, targetDir }) => {
        await fs.mkdir(path.join(targetDir, "bin"), { recursive: true });
        await fs.copyFile(
          path.join(extractedDir, "bin", "playwright"),
          path.join(targetDir, "bin", "playwright"),
        );
        return { ok: true };
      },
    );

    const service = createBootstrapRequestService({ stateDir: tempRoot });
    installBootstrapContinuationNoop();
    const created = service.create(buildDownloadRequest());
    service.resolve(created.id, "approve");

    const result = await service.run({ id: created.id });

    expect(result?.state).toBe("available");
    expect(result?.result?.status).toBe("bootstrapped");
    expect(result?.result?.lifecycle?.status).toBe("available");
    expect(result?.result?.lifecycle?.verificationStatus).toBe("passed");
    expect(result?.result?.capability).toMatchObject({
      id: "download-installer-smoke",
      installMethod: "download",
      status: "available",
    });
  });
});
