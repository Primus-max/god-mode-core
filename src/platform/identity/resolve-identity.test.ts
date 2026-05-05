import { describe, expect, it } from "vitest";

import { asIdentityId } from "./identity-id.js";
import {
  extractChannelAndPeerFromSessionKey,
  resolveIdentityFromSessionKey,
} from "./resolve-identity.js";
import { StaticIdentityRegistry } from "./static-identity-registry.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

const registry = new StaticIdentityRegistry({
  records: [
    {
      identityId: VLADIMIR,
      displayName: "Vladimir",
      mappings: [
        { channel: "telegram", externalId: "123456789" },
        { channel: "slack", externalId: "u_vlad_001" },
      ],
    },
    {
      identityId: ALICE,
      displayName: "Alice",
      mappings: [{ channel: "telegram", externalId: "555555555" }],
    },
  ],
});

describe("extractChannelAndPeerFromSessionKey — shape parser", () => {
  it("extracts (telegram, peerId) from per-channel-peer DM key", () => {
    expect(extractChannelAndPeerFromSessionKey("agent:main:telegram:direct:123456789")).toEqual({
      channel: "telegram",
      peerId: "123456789",
    });
  });

  it("extracts (telegram, peerId) from per-account-channel-peer DM key", () => {
    expect(
      extractChannelAndPeerFromSessionKey("agent:main:telegram:account-001:direct:123456789"),
    ).toEqual({ channel: "telegram", peerId: "123456789" });
  });

  it("extracts (slack, peerId) from group session key", () => {
    expect(extractChannelAndPeerFromSessionKey("agent:main:slack:group:c01abcdef")).toEqual({
      channel: "slack",
      peerId: "c01abcdef",
    });
  });

  it("extracts (discord, peerId) from channel-kind session key", () => {
    expect(
      extractChannelAndPeerFromSessionKey("agent:main:discord:channel:guild-1-channel-2"),
    ).toEqual({ channel: "discord", peerId: "guild-1-channel-2" });
  });

  it("returns undefined for the main key (no channel/peer)", () => {
    expect(extractChannelAndPeerFromSessionKey("agent:main:main")).toBeUndefined();
  });

  it("returns undefined for per-peer DM without channel segment", () => {
    // Per-peer DM has no channel — `agent:main:direct:peer` cannot be cross-channel
    expect(extractChannelAndPeerFromSessionKey("agent:main:direct:peer123")).toBeUndefined();
  });

  it("returns undefined when the key is not in agent shape", () => {
    expect(extractChannelAndPeerFromSessionKey("not-an-agent-key")).toBeUndefined();
    expect(extractChannelAndPeerFromSessionKey("agent")).toBeUndefined();
    expect(extractChannelAndPeerFromSessionKey("agent:")).toBeUndefined();
    expect(extractChannelAndPeerFromSessionKey("agent:main")).toBeUndefined();
  });

  it("returns undefined for empty / null / undefined inputs (defensive)", () => {
    expect(extractChannelAndPeerFromSessionKey("")).toBeUndefined();
    expect(extractChannelAndPeerFromSessionKey(null)).toBeUndefined();
    expect(extractChannelAndPeerFromSessionKey(undefined)).toBeUndefined();
  });

  it("returns undefined when channel segment is not a known channel id", () => {
    // `madeup-channel` is not in CHAT_CHANNEL_ORDER — must NOT silently accept
    expect(
      extractChannelAndPeerFromSessionKey("agent:main:madeup-channel:direct:123"),
    ).toBeUndefined();
  });

  it("normalises case (channel + peerId lowercased) — matches the parser convention", () => {
    expect(extractChannelAndPeerFromSessionKey("Agent:Main:Telegram:Direct:ABCDEF")).toEqual({
      channel: "telegram",
      peerId: "abcdef",
    });
  });

  it("extracts (max, peerId) from a Max DM session key", () => {
    expect(extractChannelAndPeerFromSessionKey("agent:main:max:direct:max-user-001")).toEqual({
      channel: "max",
      peerId: "max-user-001",
    });
  });

  it("extracts (webchat, peerId) from a Web UI session key", () => {
    expect(
      extractChannelAndPeerFromSessionKey("agent:main:webchat:direct:vladimir@example.com"),
    ).toEqual({ channel: "webchat", peerId: "vladimir@example.com" });
  });

  it("does NOT extract from cron / subagent / acp wrapped keys (out of identity scope)", () => {
    expect(
      extractChannelAndPeerFromSessionKey("agent:main:subagent:abc:telegram:direct:123"),
    ).toBeUndefined();
    expect(
      extractChannelAndPeerFromSessionKey("agent:main:cron:cron-1:run:r1"),
    ).toBeUndefined();
    expect(extractChannelAndPeerFromSessionKey("agent:main:acp:abc")).toBeUndefined();
  });

  it("returns undefined when peerId segment is empty (parser fails closed)", () => {
    expect(extractChannelAndPeerFromSessionKey("agent:main:telegram:direct:")).toBeUndefined();
  });
});

describe("resolveIdentityFromSessionKey — happy + miss cases against registry", () => {
  it("resolves a Telegram session key to the configured identity", () => {
    expect(
      resolveIdentityFromSessionKey("agent:main:telegram:direct:123456789", registry),
    ).toBe(VLADIMIR);
  });

  it("resolves a Slack session key to the SAME identity (cross-channel parity)", () => {
    expect(
      resolveIdentityFromSessionKey("agent:main:slack:group:u_vlad_001", registry),
    ).toBe(VLADIMIR);
  });

  it("resolves two different Telegram peers to two different identities", () => {
    expect(resolveIdentityFromSessionKey("agent:main:telegram:direct:123456789", registry)).toBe(
      VLADIMIR,
    );
    expect(resolveIdentityFromSessionKey("agent:main:telegram:direct:555555555", registry)).toBe(
      ALICE,
    );
  });

  it("returns undefined when the session key is the main key (no channel/peer)", () => {
    expect(resolveIdentityFromSessionKey("agent:main:main", registry)).toBeUndefined();
  });

  it("returns undefined when the peer is unmapped in the registry", () => {
    expect(
      resolveIdentityFromSessionKey("agent:main:telegram:direct:000000000", registry),
    ).toBeUndefined();
  });

  it("returns undefined when the session key is malformed", () => {
    expect(resolveIdentityFromSessionKey("garbage", registry)).toBeUndefined();
    expect(resolveIdentityFromSessionKey("", registry)).toBeUndefined();
  });

  it("does not throw on registry-miss (control-flow signal, not error)", () => {
    expect(() =>
      resolveIdentityFromSessionKey("agent:main:telegram:direct:nope", registry),
    ).not.toThrow();
  });

  it("respects per-account-channel-peer shape (account segment is part of the key, not the peer)", () => {
    // `account-001` is the account segment; identity is keyed on (channel, peerId), not account
    expect(
      resolveIdentityFromSessionKey(
        "agent:main:telegram:account-001:direct:123456789",
        registry,
      ),
    ).toBe(VLADIMIR);
  });
});
