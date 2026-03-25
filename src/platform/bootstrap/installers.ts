import type { CapabilityDescriptor, CapabilityInstallMethod } from "../schemas/capability.js";
import type { BootstrapRequest } from "./contracts.js";

export type BootstrapInstaller = (params: {
  request: BootstrapRequest;
  previous?: CapabilityDescriptor;
}) => Promise<{ ok: boolean; capability: CapabilityDescriptor; reasons?: string[] }>;

function buildInstalledCapability(request: BootstrapRequest): CapabilityDescriptor {
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

const UNSUPPORTED_INSTALLER: BootstrapInstaller = async ({ request, previous }) => ({
  ok: false,
  capability: buildFailedCapability(request, previous),
  reasons: [`bootstrap installer for ${request.installMethod} is not implemented`],
});

const DEFAULT_INSTALLERS: Record<CapabilityInstallMethod, BootstrapInstaller> = {
  brew: UNSUPPORTED_INSTALLER,
  node: UNSUPPORTED_INSTALLER,
  go: UNSUPPORTED_INSTALLER,
  uv: UNSUPPORTED_INSTALLER,
  download: UNSUPPORTED_INSTALLER,
  docker: UNSUPPORTED_INSTALLER,
  builtin: BUILTIN_INSTALLER,
};

export async function installCapabilityRequest(params: {
  request: BootstrapRequest;
  previous?: CapabilityDescriptor;
  installers?: Partial<Record<CapabilityInstallMethod, BootstrapInstaller>>;
}): Promise<{ ok: boolean; capability: CapabilityDescriptor; reasons: string[] }> {
  const installer =
    params.installers?.[params.request.installMethod] ??
    DEFAULT_INSTALLERS[params.request.installMethod];
  const result = await installer({
    request: params.request,
    previous: params.previous,
  });
  return {
    ok: result.ok,
    capability: result.capability,
    reasons: result.reasons ?? [],
  };
}
