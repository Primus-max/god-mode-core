import { z } from "zod";
import { DeveloperFlowStageSchema, DeveloperPublishTargetSchema } from "./contracts.js";

export const DeveloperPreviewArtifactSchema = z
  .object({
    type: z.literal("preview"),
    stage: DeveloperFlowStageSchema.default("preview"),
    target: DeveloperPublishTargetSchema,
    label: z.string().min(1).optional(),
    url: z.string().url(),
    summary: z.string().min(1).optional(),
  })
  .strict();
export type DeveloperPreviewArtifact = z.infer<typeof DeveloperPreviewArtifactSchema>;

export const DeveloperBinaryArtifactSchema = z
  .object({
    type: z.literal("binary"),
    stage: DeveloperFlowStageSchema.default("build"),
    label: z.string().min(1),
    path: z.string().min(1).optional(),
    url: z.string().url().optional(),
    mimeType: z.string().min(1).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    summary: z.string().min(1).optional(),
  })
  .strict();
export type DeveloperBinaryArtifact = z.infer<typeof DeveloperBinaryArtifactSchema>;

export const DeveloperReleaseArtifactSchema = z
  .object({
    type: z.literal("release"),
    stage: z.enum(["release", "publish"]).default("publish"),
    target: DeveloperPublishTargetSchema,
    version: z.string().min(1),
    tag: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    url: z.string().url().optional(),
    notes: z.string().optional(),
    published: z.boolean().optional(),
  })
  .strict();
export type DeveloperReleaseArtifact = z.infer<typeof DeveloperReleaseArtifactSchema>;

export const DeveloperArtifactPayloadSchema = z.discriminatedUnion("type", [
  DeveloperPreviewArtifactSchema,
  DeveloperBinaryArtifactSchema,
  DeveloperReleaseArtifactSchema,
]);
export type DeveloperArtifactPayload = z.infer<typeof DeveloperArtifactPayloadSchema>;
