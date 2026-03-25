import type { CapabilityDescriptor, CapabilityInstallMethod } from "../schemas/capability.js";
import type { BootstrapRequest } from "./contracts.js";

export type BootstrapInstaller = (params: {
  request: BootstrapRequest;
  previous?: CapabilityDescriptor;
}) => Promise<{ capability: CapabilityDescriptor; reasons?: string[] }>;

function buildInstalledCapability(request: BootstrapRequest): CapabilityDescriptor {
  return {
    ...request.catalogEntry.capability,
    status: "available",
    version:
      request.catalogEntry.capability.version ??
      request.catalogEntry.packageRef?.split("@").at(-1) ??
      request.catalogEntry.capability.version,
  };
}

const BUILTIN_INSTALLER: BootstrapInstaller = async ({ request }) => ({
  capability: buildInstalledCapability(request),
});

const STUB_INSTALLER: BootstrapInstaller = async ({ request }) => ({
  capability: buildInstalledCapability(request),
  reasons: [`stub installer used for ${request.installMethod}`],
});

const DEFAULT_INSTALLERS: Record<CapabilityInstallMethod, BootstrapInstaller> = {
  brew: STUB_INSTALLER,
  node: STUB_INSTALLER,
  go: STUB_INSTALLER,
  uv: STUB_INSTALLER,
  download: STUB_INSTALLER,
  docker: STUB_INSTALLER,
  builtin: BUILTIN_INSTALLER,
};

export async function installCapabilityRequest(params: {
  request: BootstrapRequest;
  previous?: CapabilityDescriptor;
  installers?: Partial<Record<CapabilityInstallMethod, BootstrapInstaller>>;
}): Promise<{ capability: CapabilityDescriptor; reasons: string[] }> {
  const installer =
    params.installers?.[params.request.installMethod] ??
    DEFAULT_INSTALLERS[params.request.installMethod];
  const result = await installer({
    request: params.request,
    previous: params.previous,
  });
  return {
    capability: result.capability,
    reasons: result.reasons ?? [],
  };
}
