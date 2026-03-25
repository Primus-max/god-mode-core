import fs from "node:fs/promises";
import path from "node:path";
import { withExtractedArchiveRoot } from "../../infra/install-flow.js";
import { installFromValidatedNpmSpecArchive } from "../../infra/install-from-npm-spec.js";
import { installPackageDirWithManifestDeps } from "../../infra/install-package-dir.js";
import { parseRegistryNpmSpec } from "../../infra/npm-registry-spec.js";
import type { CapabilityDescriptor, CapabilityInstallMethod } from "../schemas/capability.js";
import type { BootstrapRequest } from "./contracts.js";
import { resolvePlatformBootstrapNodeCapabilityInstallDir } from "./paths.js";

export type BootstrapInstaller = (params: {
  request: BootstrapRequest;
  previous?: CapabilityDescriptor;
  stateDir?: string;
}) => Promise<{ ok: boolean; capability: CapabilityDescriptor; reasons?: string[] }>;

const NODE_INSTALL_TIMEOUT_MS = 300_000;
const NODE_HEALTH_CHECK_FILENAME = ".openclaw-bootstrap-healthcheck.cjs";
type NodeInstallerFlowResult = { ok: true; capability: CapabilityDescriptor } | { ok: false; error: string };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type NodePackageManifest = {
  name: string;
  version?: string;
  dependencies?: Record<string, unknown>;
};

async function readNodePackageManifest(rootDir: string): Promise<NodePackageManifest> {
  const manifestPath = path.join(rootDir, "package.json");
  const manifestRaw = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(manifestRaw) as unknown;
  if (!isObjectRecord(manifest) || typeof manifest.name !== "string" || !manifest.name.trim()) {
    throw new Error(`node installer package is missing a valid package.json name: ${manifestPath}`);
  }
  return {
    name: manifest.name.trim(),
    version: typeof manifest.version === "string" ? manifest.version : undefined,
    dependencies: isObjectRecord(manifest.dependencies) ? manifest.dependencies : undefined,
  };
}

