import { z } from "zod";

export const ArtifactKindSchema = z.enum([
  "document",
  "estimate",
  "site",
  "release",
  "binary",
  "report",
  "video",
  "image",
  "audio",
  "archive",
  "data",
  "other",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactLifecycleSchema = z.enum([
  "draft",
  "preview",
  "published",
  "approved",
  "archived",
  "deleted",
]);
export type ArtifactLifecycle = z.infer<typeof ArtifactLifecycleSchema>;

export const ArtifactDescriptorSchema = z
  .object({
    id: z.string().min(1),
    kind: ArtifactKindSchema,
    label: z.string().min(1),
    lifecycle: ArtifactLifecycleSchema,
    version: z.number().int().positive().optional(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().nonnegative().optional(),
    path: z.string().optional(),
    /** When set, correlates with `BootstrapRequestRecord.id` for audit-ready lineage. */
    bootstrapRequestId: z.string().min(1).optional(),
    url: z.string().url().optional(),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    sourceRecipeId: z.string().optional(),
    publishTarget: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptorSchema>;

export const ArtifactOperationSchema = z.enum([
  "create",
  "update",
  "version",
  "preview",
  "publish",
  "approve",
  "retain",
  "delete",
]);
export type ArtifactOperation = z.infer<typeof ArtifactOperationSchema>;
