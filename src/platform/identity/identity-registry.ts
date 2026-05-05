import type { ChatChannelId } from "../../channels/ids.js";

import type { IdentityId } from "./identity-id.js";

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
 * `channel` is constrained to `ChatChannelId` so the registry can only
 * accept channels the runtime knows about.
 */
export type IdentityMapping = {
  readonly channel: ChatChannelId;
  readonly externalId: string;
};

/**
 * One identity record: the operator (or future tenant), their display
 * name (used in UI / logs / agent-framing), and every channel-side
 * mapping that resolves to them.
 */
export type IdentityRecord = {
  readonly identityId: IdentityId;
  readonly displayName: string;
  readonly mappings: readonly IdentityMapping[];
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
  resolve(channel: ChatChannelId, externalId: string): IdentityId | undefined;
  list(): readonly IdentityRecord[];
  byIdentity(identityId: IdentityId): IdentityRecord | undefined;
}
