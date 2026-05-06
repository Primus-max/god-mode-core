import { z } from "zod";
import { CHAT_CHANNEL_ORDER } from "../channels/ids.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";

const IDENTITY_CHANNEL_VALUES = [...CHAT_CHANNEL_ORDER, INTERNAL_MESSAGE_CHANNEL] as const;

const IdentityMappingSchema = z
  .object({
    channel: z.enum(IDENTITY_CHANNEL_VALUES),
    externalId: z.string().min(1),
  })
  .strict();

const IdentityRecordSchema = z
  .object({
    displayName: z.string().min(1),
    mappings: z.array(IdentityMappingSchema).default([]),
    /**
     * Phase 5 — Stage 4 (Role-based access) of
     * `commitment_kernel_policy_gate_full.plan.md`. Optional list of
     * role-keys assigned to this identity. Each role-key resolves
     * against `policy.roles[<role>].allowedEffects` (see
     * `src/config/zod-schema.ts`) at evaluation time. Backward
     * compatible: existing identity records work unchanged — when
     * omitted, downstream consumers (`role-policy.ts`) treat the
     * absence as the empty role list, which fail-closes the role
     * gate for any effect listed in `policy.roles`.
     *
     * Schema-level: `optional` (not `default([])`) so existing
     * config fixtures and `IdentityRecord` factory constructions
     * across the codebase compile without a forced `roles: []`
     * sentinel.
     */
    roles: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Top-level `identities` section for `openclaw.json`.
 *
 * Shape: a record keyed by `IdentityId` (validated downstream by
 * `asIdentityId`). Each value carries the display name + mappings.
 *
 * Example:
 * ```jsonc
 * {
 *   "identities": {
 *     "identity:vladimir": {
 *       "displayName": "Vladimir",
 *       "mappings": [
 *         { "channel": "telegram", "externalId": "123456789" },
 *         { "channel": "webchat", "externalId": "vladimir@example.com" }
 *       ]
 *     }
 *   }
 * }
 * ```
 *
 * v1 default: a single operator record pre-seeded by the bootstrap
 * loader (see `src/platform/identity/load-identities-from-config.ts`).
 *
 * Multi-tenant (multiple operators) is permitted by the schema but not
 * enabled in v1 ergonomics — that's a v2 concern alongside OAuth /
 * IdP integration.
 */
export const IdentitiesSchema = z.record(z.string().min(1), IdentityRecordSchema);

export type IdentitiesConfig = z.infer<typeof IdentitiesSchema>;
