import { randomUUID } from "node:crypto";
import { applyTaskOverlay } from "../profile/overlay.js";
import { getInitialProfile } from "../profile/defaults.js";
import { createCapabilityRegistry } from "../registry/capability-registry.js";
import type { CapabilityRegistry } from "../registry/types.js";
import type { PolicyContext } from "../policy/types.js";
import type { CapabilityInstallMethod } from "../schemas/capability.js";
import { TRUSTED_CAPABILITY_CATALOG } from "./defaults.js";
import type { BootstrapInstaller } from "./installers.js";
import { orchestrateBootstrapRequest } from "./orchestrator.js";
import {
  BootstrapRequestRecordDetailSchema,
  BootstrapRequestRecordSchema,
  BootstrapRequestRecordSummarySchema,
  type BootstrapOrchestrationResult,
  type BootstrapRequest,
  type BootstrapRequestDecision,
  type BootstrapRequestRecord,
  type BootstrapRequestRecordDetail,
  type BootstrapRequestRecordSummary,
} from "./contracts.js";

export type BootstrapRequestService = {
  create: (request: BootstrapRequest) => BootstrapRequestRecord;
  list: () => BootstrapRequestRecordSummary[];
  get: (id: string) => BootstrapRequestRecordDetail | undefined;
  resolve: (id: string, decision: BootstrapRequestDecision) => BootstrapRequestRecordDetail | undefined;
  run: (params: {
    id: string;
    installers?: Partial<Record<CapabilityInstallMethod, BootstrapInstaller>>;
    availableBins?: string[];
    availableEnv?: string[];
    runHealthCheckCommand?: (command: string) => Promise<boolean> | boolean;
  }) => Promise<BootstrapRequestRecordDetail | undefined>;
  pendingCount: () => number;
  reset: () => void;
};

function toSummary(record: BootstrapRequestRecord): BootstrapRequestRecordSummary {
  return BootstrapRequestRecordSummarySchema.parse({
    id: record.id,
    capabilityId: record.request.capabilityId,
    installMethod: record.request.installMethod,
    reason: record.request.reason,
    sourceDomain: record.request.sourceDomain,
    ...(record.request.sourceRecipeId ? { sourceRecipeId: record.request.sourceRecipeId } : {}),
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.result ? { lastResultStatus: record.result.status } : {}),
    hasResult: Boolean(record.result),
    ...(record.reasons?.[0] ? { lastError: record.reasons[0] } : {}),
  });
}

function buildRecordSignature(request: BootstrapRequest): string {
  return [
    request.capabilityId,
    request.installMethod,
    request.reason,
    request.sourceDomain,
    request.sourceRecipeId ?? "",
  ].join("::");
}

function buildBootstrapPolicyContext(request: BootstrapRequest, explicitApproval: boolean): PolicyContext {
  if (request.sourceDomain === "document") {
    const profile = getInitialProfile("builder");
    const overlay = profile?.taskOverlays?.find((entry) => entry.id === "document_first");
    if (profile) {
      return {
        activeProfileId: profile.id,
        activeProfile: profile,
        activeStateTaskOverlay: overlay?.id,
        effective: applyTaskOverlay(profile, overlay),
        intent: "document",
        explicitApproval,
      };
    }
  }
  if (request.sourceDomain === "developer") {
    const profile = getInitialProfile("developer");
    const overlay = profile?.taskOverlays?.find((entry) => entry.id === "code_first");
    if (profile) {
      return {
        activeProfileId: profile.id,
        activeProfile: profile,
        activeStateTaskOverlay: overlay?.id,
        effective: applyTaskOverlay(profile, overlay),
        intent: "code",
        explicitApproval,
      };
    }
  }
  const profile = getInitialProfile("general");
  const overlay = profile?.taskOverlays?.find((entry) => entry.id === "general_chat");
  if (!profile) {
    throw new Error("general profile unavailable");
  }
  return {
    activeProfileId: profile.id,
    activeProfile: profile,
    activeStateTaskOverlay: overlay?.id,
    effective: applyTaskOverlay(profile, overlay),
    intent: "general",
    explicitApproval,
  };
}

