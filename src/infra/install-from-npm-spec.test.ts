import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installFromValidatedNpmSpecArchive } from "./install-from-npm-spec.js";
import * as npmPackInstall from "./npm-pack-install.js";
import * as npmRegistrySpec from "./npm-registry-spec.js";

const validateSpy = vi.spyOn(npmRegistrySpec, "validateRegistryNpmSpec");
const installFromNpmSpecArchiveWithInstallerSpy = vi.spyOn(
  npmPackInstall,
  "installFromNpmSpecArchiveWithInstaller",
);
const finalizeNpmSpecArchiveInstallSpy = vi.spyOn(npmPackInstall, "finalizeNpmSpecArchiveInstall");

beforeEach(() => {
  validateSpy.mockReset();
  installFromNpmSpecArchiveWithInstallerSpy.mockReset();
  finalizeNpmSpecArchiveInstallSpy.mockReset();
});

afterAll(() => {
  validateSpy.mockRestore();
  installFromNpmSpecArchiveWithInstallerSpy.mockRestore();
  finalizeNpmSpecArchiveInstallSpy.mockRestore();
});

describe("installFromValidatedNpmSpecArchive", () => {
  it("trims the spec and returns validation errors before running the installer", async () => {
    validateSpy.mockReturnValueOnce("unsupported npm spec");

    await expect(
      installFromValidatedNpmSpecArchive({
        spec: "  nope  ",
        timeoutMs: 30_000,
        tempDirPrefix: "openclaw-npm-",
        installFromArchive: vi.fn(),
        archiveInstallParams: {},
      }),
    ).resolves.toEqual({ ok: false, error: "unsupported npm spec" });

    expect(validateSpy).toHaveBeenCalledWith("nope");
    expect(installFromNpmSpecArchiveWithInstallerSpy).not.toHaveBeenCalled();
    expect(finalizeNpmSpecArchiveInstallSpy).not.toHaveBeenCalled();
  });

  it("passes the trimmed spec through the archive installer and finalizer", async () => {
    const installFromArchive = vi.fn();
    const warn = vi.fn();
    const onIntegrityDrift = vi.fn();
    const flowResult = {
      ok: true as const,
      installResult: { ok: true },
      npmResolution: { version: "1.2.3" },
    };
    const finalized = { ok: true, archivePath: "/tmp/pkg.tgz" };
    validateSpy.mockReturnValueOnce(null);
    installFromNpmSpecArchiveWithInstallerSpy.mockResolvedValueOnce(flowResult);
    finalizeNpmSpecArchiveInstallSpy.mockReturnValueOnce(finalized);

    await expect(
      installFromValidatedNpmSpecArchive({
        spec: "  @openclaw/demo@beta  ",
        timeoutMs: 45_000,
        tempDirPrefix: "openclaw-npm-",
        expectedIntegrity: "sha512-demo",
        onIntegrityDrift,
        warn,
        installFromArchive,
        archiveInstallParams: { destination: "/tmp/demo" },
      }),
    ).resolves.toBe(finalized);

    expect(installFromNpmSpecArchiveWithInstallerSpy).toHaveBeenCalledWith({
      tempDirPrefix: "openclaw-npm-",
      spec: "@openclaw/demo@beta",
      timeoutMs: 45_000,
      expectedIntegrity: "sha512-demo",
      onIntegrityDrift,
      warn,
      installFromArchive,
      archiveInstallParams: { destination: "/tmp/demo" },
    });
    expect(finalizeNpmSpecArchiveInstallSpy).toHaveBeenCalledWith(flowResult);
  });
});
