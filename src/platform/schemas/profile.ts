import { z } from "zod";

/**
 * Contract marker: `preferredTools`, `toolHints`, `modelHints`, and related profile fields are
 * planner and UX hints only. They MUST NOT be treated as policy grants, effective tool allowlists,
 * or implicit capability approval. Downstream policy engines own authorization.
 */
export const PLATFORM_PROFILE_HINTS_ARE_NON_AUTHORITATIVE = true as const;

export const PROFILE_IDS = [
  "builder",
  "developer",
  "integrator",
  "operator",
  "media_creator",
  "general",
] as const;

export type ProfileId = (typeof PROFILE_IDS)[number];

export const ProfileIdSchema = z.enum(PROFILE_IDS);

export const TaskOverlaySchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    parentProfile: ProfileIdSchema,
    toolHints: z.array(z.string().min(1)).optional(),
    modelHints: z.array(z.string().min(1)).optional(),
    publishTargets: z.array(z.string().min(1)).optional(),
    timeoutSeconds: z.number().positive().optional(),
  })
  .strict();

export type TaskOverlay = z.infer<typeof TaskOverlaySchema>;

export const ProfileSchema = z
  .object({
    id: ProfileIdSchema,
    label: z.string().min(1),
    description: z.string().optional(),
    defaultModel: z.string().min(1).optional(),
    defaultImageGenerationModel: z.string().min(1).optional(),
    preferredTools: z.array(z.string().min(1)).optional(),
    preferredPublishTargets: z.array(z.string().min(1)).optional(),
    taskOverlays: z.array(TaskOverlaySchema).optional(),
    riskCeiling: z.enum(["low", "medium", "high"]).optional(),
    priority: z.number().int().nonnegative().optional(),
  })
  .strict();

export type Profile = z.infer<typeof ProfileSchema>;

export const ProfileScoringSignalSchema = z
  .object({
    source: z.enum(["channel", "file", "tool_usage", "artifact", "dialogue", "config"]),
    profileId: ProfileIdSchema,
    weight: z.number().min(0).max(1),
    reason: z.string().optional(),
  })
  .strict();

export type ProfileScoringSignal = z.infer<typeof ProfileScoringSignalSchema>;

export const ActiveProfileStateSchema = z
  .object({
    baseProfile: ProfileIdSchema,
    sessionProfile: ProfileIdSchema.optional(),
    taskOverlay: z.string().optional(),
    confidence: z.number().min(0).max(1),
    signals: z.array(ProfileScoringSignalSchema).optional(),
  })
  .strict();

export type ActiveProfileState = z.infer<typeof ActiveProfileStateSchema>;
