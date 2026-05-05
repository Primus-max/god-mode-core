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
