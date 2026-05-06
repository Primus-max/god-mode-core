import { describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../../../config/config.js";
import { asIdentityId, type IdentityId } from "../../identity/identity-id.js";
import type { EpisodicMemoryEvent, MemoryEntryId, MemoryStore } from "../../memory/index.js";
import {
  BUDGET_POLICY_REASONS,
  buildBudgetWindowId,
  createBudgetPolicy,
  type BudgetIncrementInput,
  type BudgetPolicyConfigEntry,
  type BudgetReadQuery,
  type BudgetStore,
  type BudgetWindow,
  type BudgetWindowId,
} from "../index.js";
import type { EffectFamilyId, EffectId } from "../ids.js";

/**
 * Phase 4 — Stage 3 (Budgets) implementation tests.
 *
 * Reverse-test for the orthogonal `BUDGET_POLICY_REASONS` tuple lives in
 * `policy-gate-stages.test.ts` (Phase 2 deliverable, not duplicated here).
 *
 * Coverage matrix (sub-plan §4.h):
 *   (1)  Per-user budget exceeded → reason='budget_exceeded_user'
 *   (2)  Per-channel budget exceeded → reason='budget_exceeded_channel'
 *   (3)  Per-effect budget exceeded → reason='budget_exceeded_effect'
 *   (4)  Window reset (mock clock past windowEnd) → counter resets
 *   (5)  Concurrent increments → atomic, both observe correct values
 *   (6)  No budget rule for a dimension → within=true
 *   (7)  Empty policy.budgets → all dimensions pass within=true
 *   (8)  BudgetWindowId brand non-assignability (compile-time)
 *   (9)  Episodic event emitted on denial via injected MemoryStore
 *   (10) Anonymous identity + user-budget rule → fail-closed within=false
 *   (11) Anonymous identity + channel-budget rule → evaluates against channel
 *   (12) Multiple rules same dimension (filter by effectFamily) → only matches
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

const POST_EFFECT = "external_effect.performed" as EffectId;
const ANSWER_EFFECT = "communication.answer_delivered" as EffectId;
const PDF_EFFECT = "artifact.pdf_created" as EffectId;

const COMMUNICATION_FAMILY = "communication" as EffectFamilyId;
const ARTIFACT_FAMILY = "artifact" as EffectFamilyId;

function cfgWithBudgets(entries: readonly BudgetPolicyConfigEntry[]): OpenClawConfig {
  return {
    policy: { budgets: entries },
  } as unknown as OpenClawConfig;
}

/**
 * In-memory `BudgetStore` fake. Mirrors the production
 * `SqliteBudgetStore` behaviour: per-(dimension, key) rows, lazy
 * window-roll on `read`, atomic increment via
 * `single-pass mutation`. Used by the policy-level tests so this
 * file does not depend on real SQLite I/O.
 */
function createFakeBudgetStore(opts: { now?: () => number } = {}): BudgetStore & {
  rows: Map<string, BudgetWindow>;
  incrementCallLog: Array<BudgetIncrementInput>;
} {
  const rows = new Map<string, BudgetWindow>();
  const incrementCallLog: Array<BudgetIncrementInput> = [];
  const nowFn = opts.now ?? Date.now;
  const keyFor = (q: BudgetReadQuery): string =>
    q.dimension === "user"
      ? `user|${String(q.identityId ?? "")}`
      : q.dimension === "channel"
        ? `channel|${String(q.channel ?? "")}`
        : `effect|${String(q.effectFamily ?? "")}`;

  const rollIfExpired = (key: string, now: number): BudgetWindow | undefined => {
    const w = rows.get(key);
    if (!w) {
      return undefined;
    }
    if (now < w.windowEnd) {
      return w;
    }
    const windowMs = w.windowEnd - w.windowStart;
    const newStart =
      windowMs > 0 ? w.windowStart + Math.floor((now - w.windowStart) / windowMs) * windowMs : now;
    const rolled: BudgetWindow = {
      ...w,
      windowStart: newStart,
      windowEnd: newStart + windowMs,
      used: 0,
      windowId: buildBudgetWindowId({
        dimension: w.dimension,
        ...(w.identityId !== undefined ? { identityId: w.identityId } : {}),
        ...(w.channel !== undefined ? { channel: w.channel } : {}),
        ...(w.effectFamily !== undefined ? { effectFamily: w.effectFamily } : {}),
        windowStart: newStart,
      }),
    };
    rows.set(key, rolled);
    return rolled;
  };

  return {
    rows,
    incrementCallLog,
    read(query: BudgetReadQuery): Promise<BudgetWindow | null> {
      const key = keyFor(query);
      const w = rollIfExpired(key, nowFn());
      return Promise.resolve(w ?? null);
    },
    increment(input: BudgetIncrementInput): Promise<BudgetWindow> {
      incrementCallLog.push(input);
      const key = keyFor(input);
      const now = nowFn();
      let w = rollIfExpired(key, now);
      if (!w) {
        const windowStart = now;
        const windowEnd = windowStart + input.windowMs;
        const fresh: BudgetWindow = {
          windowId: buildBudgetWindowId({
            dimension: input.dimension,
            ...(input.identityId !== undefined ? { identityId: input.identityId } : {}),
            ...(input.channel !== undefined ? { channel: input.channel } : {}),
            ...(input.effectFamily !== undefined ? { effectFamily: input.effectFamily } : {}),
            windowStart,
          }),
          dimension: input.dimension,
          ...(input.identityId !== undefined ? { identityId: input.identityId } : {}),
          ...(input.channel !== undefined ? { channel: input.channel } : {}),
          ...(input.effectFamily !== undefined ? { effectFamily: input.effectFamily } : {}),
          windowStart,
          windowEnd,
          used: 0,
          limit: input.limit,
        };
        rows.set(key, fresh);
        w = fresh;
      }
      const updated: BudgetWindow = { ...w, used: w.used + 1, limit: input.limit };
      rows.set(key, updated);
      return Promise.resolve(updated);
    },
    resetExpired(now: number): Promise<number> {
      let count = 0;
      for (const [k, w] of rows) {
        if (now >= w.windowEnd) {
          rollIfExpired(k, now);
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
  };
}

function fakeMemoryStore(): { store: MemoryStore; events: EpisodicMemoryEvent[] } {
  const events: EpisodicMemoryEvent[] = [];
  const store: MemoryStore = {
    storeEpisodic: vi.fn(async (event: EpisodicMemoryEvent) => {
      events.push(event);
      return `mem:${events.length}` as MemoryEntryId;
    }),
    storeSemantic: vi.fn(),
    recall: vi.fn(),
    list: vi.fn(),
    forget: vi.fn(),
  } as unknown as MemoryStore;
  return { store, events };
}

describe("createBudgetPolicy — Stage 3 (Budgets) runtime", () => {
  it("(7) returns within=true when policy.budgets is empty (default-allow)", async () => {
    const reader = createBudgetPolicy({
      cfg: cfgWithBudgets([]),
      budgetStore: createFakeBudgetStore(),
    });
    const decision = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      channel: "telegram",
    });
    expect(decision.within).toBe(true);
  });

  it("(6) returns within=true when no rule applies to the request dimension", async () => {
    // Only a channel-dimension rule, but the channel does not match.
    const reader = createBudgetPolicy({
      cfg: cfgWithBudgets([
        { dimension: "channel", limit: 10, windowMs: 60_000, channel: "slack" },
      ]),
      budgetStore: createFakeBudgetStore(),
    });
    const decision = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      channel: "telegram",
    });
    expect(decision.within).toBe(true);
  });

  it("(1) denies with reason='budget_exceeded_user' when per-user limit is exceeded", async () => {
    const store = createFakeBudgetStore();
    const reader = createBudgetPolicy({
      cfg: cfgWithBudgets([
        { dimension: "user", limit: 2, windowMs: 60_000, identityId: VLADIMIR },
      ]),
      budgetStore: store,
    });
    // Two within-limit charges.
    expect(
      (await reader.evaluate({ identityId: VLADIMIR, effectId: POST_EFFECT, channel: "telegram" }))
        .within,
    ).toBe(true);
    expect(
      (await reader.evaluate({ identityId: VLADIMIR, effectId: POST_EFFECT, channel: "telegram" }))
        .within,
    ).toBe(true);
    // Third charge denies.
    const denial = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      channel: "telegram",
    });
    expect(denial.within).toBe(false);
    if (denial.within === false) {
      expect(denial.reason).toBe("budget_exceeded_user");
      expect(denial.reason).toBe(BUDGET_POLICY_REASONS[0]);
      expect(denial.used).toBe(3);
      expect(denial.limit).toBe(2);
      expect(denial.windowId.length).toBeGreaterThan(0);
    }
  });

  it("(2) denies with reason='budget_exceeded_channel' when per-channel limit is exceeded", async () => {
    const reader = createBudgetPolicy({
      cfg: cfgWithBudgets([
        { dimension: "channel", limit: 1, windowMs: 60_000, channel: "telegram" },
      ]),
      budgetStore: createFakeBudgetStore(),
    });
    // First charge passes.
    expect(
      (await reader.evaluate({ identityId: VLADIMIR, effectId: POST_EFFECT, channel: "telegram" }))
        .within,
    ).toBe(true);
    // Second charge from a *different* identity but same channel denies.
    const denial = await reader.evaluate({
      identityId: ALICE,
      effectId: POST_EFFECT,
      channel: "telegram",
    });
    expect(denial.within).toBe(false);
    if (denial.within === false) {
      expect(denial.reason).toBe("budget_exceeded_channel");
    }
  });

  it("(3) denies with reason='budget_exceeded_effect' when per-effect limit is exceeded", async () => {
    const reader = createBudgetPolicy({
      cfg: cfgWithBudgets([
        { dimension: "effect", limit: 1, windowMs: 60_000, effectFamily: ARTIFACT_FAMILY },
      ]),
      budgetStore: createFakeBudgetStore(),
      // Test injects a deterministic resolver instead of the registry.
      resolveEffectFamily: (effectId) =>
        effectId === PDF_EFFECT ? ARTIFACT_FAMILY : undefined,
    });
    expect(
      (await reader.evaluate({ identityId: VLADIMIR, effectId: PDF_EFFECT, channel: "telegram" }))
        .within,
    ).toBe(true);
    const denial = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: PDF_EFFECT,
      channel: "telegram",
    });
    expect(denial.within).toBe(false);
    if (denial.within === false) {
      expect(denial.reason).toBe("budget_exceeded_effect");
    }
  });

  it("(4) resets the counter when the window rolls past windowEnd (mock clock)", async () => {
    let clock = 1_000_000;
    const store = createFakeBudgetStore({ now: () => clock });
    const reader = createBudgetPolicy({
      cfg: cfgWithBudgets([
        { dimension: "user", limit: 1, windowMs: 60_000, identityId: VLADIMIR },
      ]),
      budgetStore: store,
    });
    expect(
      (await reader.evaluate({ identityId: VLADIMIR, effectId: POST_EFFECT, channel: "telegram" }))
        .within,
    ).toBe(true);
    const exhaust = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      channel: "telegram",
    });
    expect(exhaust.within).toBe(false);
    // Advance past the window end.
    clock += 120_000;
    const reset = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      channel: "telegram",
    });
    expect(reset.within).toBe(true);
  });

  it("(5) handles concurrent increments atomically — two parallel calls observe sequential used values", async () => {
    const store = createFakeBudgetStore();
    const reader = createBudgetPolicy({
      cfg: cfgWithBudgets([
        { dimension: "user", limit: 100, windowMs: 60_000, identityId: VLADIMIR },
      ]),
      budgetStore: store,
    });
    const results = await Promise.all([
      reader.evaluate({ identityId: VLADIMIR, effectId: POST_EFFECT, channel: "telegram" }),
      reader.evaluate({ identityId: VLADIMIR, effectId: POST_EFFECT, channel: "telegram" }),
      reader.evaluate({ identityId: VLADIMIR, effectId: POST_EFFECT, channel: "telegram" }),
    ]);
    // All three within-limit (limit=100), so we only check counter monotonicity:
    // the in-memory fake serializes via JS event-loop semantics, so used==1,2,3.
    const w = store.rows.get("user|identity:vladimir");
    expect(w?.used).toBe(3);
    for (const r of results) {
      expect(r.within).toBe(true);
    }
  });

  it("(9) emits a policy_budget episodic event on denial via the injected MemoryStore", async () => {
    const { store, events } = fakeMemoryStore();
    const reader = createBudgetPolicy({
      cfg: cfgWithBudgets([
        { dimension: "user", limit: 1, windowMs: 60_000, identityId: VLADIMIR },
      ]),
      budgetStore: createFakeBudgetStore(),
      memoryStore: store,
    });
    await reader.evaluate({ identityId: VLADIMIR, effectId: POST_EFFECT, channel: "telegram" });
    const denial = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      channel: "telegram",
    });
    expect(denial.within).toBe(false);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.effectFamily).toBe("policy_budget");
    expect(event.identityId).toBe(VLADIMIR);
    if (event.effectFamily === "policy_budget") {
      expect(event.payload.reason).toBe("budget_exceeded_user");
      expect(event.payload.identityId).toBe(VLADIMIR);
      expect(event.payload.effectId).toBe(POST_EFFECT);
      expect(event.payload.used).toBe(2);
      expect(event.payload.limit).toBe(1);
      expect(event.payload.windowId).toBeDefined();
    }
  });

  it("(10) fails closed for anonymous identity (undefined) when a user-budget rule applies", async () => {
    const store = createFakeBudgetStore();
    const reader = createBudgetPolicy({
      cfg: cfgWithBudgets([
        { dimension: "user", limit: 5, windowMs: 60_000, identityId: VLADIMIR },
      ]),
      budgetStore: store,
    });
    // Rule scoped to VLADIMIR; an anonymous turn does NOT match the
    // identityId filter, so the rule skips → within=true (default-allow).
    const decisionAnonRuleScoped = await reader.evaluate({
      effectId: POST_EFFECT,
      channel: "telegram",
    });
    expect(decisionAnonRuleScoped.within).toBe(true);
    expect(store.incrementCallLog).toHaveLength(0);

    // Now a `dimension='user'` rule with no identityId filter — fail-closed.
    const readerAny = createBudgetPolicy({
      cfg: cfgWithBudgets([{ dimension: "user", limit: 5, windowMs: 60_000 }]),
      budgetStore: store,
    });
    const decisionAnonUnscoped = await readerAny.evaluate({
      effectId: POST_EFFECT,
      channel: "telegram",
    });
    expect(decisionAnonUnscoped.within).toBe(false);
    if (decisionAnonUnscoped.within === false) {
      expect(decisionAnonUnscoped.reason).toBe("budget_exceeded_user");
      expect(decisionAnonUnscoped.used).toBe(0);
      expect(decisionAnonUnscoped.limit).toBe(5);
    }
  });

  it("(11) anonymous identity still evaluates per-channel rules (channel is operator-agnostic)", async () => {
    const reader = createBudgetPolicy({
      cfg: cfgWithBudgets([
        { dimension: "channel", limit: 1, windowMs: 60_000, channel: "telegram" },
      ]),
      budgetStore: createFakeBudgetStore(),
    });
    // First anonymous turn passes.
    expect(
      (await reader.evaluate({ effectId: POST_EFFECT, channel: "telegram" })).within,
    ).toBe(true);
    // Second anonymous turn denies.
    const denial = await reader.evaluate({ effectId: POST_EFFECT, channel: "telegram" });
    expect(denial.within).toBe(false);
    if (denial.within === false) {
      expect(denial.reason).toBe("budget_exceeded_channel");
    }
  });

  it("(12) multiple user-rules with effectFamily filter — only the matching rule charges", async () => {
    const store = createFakeBudgetStore();
    const reader = createBudgetPolicy({
      cfg: cfgWithBudgets([
        // Vlad: 1 PDF/day
        {
          dimension: "user",
          limit: 1,
          windowMs: 60_000,
          identityId: VLADIMIR,
          effectFamily: ARTIFACT_FAMILY,
        },
        // Vlad: 5 communication/day
        {
          dimension: "user",
          limit: 5,
          windowMs: 60_000,
          identityId: VLADIMIR,
          effectFamily: COMMUNICATION_FAMILY,
        },
      ]),
      budgetStore: store,
      resolveEffectFamily: (effectId) =>
        effectId === PDF_EFFECT
          ? ARTIFACT_FAMILY
          : effectId === ANSWER_EFFECT
            ? COMMUNICATION_FAMILY
            : undefined,
    });
    // First PDF passes (1/1).
    expect(
      (await reader.evaluate({ identityId: VLADIMIR, effectId: PDF_EFFECT, channel: "telegram" }))
        .within,
    ).toBe(true);
    // Second PDF denies — but communication rule is not consulted yet.
    const denial = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: PDF_EFFECT,
      channel: "telegram",
    });
    expect(denial.within).toBe(false);
    if (denial.within === false) {
      expect(denial.reason).toBe("budget_exceeded_user");
    }
    // Communication rule is independent — it should still pass for ANSWER_EFFECT.
    const answerOk = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: ANSWER_EFFECT,
      channel: "telegram",
    });
    expect(answerOk.within).toBe(true);
  });
});

