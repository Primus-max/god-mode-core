import { createArtifactStore } from "../registry/artifact-store.js";
import type { ArtifactDescriptor, ArtifactKind, ArtifactLifecycle } from "../schemas/artifact.js";
import { DeveloperArtifactPayloadSchema, type DeveloperArtifactPayload } from "./artifacts.js";
import { DeveloperPublishTargetSchema } from "./contracts.js";
import { materializeDeveloperDescriptor } from "./materialize.js";

const DeveloperArtifactEnvelopeSchema = {
  parse(value: unknown): {
    route?: "code_build_publish";
    artifacts: DeveloperArtifactPayload[];
  } | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("developer artifact envelope must be an object");
    }
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record.artifacts)) {
      return null;
    }
    const artifacts = Array.isArray(record.artifacts)
      ? record.artifacts.map((entry) => DeveloperArtifactPayloadSchema.parse(entry))
      : [];
    const route = record.route === "code_build_publish" ? "code_build_publish" : undefined;
    return { route, artifacts };
  },
};

let developerArtifactStore = createArtifactStore();

function resolveArtifactKind(payload: DeveloperArtifactPayload): ArtifactKind {
  if (payload.type === "preview") {
    return "site";
  }
  if (payload.type === "binary") {
    return "binary";
  }
  return "release";
}

function resolveArtifactLifecycle(payload: DeveloperArtifactPayload): ArtifactLifecycle {
  if (payload.type === "preview") {
    return "preview";
  }
  if (payload.type === "release" && payload.published) {
    return "published";
  }
  return "draft";
}

function buildArtifactLabel(payload: DeveloperArtifactPayload, index: number): string {
  if (payload.type === "preview") {
    return payload.label ?? `Preview ${payload.target.toUpperCase()} ${String(index)}`;
  }
  if (payload.type === "binary") {
    return payload.label;
  }
  return payload.label ?? `Release ${payload.version}`;
}

function buildArtifactMetadata(payload: DeveloperArtifactPayload, runId: string) {
  return {
    developerArtifactType: payload.type,
    stage: payload.stage,
    runId,
    normalizedDeveloperPayload: payload,
  };
}

export function extractDeveloperArtifactPayloads(
  assistantTexts: string[],
): DeveloperArtifactPayload[] {
  const payloads: DeveloperArtifactPayload[] = [];
  for (const text of assistantTexts) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const envelope = DeveloperArtifactEnvelopeSchema.parse(parsed);
      if (!envelope) {
        throw new Error("not an envelope");
      }
      if (envelope.route && envelope.route !== "code_build_publish") {
        continue;
      }
      payloads.push(...envelope.artifacts);
      continue;
    } catch {}
    try {
      payloads.push(DeveloperArtifactPayloadSchema.parse(JSON.parse(trimmed)));
    } catch {}
  }
  return payloads;
}

export function projectDeveloperArtifacts(params: {
  sessionId: string;
  runId: string;
  payloads: DeveloperArtifactPayload[];
  materialize?: boolean;
}): ArtifactDescriptor[] {
  return params.payloads.map((payload, index) => {
    const descriptor: ArtifactDescriptor = {
      id: `${params.sessionId}:${params.runId}:developer:${index + 1}`,
      kind: resolveArtifactKind(payload),
      label: buildArtifactLabel(payload, index + 1),
      lifecycle: resolveArtifactLifecycle(payload),
      mimeType: payload.type === "binary" ? payload.mimeType : undefined,
      sizeBytes: payload.type === "binary" ? payload.sizeBytes : undefined,
      path: payload.type === "binary" ? payload.path : undefined,
      url: payload.url,
      sourceRecipeId: "code_build_publish",
      publishTarget:
        "target" in payload ? DeveloperPublishTargetSchema.parse(payload.target) : undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: buildArtifactMetadata(payload, params.runId),
    };
    if (params.materialize === false) {
      return descriptor;
    }
    return materializeDeveloperDescriptor({
      descriptor,
      payload,
    });
  });
}

export function captureDeveloperArtifactsFromLlmOutput(params: {
  runId: string;
  sessionId: string;
  assistantTexts: string[];
  recipeId?: string;
  materialize?: boolean;
}): ArtifactDescriptor[] {
  if (params.recipeId && params.recipeId !== "code_build_publish") {
    return [];
  }
  const payloads = extractDeveloperArtifactPayloads(params.assistantTexts);
  const artifacts = projectDeveloperArtifacts({
    sessionId: params.sessionId,
    runId: params.runId,
    payloads,
    materialize: params.materialize,
  });
  for (const artifact of artifacts) {
    developerArtifactStore.create(artifact);
  }
  return artifacts;
}

export function listCapturedDeveloperArtifacts(): ArtifactDescriptor[] {
  return developerArtifactStore.list();
}

export function resetCapturedDeveloperArtifacts(): void {
  developerArtifactStore = createArtifactStore();
}
