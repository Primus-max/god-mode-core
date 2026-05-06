import { describe, expect, it, vi } from "vitest";
import { asIdentityId } from "../../identity/identity-id.js";
import { PolicyEscalationPayloadSchema } from "../../memory/episodic-memory-event.js";
import type { EpisodicMemoryEvent, MemoryEntryId, MemoryStore } from "../../memory/index.js";
import type { EffectId } from "../ids.js";
import {
  ESCALATION_POLICY_REASONS,
  createEscalationHook,
  type ApprovalRequestCreator,
  type EscalationHookFireInput,
} from "../index.js";

/**
 * Phase 7 — Stage 6 (Escalation hooks) implementation tests.
 *
 * Reverse-test for the orthogonal `ESCALATION_POLICY_REASONS` tuple
 * lives in `policy-gate-stages.test.ts` (Phase 2 deliverable, not
 * duplicated here).
 *
 * Coverage matrix (sub-plan §3 row Phase 7 + spec):
 *   (1)  denialReason='requires_approval' → channel='approval_request'
 *        (approvalCreator.create called).
 *   (2)  denialReason='budget_exceeded_user' → channel='memory'
 *        (memoryStore.storeEpisodic called).
 *   (3)  denialReason='budget_exceeded_channel' → channel='memory'.
 *   (4)  denialReason='budget_exceeded_effect' → channel='memory'.
 *   (5)  denialReason='role_denied' → channel='memory'.
 *   (6)  denialReason='retry_limit_exceeded' → channel='memory'.
 *   (7)  Idempotency: same `(turnId, identityId, denialReason, effectId)` →
 *        second fire returns `{fired: false, reason: 'escalation_failed',
 *        error.message='duplicate'}` and does NOT re-call the channel.
 *   (8)  Defense-in-depth: memoryStore.storeEpisodic throws → returns
 *        `{fired: false, ..., error.message='transport_error: ...'}` and
 *        does NOT propagate.
 *   (9)  Defense-in-depth: approvalCreator.create throws → returns
 *        `{fired: false, ..., error.message='transport_error: ...'}` and
 *        does NOT propagate.
 *   (10) Anonymous-flavoured denial (non-approval reason) routed to
 *        memory channel → still fires (per spec the "anonymous-like"
 *        path uses memory because there is no approval flow to route to).
 *   (11) Episodic payload validates against the Phase 2
 *        `PolicyEscalationPayloadSchema` Zod schema.
 *   (12) Different turn (turnId changes) → idempotency map resets and a
 *        new fire succeeds for the same `(identityId, denialReason,
 *        effectId)` triple.
 *   (13) No-channel: escalation hook constructed without memoryStore AND
 *        without approvalCreator → memory-channel-bound denial returns
 *        `error.message='no_channel'`.
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

const POST_EFFECT = "external_effect.performed" as EffectId;
const PDF_EFFECT = "artifact.pdf_created" as EffectId;

function fakeMemoryStore(): {
  store: MemoryStore;
  events: EpisodicMemoryEvent[];
  storeEpisodic: ReturnType<typeof vi.fn>;
} {
  const events: EpisodicMemoryEvent[] = [];
  const storeEpisodic = vi.fn(async (event: EpisodicMemoryEvent) => {
    events.push(event);
    return `mem:${events.length}` as MemoryEntryId;
  });
  const store: MemoryStore = {
    storeEpisodic,
    recall: vi.fn(),
    healthCheck: vi.fn(),
  } as unknown as MemoryStore;
  return { store, events, storeEpisodic };
}

function rejectingMemoryStore(message: string): {
  store: MemoryStore;
  storeEpisodic: ReturnType<typeof vi.fn>;
} {
  const storeEpisodic = vi.fn(async (_event: EpisodicMemoryEvent) => {
    throw new Error(message);
  });
  const store: MemoryStore = {
    storeEpisodic,
    recall: vi.fn(),
    healthCheck: vi.fn(),
  } as unknown as MemoryStore;
  return { store, storeEpisodic };
}

function fixedApprovalCreator(id: string): {
  creator: ApprovalRequestCreator;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(() => ({
    id,
    request: { command: `policy-gate:${id}` },
    createdAtMs: 1_000_000,
    expiresAtMs: 1_900_000,
  }));
  const creator: ApprovalRequestCreator = { create };
  return { creator, create };
}

function throwingApprovalCreator(message: string): {
  creator: ApprovalRequestCreator;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(() => {
    throw new Error(message);
  });
  const creator: ApprovalRequestCreator = { create };
  return { creator, create };
}

function fireInput(
  overrides: Partial<EscalationHookFireInput> & { turnId?: string } = {},
): EscalationHookFireInput & { turnId?: string } {
  return {
    identityId: VLADIMIR,
    effectId: POST_EFFECT,
    denialReason: "requires_approval",
    channel: "telegram",
    ...overrides,
  };
}

describe("createEscalationHook — Stage 6 (Escalation) channel selection", () => {
  it("(1) requires_approval → routes to channel='approval_request' (approvalCreator.create called)", async () => {
    const { store } = fakeMemoryStore();
    const { creator, create } = fixedApprovalCreator("escalation-001");

    const hook = createEscalationHook({ memoryStore: store, approvalCreator: creator });
    const result = await hook.fire(
      fireInput({ denialReason: "requires_approval", turnId: "turn:1" }),
    );

    expect(result.fired).toBe(true);
    if (result.fired) {
      expect(result.escalationId).toBe("escalation-001");
    }
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("(2) budget_exceeded_user → routes to channel='memory' (storeEpisodic called)", async () => {
    const { store, events, storeEpisodic } = fakeMemoryStore();
    const { creator, create } = fixedApprovalCreator("never");

    const hook = createEscalationHook({ memoryStore: store, approvalCreator: creator });
    const result = await hook.fire(
      fireInput({ denialReason: "budget_exceeded_user", turnId: "turn:1" }),
    );

    expect(result.fired).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(storeEpisodic).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.effectFamily).toBe("policy_escalation");
  });

  it("(3) budget_exceeded_channel → routes to channel='memory'", async () => {
    const { store, storeEpisodic } = fakeMemoryStore();
    const { creator, create } = fixedApprovalCreator("never");
    const hook = createEscalationHook({ memoryStore: store, approvalCreator: creator });

    const result = await hook.fire(
      fireInput({ denialReason: "budget_exceeded_channel", turnId: "turn:1" }),
    );
    expect(result.fired).toBe(true);
    expect(storeEpisodic).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("(4) budget_exceeded_effect → routes to channel='memory'", async () => {
    const { store, storeEpisodic } = fakeMemoryStore();
    const { creator } = fixedApprovalCreator("never");
    const hook = createEscalationHook({ memoryStore: store, approvalCreator: creator });

    const result = await hook.fire(
      fireInput({ denialReason: "budget_exceeded_effect", turnId: "turn:1" }),
    );
    expect(result.fired).toBe(true);
    expect(storeEpisodic).toHaveBeenCalledTimes(1);
  });

  it("(5) role_denied → routes to channel='memory'", async () => {
    const { store, storeEpisodic } = fakeMemoryStore();
    const { creator } = fixedApprovalCreator("never");
    const hook = createEscalationHook({ memoryStore: store, approvalCreator: creator });

    const result = await hook.fire(fireInput({ denialReason: "role_denied", turnId: "turn:1" }));
    expect(result.fired).toBe(true);
    expect(storeEpisodic).toHaveBeenCalledTimes(1);
  });

  it("(6) retry_limit_exceeded → routes to channel='memory'", async () => {
    const { store, storeEpisodic } = fakeMemoryStore();
    const { creator } = fixedApprovalCreator("never");
    const hook = createEscalationHook({ memoryStore: store, approvalCreator: creator });

    const result = await hook.fire(
      fireInput({ denialReason: "retry_limit_exceeded", turnId: "turn:1" }),
    );
    expect(result.fired).toBe(true);
    expect(storeEpisodic).toHaveBeenCalledTimes(1);
  });
});

describe("createEscalationHook — idempotency", () => {
  it("(7) repeated fire within same turn for same (identity, reason, effect) → duplicate, no re-call", async () => {
    const { store, storeEpisodic } = fakeMemoryStore();
    const { creator } = fixedApprovalCreator("escalation-001");
    const hook = createEscalationHook({ memoryStore: store, approvalCreator: creator });

    const first = await hook.fire(
      fireInput({ denialReason: "budget_exceeded_user", turnId: "turn:42" }),
    );
    expect(first.fired).toBe(true);
    expect(storeEpisodic).toHaveBeenCalledTimes(1);

    const second = await hook.fire(
      fireInput({ denialReason: "budget_exceeded_user", turnId: "turn:42" }),
    );
    expect(second.fired).toBe(false);
    if (!second.fired) {
      expect(second.reason).toBe(ESCALATION_POLICY_REASONS[0]);
      expect(second.error.message).toContain("duplicate");
    }
    // Memory store NOT called twice — duplicate skip.
    expect(storeEpisodic).toHaveBeenCalledTimes(1);
  });

  it("(12) different turnId resets idempotency for the same (identity, reason, effect)", async () => {
    const { store, storeEpisodic } = fakeMemoryStore();
    const { creator } = fixedApprovalCreator("e2");
    const hook = createEscalationHook({ memoryStore: store, approvalCreator: creator });

    const first = await hook.fire(fireInput({ denialReason: "role_denied", turnId: "turn:1" }));
    expect(first.fired).toBe(true);
    const second = await hook.fire(fireInput({ denialReason: "role_denied", turnId: "turn:2" }));
    expect(second.fired).toBe(true);
    expect(storeEpisodic).toHaveBeenCalledTimes(2);
  });

  it("idempotency keyed on (identityId, denialReason, effectId) — different identity in same turn re-fires", async () => {
    const { store, storeEpisodic } = fakeMemoryStore();
    const { creator } = fixedApprovalCreator("e3");
    const hook = createEscalationHook({ memoryStore: store, approvalCreator: creator });

    await hook.fire(
      fireInput({
        identityId: VLADIMIR,
        denialReason: "role_denied",
        turnId: "turn:7",
      }),
    );
    const second = await hook.fire(
      fireInput({
        identityId: ALICE,
        denialReason: "role_denied",
        turnId: "turn:7",
      }),
    );
    expect(second.fired).toBe(true);
    expect(storeEpisodic).toHaveBeenCalledTimes(2);
  });
});

describe("createEscalationHook — defense-in-depth", () => {
  it("(8) memoryStore.storeEpisodic throws → returns fired=false with transport_error, does NOT propagate", async () => {
    const { store } = rejectingMemoryStore("sqlite locked");
    const { creator } = fixedApprovalCreator("never");
    const hook = createEscalationHook({ memoryStore: store, approvalCreator: creator });

    let threw = false;
    let result;
    try {
      result = await hook.fire(
        fireInput({ denialReason: "budget_exceeded_user", turnId: "turn:1" }),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.fired).toBe(false);
    if (result && !result.fired) {
      expect(result.reason).toBe(ESCALATION_POLICY_REASONS[0]);
      expect(result.error.message).toContain("transport_error");
      expect(result.error.message).toContain("sqlite locked");
    }
  });

  it("(9) approvalCreator.create throws → returns fired=false with transport_error, does NOT propagate", async () => {
    const { store } = fakeMemoryStore();
    const { creator } = throwingApprovalCreator("approval manager full");
    const hook = createEscalationHook({ memoryStore: store, approvalCreator: creator });

    let threw = false;
    let result;
    try {
      result = await hook.fire(fireInput({ denialReason: "requires_approval", turnId: "turn:1" }));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.fired).toBe(false);
    if (result && !result.fired) {
      expect(result.error.message).toContain("transport_error");
      expect(result.error.message).toContain("approval manager full");
    }
  });

  it("(13) no channel injected → memory-routed denial returns no_channel error", async () => {
    const hook = createEscalationHook({});
    const result = await hook.fire(fireInput({ denialReason: "role_denied", turnId: "turn:1" }));
    expect(result.fired).toBe(false);
    if (!result.fired) {
      expect(result.error.message).toContain("no_channel");
    }
  });

  it("(13b) no approvalCreator injected → approval-routed denial returns no_channel error", async () => {
    const { store } = fakeMemoryStore();
    const hook = createEscalationHook({ memoryStore: store });
    const result = await hook.fire(
      fireInput({ denialReason: "requires_approval", turnId: "turn:1" }),
    );
    expect(result.fired).toBe(false);
    if (!result.fired) {
      expect(result.error.message).toContain("no_channel");
    }
  });
});

describe("createEscalationHook — anonymous-like + payload shape", () => {
  it("(10) non-approval denial fires through memory channel (does not require approvalCreator)", async () => {
    const { store, storeEpisodic } = fakeMemoryStore();
    const hook = createEscalationHook({ memoryStore: store });

    const result = await hook.fire(
      fireInput({ denialReason: "retry_limit_exceeded", turnId: "turn:1" }),
    );
    expect(result.fired).toBe(true);
    expect(storeEpisodic).toHaveBeenCalledTimes(1);
  });

  it("(11) episodic payload validates against PolicyEscalationPayloadSchema (Phase 2 Zod)", async () => {
    const { store, events } = fakeMemoryStore();
    const hook = createEscalationHook({ memoryStore: store });

    const result = await hook.fire(fireInput({ denialReason: "role_denied", turnId: "turn:1" }));
    expect(result.fired).toBe(true);

    expect(events).toHaveLength(1);
    const payload = events[0]?.payload;
    const parsed = PolicyEscalationPayloadSchema.parse(payload);
    expect(parsed.denialReason).toBe("role_denied");
    expect(parsed.identityId).toBe(VLADIMIR);
    expect(parsed.effectId).toBe(POST_EFFECT);
    expect(parsed.channel).toBe("telegram");
    expect(parsed.escalationId.length).toBeGreaterThan(0);
  });
});
