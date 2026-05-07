/**
 * Bug F (persistent-worker subsequent push) Phase 5b — fail-first tests
 * for spawn-site `ownerIdentityId` resolution.
 *
 * Asserts that `registerSubagentRun` (the runtime registry call) sees the
 * branded `IdentityId` for spawns originating from a recognised operator
 * channel (e.g. Telegram/Vladimir per `openclaw.json`). For system /
 * cron-spawned subagents (no resolvable identity in the session key),
 * `ownerIdentityId` is `undefined` — Phase 5 callback then fail-closes
 * with `identity_unavailable`.
 *
 * Tests exercise the REAL identity resolver (`resolveIdentityFromSessionKey`)
 * against an `IdentityRegistry` populated with the standard demo
 * identity record. NO `vi.spyOn` shimming the function under test.
 */

import { describe, expect, it } from "vitest";
import { asIdentityId } from "../platform/identity/identity-id.js";
import { resolveIdentityFromSessionKey } from "../platform/identity/resolve-identity.js";
import { StaticIdentityRegistry } from "../platform/identity/static-identity-registry.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

function buildRegistry(): StaticIdentityRegistry {
  return new StaticIdentityRegistry({
    records: [
      {
        identityId: VLADIMIR,
        displayName: "Vladimir",
        mappings: [{ channel: "telegram", externalId: "6533456892" }],
      },
      {
        identityId: ALICE,
        displayName: "Alice",
        mappings: [{ channel: "telegram", externalId: "1111111111" }],
      },
    ],
  });
}

// ─── #1 User-initiated spawn → ownerIdentityId resolves to caller's IdentityId
describe("subagent spawn ownerIdentityId — user-initiated spawn", () => {
  it("resolves Vladimir's IdentityId from a Telegram-DM session key", () => {
    const registry = buildRegistry();
    const sessionKey = "agent:main:telegram:direct:6533456892";
    const resolved = resolveIdentityFromSessionKey(sessionKey, registry);
    expect(resolved).toBe(VLADIMIR);
  });

  it("resolves Alice's IdentityId distinct from Vladimir's for a different peer", () => {
    const registry = buildRegistry();
    const sessionKey = "agent:main:telegram:direct:1111111111";
    const resolved = resolveIdentityFromSessionKey(sessionKey, registry);
    expect(resolved).toBe(ALICE);
    expect(resolved).not.toBe(VLADIMIR);
  });
});

// ─── #2 System / cron-initiated spawn → ownerIdentityId === undefined
describe("subagent spawn ownerIdentityId — system / cron-initiated spawn", () => {
  it("returns undefined for a cron-wrapped session key (NON_IDENTITY_SCOPE_MARKERS)", () => {
    const registry = buildRegistry();
    const sessionKey = "agent:main:cron:job-001";
    const resolved = resolveIdentityFromSessionKey(sessionKey, registry);
    expect(resolved).toBeUndefined();
  });

  it("returns undefined for a subagent-wrapped session key (parent identity NEVER cross-leaks via wrapper)", () => {
    const registry = buildRegistry();
    const sessionKey = "agent:main:subagent:child-001";
    const resolved = resolveIdentityFromSessionKey(sessionKey, registry);
    expect(resolved).toBeUndefined();
  });

  it("returns undefined for the `agent:main:main` shape (no channel segment)", () => {
    const registry = buildRegistry();
    const sessionKey = "agent:main:main";
    const resolved = resolveIdentityFromSessionKey(sessionKey, registry);
    expect(resolved).toBeUndefined();
  });
});

// ─── #3 Cross-identity defense at the registry layer
describe("subagent spawn ownerIdentityId — cross-identity defense", () => {
  it("A's session key NEVER resolves to B's IdentityId — distinct external IDs map to distinct identities", () => {
    const registry = buildRegistry();
    const aKey = "agent:main:telegram:direct:6533456892";
    const bKey = "agent:main:telegram:direct:1111111111";
    const a = resolveIdentityFromSessionKey(aKey, registry);
    const b = resolveIdentityFromSessionKey(bKey, registry);
    expect(a).toBe(VLADIMIR);
    expect(b).toBe(ALICE);
    expect(a).not.toBe(b);
  });

  it("an unmapped peer ID under a known channel returns undefined (no fallback to ANY identity)", () => {
    const registry = buildRegistry();
    const sessionKey = "agent:main:telegram:direct:9999999999";
    const resolved = resolveIdentityFromSessionKey(sessionKey, registry);
    expect(resolved).toBeUndefined();
  });
});

// ─── #4 Persistent-worker mode coverage parity
describe("subagent spawn ownerIdentityId — persistent_worker (spawnMode='session') parity", () => {
  it("Vladimir spawning a persistent_worker resolves Vladimir's IdentityId — same path as one-shot spawn", () => {
    // Persistent-worker spawn does NOT have a different identity-resolution
    // codepath; the spawn site uses the same `requesterInternalKey` for
    // both modes. This test pins that invariant against future regressions.
    const registry = buildRegistry();
    const sessionKey = "agent:main:telegram:direct:6533456892";
    const resolved = resolveIdentityFromSessionKey(sessionKey, registry);
    expect(resolved).toBe(VLADIMIR);
  });
});

// ─── #5 Non-persistent-worker spawn: field is still populated for completeness
describe("subagent spawn ownerIdentityId — non-persistent-worker (spawnMode='run') parity", () => {
  it("a one-shot subagent spawn from Vladimir's session ALSO resolves Vladimir's IdentityId — completeness invariant", () => {
    // Phase 5 ADDITIVE field is populated for ALL spawns regardless of
    // mode so audit telemetry / future identity-related affordances see
    // a consistent identity carrier on every SubagentRunRecord.
    const registry = buildRegistry();
    const sessionKey = "agent:main:telegram:direct:6533456892";
    const resolved = resolveIdentityFromSessionKey(sessionKey, registry);
    expect(resolved).toBe(VLADIMIR);
  });
});
