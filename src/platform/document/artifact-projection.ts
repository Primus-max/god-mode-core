import { z } from "zod";
import { createArtifactStore } from "../registry/artifact-store.js";
import type { ArtifactDescriptor, ArtifactKind } from "../schemas/artifact.js";
import { DocumentArtifactPayloadSchema, type DocumentArtifactPayload } from "./artifacts.js";
import { DocumentRuntimeRouteSchema, type DocumentRuntimeRoute } from "./contracts.js";
import { getDocumentTaskDescriptor } from "./defaults.js";

const DOCUMENT_RECIPE_IDS = new Set<DocumentRuntimeRoute>([
  "doc_ingest",
  "ocr_extract",
  "table_extract",
]);

let documentArtifactStore = createArtifactStore();

const DocumentArtifactEnvelopeSchema = z
  .object({
    route: DocumentRuntimeRouteSchema.optional(),
    artifacts: z.array(DocumentArtifactPayloadSchema).min(1),
    warnings: z.array(z.string().min(1)).optional(),
  })
  .strict();

function isDocumentRoute(route: string | undefined): route is DocumentRuntimeRoute {
  return Boolean(route && DOCUMENT_RECIPE_IDS.has(route as DocumentRuntimeRoute));
}

function resolveArtifactKind(payload: DocumentArtifactPayload): ArtifactKind {
  switch (payload.type) {
    case "report":
      return "report";
    case "extraction":
    case "export":
      return "data";
  }
}

function resolveArtifactMimeType(payload: DocumentArtifactPayload): string | undefined {
  if (payload.type === "report") {
    switch (payload.format) {
      case "markdown":
        return "text/markdown";
      case "json":
        return "application/json";
      case "text":
        return "text/plain";
    }
  }
  if (payload.type === "export") {
    switch (payload.format) {
      case "json":
        return "application/json";
      case "csv":
        return "text/csv";
      case "xlsx":
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      case "markdown":
        return "text/markdown";
    }
  }
  return undefined;
}

function buildArtifactMetadata(payload: DocumentArtifactPayload, route: DocumentRuntimeRoute) {
  if (payload.type === "extraction") {
    return {
      route,
      documentArtifactType: payload.type,
      sourceArtifactId: payload.sourceArtifactId,
      fieldCount: payload.fields?.length ?? 0,
      tableCount: payload.tables?.length ?? 0,
      hasPlainText: Boolean(payload.plainText),
      noteCount: payload.notes?.length ?? 0,
      documentPayload: payload,
    };
  }
  if (payload.type === "report") {
    return {
      route,
      documentArtifactType: payload.type,
      format: payload.format,
      sectionCount: payload.sections?.length ?? 0,
      hasSummary: Boolean(payload.summary),
      documentPayload: payload,
    };
  }
  return {
    route,
    documentArtifactType: payload.type,
    format: payload.format,
    fileName: payload.fileName,
    previewRowCount: payload.previewRows?.length ?? 0,
    documentPayload: payload,
  };
}

function buildArtifactLabel(params: {
  route: DocumentRuntimeRoute;
  payload: DocumentArtifactPayload;
  index: number;
}): string {
  const descriptor = getDocumentTaskDescriptor(params.route);
  const prefix = descriptor?.label ?? params.route;
  if (params.payload.type === "report") {
    return `${prefix} report ${params.index}`;
  }
  if (params.payload.type === "export") {
    return `${prefix} export ${params.index}`;
  }
  return `${prefix} extraction ${params.index}`;
}

function extractJsonCodeBlocks(text: string): string[] {
  return Array.from(
    text.matchAll(/```json\s*([\s\S]*?)```/giu),
    (match) => match[1]?.trim() ?? "",
  ).filter((block) => block.length > 0);
}

function parseArtifactCandidate(
  raw: string,
  expectedRoute?: DocumentRuntimeRoute,
): DocumentArtifactPayload[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const envelope = DocumentArtifactEnvelopeSchema.safeParse(parsed);
    if (envelope.success) {
      if (expectedRoute && envelope.data.route && envelope.data.route !== expectedRoute) {
        return [];
      }
      return envelope.data.artifacts;
    }
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => DocumentArtifactPayloadSchema.safeParse(entry))
        .filter((result) => result.success)
        .map((result) => result.data);
    }
    const result = DocumentArtifactPayloadSchema.safeParse(parsed);
    return result.success ? [result.data] : [];
  } catch {
    return [];
  }
}

export function extractDocumentArtifactPayloads(
  texts: string[],
  expectedRoute?: DocumentRuntimeRoute,
): DocumentArtifactPayload[] {
  const payloads: DocumentArtifactPayload[] = [];

  for (const text of texts) {
    const candidates = [text.trim(), ...extractJsonCodeBlocks(text)];
    for (const candidate of candidates) {
      payloads.push(...parseArtifactCandidate(candidate, expectedRoute));
    }
  }

  const allowedOutputTypes = expectedRoute
    ? new Set(getDocumentTaskDescriptor(expectedRoute)?.outputTypes ?? [])
    : null;
  const deduped = new Map<string, DocumentArtifactPayload>();

  for (const payload of payloads) {
    if (allowedOutputTypes && !allowedOutputTypes.has(payload.type)) {
      continue;
    }
    deduped.set(JSON.stringify(payload), payload);
  }

  return Array.from(deduped.values());
}

export function projectDocumentArtifacts(params: {
  sessionId: string;
  runId: string;
  route: DocumentRuntimeRoute;
  payloads: DocumentArtifactPayload[];
}): ArtifactDescriptor[] {
  return params.payloads.map((payload, index) => ({
    id: `${params.sessionId}:${params.runId}:${index + 1}`,
    kind: resolveArtifactKind(payload),
    label: buildArtifactLabel({ route: params.route, payload, index: index + 1 }),
    lifecycle: "draft",
    mimeType: resolveArtifactMimeType(payload),
    sourceRecipeId: params.route,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {
      runId: params.runId,
      ...buildArtifactMetadata(payload, params.route),
    },
  }));
}

export function captureDocumentArtifactsFromLlmOutput(params: {
  sessionId: string;
  runId: string;
  recipeId?: string;
  assistantTexts: string[];
}): ArtifactDescriptor[] {
  if (!isDocumentRoute(params.recipeId)) {
    return [];
  }

  const created = projectDocumentArtifacts({
    sessionId: params.sessionId,
    runId: params.runId,
    route: params.recipeId,
    payloads: extractDocumentArtifactPayloads(params.assistantTexts, params.recipeId),
  });

  for (const descriptor of created) {
    documentArtifactStore.create(descriptor);
  }

  return created;
}

export function listCapturedDocumentArtifacts(): ArtifactDescriptor[] {
  return documentArtifactStore.list();
}

export function resetCapturedDocumentArtifacts(): void {
  documentArtifactStore = createArtifactStore();
}
