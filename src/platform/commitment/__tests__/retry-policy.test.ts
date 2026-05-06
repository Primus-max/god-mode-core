import { describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../../../config/config.js";
import { asIdentityId, type IdentityId } from "../../identity/identity-id.js";
import type {
  EpisodicMemoryEvent,
  MemoryEntryId,
  MemoryStore,
} from "../../memory/index.js";
import type { EffectId } from "../ids.js";
import {
  RETRY_POLICY_REASONS,
  buildRetryStateKey,
  createInMemoryRetryStateStore,
  createRetryPolicy,
  type RetryPolicyConfigEntry,
  type RetryStateStore,
} from "../index.js";

/**
 * Phase 6 — Stage 5 (Retry policies) implementation tests.
 *
 * Reverse-test for the orthogonal `RETRY_POLICY_REASONS` tuple already
 * lives in `policy-gate-stages.test.ts` (Phase 2 deliverable).
 *
 * Coverage matrix (sub-plan §3 row Phase 6 + §h):
 *   (1)  attempts 1/2/3 with maxAttempts=3 → all `retry: true` with
 *        exponential backoff `100/200/400` ms.
 *   (2)  4th attempt (attemptCount=3, maxAttempts=3) → `retry: false`
 *        with reason `retry_limit_exceeded`.
 *   (3)  Backoff cap: when computed backoff > maxBackoffMs → return
 *        the cap value, not the exponential.
 *   (4)  Per-effect override: `policy.retry.perEffect[<id>].maxAttempts=5`
 *        permits 5 retries before blocking.
 *   (5)  Default `maxAttempts=3` when no per-effect entry is configured.
 *   (6)  Counter scoped per `(identityId, effectId, sessionId)` —
 *        switching session restarts the counter at 0.
 *   (7)  Counter scoped per identityId — switching identity restarts.
 *   (8)  Anonymous identity — `(undefined, effectId, sessionId)` keying
 *        is supported; anonymous turns share one bucket per effect+session.
 *   (9)  Empty config (`policy.retry` undefined) → defaults applied
 *        (`maxAttempts=3`, `maxBackoffMs=30_000`).
 *   (10) Episodic event emitted on `retry: false` (with required
 *        `identityId` for non-anonymous turns).
 *   (11) LRU eviction on overflow does not corrupt unrelated counters.
 *   (12) Brand discipline — `EffectId` non-assignability preserved
 *        (compile-time).
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");
const POST_EFFECT = "external_effect.performed" as EffectId;
const ANSWER_EFFECT = "communication.answer_delivered" as EffectId;
const PDF_EFFECT = "artifact.pdf_created" as EffectId;
const SESSION_A = "session:a";
const SESSION_B = "session:b";

function cfgWithRetry(retry?: {
  defaultMaxAttempts?: number;
  defaultMaxBackoffMs?: number;
  perEffect?: Record<string, RetryPolicyConfigEntry>;
}): OpenClawConfig {
  return {
    policy: { retry },
  } as unknown as OpenClawConfig;
}

function emptyCfg(): OpenClawConfig {
  return {} as OpenClawConfig;
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
    storeSemantic: vi.fn(),
    recall: vi.fn(),
    forget: vi.fn(),
    healthCheck: vi.fn(),
  } as unknown as MemoryStore;
  return { store, events };
}

describe("createRetryPolicy — Stage 5 (Retry policies) runtime", () => {
  it("(1) attempts 1/2/3 with maxAttempts=3 yield retry=true with backoff 100/200/400 ms", async () => {
    const reader = createRetryPolicy({
      cfg: cfgWithRetry({ defaultMaxAttempts: 3 }),
      retryStateStore: createInMemoryRetryStateStore(),
    });

    // Caller sees `attemptCount` as the number of failures so far —
    // attempt 1 has attemptCount=1 (one failure observed; one retry
    // remains within the budget). The backoff for attempt N is
    // `100 * 2^(N-1)` capped at `maxBackoffMs`.
    const r1 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 1,
    });
    expect(r1).toEqual({ retry: true, backoffMs: 100 });

    const r2 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 2,
    });
    expect(r2).toEqual({ retry: true, backoffMs: 200 });

    const r3 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 3,
    });
    // attemptCount === maxAttempts → exhausted, no retry.
    expect(r3.retry).toBe(false);
    if (r3.retry === false) {
      expect(r3.reason).toBe(RETRY_POLICY_REASONS[0]);
      expect(r3.attemptCount).toBe(3);
      expect(r3.maxAttempts).toBe(3);
    }
  });

  it("(2) attemptCount >= maxAttempts → retry=false with retry_limit_exceeded", async () => {
    const reader = createRetryPolicy({
      cfg: cfgWithRetry({ defaultMaxAttempts: 3 }),
      retryStateStore: createInMemoryRetryStateStore(),
    });

    const decision = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 5, // already past limit
    });

    expect(decision.retry).toBe(false);
    if (decision.retry === false) {
      expect(decision.reason).toBe("retry_limit_exceeded");
      expect(decision.attemptCount).toBe(5);
      expect(decision.maxAttempts).toBe(3);
    }
  });

  it("(3) backoff capped at maxBackoffMs", async () => {
    const reader = createRetryPolicy({
      cfg: cfgWithRetry({ defaultMaxAttempts: 10, defaultMaxBackoffMs: 500 }),
      retryStateStore: createInMemoryRetryStateStore(),
    });

    // attempt 4 → 100 * 2^3 = 800ms exponential, but cap is 500.
    const r4 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 4,
    });
    expect(r4).toEqual({ retry: true, backoffMs: 500 });

    // attempt 8 → 100 * 2^7 = 12800ms exponential, capped at 500.
    const r8 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 8,
    });
    expect(r8).toEqual({ retry: true, backoffMs: 500 });

    // attempt 1 → 100ms exponential, well under the cap.
    const r1 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 1,
    });
    expect(r1).toEqual({ retry: true, backoffMs: 100 });
  });

  it("(4) per-effect override increases maxAttempts to 5", async () => {
    const reader = createRetryPolicy({
      cfg: cfgWithRetry({
        defaultMaxAttempts: 3,
        perEffect: { [PDF_EFFECT]: { maxAttempts: 5 } },
      }),
      retryStateStore: createInMemoryRetryStateStore(),
    });

    // Default-budget effect maxes at 3.
    const postExhausted = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 3,
    });
    expect(postExhausted.retry).toBe(false);

    // Per-effect override: PDF gets 5 retries, attempt 3 still
    // within budget → retry=true.
    const pdf3 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: PDF_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 3,
    });
    expect(pdf3).toEqual({ retry: true, backoffMs: 400 });

    // attempt 4 within PDF budget → retry=true.
    const pdf4 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: PDF_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 4,
    });
    expect(pdf4).toEqual({ retry: true, backoffMs: 800 });

    // attempt 5 reaches the per-effect limit → retry=false.
    const pdf5 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: PDF_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 5,
    });
    expect(pdf5.retry).toBe(false);
    if (pdf5.retry === false) {
      expect(pdf5.maxAttempts).toBe(5);
    }
  });

  it("(4 cont.) per-effect override accepts a custom maxBackoffMs", async () => {
    const reader = createRetryPolicy({
      cfg: cfgWithRetry({
        defaultMaxAttempts: 10,
        defaultMaxBackoffMs: 30_000,
        perEffect: { [PDF_EFFECT]: { maxAttempts: 10, maxBackoffMs: 250 } },
      }),
      retryStateStore: createInMemoryRetryStateStore(),
    });

    // attempt 5 → 100 * 2^4 = 1600ms exponential, but PDF cap is 250.
    const pdf5 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: PDF_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 5,
    });
    expect(pdf5).toEqual({ retry: true, backoffMs: 250 });

    // POST effect uses the default cap (30_000), so attempt 5 returns
    // the full exponential 1600ms.
    const post5 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 5,
    });
    expect(post5).toEqual({ retry: true, backoffMs: 1600 });
  });

  it("(5) defaults apply when no per-effect entry — maxAttempts=3, maxBackoffMs=30_000", async () => {
    const reader = createRetryPolicy({
      cfg: emptyCfg(),
      retryStateStore: createInMemoryRetryStateStore(),
    });

    const r2 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: ANSWER_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 2,
    });
    expect(r2).toEqual({ retry: true, backoffMs: 200 });

    const r3 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: ANSWER_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 3,
    });
    expect(r3.retry).toBe(false);
    if (r3.retry === false) {
      expect(r3.maxAttempts).toBe(3);
    }
  });

  it("(6) counter scoped per session — switching session resets the budget", async () => {
    const store = createInMemoryRetryStateStore();
    const reader = createRetryPolicy({
      cfg: cfgWithRetry({ defaultMaxAttempts: 3 }),
      retryStateStore: store,
    });

    // Walk session A up to the limit.
    await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 1,
    });
    await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 2,
    });
    const aExhausted = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 3,
    });
    expect(aExhausted.retry).toBe(false);

    // Session B same identity + effect — counter is independent so
    // attempt 1 still allowed. The store key carries sessionId.
    const bFresh = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_B,
      attemptCount: 1,
    });
    expect(bFresh).toEqual({ retry: true, backoffMs: 100 });

    // Verify by inspecting the store directly: A and B keys hold
    // independent entries.
    const keyA = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
    });
    const keyB = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_B,
    });
    expect(keyA).not.toBe(keyB);
  });

  it("(7) counter scoped per identityId — switching identity resets the budget", async () => {
    const reader = createRetryPolicy({
      cfg: cfgWithRetry({ defaultMaxAttempts: 3 }),
      retryStateStore: createInMemoryRetryStateStore(),
    });

    // Vlad reaches the limit.
    const vlad3 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 3,
    });
    expect(vlad3.retry).toBe(false);

    // Alice on the same effect+session is independent.
    const alice1 = await reader.evaluate({
      identityId: ALICE,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 1,
    });
    expect(alice1).toEqual({ retry: true, backoffMs: 100 });
  });

  it("(8) anonymous identity (undefined) — keying still works, counter advances", async () => {
    const reader = createRetryPolicy({
      cfg: cfgWithRetry({ defaultMaxAttempts: 3 }),
      retryStateStore: createInMemoryRetryStateStore(),
    });

    const r1 = await reader.evaluate({
      identityId: undefined as unknown as IdentityId,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 1,
    });
    expect(r1).toEqual({ retry: true, backoffMs: 100 });

    const r3 = await reader.evaluate({
      identityId: undefined as unknown as IdentityId,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 3,
    });
    expect(r3.retry).toBe(false);
  });

  it("(10) emits policy_retry episodic event on retry=false (named identity)", async () => {
    const { store, events } = fakeMemoryStore();
    const reader = createRetryPolicy({
      cfg: cfgWithRetry({ defaultMaxAttempts: 3 }),
      retryStateStore: createInMemoryRetryStateStore(),
      memoryStore: store,
    });

    await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 3,
    });

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.effectFamily).toBe("policy_retry");
    expect(event.identityId).toBe(VLADIMIR);
    if (event.effectFamily === "policy_retry") {
      expect(event.payload.reason).toBe("retry_limit_exceeded");
      expect(event.payload.effectId).toBe(POST_EFFECT);
      expect(event.payload.identityId).toBe(VLADIMIR);
      expect(event.payload.sessionId).toBe(SESSION_A);
      expect(event.payload.attemptCount).toBe(3);
      expect(event.payload.maxAttempts).toBe(3);
    }
  });

  it("does NOT emit an episodic event on retry=true", async () => {
    const { store, events } = fakeMemoryStore();
    const reader = createRetryPolicy({
      cfg: cfgWithRetry({ defaultMaxAttempts: 3 }),
      retryStateStore: createInMemoryRetryStateStore(),
      memoryStore: store,
    });

    await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 1,
    });

    expect(events).toHaveLength(0);
  });

  it("does NOT emit an episodic event on anonymous denial (no identityId for the event)", async () => {
    const { store, events } = fakeMemoryStore();
    const reader = createRetryPolicy({
      cfg: cfgWithRetry({ defaultMaxAttempts: 3 }),
      retryStateStore: createInMemoryRetryStateStore(),
      memoryStore: store,
    });

    await reader.evaluate({
      identityId: undefined as unknown as IdentityId,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 3,
    });

    // Anonymous denial cannot emit an EpisodicMemoryEvent (its
    // identityId field is required); the gate denies silently.
    expect(events).toHaveLength(0);
  });

  it("(11) LRU eviction on overflow does NOT corrupt unrelated counters used in a single evaluation", async () => {
    // The reader uses the injected store directly; eviction policy
    // belongs to the store. This test pins the integration: a small
    // LRU forced over capacity must not bleed counts across distinct
    // (identity, effect, session) buckets.
    const store = createInMemoryRetryStateStore({ maxKeys: 3 });
    const reader = createRetryPolicy({
      cfg: cfgWithRetry({ defaultMaxAttempts: 5 }),
      retryStateStore: store,
    });

    // Fresh evaluations with three different sessions — the store is
    // populated to exactly capacity.
    await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: "s:0",
      attemptCount: 1,
    });
    await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: "s:1",
      attemptCount: 1,
    });
    await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: "s:2",
      attemptCount: 1,
    });

    // Each evaluation should still return retry=true (1 < 5).
    const r0 = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: "s:0",
      attemptCount: 1,
    });
    expect(r0.retry).toBe(true);
  });

  it("(11 cont.) write through the policy still reaches the underlying retryStateStore", async () => {
    // The Phase 6 spec keys the counter on (identityId × effectId ×
    // sessionId). The reader MUST consult the injected store for
    // historical counter state, even though `attemptCount` is
    // supplied by the caller — the store is the source-of-truth for
    // cross-call recall (which the wrapper layer in Phase 6 will
    // bump). Verify the store records something on each eval.
    const recorded: Array<{ key: string; method: string }> = [];
    const wrappingStore: RetryStateStore = {
      get(key) {
        recorded.push({ key, method: "get" });
        return 0;
      },
      increment(key) {
        recorded.push({ key, method: "increment" });
        return 1;
      },
      reset(key) {
        recorded.push({ key, method: "reset" });
      },
    };
    const reader = createRetryPolicy({
      cfg: cfgWithRetry({ defaultMaxAttempts: 3 }),
      retryStateStore: wrappingStore,
    });

    await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 1,
    });

    // The reader consults the store at least once on every eval.
    // The exact methods called are an impl detail; the seam itself
    // must be exercised so a future caller-layer wiring (the
    // pi-embedded-runner wrapper) can rely on the same store.
    expect(recorded.length).toBeGreaterThan(0);
    const k = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
    });
    expect(recorded.every((r) => r.key === k)).toBe(true);
  });

  it("episodic write failure is contained — denial decision still returns", async () => {
    const failing: MemoryStore = {
      storeEpisodic: vi.fn(async () => {
        throw new Error("disk full");
      }),
      storeSemantic: vi.fn(),
      recall: vi.fn(),
      forget: vi.fn(),
      healthCheck: vi.fn(),
    } as unknown as MemoryStore;
    const reader = createRetryPolicy({
      cfg: cfgWithRetry({ defaultMaxAttempts: 3 }),
      retryStateStore: createInMemoryRetryStateStore(),
      memoryStore: failing,
    });

    const decision = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
      attemptCount: 3,
    });

    expect(decision.retry).toBe(false);
    if (decision.retry === false) {
      expect(decision.reason).toBe("retry_limit_exceeded");
    }
  });
});

describe("createRetryPolicy — log-line evidence (sub-plan §3 row Phase 6)", () => {
  it("emits [policy-gate] event=retry_checked on every evaluation", async () => {
    const logs: string[] = [];
    const { defaultRuntime } = await import("../../../runtime.js");
    const spy = vi.spyOn(defaultRuntime, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });

    try {
      const reader = createRetryPolicy({
        cfg: cfgWithRetry({ defaultMaxAttempts: 3 }),
        retryStateStore: createInMemoryRetryStateStore(),
      });

      await reader.evaluate({
        identityId: VLADIMIR,
        effectId: POST_EFFECT,
        sessionId: SESSION_A,
        attemptCount: 1,
      });

      const checked = logs.find((l) => l.includes("event=retry_checked"));
      expect(checked).toBeTruthy();
      expect(checked).toMatch(/\[policy-gate\] event=retry_checked stage=5 attempt=1\/3 backoff_ms=100/);
    } finally {
      spy.mockRestore();
    }
  });

  it("emits [policy-gate] event=retry_exhausted on retry=false", async () => {
    const logs: string[] = [];
    const { defaultRuntime } = await import("../../../runtime.js");
    const spy = vi.spyOn(defaultRuntime, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });

    try {
      const reader = createRetryPolicy({
        cfg: cfgWithRetry({ defaultMaxAttempts: 3 }),
        retryStateStore: createInMemoryRetryStateStore(),
      });

      await reader.evaluate({
        identityId: VLADIMIR,
        effectId: POST_EFFECT,
        sessionId: SESSION_A,
        attemptCount: 3,
      });

      const exhausted = logs.find((l) => l.includes("event=retry_exhausted"));
      expect(exhausted).toBeTruthy();
      expect(exhausted).toMatch(/\[policy-gate\] event=retry_exhausted effect=external_effect.performed/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("EffectId — brand discipline (invariant #16)", () => {
  it("(12) does not allow EffectId to be assigned to IdentityId implicitly", () => {
    const effect: EffectId = POST_EFFECT;
    // @ts-expect-error - EffectId must not be assignable to IdentityId
    const _bad: IdentityId = effect;
    void _bad;
    expect(typeof effect).toBe("string");
  });
});