async function writeNodeHealthCheckScript(params: {
  targetDir: string;
  packageName: string;
  capabilityId: string;
}): Promise<string> {
  const scriptPath = path.join(params.targetDir, NODE_HEALTH_CHECK_FILENAME);
  const script = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const expectedPackageName = ${JSON.stringify(params.packageName)};`,
    `const expectedCapabilityId = ${JSON.stringify(params.capabilityId)};`,
    'const manifestPath = path.join(__dirname, "package.json");',
    'const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));',
    'if (manifest.name !== expectedPackageName) {',
    '  throw new Error(`bootstrap package mismatch for ${expectedCapabilityId}: ${manifest.name}`);',
    "}",
    'process.stdout.write(`${manifest.name}@${manifest.version ?? "0.0.0"}\\n`);',
  ].join("\n");
  await fs.writeFile(scriptPath, `${script}\n`, "utf-8");
  return `node ${scriptPath}`;
}

function buildInstalledCapability(
  request: BootstrapRequest,
  overrides?: Partial<CapabilityDescriptor>,
): CapabilityDescriptor {
  return {
    ...request.catalogEntry.capability,
    status: "available",
    installMethod: request.installMethod,
    ...(request.catalogEntry.install?.sandboxed !== undefined
      ? { sandboxed: request.catalogEntry.install.sandboxed }
      : {}),
    version:
      request.catalogEntry.capability.version ??
      request.catalogEntry.install?.packageRef?.split("@").at(-1) ??
      request.catalogEntry.capability.version,
    ...overrides,
  };
}

function buildFailedCapability(request: BootstrapRequest, previous?: CapabilityDescriptor): CapabilityDescriptor {
  if (previous) {
    return previous;
  }
  return {
    ...request.catalogEntry.capability,
    status: "missing",
    installMethod: request.installMethod,
    ...(request.catalogEntry.install?.sandboxed !== undefined
      ? { sandboxed: request.catalogEntry.install.sandboxed }
      : {}),
  };
}

const BUILTIN_INSTALLER: BootstrapInstaller = async ({ request }) => ({
  ok: true,
  capability: buildInstalledCapability(request),
});

const NODE_INSTALLER: BootstrapInstaller = async ({ request, previous, stateDir }) => {
  const install = request.catalogEntry.install;
  const packageRef = install?.packageRef?.trim();
  if (!packageRef) {
    return {
      ok: false,
      capability: buildFailedCapability(request, previous),
      reasons: [`node bootstrap installer requires a packageRef for ${request.capabilityId}`],
    };
  }
  if (!install) {
    return {
      ok: false,
      capability: buildFailedCapability(request, previous),
      reasons: [`node bootstrap installer requires install metadata for ${request.capabilityId}`],
    };
  }
  const parsedSpec = parseRegistryNpmSpec(packageRef);
  if (!parsedSpec || parsedSpec.selectorKind !== "exact-version") {
    return {
      ok: false,
      capability: buildFailedCapability(request, previous),
      reasons: [
        `node bootstrap installer requires an exact npm registry packageRef for ${request.capabilityId}`,
      ],
    };
  }

  const result = await installFromValidatedNpmSpecArchive<NodeInstallerFlowResult, { archivePath: string }>({
    spec: packageRef,
    timeoutMs: NODE_INSTALL_TIMEOUT_MS,
    tempDirPrefix: "openclaw-bootstrap-node-pack-",
    expectedIntegrity: install.integrity,
    archiveInstallParams: {},
    installFromArchive: async ({ archivePath }) =>
      await withExtractedArchiveRoot({
        archivePath,
        tempDirPrefix: "openclaw-bootstrap-node-extract-",
        timeoutMs: NODE_INSTALL_TIMEOUT_MS,
        rootMarkers: ["package.json"],
        onExtracted: async (rootDir) => {
          const manifest = await readNodePackageManifest(rootDir);
          if (manifest.name !== parsedSpec.name) {
            return {
              ok: false,
              error: `node bootstrap package mismatch: expected ${parsedSpec.name}, got ${manifest.name}`,
            };
          }
          const targetDir = resolvePlatformBootstrapNodeCapabilityInstallDir({
            capabilityId: request.capabilityId,
            stateDir,
          });
          const installResult = await installPackageDirWithManifestDeps({
            sourceDir: rootDir,
            targetDir,
            mode: previous ? "update" : "install",
            timeoutMs: NODE_INSTALL_TIMEOUT_MS,
            copyErrorPrefix: `failed to install capability ${request.capabilityId}`,
            depsLogMessage: `Installing ${manifest.name} dependencies…`,
            manifestDependencies: manifest.dependencies,
          });
          if (!installResult.ok) {
            return installResult;
          }
          const healthCheckCommand = await writeNodeHealthCheckScript({
            targetDir,
            packageName: manifest.name,
            capabilityId: request.capabilityId,
          });
          return {
            ok: true as const,
            capability: buildInstalledCapability(request, {
              version: manifest.version ?? parsedSpec.selector,
              requiredBins: ["node"],
              healthCheckCommand,
              sandboxed: true,
            }),
          };
        },
      }),
  });

  if (!result.ok) {
    return {
      ok: false,
      capability: buildFailedCapability(request, previous),
      reasons: [result.error],
    };
  }

  return {
    ok: true,
    capability: result.capability,
  };
};

const UNSUPPORTED_INSTALLER: BootstrapInstaller = async ({ request, previous }) => ({
  ok: false,
  capability: buildFailedCapability(request, previous),
  reasons: [`bootstrap installer for ${request.installMethod} is not implemented`],
});

const DEFAULT_INSTALLERS: Record<CapabilityInstallMethod, BootstrapInstaller> = {
  brew: UNSUPPORTED_INSTALLER,
  node: NODE_INSTALLER,
  go: UNSUPPORTED_INSTALLER,
  uv: UNSUPPORTED_INSTALLER,
  download: UNSUPPORTED_INSTALLER,
  docker: UNSUPPORTED_INSTALLER,
  builtin: BUILTIN_INSTALLER,
};

export async function installCapabilityRequest(params: {
  request: BootstrapRequest;
  previous?: CapabilityDescriptor;
  stateDir?: string;
  installers?: Partial<Record<CapabilityInstallMethod, BootstrapInstaller>>;
}): Promise<{ ok: boolean; capability: CapabilityDescriptor; reasons: string[] }> {
  const installer =
    params.installers?.[params.request.installMethod] ??
    DEFAULT_INSTALLERS[params.request.installMethod];
  const result = await installer({
    request: params.request,
    previous: params.previous,
    stateDir: params.stateDir,
  });
  return {
    ok: result.ok,
    capability: result.capability,
    reasons: result.reasons ?? [],
  };
}
