import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolvePlatformBootstrapDownloadCapabilityInstallDir,
  resolvePlatformBootstrapDownloadCapabilityStageDir,
  resolvePlatformBootstrapNodeCapabilityInstallDir,
} from "./paths.js";

const installFromValidatedNpmSpecArchiveMock = vi.hoisted(() => vi.fn());
const fetchBootstrapDownloadArtifactMock = vi.hoisted(() => vi.fn());
const withExtractedArchiveRootMock = vi.hoisted(() => vi.fn());
const installPackageDirWithManifestDepsMock = vi.hoisted(() => vi.fn());

vi.mock("../../infra/install-from-npm-spec.js", () => ({
  installFromValidatedNpmSpecArchive: (...args: unknown[]) =>
    installFromValidatedNpmSpecArchiveMock(...args),
}));

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
import { installCapabilityRequest } from "./installers.js";

function buildNodeRequest(overrides: Partial<BootstrapRequest> = {}): BootstrapRequest {
  return {
    capabilityId: "node-installer-smoke",
    installMethod: "node",
    rollbackStrategy: "restore_previous",
    reason: "missing_capability",
    sourceDomain: "platform",
    approvalMode: "explicit",
    catalogEntry: {
      capability: {
        id: "node-installer-smoke",
        label: "Node Installer Smoke",
        status: "missing",
        trusted: true,
        requiredBins: ["node"],
      },
      source: "catalog",
      install: {
        method: "node",
        packageRef: "@openclaw/node-installer-smoke@1.2.3",
        integrity: "sha512-demo",
        rollbackStrategy: "restore_previous",
      },
    },
    ...overrides,
  };
}

function buildDownloadRequest(overrides: Partial<BootstrapRequest> = {}): BootstrapRequest {
  return {
    capabilityId: "download-installer-smoke",
    installMethod: "download",
    rollbackStrategy: "restore_previous",
    reason: "renderer_unavailable",
    sourceDomain: "document",
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
    ...overrides,
  };
}

