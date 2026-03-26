import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const installFromValidatedNpmSpecArchiveMock = vi.hoisted(() => vi.fn());
const withExtractedArchiveRootMock = vi.hoisted(() => vi.fn());
const installPackageDirWithManifestDepsMock = vi.hoisted(() => vi.fn());

vi.mock("../../infra/install-from-npm-spec.js", () => ({
  installFromValidatedNpmSpecArchive: (...args: unknown[]) =>
    installFromValidatedNpmSpecArchiveMock(...args),
}));

vi.mock("../../infra/install-flow.js", () => ({
  withExtractedArchiveRoot: (...args: unknown[]) => withExtractedArchiveRootMock(...args),
}));

vi.mock("../../infra/install-package-dir.js", () => ({
  installPackageDirWithManifestDeps: (...args: unknown[]) =>
    installPackageDirWithManifestDepsMock(...args),
}));

import { createBootstrapRequestService } from "./service.js";
import type { BootstrapRequest } from "./contracts.js";

function buildNodeRequest(): BootstrapRequest {
  return {
    capabilityId: "node-installer-smoke",
    installMethod: "node",
    rollbackStrategy: "restore_previous",
    reason: "missing_capability",
    sourceDomain: "developer",
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
  };
}

describe("bootstrap request service node installer", () => {
  let tempRoot = "";

  afterEach(async () => {
    vi.clearAllMocks();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = "";
    }
  });

  it("runs the default node installer through approve, install, verify, and register", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bootstrap-node-service-"));
    const sourceDir = path.join(tempRoot, "source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/node-installer-smoke",
        version: "1.2.3",
      }),
      "utf-8",
    );

    withExtractedArchiveRootMock.mockImplementation(async ({ onExtracted }) => await onExtracted(sourceDir));
    installFromValidatedNpmSpecArchiveMock.mockImplementation(
      async ({ installFromArchive }) => await installFromArchive({ archivePath: path.join(tempRoot, "pkg.tgz") }),
    );
    installPackageDirWithManifestDepsMock.mockImplementation(async ({ sourceDir: packageDir, targetDir }) => {
      await fs.mkdir(targetDir, { recursive: true });
      await fs.copyFile(path.join(packageDir, "package.json"), path.join(targetDir, "package.json"));
      return { ok: true };
    });

    const service = createBootstrapRequestService({ stateDir: tempRoot });
    const created = service.create(buildNodeRequest());
    service.resolve(created.id, "approve");

    const result = await service.run({ id: created.id });

    expect(result?.state).toBe("available");
    expect(result?.result?.status).toBe("bootstrapped");
    expect(result?.result?.lifecycle?.status).toBe("available");
    expect(result?.result?.lifecycle?.verificationStatus).toBe("passed");
    expect(result?.result?.capability).toMatchObject({
      id: "node-installer-smoke",
      installMethod: "node",
      status: "available",
      requiredBins: ["node"],
    });
  });
});
