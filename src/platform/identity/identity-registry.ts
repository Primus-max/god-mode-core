import type { ChatChannelId } from "../../channels/ids.js";
import type { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { IdentityId } from "./identity-id.js";

/**
 * Channels eligible to participate in identity resolution. Includes the
 * external chat channels (`ChatChannelId` — Telegram, Slack, Discord,
 * Max, etc.) AND the internal Web UI channel
 * (`INTERNAL_MESSAGE_CHANNEL = "webchat"`). The Web UI is architecturally
 * distinct from chat channels (it's the operator-facing gateway client,
 * not an external messaging platform), but for cross-channel memory it
 * MUST be addressable through the same registry — otherwise a logged-in
 * Web UI user has no shared memory with their Telegram counterpart.
 */
export type IdentityChannelId = ChatChannelId | typeof INTERNAL_MESSAGE_CHANNEL;

/**
 * One mapping between an external (channel-side) addressable peer and
 * an internal `IdentityId`. The same `IdentityId` may appear in many
 * mappings (one operator across many channels).
 *
 * `externalId` is the channel-native peer identifier as a string —
 * adapters are responsible for normalising it before insertion (e.g.
 * Telegram numeric chat_id is encoded as the decimal string by the
 * Telegram adapter).
 *
 * `channel` is constrained to `IdentityChannelId` so the registry can
 * only accept channels the runtime knows about.
 */
export type IdentityMapping = {
  readonly channel: IdentityChannelId;
  readonly externalId: string;
};

/**
 * One identity record: the operator (or future tenant), their display
 * name (used in UI / logs / agent-framing), and every channel-side
 * mapping that resolves to them.
 *
 * Phase 5 (PolicyGate Full Stage 4) added the optional `roles` slot
 * — a list of role-keys validated against `policy.roles[<role>]` at
 * the role-policy reader. Backward-compatible: existing records work
 * unchanged with `roles: []` (no roles assigned → fail-closed for any
 * effect listed in `policy.roles`).
 */
export type IdentityRecord = {
  readonly identityId: IdentityId;
  readonly displayName: string;
  readonly mappings: readonly IdentityMapping[];
  readonly roles?: readonly string[];
};

/**
 * Registry contract. Implementations may be static (config-backed),
 * runtime-mutable (admin operations later), or fully dynamic (OAuth +
 * IdP, future v2). The interface is stable across all three.
 *
 * `resolve` returns `undefined` when no mapping is known — callers MUST
 * handle the absence-case (typically: anonymous session, no memory
 * recall, no cross-channel parity). Implementations MUST NOT throw on a
 * missing mapping — that is a normal control-flow signal, not an error.
 *
 * `list` returns the full set of known records. The order is
 * implementation-defined; callers that need a stable order should sort
 * locally.
 */
export interface IdentityRegistry {
  resolve(channel: IdentityChannelId, externalId: string): IdentityId | undefined;
  list(): readonly IdentityRecord[];
  byIdentity(identityId: IdentityId): IdentityRecord | undefined;
}
