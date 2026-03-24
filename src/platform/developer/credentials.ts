import { z } from "zod";

const SecretRefSchema = z
  .object({
    source: z.enum(["env", "file", "exec"]),
    provider: z.string().min(1),
    id: z.string().min(1),
  })
  .strict();

export const DeveloperCredentialKindSchema = z.enum([
  "git_pat",
  "registry_token",
  "deploy_token",
  "oauth",
  "ssh_key",
]);
export type DeveloperCredentialKind = z.infer<typeof DeveloperCredentialKindSchema>;

export const DeveloperCredentialBindingScopeSchema = z.enum(["runtime_override", "persistent"]);
export type DeveloperCredentialBindingScope = z.infer<typeof DeveloperCredentialBindingScopeSchema>;

export const DeveloperCredentialBindingSourceSchema = z.enum(["secret_ref", "auth_profile"]);
export type DeveloperCredentialBindingSource = z.infer<
  typeof DeveloperCredentialBindingSourceSchema
>;

export const DeveloperCredentialBindingSchema = z
  .object({
    id: z.string().min(1),
    target: z.enum(["github", "npm", "docker", "vercel", "netlify"]),
    credentialKind: DeveloperCredentialKindSchema,
    bindingScope: DeveloperCredentialBindingScopeSchema,
    source: DeveloperCredentialBindingSourceSchema,
    authProfileId: z.string().min(1).optional(),
    secretRef: SecretRefSchema.optional(),
    label: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((binding, ctx) => {
    if (binding.source === "auth_profile" && !binding.authProfileId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "authProfileId is required when source=auth_profile",
        path: ["authProfileId"],
      });
    }
    if (binding.source === "secret_ref" && !binding.secretRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "secretRef is required when source=secret_ref",
        path: ["secretRef"],
      });
    }
  });
export type DeveloperCredentialBinding = z.infer<typeof DeveloperCredentialBindingSchema>;

export type DeveloperCredentialGate = {
  requiresOwnerMutation: boolean;
  requiresExplicitApproval: boolean;
  policyIntent: "publish";
  publishTargets: string[];
};

export function resolveDeveloperCredentialGate(
  binding: DeveloperCredentialBinding,
): DeveloperCredentialGate {
  return {
    requiresOwnerMutation: binding.bindingScope === "persistent",
    requiresExplicitApproval: true,
    policyIntent: "publish",
    publishTargets: [binding.target],
  };
}
