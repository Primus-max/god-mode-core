import path from "node:path";
import { safePathSegmentHashed } from "../../infra/install-safe-path.js";
import { resolveStateDir } from "../../config/paths.js";

const PLATFORM_BOOTSTRAP_DIRNAME = "platform";
const BOOTSTRAP_DIRNAME = "bootstrap";
const BOOTSTRAP_AUDIT_FILENAME = "requests-audit.jsonl";
const BOOTSTRAP_INSTALLS_DIRNAME = "installs";
const BOOTSTRAP_DOWNLOAD_STAGING_DIRNAME = "downloads";
const BOOTSTRAP_DOWNLOAD_INSTALLS_DIRNAME = "download";
const BOOTSTRAP_NODE_INSTALLS_DIRNAME = "node";

export function resolvePlatformBootstrapRoot(stateDir = resolveStateDir()): string {
  return path.join(stateDir, PLATFORM_BOOTSTRAP_DIRNAME, BOOTSTRAP_DIRNAME);
}

export function resolveBootstrapAuditPath(stateDir = resolveStateDir()): string {
  return path.join(resolvePlatformBootstrapRoot(stateDir), BOOTSTRAP_AUDIT_FILENAME);
}

export function resolvePlatformBootstrapInstallRoot(stateDir = resolveStateDir()): string {
  return path.join(resolvePlatformBootstrapRoot(stateDir), BOOTSTRAP_INSTALLS_DIRNAME);
}

export function resolvePlatformBootstrapNodeInstallRoot(stateDir = resolveStateDir()): string {
  return path.join(
    resolvePlatformBootstrapInstallRoot(stateDir),
    BOOTSTRAP_NODE_INSTALLS_DIRNAME,
  );
}

export function resolvePlatformBootstrapDownloadStageRoot(stateDir = resolveStateDir()): string {
  return path.join(resolvePlatformBootstrapRoot(stateDir), BOOTSTRAP_DOWNLOAD_STAGING_DIRNAME);
}

export function resolvePlatformBootstrapDownloadInstallRoot(stateDir = resolveStateDir()): string {
  return path.join(
    resolvePlatformBootstrapInstallRoot(stateDir),
    BOOTSTRAP_DOWNLOAD_INSTALLS_DIRNAME,
  );
}

export function resolvePlatformBootstrapNodeCapabilityInstallDir(params: {
  capabilityId: string;
  stateDir?: string;
}): string {
  return path.join(
    resolvePlatformBootstrapNodeInstallRoot(params.stateDir),
    safePathSegmentHashed(params.capabilityId),
  );
}

export function resolvePlatformBootstrapDownloadCapabilityStageDir(params: {
  capabilityId: string;
  stateDir?: string;
}): string {
  return path.join(
    resolvePlatformBootstrapDownloadStageRoot(params.stateDir),
    safePathSegmentHashed(params.capabilityId),
  );
}

export function resolvePlatformBootstrapDownloadCapabilityInstallDir(params: {
  capabilityId: string;
  stateDir?: string;
}): string {
  return path.join(
    resolvePlatformBootstrapDownloadInstallRoot(params.stateDir),
    safePathSegmentHashed(params.capabilityId),
  );
}