export function createBootstrapRequestService(params?: {
  registry?: CapabilityRegistry;
}): BootstrapRequestService {
  const records = new Map<string, BootstrapRequestRecord>();
  const registry = params?.registry ?? createCapabilityRegistry([], TRUSTED_CAPABILITY_CATALOG);

  return {
    create(request) {
      const now = new Date().toISOString();
      const normalizedRequest = request;
      const signature = buildRecordSignature(normalizedRequest);
      const existing = Array.from(records.values()).find((record) => {
        return (
          buildRecordSignature(record.request) === signature &&
          (record.state === "pending" || record.state === "approved" || record.state === "running")
        );
      });
      if (existing) {
        const updated = BootstrapRequestRecordSchema.parse({
          ...existing,
          updatedAt: now,
        });
        records.set(updated.id, updated);
        return updated;
      }
      const record = BootstrapRequestRecordSchema.parse({
        id: randomUUID(),
        state: "pending",
        request: normalizedRequest,
        createdAt: now,
        updatedAt: now,
      });
      records.set(record.id, record);
      return record;
    },
    list() {
      return Array.from(records.values())
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((record) => toSummary(record));
    },
    get(id) {
      const record = records.get(id);
      return record ? BootstrapRequestRecordDetailSchema.parse(record) : undefined;
    },
    resolve(id, decision) {
      const existing = records.get(id);
      if (!existing) {
        return undefined;
      }
      const now = new Date().toISOString();
      const updated = BootstrapRequestRecordSchema.parse({
        ...existing,
        state: decision === "approve" ? "approved" : "denied",
        updatedAt: now,
        resolvedAt: now,
        ...(decision === "deny"
          ? { reasons: ["operator denied bootstrap request"] }
          : { reasons: existing.reasons }),
      });
      records.set(id, updated);
      return BootstrapRequestRecordDetailSchema.parse(updated);
    },
    async run(runParams) {
      const existing = records.get(runParams.id);
      if (!existing) {
        return undefined;
      }
      if (existing.state !== "approved") {
        const blocked = BootstrapRequestRecordSchema.parse({
          ...existing,
          updatedAt: new Date().toISOString(),
          reasons: [`bootstrap request must be approved before run (current state: ${existing.state})`],
        });
        records.set(blocked.id, blocked);
        return BootstrapRequestRecordDetailSchema.parse(blocked);
      }
      const startedAt = new Date().toISOString();
      const running = BootstrapRequestRecordSchema.parse({
        ...existing,
        state: "running",
        updatedAt: startedAt,
        startedAt,
      });
      records.set(running.id, running);
      const policyContext = buildBootstrapPolicyContext(running.request, true);
      const result = await orchestrateBootstrapRequest({
        request: running.request,
        policyContext,
        registry,
        installers: runParams.installers,
        availableBins: runParams.availableBins,
        availableEnv: runParams.availableEnv,
        runHealthCheckCommand: runParams.runHealthCheckCommand,
      });
      const completedAt = new Date().toISOString();
      const nextState = result.status === "bootstrapped" ? "available" : "degraded";
      const updated = BootstrapRequestRecordSchema.parse({
        ...running,
        state: nextState,
        updatedAt: completedAt,
        completedAt,
        result,
        reasons: result.reasons,
      });
      records.set(updated.id, updated);
      return BootstrapRequestRecordDetailSchema.parse(updated);
    },
    pendingCount() {
      return Array.from(records.values()).filter((record) => record.state === "pending").length;
    },
    reset() {
      records.clear();
    },
  };
}

let sharedBootstrapRequestService: BootstrapRequestService | null = null;

export function getPlatformBootstrapService(): BootstrapRequestService {
  if (!sharedBootstrapRequestService) {
    sharedBootstrapRequestService = createBootstrapRequestService();
  }
  return sharedBootstrapRequestService;
}

export function resetPlatformBootstrapService(): void {
  sharedBootstrapRequestService?.reset();
  sharedBootstrapRequestService = null;
}

export type { BootstrapOrchestrationResult };
