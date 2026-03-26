import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_GATEWAY_PORT } from "../../config/paths.js";
import { getAgentRunContext } from "../../infra/agent-events.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import {
  PlatformExecutionContextSnapshotSchema,
  type PlatformExecutionContextSnapshot,
} from "../decision/contracts.js";
import {
  MaterializationResultSchema,
  type MaterializationResult,
} from "../materialization/contracts.js";
import { evaluatePolicy } from "../policy/engine.js";
import { buildPolicyContextFromExecutionContext } from "../recipe/runtime-adapter.js";
import { createArtifactStore } from "../registry/artifact-store.js";
import type { ArtifactStore } from "../registry/types.js";
import { getPlatformRuntimeCheckpointService } from "../runtime/index.js";
import {
  ArtifactDescriptorSchema,
  type ArtifactDescriptor,
  type ArtifactOperation,
} from "../schemas/artifact.js";
import {
  ArtifactRecordDetailSchema,
  ArtifactRecordSummarySchema,
  PersistedArtifactRecordSchema,
  type ArtifactRecordDetail,
  type ArtifactRecordSummary,
  type PersistedArtifactRecord,
} from "./contracts.js";
import {
  resolveArtifactDirectory,
  resolveArtifactMetadataPath,
  resolvePlatformArtifactsRoot,
} from "./paths.js";

type ArtifactServiceConfig = {
  config?: OpenClawConfig;
  stateDir?: string;
  gatewayBaseUrl?: string;
  gatewayPort?: number;
};

export type ArtifactService = {
  configure: (params: ArtifactServiceConfig) => void;
  getRootDir: () => string;
  resolveOutputDir: (artifactId: string) => string;
  register: (descriptor: ArtifactDescriptor) => ArtifactDescriptor;
  get: (artifactId: string) => ArtifactDescriptor | undefined;
  getRecord: (artifactId: string) => PersistedArtifactRecord | undefined;
  getDetail: (artifactId: string) => ArtifactRecordDetail | undefined;
  list: () => ArtifactRecordSummary[];
  update: (
    artifactId: string,
    patch: Partial<ArtifactDescriptor>,
  ) => ArtifactDescriptor | undefined;
  transition: (
    artifactId: string,
    operation: ArtifactOperation,
    opts?: { explicitApproval?: boolean },
  ) =>
    | { ok: true; descriptor: ArtifactDescriptor }
    | { ok: false; code: "not_found" | "denied"; reason: string };
  rehydrate: () => number;
};

function resolveArtifactRunId(descriptor: ArtifactDescriptor): string | undefined {
  const runId = descriptor.metadata?.runId;
  return typeof runId === "string" && runId.trim().length > 0 ? runId.trim() : undefined;
}

function resolveArtifactExecutionContext(
  descriptor: ArtifactDescriptor,
): PlatformExecutionContextSnapshot | undefined {
  const parsedMetadataContext = PlatformExecutionContextSnapshotSchema.safeParse(
    descriptor.metadata?.platformExecution,
  );
  if (parsedMetadataContext.success) {
    return parsedMetadataContext.data;
  }
  const runId = resolveArtifactRunId(descriptor);
  const runContextExecution = runId ? getAgentRunContext(runId)?.platformExecution : undefined;
  const parsedRunContext = PlatformExecutionContextSnapshotSchema.safeParse(runContextExecution);
  return parsedRunContext.success ? parsedRunContext.data : undefined;
}

function resolveArtifactPolicy(descriptor: ArtifactDescriptor, explicitApproval = false) {
  const executionContext = resolveArtifactExecutionContext(descriptor);
  if (!executionContext) {
    return { executionContext: undefined, decision: undefined };
  }
  const policyContext = buildPolicyContextFromExecutionContext(executionContext, {
    artifactKinds: [descriptor.kind],
    explicitApproval,
  });
  if (!policyContext) {
    return { executionContext, decision: undefined };
  }
  if ((executionContext.publishTargets?.length ?? 0) > 0 || descriptor.publishTarget) {
    policyContext.publishTargets = Array.from(
      new Set([...(policyContext.publishTargets ?? []), ...(executionContext.publishTargets ?? [])]),
    );
    if (descriptor.publishTarget) {
      policyContext.publishTargets.push(descriptor.publishTarget);
      policyContext.publishTargets = Array.from(new Set(policyContext.publishTargets));
    }
  }
  return { executionContext, decision: evaluatePolicy(policyContext) };
}

function resolveArtifactCheckpointId(artifactId: string, operation: ArtifactOperation): string {
  return `${artifactId}:${operation}`;
}

