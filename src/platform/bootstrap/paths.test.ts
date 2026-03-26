import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolvePlatformBootstrapDownloadCapabilityInstallDir,
  resolvePlatformBootstrapDownloadCapabilityStageDir,
  resolvePlatformBootstrapDownloadInstallRoot,
  resolvePlatformBootstrapDownloadStageRoot,
  resolvePlatformBootstrapInstallRoot,
  resolvePlatformBootstrapNodeCapabilityInstallDir,
  resolvePlatformBootstrapNodeInstallRoot,
  resolvePlatformBootstrapRoot,
} from "./paths.js";

describe("bootstrap paths", () => {
  it("resolves bounded node install directories under the bootstrap root", () => {
    const stateDir = path.join("state-root", "profile");

    const bootstrapRoot = resolvePlatformBootstrapRoot(stateDir);
    const installRoot = resolvePlatformBootstrapInstallRoot(stateDir);
    const nodeInstallRoot = resolvePlatformBootstrapNodeInstallRoot(stateDir);
    const capabilityDir = resolvePlatformBootstrapNodeCapabilityInstallDir({
      capabilityId: "@openclaw/pdf-parser",
      stateDir,
    });

    expect(installRoot).toBe(path.join(bootstrapRoot, "installs"));
    expect(nodeInstallRoot).toBe(path.join(installRoot, "node"));
    expect(path.dirname(capabilityDir)).toBe(nodeInstallRoot);
    expect(path.basename(capabilityDir)).not.toContain(path.sep);
    expect(path.basename(capabilityDir)).not.toBe("@openclaw/pdf-parser");
  });

  it("resolves bounded download stage and install directories under the bootstrap root", () => {
    const stateDir = path.join("state-root", "profile");

    const bootstrapRoot = resolvePlatformBootstrapRoot(stateDir);
    const installRoot = resolvePlatformBootstrapInstallRoot(stateDir);
    const downloadStageRoot = resolvePlatformBootstrapDownloadStageRoot(stateDir);
    const downloadInstallRoot = resolvePlatformBootstrapDownloadInstallRoot(stateDir);
    const stageDir = resolvePlatformBootstrapDownloadCapabilityStageDir({
      capabilityId: "pdf-renderer",
      stateDir,
    });
    const installDir = resolvePlatformBootstrapDownloadCapabilityInstallDir({
      capabilityId: "pdf-renderer",
      stateDir,
    });

    expect(downloadStageRoot).toBe(path.join(bootstrapRoot, "downloads"));
    expect(downloadInstallRoot).toBe(path.join(installRoot, "download"));
    expect(path.dirname(stageDir)).toBe(downloadStageRoot);
    expect(path.dirname(installDir)).toBe(downloadInstallRoot);
  });
});
