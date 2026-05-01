import { z } from "zod";
import { BootstrapRequestSchema } from "../bootstrap/contracts.js";
import { PlatformExecutionContextSnapshotSchema } from "../decision/contracts.js";
import { ArtifactLifecycleSchema } from "../schemas/artifact.js";

export const MaterializationRenderKindSchema = z.enum([
  "html",
  "markdown",
  "pdf",
  "image_bundle",
  "site_preview",
]);
export type MaterializationRenderKind = z.infer<typeof MaterializationRenderKindSchema>;

export const MaterializationDocumentInputKindSchema = z.enum(["html", "spec", "markdown", "text"]);
export type MaterializationDocumentInputKind = z.infer<typeof MaterializationDocumentInputKindSchema>;

export const MaterializationRendererTargetSchema = z.enum(["html", "markdown", "pdf", "preview"]);
export type MaterializationRendererTarget = z.infer<typeof MaterializationRendererTargetSchema>;

export const MaterializationSourceDomainSchema = z.enum(["document", "developer"]);
export type MaterializationSourceDomain = z.infer<typeof MaterializationSourceDomainSchema>;

export const MaterializationOutputTargetSchema = z.enum(["file", "preview"]);
export type MaterializationOutputTarget = z.infer<typeof MaterializationOutputTargetSchema>;

export const MaterializationPayloadSchema = z
  .object({
    title: z.string().min(1).optional(),
    html: z.string().min(1).optional(),
    spec: z.unknown().optional(),
    markdown: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    jsonData: z.unknown().optional(),
    summary: z.string().min(1).optional(),
  })
  .strict();
export type MaterializationPayload = z.infer<typeof MaterializationPayloadSchema>;

export const MaterializationRequestSchema = z
  .object({
    artifactId: z.string().min(1),
    label: z.string().min(1),
    sourceDomain: MaterializationSourceDomainSchema,
    renderKind: MaterializationRenderKindSchema,
    documentInputKind: MaterializationDocumentInputKindSchema.optional(),
    rendererTarget: MaterializationRendererTargetSchema.optional(),
    outputTarget: MaterializationOutputTargetSchema,
    outputDir: z.string().min(1).optional(),
    baseFileName: z.string().min(1).optional(),
    includePdf: z.boolean().optional(),
    executionContext: PlatformExecutionContextSnapshotSchema.optional(),
    payload: MaterializationPayloadSchema,
  })
  .strict();
export type MaterializationRequest = z.infer<typeof MaterializationRequestSchema>;

export const MaterializedArtifactOutputSchema = z
  .object({
    renderKind: MaterializationRenderKindSchema,
    documentInputKind: MaterializationDocumentInputKindSchema.optional(),
    rendererTarget: MaterializationRendererTargetSchema.optional(),
    rendererId: z.string().min(1).optional(),
    outputTarget: MaterializationOutputTargetSchema,
    path: z.string().min(1),
    url: z.string().url().optional(),
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    lifecycle: ArtifactLifecycleSchema.optional(),
  })
  .strict();
export type MaterializedArtifactOutput = z.infer<typeof MaterializedArtifactOutputSchema>;

export const MaterializationResultSchema = z
  .object({
    primary: MaterializedArtifactOutputSchema,
    supporting: z.array(MaterializedArtifactOutputSchema).optional(),
    bootstrapRequest: BootstrapRequestSchema.optional(),
    degraded: z.boolean().optional(),
    warnings: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type MaterializationResult = z.infer<typeof MaterializationResultSchema>;
