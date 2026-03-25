import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_GATEWAY_PORT } from "../../config/paths.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import {
  MaterializationResultSchema,
  type MaterializationResult,
} from "../materialization/contracts.js";
import { createArtifactStore } from "../registry/artifact-store.js";
import type { ArtifactStore } from "../registry/types.js";
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
  transition: (artifactId: string, operation: ArtifactOperation) => ArtifactDescriptor | undefined;
  rehydrate: () => number;
};

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
  return ArtifactRecordSummarySchema.parse({
    id: record.descriptor.id,
    kind: record.descriptor.kind,
    label: record.descriptor.label,
    lifecycle: record.descriptor.lifecycle,
    mimeType: record.descriptor.mimeType,
    sizeBytes: record.descriptor.sizeBytes,
    url: record.descriptor.url,
    previewUrl: record.access.previewUrl,
    contentUrl: record.access.contentUrl,
    sourceRecipeId: record.descriptor.sourceRecipeId,
    publishTarget: record.descriptor.publishTarget,
    createdAt: record.descriptor.createdAt,
    updatedAt: record.descriptor.updatedAt,
    hasMaterialization: Boolean(record.materialization),
  });
}

function buildRecordDetail(record: PersistedArtifactRecord): ArtifactRecordDetail {
  return ArtifactRecordDetailSchema.parse({
    descriptor: record.descriptor,
    materialization: record.materialization,
    previewUrl: record.access.previewUrl,
    contentUrl: record.access.contentUrl,
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

  return {
    configure(params) {
      if (params.stateDir) {
        stateDir = params.stateDir;
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
    transition(artifactId, operation) {
      const transitioned = store.transition(artifactId, operation);
      if (!transitioned) {
        return undefined;
      }
      return upsertRecord(transitioned);
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
