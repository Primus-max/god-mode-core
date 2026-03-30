import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as installFlow from "../../infra/install-flow.js";
import * as installFromNpmSpec from "../../infra/install-from-npm-spec.js";
import * as installPackageDir from "../../infra/install-package-dir.js";
import {
  getPlatformRuntimeCheckpointService,
  resetPlatformRuntimeCheckpointService,
} from "../runtime/index.js";
import type { BootstrapRequest } from "./contracts.js";
import { createBootstrapRequestService } from "./service.js";

const installFromValidatedNpmSpecArchiveMock = vi.spyOn(
  installFromNpmSpec,
  "installFromValidatedNpmSpecArchive",
);
const withExtractedArchiveRootMock = vi.spyOn(installFlow, "withExtractedArchiveRoot");
const installPackageDirWithManifestDepsMock = vi.spyOn(
  installPackageDir,
  "installPackageDirWithManifestDeps",
);

afterAll(() => {
  installFromValidatedNpmSpecArchiveMock.mockRestore();
  withExtractedArchiveRootMock.mockRestore();
  installPackageDirWithManifestDepsMock.mockRestore();
});

function installBootstrapContinuationNoop() {
  getPlatformRuntimeCheckpointService().registerContinuationHandler(
    "bootstrap_run",
    async () => {},
  );
}

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
    resetPlatformRuntimeCheckpointService();
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

    withExtractedArchiveRootMock.mockImplementation(
      async ({ onExtracted }) => await onExtracted(sourceDir),
    );
    installFromValidatedNpmSpecArchiveMock.mockImplementation(
      async ({ installFromArchive }) =>
        await installFromArchive({ archivePath: path.join(tempRoot, "pkg.tgz") }),
    );
    installPackageDirWithManifestDepsMock.mockImplementation(
      async ({ sourceDir: packageDir, targetDir }) => {
        await fs.mkdir(targetDir, { recursive: true });
        await fs.copyFile(
          path.join(packageDir, "package.json"),
          path.join(targetDir, "package.json"),
        );
        return { ok: true };
      },
    );

    const service = createBootstrapRequestService({ stateDir: tempRoot });
    installBootstrapContinuationNoop();
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
