import { describe, expect, it } from "vitest";

import type { IdentitiesConfig } from "../../config/zod-schema.identities.js";

import {
  buildIdentityRecordsFromConfig,
  loadIdentityRegistryFromConfig,
} from "./load-identities-from-config.js";

describe("buildIdentityRecordsFromConfig", () => {
  it("returns an empty array when identities is undefined", () => {
    expect(buildIdentityRecordsFromConfig(undefined)).toEqual([]);
  });

  it("returns an empty array when identities is the empty object", () => {
    expect(buildIdentityRecordsFromConfig({})).toEqual([]);
  });

  it("converts one well-formed identity record", () => {
    const config: IdentitiesConfig = {
      "identity:vladimir": {
        displayName: "Vladimir",
        mappings: [{ channel: "telegram", externalId: "123" }],
      },
    };
    const records = buildIdentityRecordsFromConfig(config);
    expect(records).toHaveLength(1);
    expect(records[0]?.identityId).toBe("identity:vladimir");
    expect(records[0]?.displayName).toBe("Vladimir");
    expect(records[0]?.mappings).toEqual([{ channel: "telegram", externalId: "123" }]);
  });

  it("converts multiple identity records preserving each one's mappings", () => {
    const config: IdentitiesConfig = {
      "identity:vladimir": {
        displayName: "Vladimir",
        mappings: [
          { channel: "telegram", externalId: "111" },
          { channel: "webchat", externalId: "vladimir@example.com" },
        ],
      },
      "identity:alice": {
        displayName: "Alice",
        mappings: [{ channel: "slack", externalId: "U_ALICE" }],
      },
    };
    const records = buildIdentityRecordsFromConfig(config);
    expect(records).toHaveLength(2);
    const ids = records.map((record) => record.identityId).sort();
    expect(ids).toEqual(["identity:alice", "identity:vladimir"]);
  });

  it("throws when an identity id key is malformed (missing prefix)", () => {
    const config = {
      vladimir: { displayName: "V", mappings: [] },
    } as unknown as IdentitiesConfig;
    expect(() => buildIdentityRecordsFromConfig(config)).toThrow(
      /openclaw\.json identities.*not a valid IdentityId/u,
    );
  });

  it("throws when an identity id key has an empty slug", () => {
    const config = {
      "identity:": { displayName: "V", mappings: [] },
    } as unknown as IdentitiesConfig;
    expect(() => buildIdentityRecordsFromConfig(config)).toThrow(
      /openclaw\.json identities.*not a valid IdentityId/u,
    );
  });

  it("throws when an identity id has whitespace in the slug", () => {
    const config = {
      "identity:my vlad": { displayName: "V", mappings: [] },
    } as unknown as IdentitiesConfig;
    expect(() => buildIdentityRecordsFromConfig(config)).toThrow(
      /openclaw\.json identities.*not a valid IdentityId/u,
    );
  });

  it("preserves mapping order from config", () => {
    const config: IdentitiesConfig = {
      "identity:vladimir": {
        displayName: "Vladimir",
        mappings: [
          { channel: "telegram", externalId: "111" },
          { channel: "slack", externalId: "U_VLAD" },
          { channel: "webchat", externalId: "vladimir@example.com" },
        ],
      },
    };
    const records = buildIdentityRecordsFromConfig(config);
    expect(records[0]?.mappings.map((m) => m.channel)).toEqual([
      "telegram",
      "slack",
      "webchat",
    ]);
  });
});

describe("loadIdentityRegistryFromConfig", () => {
  it("builds a working registry resolvable through the standard resolve() interface", () => {
    const config: IdentitiesConfig = {
      "identity:vladimir": {
        displayName: "Vladimir",
        mappings: [
          { channel: "telegram", externalId: "111" },
          { channel: "webchat", externalId: "v@example.com" },
        ],
      },
    };
    const registry = loadIdentityRegistryFromConfig(config);
    expect(registry.resolve("telegram", "111")).toBe("identity:vladimir");
    expect(registry.resolve("webchat", "v@example.com")).toBe("identity:vladimir");
    expect(registry.resolve("telegram", "999")).toBeUndefined();
  });

  it("builds an empty registry when input is undefined (anonymous default)", () => {
    const registry = loadIdentityRegistryFromConfig(undefined);
    expect(registry.list()).toHaveLength(0);
    expect(registry.resolve("telegram", "anything")).toBeUndefined();
  });

  it("propagates registry-level validation errors (duplicate mapping for two identities)", () => {
    const config: IdentitiesConfig = {
      "identity:vladimir": {
        displayName: "V",
        mappings: [{ channel: "telegram", externalId: "111" }],
      },
      "identity:alice": {
        displayName: "A",
        mappings: [{ channel: "telegram", externalId: "111" }],
      },
    };
    expect(() => loadIdentityRegistryFromConfig(config)).toThrow(
      /conflicting.*mapping|duplicate.*mapping/iu,
    );
  });
});
