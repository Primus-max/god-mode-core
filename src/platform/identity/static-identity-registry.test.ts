import { describe, expect, it } from "vitest";

import { asIdentityId } from "./identity-id.js";
import {
  StaticIdentityRegistry,
  type StaticIdentityRegistryConfig,
} from "./static-identity-registry.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

const oneOperatorConfig: StaticIdentityRegistryConfig = {
  records: [
    {
      identityId: VLADIMIR,
      displayName: "Vladimir",
      mappings: [
        { channel: "telegram", externalId: "123456789" },
        { channel: "slack", externalId: "U_VLAD_001" },
      ],
    },
  ],
};

const twoOperatorConfig: StaticIdentityRegistryConfig = {
  records: [
    {
      identityId: VLADIMIR,
      displayName: "Vladimir",
      mappings: [{ channel: "telegram", externalId: "111" }],
    },
    {
      identityId: ALICE,
      displayName: "Alice",
      mappings: [{ channel: "telegram", externalId: "222" }],
    },
  ],
};

describe("StaticIdentityRegistry — resolve()", () => {
  it("resolves a Telegram peer to the configured identity", () => {
    const registry = new StaticIdentityRegistry(oneOperatorConfig);
    expect(registry.resolve("telegram", "123456789")).toBe(VLADIMIR);
  });

  it("resolves a Slack peer to the same identity (cross-channel)", () => {
    const registry = new StaticIdentityRegistry(oneOperatorConfig);
    expect(registry.resolve("slack", "U_VLAD_001")).toBe(VLADIMIR);
  });

  it("returns undefined for an unmapped Telegram peer (no throw)", () => {
    const registry = new StaticIdentityRegistry(oneOperatorConfig);
    expect(registry.resolve("telegram", "unknown-peer")).toBeUndefined();
  });

  it("returns undefined for a known peer on the wrong channel (channel-keyed lookup)", () => {
    const registry = new StaticIdentityRegistry(oneOperatorConfig);
    // `123456789` is the Telegram external id, NOT a Slack one
    expect(registry.resolve("slack", "123456789")).toBeUndefined();
  });

  it("returns undefined when the registry has no records", () => {
    const registry = new StaticIdentityRegistry({ records: [] });
    expect(registry.resolve("telegram", "anything")).toBeUndefined();
  });

  it("distinguishes two operators sharing the same channel", () => {
    const registry = new StaticIdentityRegistry(twoOperatorConfig);
    expect(registry.resolve("telegram", "111")).toBe(VLADIMIR);
    expect(registry.resolve("telegram", "222")).toBe(ALICE);
  });

  it("lookup is exact-match on externalId — no prefix or substring matching", () => {
    const registry = new StaticIdentityRegistry(oneOperatorConfig);
    expect(registry.resolve("telegram", "123")).toBeUndefined();
    expect(registry.resolve("telegram", "12345678")).toBeUndefined();
    expect(registry.resolve("telegram", "1234567890")).toBeUndefined();
  });
});

describe("StaticIdentityRegistry — list() + byIdentity()", () => {
  it("list() returns every configured record", () => {
    const registry = new StaticIdentityRegistry(twoOperatorConfig);
    const list = registry.list();
    expect(list).toHaveLength(2);
    const ids = list.map((record) => record.identityId).sort();
    expect(ids).toEqual([ALICE, VLADIMIR].sort());
  });

  it("byIdentity returns the matching record", () => {
    const registry = new StaticIdentityRegistry(oneOperatorConfig);
    const record = registry.byIdentity(VLADIMIR);
    expect(record?.displayName).toBe("Vladimir");
    expect(record?.mappings).toHaveLength(2);
  });

  it("byIdentity returns undefined for an unknown identity", () => {
    const registry = new StaticIdentityRegistry(oneOperatorConfig);
    expect(registry.byIdentity(ALICE)).toBeUndefined();
  });

  it("list() returns frozen records (no mutation through caller)", () => {
    const registry = new StaticIdentityRegistry(oneOperatorConfig);
    const list = registry.list();
    expect(() => {
      // @ts-expect-error - test enforces runtime freeze, not just TS
      list.push({ identityId: ALICE, displayName: "x", mappings: [] });
    }).toThrow();
  });
});

