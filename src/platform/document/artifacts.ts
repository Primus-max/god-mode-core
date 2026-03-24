import { z } from "zod";

export const DocumentArtifactTypeSchema = z.enum(["extraction", "report", "export"]);
export type DocumentArtifactType = z.infer<typeof DocumentArtifactTypeSchema>;

export const DocumentFieldValueTypeSchema = z.enum([
  "string",
  "number",
  "currency",
  "date",
  "boolean",
  "table",
  "list",
  "json",
]);
export type DocumentFieldValueType = z.infer<typeof DocumentFieldValueTypeSchema>;

export const DocumentExtractedFieldSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1).optional(),
    valueType: DocumentFieldValueTypeSchema,
    value: z.unknown(),
    confidence: z.number().min(0).max(1).optional(),
    pageRefs: z.array(z.number().int().positive()).optional(),
  })
  .strict();
export type DocumentExtractedField = z.infer<typeof DocumentExtractedFieldSchema>;

export const DocumentTableSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).optional(),
    headers: z.array(z.string()).optional(),
    rows: z.array(z.array(z.string())).min(1),
    pageRefs: z.array(z.number().int().positive()).optional(),
  })
  .strict();
export type DocumentTable = z.infer<typeof DocumentTableSchema>;

export const DocumentExtractionArtifactSchema = z
  .object({
    type: z.literal("extraction"),
    sourceArtifactId: z.string().min(1).optional(),
    fields: z.array(DocumentExtractedFieldSchema).optional(),
    tables: z.array(DocumentTableSchema).optional(),
    plainText: z.string().min(1).optional(),
    notes: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type DocumentExtractionArtifact = z.infer<typeof DocumentExtractionArtifactSchema>;

export const DocumentReportFormatSchema = z.enum(["markdown", "json", "text"]);
export type DocumentReportFormat = z.infer<typeof DocumentReportFormatSchema>;

export const DocumentReportArtifactSchema = z
  .object({
    type: z.literal("report"),
    format: DocumentReportFormatSchema,
    content: z.string().min(1),
    sections: z.array(z.string().min(1)).optional(),
    summary: z.string().min(1).optional(),
  })
  .strict();
export type DocumentReportArtifact = z.infer<typeof DocumentReportArtifactSchema>;

export const DocumentExportFormatSchema = z.enum(["json", "csv", "xlsx", "markdown"]);
export type DocumentExportFormat = z.infer<typeof DocumentExportFormatSchema>;

export const DocumentExportArtifactSchema = z
  .object({
    type: z.literal("export"),
    format: DocumentExportFormatSchema,
    fileName: z.string().min(1).optional(),
    mimeType: z.string().min(1).optional(),
    previewRows: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict();
export type DocumentExportArtifact = z.infer<typeof DocumentExportArtifactSchema>;

export const DocumentArtifactPayloadSchema = z.discriminatedUnion("type", [
  DocumentExtractionArtifactSchema,
  DocumentReportArtifactSchema,
  DocumentExportArtifactSchema,
]);
export type DocumentArtifactPayload = z.infer<typeof DocumentArtifactPayloadSchema>;
