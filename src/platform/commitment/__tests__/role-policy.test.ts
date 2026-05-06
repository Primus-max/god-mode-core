import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { asIdentityId, type IdentityId } from "../../identity/identity-id.js";
import type { EpisodicMemoryEvent, MemoryEntryId, MemoryStore } from "../../memory/index.js";
import type { EffectId } from "../ids.js";
import {
  ROLE_POLICY_REASONS,
  createRolePolicy,
  type RoleId,
  type RolePolicyConfigEntry,
  type RoleResolver,
} from "../index.js";

/**
 * Phase 5 — Stage 4 (Role-based access) implementation tests.
 *
 * Reverse-test for the orthogonal `ROLE_POLICY_REASONS` tuple lives in
 * `policy-gate-stages.test.ts` (Phase 2 deliverable, not duplicated here).
 *
 * Coverage matrix (sub-plan §3 row Phase 5 + §g):
 *   (1)  Identity with `admin` role + admin allowedEffects=['*'] →
 *        all effects `allowed: true`.
 *   (2)  Identity with `user` role + user allowedEffects=['effect.A']
 *        + effect=A → `allowed: true`.
 *   (3)  Identity with `user` role + user allowedEffects=['effect.A']
 *        + effect=B → `allowed: false`.
 *   (4)  Identity with multiple roles, one permits → `allowed: true`
 *        with the permitting role.
 *   (5)  Identity with no roles (empty resolver result) → fail-closed
 *        `allowed: false`.
 *   (6)  Anonymous identity → fail-closed `allowed: false`.
 *   (7)  Empty config (`policy.roles = {}`) → all role-checks fail-closed.
 *   (8)  Missing role config (`policy.roles[role]` undefined) →
 *        fail-closed for that role.
 *   (9)  `RoleId` brand non-assignability (compile-time).
 *   (10) Episodic event emitted on denial (via injected mock observer).
 *   (11) `roleResolver` called exactly once per evaluation.
 *   (12) `requiredRole` field populated correctly on denial.
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

const POST_EFFECT = "external_effect.performed" as EffectId;
const ANSWER_EFFECT = "communication.answer_delivered" as EffectId;
const PDF_EFFECT = "artifact.pdf_created" as EffectId;

const ADMIN_ROLE = "admin" as RoleId;
const USER_ROLE = "user" as RoleId;
const POSTER_ROLE = "poster" as RoleId;

function cfgWithRoles(entries: Readonly<Record<string, RolePolicyConfigEntry>>): OpenClawConfig {
  return {
    policy: { roles: entries },
  } as unknown as OpenClawConfig;
}

function fixedRoleResolver(roles: readonly RoleId[]): RoleResolver {
  return vi.fn(async () => roles);
}

function fakeMemoryStore(): {
  store: MemoryStore;
  events: EpisodicMemoryEvent[];
} {
  const events: EpisodicMemoryEvent[] = [];
  const store: MemoryStore = {
    storeEpisodic: vi.fn(async (event: EpisodicMemoryEvent) => {
      events.push(event);
      return `mem:${events.length}` as MemoryEntryId;
    }),
    recall: vi.fn(),
    healthCheck: vi.fn(),
  } as unknown as MemoryStore;
  return { store, events };
}

describe("createRolePolicy — Stage 4 (Role-based access) runtime", () => {
  it("(1) admin role with allowedEffects=['*'] permits any effect", async () => {
    const reader = createRolePolicy({
      cfg: cfgWithRoles({
        admin: { allowedEffects: ["*" as EffectId] },
      }),
      roleResolver: fixedRoleResolver([ADMIN_ROLE]),
    });

    const decision1 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
    });
    const decision2 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: ANSWER_EFFECT,
    });
    const decision3 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: PDF_EFFECT,
    });

    expect(decision1).toEqual({ allowed: true, role: ADMIN_ROLE });
    expect(decision2).toEqual({ allowed: true, role: ADMIN_ROLE });
    expect(decision3).toEqual({ allowed: true, role: ADMIN_ROLE });
  });

  it("(2) user role with allowedEffects=['effect.A'] permits effect.A", async () => {
    const reader = createRolePolicy({
      cfg: cfgWithRoles({
        user: { allowedEffects: [ANSWER_EFFECT] },
      }),
      roleResolver: fixedRoleResolver([USER_ROLE]),
    });

    const decision = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: ANSWER_EFFECT,
    });

    expect(decision).toEqual({ allowed: true, role: USER_ROLE });
  });

  it("(3) user role with allowedEffects=['effect.A'] denies effect.B", async () => {
    const reader = createRolePolicy({
      cfg: cfgWithRoles({
        user: { allowedEffects: [ANSWER_EFFECT] },
      }),
      roleResolver: fixedRoleResolver([USER_ROLE]),
    });

    const decision = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed === false) {
      expect(decision.reason).toBe(ROLE_POLICY_REASONS[0]);
      expect(decision.reason).toBe("role_denied");
      // No role permits POST_EFFECT — fallback to first configured role.
      expect(String(decision.requiredRole)).toBe("user");
    }
  });

  it("(4) identity with multiple roles, one permits → allowed with that role", async () => {
    const reader = createRolePolicy({
      cfg: cfgWithRoles({
        user: { allowedEffects: [ANSWER_EFFECT] },
        poster: { allowedEffects: [POST_EFFECT] },
      }),
      roleResolver: fixedRoleResolver([USER_ROLE, POSTER_ROLE]),
    });

    const decision = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
    });

    expect(decision).toEqual({ allowed: true, role: POSTER_ROLE });
  });

  it("(5) identity with no roles (empty resolver result) → fail-closed", async () => {
    const reader = createRolePolicy({
      cfg: cfgWithRoles({
        user: { allowedEffects: [ANSWER_EFFECT] },
        admin: { allowedEffects: ["*" as EffectId] },
      }),
      roleResolver: fixedRoleResolver([]),
    });

    const decision = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: ANSWER_EFFECT,
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed === false) {
      expect(decision.reason).toBe("role_denied");
      // requiredRole = first role whose allowedEffects permits the effect.
      // Both `user` and `admin` permit ANSWER_EFFECT — first wins.
      expect(String(decision.requiredRole)).toBe("user");
    }
  });

  it("(6) anonymous identity (undefined) → fail-closed", async () => {
    const reader = createRolePolicy({
      cfg: cfgWithRoles({
        user: { allowedEffects: [ANSWER_EFFECT] },
      }),
      roleResolver: vi.fn(async () => [USER_ROLE]),
    });

    const decision = await reader.evaluate({
      // Phase 2 interface marks identityId as required, but the
      // wiring layer (RunTurnDecisionInput) threads optional values
      // through — the reader fail-closes against the structural leak.
      identityId: undefined as unknown as IdentityId,
      effectId: ANSWER_EFFECT,
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed === false) {
      expect(decision.reason).toBe("role_denied");
      // No-roles-configured fallback returns the first configured role-key.
      expect(String(decision.requiredRole)).toBe("user");
    }
  });

  it("(7) empty config (policy.roles={}) → all role-checks fail-closed (default-deny)", async () => {
    const reader = createRolePolicy({
      cfg: cfgWithRoles({}),
      roleResolver: fixedRoleResolver([USER_ROLE]),
    });

    const decision = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: ANSWER_EFFECT,
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed === false) {
      expect(decision.reason).toBe("role_denied");
      // Sentinel fallback: no roles configured at all.
      expect(String(decision.requiredRole)).toBe("role:none");
    }
  });

  it("(8) missing role config (policy.roles[role] undefined) → fail-closed for that role", async () => {
    // Identity has the `phantom` role but config does not define it.
    // The role is silently skipped; if no other role permits, denied.
    const reader = createRolePolicy({
      cfg: cfgWithRoles({
        user: { allowedEffects: [ANSWER_EFFECT] },
      }),
      roleResolver: fixedRoleResolver(["phantom" as RoleId]),
    });

    const decision = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: ANSWER_EFFECT,
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed === false) {
      expect(decision.reason).toBe("role_denied");
      // requiredRole = first role whose allowedEffects permits.
      expect(String(decision.requiredRole)).toBe("user");
    }
  });

  it("(10) emits a policy_role episodic event on denial via injected MemoryStore", async () => {
    const { store, events } = fakeMemoryStore();
    const reader = createRolePolicy({
      cfg: cfgWithRoles({
        user: { allowedEffects: [ANSWER_EFFECT] },
      }),
      roleResolver: fixedRoleResolver([USER_ROLE]),
      memoryStore: store,
    });

    await reader.evaluate({ identityId: VLADIMIR, effectId: POST_EFFECT });

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.effectFamily).toBe("policy_role");
    expect(event.identityId).toBe(VLADIMIR);
    if (event.effectFamily === "policy_role") {
      expect(event.payload.reason).toBe("role_denied");
      expect(event.payload.effectId).toBe(POST_EFFECT);
      expect(event.payload.identityId).toBe(VLADIMIR);
      expect(String(event.payload.requiredRole)).toBe("user");
    }
  });

  it("does NOT emit an episodic event on allowed=true", async () => {
    const { store, events } = fakeMemoryStore();
    const reader = createRolePolicy({
      cfg: cfgWithRoles({
        user: { allowedEffects: [ANSWER_EFFECT] },
      }),
      roleResolver: fixedRoleResolver([USER_ROLE]),
      memoryStore: store,
    });

    await reader.evaluate({ identityId: VLADIMIR, effectId: ANSWER_EFFECT });

    expect(events).toHaveLength(0);
  });

  it("does NOT emit an episodic event on anonymous denial (no identityId for the event)", async () => {
    const { store, events } = fakeMemoryStore();
    const reader = createRolePolicy({
      cfg: cfgWithRoles({
        user: { allowedEffects: [ANSWER_EFFECT] },
      }),
      roleResolver: fixedRoleResolver([USER_ROLE]),
      memoryStore: store,
    });

    const decision = await reader.evaluate({
      identityId: undefined as unknown as IdentityId,
      effectId: ANSWER_EFFECT,
    });

    expect(decision.allowed).toBe(false);
    // Anonymous denial cannot emit an EpisodicMemoryEvent (its
    // identityId field is required); the gate fail-closes silently.
    expect(events).toHaveLength(0);
  });

  it("(11) roleResolver called exactly once per evaluation (efficiency check)", async () => {
    const resolver = vi.fn(async () => [USER_ROLE]);
    const reader = createRolePolicy({
      cfg: cfgWithRoles({
        user: { allowedEffects: [ANSWER_EFFECT] },
      }),
      roleResolver: resolver,
    });

    await reader.evaluate({ identityId: VLADIMIR, effectId: ANSWER_EFFECT });
    expect(resolver).toHaveBeenCalledTimes(1);

    // Second evaluation calls resolver again (one call per evaluation).
    await reader.evaluate({ identityId: VLADIMIR, effectId: ANSWER_EFFECT });
    expect(resolver).toHaveBeenCalledTimes(2);

    // Anonymous evaluation MUST NOT call resolver — fail-closed
    // upstream of the resolver.
    await reader.evaluate({
      identityId: undefined as unknown as IdentityId,
      effectId: ANSWER_EFFECT,
    });
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("(12) requiredRole on denial = first role in config whose allowedEffects would have permitted", async () => {
    // user → allows ANSWER; poster → allows POST. Identity holds neither.
    // Effect = POST_EFFECT → poster is the role that would have permitted.
    const reader = createRolePolicy({
      cfg: cfgWithRoles({
        user: { allowedEffects: [ANSWER_EFFECT] },
        poster: { allowedEffects: [POST_EFFECT] },
      }),
      roleResolver: fixedRoleResolver(["phantom" as RoleId]),
    });

    const decision = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed === false) {
      expect(String(decision.requiredRole)).toBe("poster");
    }
  });

  it("(12 cont.) when no role would permit, requiredRole = first configured role", async () => {
    const reader = createRolePolicy({
      cfg: cfgWithRoles({
        user: { allowedEffects: [ANSWER_EFFECT] },
        poster: { allowedEffects: [POST_EFFECT] },
      }),
      roleResolver: fixedRoleResolver([USER_ROLE]),
    });

    // Identity has user role; PDF_EFFECT is NOT permitted by any role
    // in config. So no role would have permitted → fall back to the
    // first configured role-key.
    const decision = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: PDF_EFFECT,
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed === false) {
      expect(String(decision.requiredRole)).toBe("user");
    }
  });

  it("does NOT permit anonymous turn even with admin wildcard role configured", async () => {
    // Wildcard does not bypass identity check — admin perms apply only
    // to identities holding that role; anonymous turns fail-closed.
    const reader = createRolePolicy({
      cfg: cfgWithRoles({
        admin: { allowedEffects: ["*" as EffectId] },
      }),
      roleResolver: fixedRoleResolver([ADMIN_ROLE]),
    });

    const decision = await reader.evaluate({
      identityId: undefined as unknown as IdentityId,
      effectId: POST_EFFECT,
    });

    expect(decision.allowed).toBe(false);
  });

  it("multiple identities resolve independently via the resolver hook", async () => {
    const resolver = vi.fn(async ({ identityId }: { identityId: IdentityId }) => {
      if (identityId === VLADIMIR) {
        return [ADMIN_ROLE];
      }
      if (identityId === ALICE) {
        return [USER_ROLE];
      }
      return [];
    });
    const reader = createRolePolicy({
      cfg: cfgWithRoles({
        user: { allowedEffects: [ANSWER_EFFECT] },
        admin: { allowedEffects: ["*" as EffectId] },
      }),
      roleResolver: resolver,
    });

    const vladDecision = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
    });
    const aliceDecision = await reader.evaluate({
      identityId: ALICE,
      effectId: POST_EFFECT,
    });
    const aliceAnswer = await reader.evaluate({
      identityId: ALICE,
      effectId: ANSWER_EFFECT,
    });

    expect(vladDecision).toEqual({ allowed: true, role: ADMIN_ROLE });
    expect(aliceDecision.allowed).toBe(false);
    expect(aliceAnswer).toEqual({ allowed: true, role: USER_ROLE });
  });

  it("episodic write failure is contained — denial decision still returns", async () => {
    const failing: MemoryStore = {
      storeEpisodic: vi.fn(async () => {
        throw new Error("disk full");
      }),
      recall: vi.fn(),
      healthCheck: vi.fn(),
    } as unknown as MemoryStore;
    const reader = createRolePolicy({
      cfg: cfgWithRoles({
        user: { allowedEffects: [ANSWER_EFFECT] },
      }),
      roleResolver: fixedRoleResolver([USER_ROLE]),
      memoryStore: failing,
    });

    const decision = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed === false) {
      expect(decision.reason).toBe("role_denied");
    }
  });
});

describe("RoleId — brand discipline (invariant #16)", () => {
  it("(9) does not allow IdentityId to be assigned to RoleId implicitly", () => {
    const identity: IdentityId = VLADIMIR;
    // @ts-expect-error - IdentityId must not be assignable to RoleId
    const _bad: RoleId = identity;
    void _bad;
    const role: RoleId = "user" as unknown as RoleId;
    // @ts-expect-error - RoleId must not be assignable to IdentityId
    const _bad2: IdentityId = role;
    void _bad2;
    expect(typeof identity).toBe("string");
    expect(typeof role).toBe("string");
  });
});
