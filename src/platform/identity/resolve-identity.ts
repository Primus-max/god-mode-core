import { CHAT_CHANNEL_ORDER, type ChatChannelId } from "../../channels/ids.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";

import type { IdentityId } from "./identity-id.js";
import type { IdentityRegistry } from "./identity-registry.js";

const KNOWN_CHANNEL_IDS: ReadonlySet<string> = new Set<string>(CHAT_CHANNEL_ORDER);

/**
 * Set of segment names that wrap a session key into a non-identity scope
 * (cron runs, subagent children, ACP-managed sessions). When any of
 * these markers appears as the second segment of the agent-rest, the
 * key is NOT a direct user-channel session — it does not have a stable
 * `(channel, peerId)` identity to resolve. Surfacing the inner
 * channel/peer would conflate the wrapper's lifecycle with the parent's
 * identity. We fail closed and return `undefined`.
 */
const NON_IDENTITY_SCOPE_MARKERS: ReadonlySet<string> = new Set(["subagent", "cron", "acp"]);

export type ChannelAndPeer = {
  readonly channel: ChatChannelId;
  readonly peerId: string;
};

/**
 * Extract `(channel, peerId)` from an agent-shaped session key when the
 * key encodes a known external channel + peer. Returns `undefined`
 * otherwise — including for the main key, per-peer DMs without a
 * channel segment, malformed keys, and wrapped scopes (cron / subagent
 * / acp).
 *
 * Supported shapes (all per `src/routing/session-key.ts` builders):
 *
 * - `agent:{agentId}:{channel}:direct:{peerId}` — per-channel-peer DM
 * - `agent:{agentId}:{channel}:{accountId}:direct:{peerId}` — per-account-channel-peer DM
 * - `agent:{agentId}:{channel}:{peerKind}:{peerId}` — group / channel
 *
 * Unsupported (returns `undefined`):
 * - `agent:{agentId}:main` — no channel segment
 * - `agent:{agentId}:direct:{peerId}` — per-peer DM without channel; cannot be cross-channel
 * - any key wrapped under cron / subagent / acp scopes
 *
 * Channel name MUST be one of `CHAT_CHANNEL_ORDER`. Unknown channel
 * tokens fail closed — this prevents an attacker-controlled session key
 * from forging a channel that the identity registry never sees.
 */
export function extractChannelAndPeerFromSessionKey(
  sessionKey: string | null | undefined,
): ChannelAndPeer | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return undefined;
  }
  const segments = parsed.rest.split(":").filter((segment) => segment !== "");
  if (segments.length < 3) {
    return undefined;
  }

  const firstSegment = segments[0];
  if (firstSegment === undefined) {
    return undefined;
  }
  if (NON_IDENTITY_SCOPE_MARKERS.has(firstSegment)) {
    return undefined;
  }

  if (!KNOWN_CHANNEL_IDS.has(firstSegment)) {
    return undefined;
  }
  const channel = firstSegment as ChatChannelId;

  // Peer-kind appears in segments[1] for the simple per-channel-peer
  // shape, or segments[2] for the per-account-channel-peer shape (the
  // account id occupies segments[1]). The peerId is the last segment in
  // both shapes.
  const peerKindIndex = segments[1] === "direct" || segments[1] === "group" || segments[1] === "channel" ? 1 : 2;
  const peerKind = segments[peerKindIndex];
  if (peerKind !== "direct" && peerKind !== "group" && peerKind !== "channel") {
    return undefined;
  }
  const peerId = segments[peerKindIndex + 1];
  if (peerId === undefined || peerId === "") {
    return undefined;
  }

  return { channel, peerId };
}

/**
 * Resolve a session key to its `IdentityId` via the supplied registry.
 * Returns `undefined` when the key cannot be parsed, has no
 * channel/peer pair, or the pair is not mapped in the registry.
 *
 * Never throws on miss — absent identity is a normal control-flow
 * signal. Callers MUST handle `undefined` (typically: anonymous
 * session, no memory recall, no cross-channel parity).
 */
export function resolveIdentityFromSessionKey(
  sessionKey: string | null | undefined,
  registry: IdentityRegistry,
): IdentityId | undefined {
  const extracted = extractChannelAndPeerFromSessionKey(sessionKey);
  if (!extracted) {
    return undefined;
  }
  return registry.resolve(extracted.channel, extracted.peerId);
}