describe("StaticIdentityRegistry — Phase 3 channel coverage (max + webchat)", () => {
  it("accepts `max` (RU messenger) as a chat-channel mapping", () => {
    const registry = new StaticIdentityRegistry({
      records: [
        {
          identityId: VLADIMIR,
          displayName: "Vladimir",
          mappings: [{ channel: "max", externalId: "max-user-001" }],
        },
      ],
    });
    expect(registry.resolve("max", "max-user-001")).toBe(VLADIMIR);
  });

  it("accepts `webchat` (Web UI internal channel) as a mapping", () => {
    const registry = new StaticIdentityRegistry({
      records: [
        {
          identityId: VLADIMIR,
          displayName: "Vladimir",
          mappings: [
            { channel: "telegram", externalId: "111" },
            { channel: "webchat", externalId: "vladimir@example.com" },
          ],
        },
      ],
    });
    expect(registry.resolve("telegram", "111")).toBe(VLADIMIR);
    expect(registry.resolve("webchat", "vladimir@example.com")).toBe(VLADIMIR);
  });

  it("Telegram peer + Web UI peer for the same operator both resolve to the same identity (cross-channel parity)", () => {
    const registry = new StaticIdentityRegistry({
      records: [
        {
          identityId: VLADIMIR,
          displayName: "Vladimir",
          mappings: [
            { channel: "telegram", externalId: "tg-vlad" },
            { channel: "webchat", externalId: "web-vlad" },
            { channel: "max", externalId: "max-vlad" },
          ],
        },
      ],
    });
    const fromTelegram = registry.resolve("telegram", "tg-vlad");
    const fromWeb = registry.resolve("webchat", "web-vlad");
    const fromMax = registry.resolve("max", "max-vlad");
    expect(fromTelegram).toBe(fromWeb);
    expect(fromTelegram).toBe(fromMax);
    expect(fromTelegram).toBe(VLADIMIR);
  });
});

describe("StaticIdentityRegistry — config validation at construction", () => {
  it("rejects duplicate identity ids in records", () => {
    expect(
      () =>
        new StaticIdentityRegistry({
          records: [
            { identityId: VLADIMIR, displayName: "V1", mappings: [] },
            { identityId: VLADIMIR, displayName: "V2", mappings: [] },
          ],
        }),
    ).toThrow(/duplicate.*identity/iu);
  });

  it("rejects two records mapping the same (channel, externalId) tuple to different identities", () => {
    expect(
      () =>
        new StaticIdentityRegistry({
          records: [
            {
              identityId: VLADIMIR,
              displayName: "V",
              mappings: [{ channel: "telegram", externalId: "999" }],
            },
            {
              identityId: ALICE,
              displayName: "A",
              mappings: [{ channel: "telegram", externalId: "999" }],
            },
          ],
        }),
    ).toThrow(/conflicting.*mapping|duplicate.*mapping/iu);
  });

  it("rejects an empty externalId in a mapping", () => {
    expect(
      () =>
        new StaticIdentityRegistry({
          records: [
            {
              identityId: VLADIMIR,
              displayName: "V",
              mappings: [{ channel: "telegram", externalId: "" }],
            },
          ],
        }),
    ).toThrow(/external/iu);
  });

  it("accepts a record with zero mappings (the operator exists but has no channel mappings yet)", () => {
    const registry = new StaticIdentityRegistry({
      records: [{ identityId: VLADIMIR, displayName: "V", mappings: [] }],
    });
    expect(registry.byIdentity(VLADIMIR)?.displayName).toBe("V");
    expect(registry.resolve("telegram", "anything")).toBeUndefined();
  });
});
