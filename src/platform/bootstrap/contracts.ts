import { z } from "zod";
import {
  CapabilityCatalogEntrySchema,
  CapabilityDescriptorSchema,
  CapabilityInstallMethodSchema,
} from "../schemas/capability.js";

export const BootstrapReasonSchema = z.enum([
  "missing_capability",
  "recipe_requirement",
  "renderer_unavailable",
]);
export type BootstrapReason = z.infer<typeof BootstrapReasonSchema>;

export const BootstrapLifecycleStateSchema = z.enum([
  "requested",
  "approved",
  "installing",
  "verifying",
  "available",
  "failed",
  "rolled_back",
  "degraded",
  "denied",
]);
export type BootstrapLifecycleState = z.infer<typeof BootstrapLifecycleStateSchema>;

export const BootstrapSourceDomainSchema = z.enum(["document", "developer", "platform"]);
export type BootstrapSourceDomain = z.infer<typeof BootstrapSourceDomainSchema>;

export const BootstrapRequestSchema = z
  .object({
    capabilityId: z.string().min(1),
    installMethod: CapabilityInstallMethodSchema,
    reason: BootstrapReasonSchema,
    sourceDomain: BootstrapSourceDomainSchema,
    sourceRecipeId: z.string().min(1).optional(),
    approvalRequired: z.boolean(),
    catalogEntry: CapabilityCatalogEntrySchema,
  })
  .strict();
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;

export const BootstrapResolutionSchema = z
  .object({
    status: z.enum(["available", "request", "unknown", "untrusted"]),
    capability: CapabilityDescriptorSchema.optional(),
    catalogEntry: CapabilityCatalogEntrySchema.optional(),
    request: BootstrapRequestSchema.optional(),
    reasons: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type BootstrapResolution = z.infer<typeof BootstrapResolutionSchema>;

export const BootstrapLifecycleResultSchema = z
  .object({
    capabilityId: z.string().min(1),
    status: BootstrapLifecycleStateSchema,
    transitions: z.array(BootstrapLifecycleStateSchema).min(1),
    capability: CapabilityDescriptorSchema.optional(),
    reasons: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type BootstrapLifecycleResult = z.infer<typeof BootstrapLifecycleResultSchema>;