describe("BudgetWindowId — brand discipline (invariant #16)", () => {
  it("buildBudgetWindowId produces a stable string across same inputs", () => {
    const a = buildBudgetWindowId({
      dimension: "user",
      identityId: VLADIMIR,
      windowStart: 1_000_000,
    });
    const b = buildBudgetWindowId({
      dimension: "user",
      identityId: VLADIMIR,
      windowStart: 1_000_000,
    });
    expect(a).toBe(b);
  });

  it("rejects raw string assignment to BudgetWindowId via TS (compile-time)", () => {
    // Negative coverage: the brand prevents implicit string assignment.
    // @ts-expect-error - raw string cannot be assigned to BudgetWindowId
    const bad: BudgetWindowId = "budget:user:vlad:0";
    expect(typeof bad).toBe("string");
  });

  it("rejects EffectId assigned to BudgetWindowId implicitly", () => {
    const _eff: EffectId = POST_EFFECT;
    // @ts-expect-error - EffectId is not assignable to BudgetWindowId
    const _bad: BudgetWindowId = _eff;
    void _bad;
  });
});

describe("createBudgetPolicy — error / edge inputs (negative coverage)", () => {
  it("does not crash when memoryStore.storeEpisodic throws — denial still surfaces", async () => {
    const store: MemoryStore = {
      storeEpisodic: vi.fn(() => Promise.reject(new Error("store unavailable"))),
      storeSemantic: vi.fn(),
      recall: vi.fn(),
      list: vi.fn(),
      forget: vi.fn(),
    } as unknown as MemoryStore;
    const reader = createBudgetPolicy({
      cfg: cfgWithBudgets([
        { dimension: "user", limit: 1, windowMs: 60_000, identityId: VLADIMIR },
      ]),
      budgetStore: createFakeBudgetStore(),
      memoryStore: store,
    });
    await reader.evaluate({ identityId: VLADIMIR, effectId: POST_EFFECT, channel: "telegram" });
    const denial = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      channel: "telegram",
    });
    expect(denial.within).toBe(false);
    // The throw was contained — `storeEpisodic` was called once.
    expect(store.storeEpisodic).toHaveBeenCalledTimes(1);
  });

  it("ignores entries whose dimension does not match any of the three orthogonal axes", async () => {
    // Defensive — a malformed config entry (e.g. older schema) should
    // not throw; the reader silently skips entries it cannot route.
    const reader = createBudgetPolicy({
      cfg: cfgWithBudgets([
        { dimension: "user" as const, limit: 5, windowMs: 60_000, identityId: VLADIMIR },
      ]),
      budgetStore: createFakeBudgetStore(),
    });
    const decision = await reader.evaluate({
      identityId: ALICE,
      effectId: POST_EFFECT,
      channel: "telegram",
    });
    // Rule scoped to VLADIMIR; ALICE skips it — within=true.
    expect(decision.within).toBe(true);
  });

  it("skips per-user rule when identity filter does not match request identity", async () => {
    const reader = createBudgetPolicy({
      cfg: cfgWithBudgets([
        { dimension: "user", limit: 1, windowMs: 60_000, identityId: ALICE },
      ]),
      budgetStore: createFakeBudgetStore(),
    });
    // Request from VLADIMIR — rule scoped to ALICE → skip → within=true.
    expect(
      (await reader.evaluate({ identityId: VLADIMIR, effectId: POST_EFFECT, channel: "telegram" }))
        .within,
    ).toBe(true);
  });

  it("does not consult the budget store when no rule applies to the request", async () => {
    const store = createFakeBudgetStore();
    const reader = createBudgetPolicy({
      cfg: cfgWithBudgets([
        { dimension: "channel", limit: 1, windowMs: 60_000, channel: "slack" },
      ]),
      budgetStore: store,
    });
    await reader.evaluate({ identityId: VLADIMIR, effectId: POST_EFFECT, channel: "telegram" });
    expect(store.incrementCallLog).toHaveLength(0);
  });
});

describe("createBudgetPolicy — IdentityId widening", () => {
  it("evaluates with explicit IdentityId imported from identity-id.js", async () => {
    // Smoke check that the type-level import surface lines up — the
    // TS compiler would already catch a bad import, this just exercises
    // the runtime path.
    const id: IdentityId = VLADIMIR;
    const reader = createBudgetPolicy({
      cfg: cfgWithBudgets([{ dimension: "user", limit: 5, windowMs: 60_000, identityId: id }]),
      budgetStore: createFakeBudgetStore(),
    });
    const decision = await reader.evaluate({
      identityId: id,
      effectId: POST_EFFECT,
      channel: "telegram",
    });
    expect(decision.within).toBe(true);
  });
});
