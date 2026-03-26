import { z } from "zod";
import { ArtifactKindSchema } from "../schemas/artifact.js";
import { DocumentArtifactPayloadSchema, DocumentArtifactTypeSchema } from "./artifacts.js";

export const DocumentRuntimeRouteSchema = z.enum(["doc_ingest", "ocr_extract", "table_extract"]);
export type DocumentRuntimeRoute = z.infer<typeof DocumentRuntimeRouteSchema>;

export const DocumentBackendKindSchema = z.enum(["parser", "ocr", "table"]);
export type DocumentBackendKind = z.infer<typeof DocumentBackendKindSchema>;

export const DocumentInputHintsSchema = z
  .object({
    needsOcr: z.boolean().optional(),
    needsTables: z.boolean().optional(),
    preferStructuredOutput: z.boolean().optional(),
    languageHints: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type DocumentInputHints = z.infer<typeof DocumentInputHintsSchema>;

export const DocumentInputDescriptorSchema = z
  .object({
    fileName: z.string().min(1).optional(),
    mimeType: z.string().min(1).optional(),
    sourcePath: z.string().min(1).optional(),
    artifactKind: ArtifactKindSchema.optional(),
    pageCount: z.number().int().positive().optional(),
    hints: DocumentInputHintsSchema.optional(),
  })
  .strict();
export type DocumentInputDescriptor = z.infer<typeof DocumentInputDescriptorSchema>;

export const DocumentBackendDescriptorSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: DocumentBackendKindSchema,
    capabilityId: z.string().min(1),
    description: z.string().min(1).optional(),
    modelRef: z.string().min(1).optional(),
  })
  .strict();
export type DocumentBackendDescriptor = z.infer<typeof DocumentBackendDescriptorSchema>;

export const DocumentTaskDescriptorSchema = z
  .object({
    id: z.string().min(1),
    route: DocumentRuntimeRouteSchema,
    label: z.string().min(1),
    description: z.string().min(1),
    acceptedMimeTypes: z.array(z.string().min(1)).min(1),
    requiredCapabilities: z.array(z.string().min(1)).min(1),
    backendKinds: z.array(DocumentBackendKindSchema).min(1),
    outputTypes: z.array(DocumentArtifactTypeSchema).min(1),
  })
  .strict();
export type DocumentTaskDescriptor = z.infer<typeof DocumentTaskDescriptorSchema>;

export const DocumentRuntimeRequestSchema = z
  .object({
    route: DocumentRuntimeRouteSchema,
    instructions: z.string().min(1).optional(),
    input: DocumentInputDescriptorSchema,
  })
  .strict();
export type DocumentRuntimeRequest = z.infer<typeof DocumentRuntimeRequestSchema>;

export const DocumentRuntimeResultSchema = z
  .object({
    route: DocumentRuntimeRouteSchema,
    backendId: z.string().min(1).optional(),
    artifacts: z.array(DocumentArtifactPayloadSchema).min(1),
    warnings: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type DocumentRuntimeResult = z.infer<typeof DocumentRuntimeResultSchema>;
