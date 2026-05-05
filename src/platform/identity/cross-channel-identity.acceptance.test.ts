import { describe, expect, it } from "vitest";

import type { IdentitiesConfig } from "../../config/zod-schema.identities.js";

import { loadIdentityRegistryFromConfig } from "./load-identities-from-config.js";
import { resolveIdentityFromSessionKey } from "./resolve-identity.js";

/**
 * Slice D Phase 6 — cross-channel acceptance fixture.
 *
 * This is the contract slice D promises and slice E (memory layer)
 * consumes. It walks the FULL stack from raw config → registry → session
 * keys → IdentityId, asserting that two distinct session keys representing
 * the same operator on different channels resolve to byte-equal
 * IdentityId values.
 *
 * If this test fails, the cross-channel-memory invariant is broken at
 * the foundation and slice E cannot deliver "one operator, one memory".
 *
 * The shape of the assertions here is deliberately minimal — it tests
 * the contract, not implementation details (those are covered by the
 * per-phase tests in identity-id.test.ts / static-identity-registry.test.ts
 * / resolve-identity.test.ts / load-identities-from-config.test.ts).
 */
describe("Slice D acceptance — cross-channel identity resolution", () => {
  const config: IdentitiesConfig = {
    "identity:vladimir": {
      displayName: "Vladimir",
      mappings: [
        { channel: "telegram", externalId: "123456789" },
        { channel: "webchat", externalId: "vladimir@example.com" },
        { channel: "max", externalId: "max-vladimir" },
        { channel: "slack", externalId: "u_vlad_001" },
      ],
    },
    "identity:alice": {
      displayName: "Alice",
      mappings: [
        { channel: "telegram", externalId: "987654321" },
        { channel: "webchat", externalId: "alice@example.com" },
      ],
    },
  };

  it("Telegram session key + Web UI session key resolve to the SAME IdentityId for one operator", () => {
    const registry = loadIdentityRegistryFromConfig(config);

    const fromTelegram = resolveIdentityFromSessionKey(
      "agent:main:telegram:direct:123456789",
      registry,
    );
    const fromWeb = resolveIdentityFromSessionKey(
      "agent:main:webchat:direct:vladimir@example.com",
      registry,
    );

    expect(fromTelegram).toBe("identity:vladimir");
    expect(fromWeb).toBe("identity:vladimir");
    expect(fromTelegram).toBe(fromWeb);
  });

  it("Three different channel session keys for one operator all resolve to the same IdentityId (Telegram + Web + Max)", () => {
    const registry = loadIdentityRegistryFromConfig(config);

    const fromTelegram = resolveIdentityFromSessionKey(
      "agent:main:telegram:direct:123456789",
      registry,
    );
    const fromWeb = resolveIdentityFromSessionKey(
      "agent:main:webchat:direct:vladimir@example.com",
      registry,
    );
    const fromMax = resolveIdentityFromSessionKey(
      "agent:main:max:direct:max-vladimir",
      registry,
    );

    expect(fromTelegram).toBe(fromWeb);
    expect(fromWeb).toBe(fromMax);
    expect(fromMax).toBe("identity:vladimir");
  });

  it("Two different operators on the same channel resolve to two different IdentityIds (no cross-tenant bleed)", () => {
    const registry = loadIdentityRegistryFromConfig(config);

    const vladimir = resolveIdentityFromSessionKey(
      "agent:main:telegram:direct:123456789",
      registry,
    );
    const alice = resolveIdentityFromSessionKey(
      "agent:main:telegram:direct:987654321",
      registry,
    );

    expect(vladimir).toBe("identity:vladimir");
    expect(alice).toBe("identity:alice");
    expect(vladimir).not.toBe(alice);
  });

  it("Same operator across channels is symmetric across the per-account-channel-peer key shape (production session-key shape)", () => {
    const registry = loadIdentityRegistryFromConfig(config);

    const fromTelegramAccount = resolveIdentityFromSessionKey(
      "agent:main:telegram:account-001:direct:123456789",
      registry,
    );
    const fromWebSimple = resolveIdentityFromSessionKey(
      "agent:main:webchat:direct:vladimir@example.com",
      registry,
    );

    expect(fromTelegramAccount).toBe("identity:vladimir");
    expect(fromTelegramAccount).toBe(fromWebSimple);
  });

  it("Group session keys with peer-id matching a configured external id resolve correctly", () => {
    const registry = loadIdentityRegistryFromConfig({
      "identity:team-alpha": {
        displayName: "Team Alpha",
        mappings: [
          { channel: "slack", externalId: "c01-channel-id" },
          { channel: "discord", externalId: "guild-1-channel-2" },
        ],
      },
    });

    const fromSlack = resolveIdentityFromSessionKey(
      "agent:main:slack:group:c01-channel-id",
      registry,
    );
    const fromDiscord = resolveIdentityFromSessionKey(
      "agent:main:discord:channel:guild-1-channel-2",
      registry,
    );

    expect(fromSlack).toBe("identity:team-alpha");
    expect(fromDiscord).toBe("identity:team-alpha");
    expect(fromSlack).toBe(fromDiscord);
  });

  it("Anonymous session (no operator mapping) resolves to undefined — does NOT bleed into a known identity", () => {
    const registry = loadIdentityRegistryFromConfig(config);

    expect(
      resolveIdentityFromSessionKey("agent:main:telegram:direct:000000000", registry),
    ).toBeUndefined();
    expect(
      resolveIdentityFromSessionKey("agent:main:webchat:direct:stranger@example.com", registry),
    ).toBeUndefined();
  });

  it("Empty / undefined config produces a registry that always returns undefined (sane default for unconfigured deploy)", () => {
    const registry = loadIdentityRegistryFromConfig(undefined);

    expect(
      resolveIdentityFromSessionKey("agent:main:telegram:direct:123456789", registry),
    ).toBeUndefined();
    expect(
      resolveIdentityFromSessionKey("agent:main:webchat:direct:vladimir@example.com", registry),
    ).toBeUndefined();
  });

  it("Wrapped session keys (subagent / cron / acp) do NOT leak the parent operator's identity through the wrapper", () => {
    const registry = loadIdentityRegistryFromConfig(config);

    expect(
      resolveIdentityFromSessionKey(
        "agent:main:subagent:abc:telegram:direct:123456789",
        registry,
      ),
    ).toBeUndefined();
    expect(
      resolveIdentityFromSessionKey("agent:main:cron:cron-1:run:r1", registry),
    ).toBeUndefined();
    expect(resolveIdentityFromSessionKey("agent:main:acp:abc", registry)).toBeUndefined();
  });
});