function normalizeGatewayBaseUrl(raw: string): string {
  const parsed = new URL(raw);
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString().replace(/\/+$/u, "");
}

function resolveGatewayBaseUrl(params: ArtifactServiceConfig): string {
  if (params.gatewayBaseUrl) {
    return normalizeGatewayBaseUrl(params.gatewayBaseUrl);
  }
  const scheme = params.config?.gateway?.tls?.enabled ? "https" : "http";
  const port =
    params.gatewayPort ??
    (typeof params.config?.gateway?.port === "number" ? params.config.gateway.port : undefined) ??
    DEFAULT_GATEWAY_PORT;
  const customHost = params.config?.gateway?.customBindHost?.trim();
  const host = params.config?.gateway?.bind === "custom" && customHost ? customHost : "127.0.0.1";
  return `${scheme}://${host}:${String(port)}`;
}

function readMaterializationFromDescriptor(
  descriptor: ArtifactDescriptor,
): MaterializationResult | undefined {
  const candidate = descriptor.metadata?.materialization;
  const parsed = MaterializationResultSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function buildPreviewUrl(baseUrl: string, artifactId: string, token: string): string {
  return new URL(
    `/platform/artifacts/preview/${encodeURIComponent(artifactId)}/${encodeURIComponent(token)}`,
    baseUrl,
  ).toString();
}

function buildContentUrl(baseUrl: string, artifactId: string, token: string): string {
  return new URL(
    `/platform/artifacts/content/${encodeURIComponent(artifactId)}/${encodeURIComponent(token)}`,
    baseUrl,
  ).toString();
}

function rewriteMaterializationUrls(params: {
  descriptor: ArtifactDescriptor;
  materialization?: MaterializationResult;
  token: string;
  baseUrl: string;
}): {
  descriptor: ArtifactDescriptor;
  materialization?: MaterializationResult;
  previewUrl?: string;
  contentUrl?: string;
} {
  const { descriptor, materialization, token, baseUrl } = params;
  if (!materialization) {
    return { descriptor };
  }

  const previewUrl =
    materialization.primary.outputTarget === "preview"
      ? buildPreviewUrl(baseUrl, descriptor.id, token)
      : undefined;
  const contentUrl = descriptor.path ? buildContentUrl(baseUrl, descriptor.id, token) : undefined;

  const rewritten: MaterializationResult = {
    ...materialization,
    primary: {
      ...materialization.primary,
      ...(previewUrl ? { url: previewUrl } : {}),
    },
  };

  const nextDescriptor: ArtifactDescriptor = {
    ...descriptor,
    url:
      descriptor.url && !descriptor.url.startsWith("file://")
        ? descriptor.url
        : (previewUrl ?? descriptor.url),
    metadata: {
      ...descriptor.metadata,
      materialization: rewritten,
      ...(contentUrl ? { artifactContentUrl: contentUrl } : {}),
      ...(previewUrl ? { artifactPreviewUrl: previewUrl } : {}),
    },
  };
  return { descriptor: nextDescriptor, materialization: rewritten, previewUrl, contentUrl };
}

function buildRecordSummary(record: PersistedArtifactRecord): ArtifactRecordSummary {
  const metadata = record.descriptor.metadata ?? {};
  const artifactType =
    typeof metadata.documentArtifactType === "string"
      ? metadata.documentArtifactType
      : typeof metadata.developerArtifactType === "string"
        ? metadata.developerArtifactType
        : undefined;
  const runId = typeof metadata.runId === "string" ? metadata.runId : undefined;
  return ArtifactRecordSummarySchema.parse({
    id: record.descriptor.id,
    kind: record.descriptor.kind,
    label: record.descriptor.label,
    lifecycle: record.descriptor.lifecycle,
    artifactType,
    mimeType: record.descriptor.mimeType,
    sizeBytes: record.descriptor.sizeBytes,
    url: record.descriptor.url,
    previewUrl: record.access.previewUrl,
    contentUrl: record.access.contentUrl,
    previewAvailable: Boolean(record.access.previewUrl),
    contentAvailable: Boolean(record.access.contentUrl),
    sourceRecipeId: record.descriptor.sourceRecipeId,
    publishTarget: record.descriptor.publishTarget,
    runId,
    createdAt: record.descriptor.createdAt,
    updatedAt: record.descriptor.updatedAt,
    hasMaterialization: Boolean(record.materialization),
  });
}

function buildRecordDetail(record: PersistedArtifactRecord): ArtifactRecordDetail {
  const metadata = record.descriptor.metadata ?? {};
  const artifactType =
    typeof metadata.documentArtifactType === "string"
      ? metadata.documentArtifactType
      : typeof metadata.developerArtifactType === "string"
        ? metadata.developerArtifactType
        : undefined;
  const runId = typeof metadata.runId === "string" ? metadata.runId : undefined;
  return ArtifactRecordDetailSchema.parse({
    descriptor: record.descriptor,
    materialization: record.materialization,
    artifactType,
    runId,
    previewUrl: record.access.previewUrl,
    contentUrl: record.access.contentUrl,
    previewAvailable: Boolean(record.access.previewUrl),
    contentAvailable: Boolean(record.access.contentUrl),
    warnings: record.materialization?.warnings,
  });
}

function writeRecordFile(filePath: string, record: PersistedArtifactRecord): void {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

export function createArtifactService(initial?: ArtifactServiceConfig): ArtifactService {
  let stateDir = initial?.stateDir;
  let config = initial?.config;
  let gatewayBaseUrl = initial?.gatewayBaseUrl;
  let gatewayPort = initial?.gatewayPort;
  let store: ArtifactStore = createArtifactStore();
  let records = new Map<string, PersistedArtifactRecord>();
  const runtimeCheckpointService = getPlatformRuntimeCheckpointService({
    ...(initial?.stateDir ? { stateDir: initial.stateDir } : {}),
  });

  function ensureRootDir(): string {
    const rootDir = resolvePlatformArtifactsRoot(stateDir);
    fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    return rootDir;
  }

  function persistRecord(record: PersistedArtifactRecord): PersistedArtifactRecord {
    ensureRootDir();
    const artifactDir = resolveArtifactDirectory({ artifactId: record.descriptor.id, stateDir });
    fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    const persisted = PersistedArtifactRecordSchema.parse(record);
    writeRecordFile(
      resolveArtifactMetadataPath({ artifactId: persisted.descriptor.id, stateDir }),
      persisted,
    );
    return persisted;
  }

  function upsertRecord(descriptorInput: ArtifactDescriptor): ArtifactDescriptor {
    const descriptor = ArtifactDescriptorSchema.parse(descriptorInput);
    const policy = resolveArtifactPolicy(descriptor);
    if (policy.decision && !policy.decision.allowArtifactPersistence) {
      return descriptor;
    }
    const existing = records.get(descriptor.id);
    const token = existing?.access.token ?? generateSecureToken(18);
    const materialization = readMaterializationFromDescriptor(descriptor);
    const baseUrl = resolveGatewayBaseUrl({
      config,
      stateDir,
      gatewayBaseUrl,
      gatewayPort,
    });
    const rewritten = rewriteMaterializationUrls({
      descriptor,
      materialization,
      token,
      baseUrl,
    });
    const record = persistRecord({
      version: 1,
      descriptor: rewritten.descriptor,
      ...(rewritten.materialization ? { materialization: rewritten.materialization } : {}),
      access: {
        token,
        ...(rewritten.previewUrl ? { previewUrl: rewritten.previewUrl } : {}),
        ...(rewritten.contentUrl ? { contentUrl: rewritten.contentUrl } : {}),
      },
    });

    if (existing) {
      store.update(record.descriptor.id, record.descriptor);
    } else {
      store.create(record.descriptor);
    }
    records.set(record.descriptor.id, record);
    return record.descriptor;
  }

  function replaceState(nextRecords: PersistedArtifactRecord[]): void {
    records = new Map(nextRecords.map((record) => [record.descriptor.id, record]));
    store = createArtifactStore(nextRecords.map((record) => record.descriptor));
  }

  const service: ArtifactService = {
    configure(params) {
      if (params.stateDir) {
        stateDir = params.stateDir;
        runtimeCheckpointService.configure({ stateDir: params.stateDir });
      }
      if (params.config) {
        config = params.config;
      }
      if (params.gatewayBaseUrl) {
        gatewayBaseUrl = params.gatewayBaseUrl;
      }
      if (typeof params.gatewayPort === "number") {
        gatewayPort = params.gatewayPort;
      }
    },
    getRootDir() {
      return ensureRootDir();
    },
    resolveOutputDir(artifactId) {
      return resolveArtifactDirectory({ artifactId, stateDir });
    },
    register(descriptor) {
      return upsertRecord(descriptor);
    },
    get(artifactId) {
      return store.get(artifactId);
    },
    getRecord(artifactId) {
      return records.get(artifactId);
    },
    getDetail(artifactId) {
      const record = records.get(artifactId);
      return record ? buildRecordDetail(record) : undefined;
    },
    list() {
      return Array.from(records.values())
        .map((record) => buildRecordSummary(record))
        .toSorted((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
    },
    update(artifactId, patch) {
      const existing = store.get(artifactId);
      if (!existing) {
        return undefined;
      }
      return upsertRecord({
        ...existing,
        ...patch,
        id: artifactId,
      });
    },
    transition(artifactId, operation, opts) {
      const existing = store.get(artifactId);
      if (!existing) {
        return {
          ok: false,
          code: "not_found",
          reason: "artifact not found",
        };
      }
      const policy = resolveArtifactPolicy(
        existing,
        opts?.explicitApproval ?? (operation === "publish" || operation === "approve"),
      );
      const checkpointId = resolveArtifactCheckpointId(artifactId, operation);
      if (policy.executionContext && (operation === "publish" || operation === "approve")) {
        if ((policy.executionContext.publishTargets?.length ?? 0) === 0) {
          runtimeCheckpointService.createCheckpoint({
            id: checkpointId,
            runId: resolveArtifactRunId(existing) ?? checkpointId,
            boundary: "artifact_publish",
            blockedReason:
              "artifact publish transition requires publish intent in the frozen execution context",
            nextActions: [
              {
                method: "platform.artifacts.transition",
                label: "Retry artifact transition after explicit approval",
                phase: "retry",
              },
            ],
            target: {
              artifactId,
              operation,
            },
            continuation: {
              kind: "artifact_transition",
              state: "idle",
              attempts: 0,
            },
            executionContext: policy.executionContext,
          });
          return {
            ok: false,
            code: "denied",
            reason: "artifact publish transition requires publish intent in the frozen execution context",
          };
        }
      }
      if (policy.decision) {
        if ((operation === "publish" || operation === "approve") && !policy.decision.allowPublish) {
          runtimeCheckpointService.createCheckpoint({
            id: checkpointId,
            runId: resolveArtifactRunId(existing) ?? checkpointId,
            boundary: "artifact_publish",
            blockedReason:
              policy.decision.deniedReasons[0] ??
              "artifact publish transition denied by platform execution policy",
            deniedReasons: policy.decision.deniedReasons,
            nextActions: [
              {
                method: "platform.artifacts.transition",
                label: "Retry artifact transition after explicit approval",
                phase: "retry",
              },
            ],
            target: {
              artifactId,
              operation,
            },
            continuation: {
              kind: "artifact_transition",
              state: "idle",
              attempts: 0,
            },
            executionContext: policy.executionContext,
          });
          return {
            ok: false,
            code: "denied",
            reason:
              policy.decision.deniedReasons[0] ??
              "artifact publish transition denied by platform execution policy",
          };
        }
        if (operation === "preview" && !policy.decision.allowArtifactPersistence) {
          return {
            ok: false,
            code: "denied",
            reason:
              policy.decision.deniedReasons[0] ??
              "artifact preview transition denied by platform execution policy",
          };
        }
      }
      const transitioned = store.transition(artifactId, operation);
      if (!transitioned) {
        return {
          ok: false,
          code: "not_found",
          reason: "artifact not found",
        };
      }
      if (operation === "publish" || operation === "approve") {
        runtimeCheckpointService.updateCheckpoint(checkpointId, {
          status: "completed",
          completedAtMs: Date.now(),
        });
      }
      return {
        ok: true,
        descriptor: upsertRecord(transitioned),
      };
    },
    rehydrate() {
      const rootDir = ensureRootDir();
      const entries = fs.readdirSync(rootDir, { withFileTypes: true });
      const nextRecords: PersistedArtifactRecord[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const metaPath = path.join(rootDir, entry.name, "meta.json");
        if (!fs.existsSync(metaPath)) {
          continue;
        }
        try {
          const raw = JSON.parse(fs.readFileSync(metaPath, "utf8")) as unknown;
          nextRecords.push(PersistedArtifactRecordSchema.parse(raw));
        } catch {}
      }
      replaceState(nextRecords);
      return nextRecords.length;
    },
  };
  runtimeCheckpointService.registerContinuationHandler("artifact_transition", async (checkpoint) => {
    const artifactId = checkpoint.target?.artifactId;
    const operation = checkpoint.target?.operation;
    if (!artifactId || !operation) {
      return;
    }
    service.transition(artifactId, operation as ArtifactOperation, {
      explicitApproval: true,
    });
  });
  return service;
}

let platformArtifactService: ArtifactService | null = null;

export function getPlatformArtifactService(config?: ArtifactServiceConfig): ArtifactService {
  if (!platformArtifactService) {
    platformArtifactService = createArtifactService(config);
  } else if (config) {
    platformArtifactService.configure(config);
  }
  return platformArtifactService;
}

export function resetPlatformArtifactService(): void {
  platformArtifactService = null;
}