describe("bootstrap installers", () => {
  let tempRoot = "";

  afterEach(async () => {
    vi.clearAllMocks();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = "";
    }
  });

  it("installs node capabilities into the bounded bootstrap node directory", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bootstrap-installers-"));
    const sourceDir = path.join(tempRoot, "source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/node-installer-smoke",
        version: "1.2.3",
        dependencies: {
          zod: "^4.0.0",
        },
      }),
      "utf-8",
    );

    withExtractedArchiveRootMock.mockImplementation(
      async ({ onExtracted }) => await onExtracted(sourceDir),
    );
    installFromValidatedNpmSpecArchiveMock.mockImplementation(
      async ({ installFromArchive }) =>
        await installFromArchive({ archivePath: path.join(tempRoot, "pkg.tgz") }),
    );
    installPackageDirWithManifestDepsMock.mockImplementation(async ({ targetDir }) => {
      await fs.mkdir(targetDir, { recursive: true });
      return { ok: true };
    });

    const request = buildNodeRequest();
    const result = await installCapabilityRequest({
      request,
      stateDir: tempRoot,
    });

    const targetDir = resolvePlatformBootstrapNodeCapabilityInstallDir({
      capabilityId: request.capabilityId,
      stateDir: tempRoot,
    });

    expect(result.ok).toBe(true);
    expect(installFromValidatedNpmSpecArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@openclaw/node-installer-smoke@1.2.3",
        expectedIntegrity: "sha512-demo",
      }),
    );
    expect(installPackageDirWithManifestDepsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDir,
        targetDir,
        mode: "install",
        manifestDependencies: { zod: "^4.0.0" },
      }),
    );
    expect(result.capability).toMatchObject({
      id: "node-installer-smoke",
      status: "available",
      installMethod: "node",
      trusted: true,
      requiredBins: ["node"],
      sandboxed: true,
      version: "1.2.3",
    });
    expect(result.capability.healthCheckCommand).toBe(
      `node ${path.join(targetDir, ".openclaw-bootstrap-healthcheck.cjs")}`,
    );
    await expect(
      fs.readFile(path.join(targetDir, ".openclaw-bootstrap-healthcheck.cjs"), "utf-8"),
    ).resolves.toContain('"package.json"');
  });

  it("fails node installs when the resolved package name does not match the catalog packageRef", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bootstrap-installers-"));
    const sourceDir = path.join(tempRoot, "source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/wrong-package",
        version: "1.2.3",
      }),
      "utf-8",
    );

    withExtractedArchiveRootMock.mockImplementation(
      async ({ onExtracted }) => await onExtracted(sourceDir),
    );
    installFromValidatedNpmSpecArchiveMock.mockImplementation(
      async ({ installFromArchive }) =>
        await installFromArchive({ archivePath: path.join(tempRoot, "pkg.tgz") }),
    );

    const result = await installCapabilityRequest({
      request: buildNodeRequest(),
      stateDir: tempRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain(
      "node bootstrap package mismatch: expected @openclaw/node-installer-smoke, got @openclaw/wrong-package",
    );
    expect(installPackageDirWithManifestDepsMock).not.toHaveBeenCalled();
  });

  it("rejects non-exact node package refs before touching npm install flows", async () => {
    const result = await installCapabilityRequest({
      request: buildNodeRequest({
        catalogEntry: {
          capability: {
            id: "node-installer-smoke",
            label: "Node Installer Smoke",
            status: "missing",
            trusted: true,
          },
          source: "catalog",
          install: {
            method: "node",
            packageRef: "@openclaw/node-installer-smoke@latest",
            integrity: "sha512-demo",
            rollbackStrategy: "restore_previous",
          },
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain(
      "node bootstrap installer requires an exact npm registry packageRef for node-installer-smoke",
    );
    expect(installFromValidatedNpmSpecArchiveMock).not.toHaveBeenCalled();
    expect(withExtractedArchiveRootMock).not.toHaveBeenCalled();
  });

  it("installs download capabilities into bounded bootstrap directories", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bootstrap-installers-"));
    const sourceDir = path.join(tempRoot, "download-source");
    await fs.mkdir(path.join(sourceDir, "bin"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "bin", "playwright"), "#!/bin/sh\n", "utf-8");

    fetchBootstrapDownloadArtifactMock.mockResolvedValue({
      ok: true,
      archivePath: path.join(tempRoot, "archive.tgz"),
      bytes: 128,
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    withExtractedArchiveRootMock.mockImplementation(
      async ({ onExtracted }) => await onExtracted(sourceDir),
    );
    installPackageDirWithManifestDepsMock.mockImplementation(async ({ targetDir }) => {
      await fs.mkdir(path.join(targetDir, "bin"), { recursive: true });
      await fs.copyFile(
        path.join(sourceDir, "bin", "playwright"),
        path.join(targetDir, "bin", "playwright"),
      );
      return { ok: true };
    });

    const request = buildDownloadRequest();
    const result = await installCapabilityRequest({
      request,
      stateDir: tempRoot,
    });

    const stageDir = resolvePlatformBootstrapDownloadCapabilityStageDir({
      capabilityId: request.capabilityId,
      stateDir: tempRoot,
    });
    const targetDir = resolvePlatformBootstrapDownloadCapabilityInstallDir({
      capabilityId: request.capabilityId,
      stateDir: tempRoot,
    });

    expect(result.ok).toBe(true);
    expect(fetchBootstrapDownloadArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://openclaw.ai/bootstrap/playwright-pdf-renderer-1.2.3.tgz",
        integrity: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        archiveKind: "tar",
        targetDir: stageDir,
      }),
    );
    expect(installPackageDirWithManifestDepsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDir,
        targetDir,
        mode: "install",
        manifestDependencies: {},
      }),
    );
    expect(result.capability).toMatchObject({
      id: "download-installer-smoke",
      status: "available",
      installMethod: "download",
      trusted: true,
      requiredBins: ["node", path.join(targetDir, "bin", "playwright")],
      sandboxed: true,
    });
    expect(result.capability.healthCheckCommand).toBe(
      `node ${path.join(targetDir, ".openclaw-bootstrap-healthcheck.cjs")}`,
    );
  });

  it("fails download installs when trusted artifact fetch fails", async () => {
    fetchBootstrapDownloadArtifactMock.mockResolvedValue({
      ok: false,
      error:
        "bootstrap download integrity mismatch for https://openclaw.ai/bootstrap/playwright-pdf-renderer-1.2.3.tgz",
    });

    const result = await installCapabilityRequest({
      request: buildDownloadRequest(),
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain(
      "bootstrap download integrity mismatch for https://openclaw.ai/bootstrap/playwright-pdf-renderer-1.2.3.tgz",
    );
    expect(withExtractedArchiveRootMock).not.toHaveBeenCalled();
  });
});
