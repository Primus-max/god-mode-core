import { z } from "zod";

export const CapabilityStatusSchema = z.enum([
  "available",
  "missing",
  "installing",
  "failed",
  "disabled",
]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const CapabilityInstallMethodSchema = z.enum([
  "brew",
  "node",
  "go",
  "uv",
  "download",
  "docker",
  "builtin",
]);
export type CapabilityInstallMethod = z.infer<typeof CapabilityInstallMethodSchema>;

export const CapabilityCatalogSourceSchema = z.enum(["builtin", "catalog", "user"]);
export type CapabilityCatalogSource = z.infer<typeof CapabilityCatalogSourceSchema>;

export const CapabilityRollbackStrategySchema = z.enum([
  "disable",
  "keep_failed",
  "restore_previous",
]);
export type CapabilityRollbackStrategy = z.infer<typeof CapabilityRollbackStrategySchema>;

export const CapabilityDescriptorSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    version: z.string().optional(),
    status: CapabilityStatusSchema,
    installMethod: CapabilityInstallMethodSchema.optional(),
    trusted: z.boolean(),
    sandboxed: z.boolean().optional(),
    os: z.array(z.enum(["linux", "darwin", "win32"])).optional(),
    requiredBins: z.array(z.string()).optional(),
    requiredEnv: z.array(z.string()).optional(),
    healthCheckCommand: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;

export const CapabilityCatalogEntrySchema = z
  .object({
    capability: CapabilityDescriptorSchema,
    packageRef: z.string().optional(),
    source: CapabilityCatalogSourceSchema,
    integrity: z.string().min(1).optional(),
    rollbackStrategy: CapabilityRollbackStrategySchema.optional(),
  })
  .strict();

export type CapabilityCatalogEntry = z.infer<typeof CapabilityCatalogEntrySchema>;

export const CapabilityCatalogSchema = z.array(CapabilityCatalogEntrySchema);
export type CapabilityCatalog = z.infer<typeof CapabilityCatalogSchema>;
