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

export const CapabilityCatalogInstallSchema = z
  .object({
    method: CapabilityInstallMethodSchema,
    packageRef: z.string().min(1).optional(),
    integrity: z.string().min(1).optional(),
    sandboxed: z.boolean().optional(),
    rollbackStrategy: CapabilityRollbackStrategySchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.method !== "builtin" && !value.packageRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `packageRef is required for ${value.method} install entries`,
        path: ["packageRef"],
      });
    }
    if (value.method !== "builtin" && !value.integrity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `integrity is required for ${value.method} install entries`,
        path: ["integrity"],
      });
    }
    if (value.method === "builtin" && value.packageRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "builtin install entries must not declare packageRef",
        path: ["packageRef"],
      });
    }
    if (value.method === "builtin" && value.integrity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "builtin install entries must not declare integrity",
        path: ["integrity"],
      });
    }
  })
  .strict();
export type CapabilityCatalogInstall = z.infer<typeof CapabilityCatalogInstallSchema>;

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
    source: CapabilityCatalogSourceSchema,
    install: CapabilityCatalogInstallSchema.optional(),
  })
  .superRefine((entry, ctx) => {
    const installMethod = entry.install?.method ?? entry.capability.installMethod ?? "builtin";
    if (entry.source === "user" && entry.capability.trusted) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "user catalog entries must not be marked trusted",
        path: ["capability", "trusted"],
      });
    }
    if (installMethod === "builtin" && entry.install && entry.install.method !== "builtin") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "builtin bootstrap entries must use builtin install metadata",
        path: ["install", "method"],
      });
    }
    if (installMethod !== "builtin" && !entry.install) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `non-builtin capability ${entry.capability.id} requires explicit install metadata`,
        path: ["install"],
      });
    }
  })
  .strict();

export type CapabilityCatalogEntry = z.infer<typeof CapabilityCatalogEntrySchema>;

export const CapabilityCatalogSchema = z.array(CapabilityCatalogEntrySchema);
export type CapabilityCatalog = z.infer<typeof CapabilityCatalogSchema>;
