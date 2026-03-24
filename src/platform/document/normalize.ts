import { z } from "zod";
import type {
  DocumentArtifactPayload,
  DocumentExportArtifact,
  DocumentExtractionArtifact,
  DocumentReportArtifact,
} from "./artifacts.js";
import type { DocumentRuntimeRoute } from "./contracts.js";
import { normalizeExtractedFields, type NormalizedDocumentField } from "./normalize-fields.js";
import { normalizeReport, type NormalizedDocumentReport } from "./normalize-report.js";
import {
  normalizePreviewRows,
  normalizeTables,
  type NormalizedDocumentTable,
} from "./normalize-tables.js";

export const NormalizedDocumentFieldSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    sourceKeys: z.array(z.string().min(1)).min(1),
    valueType: z.enum(["string", "number", "currency", "date", "boolean", "table", "list", "json"]),
    valueText: z.string(),
    numberValue: z.number().optional(),
    booleanValue: z.boolean().optional(),
    isoDate: z.string().datetime().optional(),
    confidence: z.number().min(0).max(1).optional(),
    pageRefs: z.array(z.number().int().positive()).optional(),
    alternates: z.array(z.string()).optional(),
  })
  .strict();

export const NormalizedDocumentTableSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).optional(),
    headers: z.array(z.string().min(1)).min(1),
    rows: z.array(z.record(z.string(), z.string())).min(1),
    rowCount: z.number().int().nonnegative(),
    columnCount: z.number().int().positive(),
    pageRefs: z.array(z.number().int().positive()).optional(),
  })
  .strict();

const NormalizedPreviewValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const NormalizedDocumentExtractionSchema = z
  .object({
    type: z.literal("extraction"),
    route: z.enum(["doc_ingest", "ocr_extract", "table_extract"]),
    sourceArtifactId: z.string().min(1).optional(),
    fields: z.array(NormalizedDocumentFieldSchema),
    tables: z.array(NormalizedDocumentTableSchema),
    fieldCount: z.number().int().nonnegative(),
    tableCount: z.number().int().nonnegative(),
    plainText: z.string().min(1).optional(),
    notes: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const NormalizedDocumentReportSchema = z
  .object({
    type: z.literal("report"),
    route: z.enum(["doc_ingest", "ocr_extract", "table_extract"]),
    format: z.enum(["markdown", "json", "text"]),
    content: z.string().min(1),
    summary: z.string().min(1),
    sections: z.array(z.string().min(1)),
  })
  .strict();

export const NormalizedDocumentExportSchema = z
  .object({
    type: z.literal("export"),
    route: z.enum(["doc_ingest", "ocr_extract", "table_extract"]),
    format: z.enum(["json", "csv", "xlsx", "markdown"]),
    fileName: z.string().min(1).optional(),
    mimeType: z.string().min(1).optional(),
    columns: z.array(z.string().min(1)),
    previewRows: z.array(z.record(z.string(), NormalizedPreviewValueSchema)),
    rowCount: z.number().int().nonnegative(),
  })
  .strict();

export const NormalizedDocumentArtifactSchema = z.discriminatedUnion("type", [
  NormalizedDocumentExtractionSchema,
  NormalizedDocumentReportSchema,
  NormalizedDocumentExportSchema,
]);

export type NormalizedDocumentExtraction = z.infer<typeof NormalizedDocumentExtractionSchema>;
export type NormalizedDocumentReportArtifact = z.infer<typeof NormalizedDocumentReportSchema>;
export type NormalizedDocumentExport = z.infer<typeof NormalizedDocumentExportSchema>;
export type NormalizedDocumentArtifact = z.infer<typeof NormalizedDocumentArtifactSchema>;

export type NormalizedDocumentArtifactBundle = {
  raw: DocumentArtifactPayload;
  normalized: NormalizedDocumentArtifact;
};

function normalizeExtractionArtifact(
  route: DocumentRuntimeRoute,
  artifact: DocumentExtractionArtifact,
): NormalizedDocumentExtraction {
  const fields = normalizeExtractedFields(artifact.fields);
  const tables = normalizeTables(artifact.tables);
  return {
    type: "extraction",
    route,
    ...(artifact.sourceArtifactId ? { sourceArtifactId: artifact.sourceArtifactId } : {}),
    fields,
    tables,
    fieldCount: fields.length,
    tableCount: tables.length,
    ...(artifact.plainText ? { plainText: artifact.plainText.trim() } : {}),
    ...(artifact.notes?.length
      ? { notes: artifact.notes.map((note) => note.trim()).filter(Boolean) }
      : {}),
  };
}

function normalizeReportArtifact(
  route: DocumentRuntimeRoute,
  artifact: DocumentReportArtifact,
): NormalizedDocumentReportArtifact {
  const normalized = normalizeReport(artifact);
  return {
    type: "report",
    route,
    ...normalized,
  };
}

function normalizeExportArtifact(
  route: DocumentRuntimeRoute,
  artifact: DocumentExportArtifact,
): NormalizedDocumentExport {
  const previewRows = normalizePreviewRows(artifact.previewRows);
  const columns = Array.from(new Set(previewRows.flatMap((row) => Object.keys(row)))).toSorted();
  return {
    type: "export",
    route,
    format: artifact.format,
    ...(artifact.fileName ? { fileName: artifact.fileName.trim() } : {}),
    ...(artifact.mimeType ? { mimeType: artifact.mimeType.trim() } : {}),
    columns,
    previewRows,
    rowCount: previewRows.length,
  };
}

export function normalizeDocumentArtifact(
  route: DocumentRuntimeRoute,
  artifact: DocumentArtifactPayload,
): NormalizedDocumentArtifact {
  switch (artifact.type) {
    case "extraction":
      return normalizeExtractionArtifact(route, artifact);
    case "report":
      return normalizeReportArtifact(route, artifact);
    case "export":
      return normalizeExportArtifact(route, artifact);
  }
}

export function normalizeDocumentArtifacts(
  route: DocumentRuntimeRoute,
  payloads: DocumentArtifactPayload[],
): NormalizedDocumentArtifactBundle[] {
  return payloads.map((raw) => {
    const normalized = normalizeDocumentArtifact(route, raw);
    NormalizedDocumentArtifactSchema.parse(normalized);
    return { raw, normalized };
  });
}

export type { NormalizedDocumentField } from "./normalize-fields.js";
export type { NormalizedDocumentTable } from "./normalize-tables.js";
export type { NormalizedDocumentReport } from "./normalize-report.js";
