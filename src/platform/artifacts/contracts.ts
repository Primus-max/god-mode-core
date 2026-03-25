import { z } from "zod";
import { MaterializationResultSchema } from "../materialization/contracts.js";
import { ArtifactDescriptorSchema, ArtifactOperationSchema } from "../schemas/artifact.js";

export const ArtifactServiceAccessSchema = z
  .object({
    token: z.string().min(1),
    previewUrl: z.string().url().optional(),
    contentUrl: z.string().url().optional(),
  })
  .strict();
export type ArtifactServiceAccess = z.infer<typeof ArtifactServiceAccessSchema>;

export const PersistedArtifactRecordSchema = z
  .object({
    version: z.literal(1),
    descriptor: ArtifactDescriptorSchema,
    materialization: MaterializationResultSchema.optional(),
    access: ArtifactServiceAccessSchema,
  })
  .strict();
export type PersistedArtifactRecord = z.infer<typeof PersistedArtifactRecordSchema>;

export const ArtifactRecordSummarySchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    label: z.string().min(1),
    lifecycle: z.string().min(1),
    mimeType: z.string().min(1).optional(),
    sizeBytes: z.number().nonnegative().optional(),
    url: z.string().url().optional(),
    previewUrl: z.string().url().optional(),
    contentUrl: z.string().url().optional(),
    sourceRecipeId: z.string().min(1).optional(),
    publishTarget: z.string().min(1).optional(),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    hasMaterialization: z.boolean(),
  })
  .strict();
export type ArtifactRecordSummary = z.infer<typeof ArtifactRecordSummarySchema>;

export const ArtifactRecordDetailSchema = z
  .object({
    descriptor: ArtifactDescriptorSchema,
    materialization: MaterializationResultSchema.optional(),
    previewUrl: z.string().url().optional(),
    contentUrl: z.string().url().optional(),
  })
  .strict();
export type ArtifactRecordDetail = z.infer<typeof ArtifactRecordDetailSchema>;

export const ArtifactServiceTransitionRequestSchema = z
  .object({
    artifactId: z.string().min(1),
    operation: ArtifactOperationSchema,
  })
  .strict();
export type ArtifactServiceTransitionRequest = z.infer<
  typeof ArtifactServiceTransitionRequestSchema
>;
