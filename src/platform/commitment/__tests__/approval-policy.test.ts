import { describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../../../config/config.js";
import { asIdentityId, type IdentityId } from "../../identity/identity-id.js";
import type { EpisodicMemoryEvent, MemoryEntryId, MemoryStore } from "../../memory/index.js";
import {
  APPROVAL_POLICY_REASONS,
  createApprovalPolicy,
  type ApprovalPolicyConfigEntry,
  type ApprovalRequestId,
} from "../index.js";
import type { EffectId } from "../ids.js";
import type { ApprovalRequestCreator } from "../approval-policy.js";

/**
 * Phase 3 — Stage 2 (Approvals) implementation tests.
 *
 * Reverse-test for the orthogonal `APPROVAL_POLICY_REASONS` tuple lives in
 * `policy-gate-stages.test.ts` (Phase 2 deliverable, do not duplicate here).
 *
 * This file covers the runtime behaviour:
 *   1. Effect not in approval list → `{approved: true}`.
 *   2. Effect in list, identity in approvers → `{approved: true}`.
 *   3. Effect in list, identity NOT in approvers → `{approved: false}`.
 *   4. Anonymous (undefined identity) + listed effect → fail-closed.
 *   5. Anonymous + unlisted effect → still `{approved: true}`.
 *   6. Empty config (no `policy.approvals`) → all effects pass.
 *   7. Returned `approvalRequestId` matches what the manager produced.
 *   8. Brand discipline (compile-time): ApprovalRequestId vs IdentityId.
 *   9. Episodic event emitted on denial via injected MemoryStore.
 *  10. Manager.create called via injected hook on denial.
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

const POST_EFFECT = "external_effect.performed" as EffectId;
const ANSWER_EFFECT = "communication.answer_delivered" as EffectId;

function cfgWithApprovals(entries: readonly ApprovalPolicyConfigEntry[]): OpenClawConfig {
  return {
    policy: { approvals: entries },
  } as unknown as OpenClawConfig;
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

function fixedApprovalCreator(id: string): ApprovalRequestCreator {
  return {
    create: vi.fn(() => ({
      id,
      request: { command: `policy-gate:${id}` },
      createdAtMs: 1_000_000,
      expiresAtMs: 1_900_000,
    })),
  };
}

describe("createApprovalPolicy — Stage 2 (Approvals) runtime", () => {
  it("returns approved=true when effect is NOT in approvals list", async () => {
    const reader = createApprovalPolicy({
      cfg: cfgWithApprovals([
        { effectId: POST_EFFECT, requiredApprovals: 1, approvers: [VLADIMIR] },
      ]),
      approvalCreator: fixedApprovalCreator("approval-001"),
    });

    const decision = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: ANSWER_EFFECT,
    });

    expect(decision).toEqual({ approved: true });
  });

  it("returns approved=true when effect requires approval but identity is in approvers list", async () => {
    const reader = createApprovalPolicy({
      cfg: cfgWithApprovals([
        { effectId: POST_EFFECT, requiredApprovals: 1, approvers: [VLADIMIR] },
      ]),
      approvalCreator: fixedApprovalCreator("approval-pre-approved"),
    });

    const decision = await reader.evaluate({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
    });

    expect(decision).toEqual({ approved: true });
  });

  it("returns approved=false with reason=requires_approval when effect requires approval and identity is NOT an approver", async () => {
    const creator = fixedApprovalCreator("approval-deny-1");
    const reader = createApprovalPolicy({
      cfg: cfgWithApprovals([
        { effectId: POST_EFFECT, requiredApprovals: 1, approvers: [VLADIMIR] },
      ]),
      approvalCreator: creator,
    });

    const decision = await reader.evaluate({
      identityId: ALICE,
      effectId: POST_EFFECT,
    });

    expect(decision.approved).toBe(false);
    if (decision.approved === false) {
      expect(decision.reason).toBe(APPROVAL_POLICY_REASONS[0]);
      expect(decision.reason).toBe("requires_approval");
      expect(decision.approvalRequestId).toBe("approval-deny-1");
    }
    expect(creator.create).toHaveBeenCalledTimes(1);
  });

  it("fails closed for anonymous identity (undefined) when effect is in approvals list", async () => {
    const reader = createApprovalPolicy({
      cfg: cfgWithApprovals([
        { effectId: POST_EFFECT, requiredApprovals: 1, approvers: [VLADIMIR] },
      ]),
      approvalCreator: fixedApprovalCreator("approval-anon"),
    });

    const decision = await reader.evaluate({
      effectId: POST_EFFECT,
    });

    expect(decision.approved).toBe(false);
    if (decision.approved === false) {
      expect(decision.reason).toBe("requires_approval");
      expect(decision.approvalRequestId).toBe("approval-anon");
    }
  });

  it("returns approved=true for anonymous identity when effect is NOT in approvals list", async () => {
    const reader = createApprovalPolicy({
      cfg: cfgWithApprovals([
        { effectId: POST_EFFECT, requiredApprovals: 1, approvers: [VLADIMIR] },
      ]),
      approvalCreator: fixedApprovalCreator("approval-anon-skip"),
    });

    const decision = await reader.evaluate({ effectId: ANSWER_EFFECT });

    expect(decision).toEqual({ approved: true });
  });

  it("returns approved=true when policy.approvals is missing or empty (default-pass for unlisted policy)", async () => {
    const readerEmpty = createApprovalPolicy({
      cfg: cfgWithApprovals([]),
      approvalCreator: fixedApprovalCreator("approval-empty"),
    });
    expect(await readerEmpty.evaluate({ identityId: VLADIMIR, effectId: POST_EFFECT })).toEqual({
      approved: true,
    });

    const readerMissing = createApprovalPolicy({
      cfg: {} as OpenClawConfig,
      approvalCreator: fixedApprovalCreator("approval-missing"),
    });
    expect(
      await readerMissing.evaluate({ identityId: VLADIMIR, effectId: POST_EFFECT }),
    ).toEqual({ approved: true });
  });

  it("emits a policy_approval episodic event on denial via the injected MemoryStore", async () => {
    const { store, events } = fakeMemoryStore();
    const reader = createApprovalPolicy({
      cfg: cfgWithApprovals([
        { effectId: POST_EFFECT, requiredApprovals: 1, approvers: [VLADIMIR] },
      ]),
      approvalCreator: fixedApprovalCreator("approval-with-memory"),
      memoryStore: store,
    });

    await reader.evaluate({ identityId: ALICE, effectId: POST_EFFECT });

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.effectFamily).toBe("policy_approval");
    expect(event.identityId).toBe(ALICE);
    if (event.effectFamily === "policy_approval") {
      expect(event.payload.reason).toBe("requires_approval");
      expect(event.payload.effectId).toBe(POST_EFFECT);
      expect(event.payload.identityId).toBe(ALICE);
      expect(event.payload.approvalRequestId).toBe("approval-with-memory");
    }
  });

  it("does NOT emit an episodic event when MemoryStore is absent (graceful degradation)", async () => {
    // No throw: an absent memory store is a valid config (anonymous turn).
    const reader = createApprovalPolicy({
      cfg: cfgWithApprovals([
        { effectId: POST_EFFECT, requiredApprovals: 1, approvers: [VLADIMIR] },
      ]),
      approvalCreator: fixedApprovalCreator("approval-no-memory"),
    });

    const decision = await reader.evaluate({ identityId: ALICE, effectId: POST_EFFECT });
    expect(decision.approved).toBe(false);
  });

  it("does NOT call approvalCreator.create on the approved=true path (no leaks)", async () => {
    const creator = fixedApprovalCreator("approval-noleak");
    const reader = createApprovalPolicy({
      cfg: cfgWithApprovals([
        { effectId: POST_EFFECT, requiredApprovals: 1, approvers: [VLADIMIR] },
      ]),
      approvalCreator: creator,
    });

    await reader.evaluate({ identityId: VLADIMIR, effectId: POST_EFFECT });
    await reader.evaluate({ identityId: VLADIMIR, effectId: ANSWER_EFFECT });

    expect(creator.create).not.toHaveBeenCalled();
  });

  it("rejects identity with empty approvers list (requiredApprovals>0) for any non-listed identity", async () => {
    const creator = fixedApprovalCreator("approval-empty-approvers");
    const reader = createApprovalPolicy({
      cfg: cfgWithApprovals([
        { effectId: POST_EFFECT, requiredApprovals: 1, approvers: [] },
      ]),
      approvalCreator: creator,
    });

    const decision = await reader.evaluate({ identityId: VLADIMIR, effectId: POST_EFFECT });
    expect(decision.approved).toBe(false);
    if (decision.approved === false) {
      expect(decision.reason).toBe("requires_approval");
    }
  });
});

describe("ApprovalRequestId — brand discipline (invariant #16)", () => {
  it("does not allow IdentityId to be assigned to ApprovalRequestId implicitly", () => {
    const identity: IdentityId = VLADIMIR;
    // @ts-expect-error - IdentityId must not be assignable to ApprovalRequestId
    const _bad: ApprovalRequestId = identity;
    void _bad;
    // The reverse direction is also blocked.
    const approval: ApprovalRequestId = "approval-x" as unknown as ApprovalRequestId;
    // @ts-expect-error - ApprovalRequestId must not be assignable to IdentityId
    const _bad2: IdentityId = approval;
    void _bad2;
    expect(typeof identity).toBe("string");
    expect(typeof approval).toBe("string");
  });
});
