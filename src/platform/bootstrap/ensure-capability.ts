import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolveStateDir } from "../../config/paths.js";
import { getApprovedCapabilityCatalogEntry } from "./catalog-approval.js";
import type { BootstrapRequest } from "./contracts.js";
import { verifyCapabilityHealth } from "./health-check.js";
import { installCapabilityRequest } from "./installers.js";
import {
  resolvePlatformBootstrapDownloadCapabilityInstallDir,
  resolvePlatformBootstrapNodeCapabilityInstallDir,
} from "./paths.js";

const NODE_HEALTH_CHECK_FILENAME = ".openclaw-bootstrap-healthcheck.cjs";

export type EnsureCapabilityResult =
  | {
      ok: true;
      capabilityId: string;
      installDir: string;
      alreadyInstalled: boolean;
    }
  | {
      ok: false;
      capabilityId: string;
      reason: string;
      installDir?: string;
    };

function resolveInstallDirForCatalogEntry(capabilityId: string, stateDir?: string): string | null {
  const entry = getApprovedCapabilityCatalogEntry(capabilityId);
  if (!entry) {
    return null;
  }
  if (entry.install?.method === "node") {
    return resolvePlatformBootstrapNodeCapabilityInstallDir({ capabilityId, stateDir });
  }
  if (entry.install?.method === "download") {
    return resolvePlatformBootstrapDownloadCapabilityInstallDir({ capabilityId, stateDir });
  }
  return null;
}

async function isManagedInstallHealthy(params: {
  capabilityId: string;
  installDir: string;
}): Promise<boolean> {
  const entry = getApprovedCapabilityCatalogEntry(params.capabilityId);
  if (!entry) {
    return false;
  }
  const healthCheckScript = path.join(params.installDir, NODE_HEALTH_CHECK_FILENAME);
  try {
    await fs.access(healthCheckScript);
  } catch {
    return false;
  }
  const managedHealth = await verifyCapabilityHealth({
    capability: {
      ...entry.capability,
      status: "available",
      requiredBins: ["node"],
      healthCheckCommand: `node ${healthCheckScript}`,
    },
  });
  return managedHealth.ok;
}

/**
 * Ensure a producer capability is installed in its managed directory. Installs on demand
 * using the approved catalog entry. Producer tools call this before dynamic-importing the
 * backing npm package — they never rely on root node_modules.
 */
export async function ensureCapability(params: {
  capabilityId: string;
  stateDir?: string;
  sourceRecipeId?: string;
}): Promise<EnsureCapabilityResult> {
  const entry = getApprovedCapabilityCatalogEntry(params.capabilityId);
  if (!entry) {
    return {
      ok: false,
      capabilityId: params.capabilityId,
      reason: `capability "${params.capabilityId}" is not in the approved bootstrap catalog`,
    };
  }
  if (!entry.install || entry.install.method === "builtin") {
    return {
      ok: true,
      capabilityId: params.capabilityId,
      installDir: "",
      alreadyInstalled: true,
    };
  }
  const stateDir = params.stateDir ?? resolveStateDir(process.env);
  const installDir = resolveInstallDirForCatalogEntry(params.capabilityId, stateDir);
  if (!installDir) {
    return {
      ok: false,
      capabilityId: params.capabilityId,
      reason: `cannot resolve managed install directory for capability "${params.capabilityId}"`,
    };
  }
  if (await isManagedInstallHealthy({ capabilityId: params.capabilityId, installDir })) {
    return {
      ok: true,
      capabilityId: params.capabilityId,
      installDir,
      alreadyInstalled: true,
    };
  }
  const request: BootstrapRequest = {
    capabilityId: params.capabilityId,
    installMethod: entry.install.method,
    ...(entry.install.rollbackStrategy
      ? { rollbackStrategy: entry.install.rollbackStrategy }
      : {}),
    reason: "missing_capability",
    sourceDomain: "platform",
    ...(params.sourceRecipeId ? { sourceRecipeId: params.sourceRecipeId } : {}),
    approvalMode: "explicit",
    catalogEntry: entry,
  };
  const installed = await installCapabilityRequest({
    request,
    stateDir,
  });
  if (!installed.ok) {
    return {
      ok: false,
      capabilityId: params.capabilityId,
      reason:
        installed.reasons[0] ??
        `bootstrap install failed for capability "${params.capabilityId}"`,
      installDir,
    };
  }
  const healthy = await isManagedInstallHealthy({
    capabilityId: params.capabilityId,
    installDir,
  });
  if (!healthy) {
    return {
      ok: false,
      capabilityId: params.capabilityId,
      reason: `bootstrap install verification failed for capability "${params.capabilityId}"`,
      installDir,
    };
  }
  return {
    ok: true,
    capabilityId: params.capabilityId,
    installDir,
    alreadyInstalled: false,
  };
}

/**
 * Dynamically import the npm package backing a capability from its managed install directory.
 * Producer tools call `ensureCapability` first, then this helper — never root node_modules.
 */
export async function loadCapabilityModule<T = unknown>(params: {
  capabilityId: string;
  packageName: string;
  stateDir?: string;
}): Promise<T> {
  const ensured = await ensureCapability({
    capabilityId: params.capabilityId,
    stateDir: params.stateDir,
  });
  if (!ensured.ok) {
    throw new Error(
      `capability "${params.capabilityId}" is not available: ${ensured.reason}`,
    );
  }
  const installDir = ensured.installDir;
  if (!installDir) {
    return (await import(params.packageName)) as T;
  }
  let installedPackageName: string | null = null;
  try {
    const manifestRaw = await fs.readFile(path.join(installDir, "package.json"), "utf-8");
    const manifest = JSON.parse(manifestRaw) as { name?: unknown };
    if (typeof manifest.name === "string" && manifest.name.trim().length > 0) {
      installedPackageName = manifest.name.trim();
    }
  } catch {
    installedPackageName = null;
  }
  if (installedPackageName && installedPackageName === params.packageName) {
    const requireForMain = createRequire(
      pathToFileURL(path.join(installDir, "package.json")).href,
    );
    let resolvedMain: string;
    try {
      resolvedMain = requireForMain.resolve(`./`);
    } catch {
      try {
        resolvedMain = requireForMain.resolve(path.join(installDir, "index.js"));
      } catch {
        resolvedMain = path.join(installDir, "index.js");
      }
    }
    return (await import(pathToFileURL(resolvedMain).href)) as T;
  }
  const requireFromManaged = createRequire(
    pathToFileURL(path.join(installDir, "package.json")).href,
  );
  let resolvedPath: string;
  try {
    resolvedPath = requireFromManaged.resolve(params.packageName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `capability "${params.capabilityId}" install did not expose package "${params.packageName}": ${message}`,
    );
  }
  return (await import(pathToFileURL(resolvedPath).href)) as T;
}
