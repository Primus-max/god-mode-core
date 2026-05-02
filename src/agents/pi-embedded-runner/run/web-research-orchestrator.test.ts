import { describe, expect, it, vi } from "vitest";
import { createDeliveryReceiptRegistry } from "../../../platform/commitment/delivery-receipt-registry.js";
import {
  WEB_EVIDENCE_COLLECTED_EFFECT,
  WEB_RESEARCH_SUMMARIZED_EFFECT,
} from "../../../platform/commitment/effect-family-registry.js";
import type { ExecutionCommitment } from "../../../platform/commitment/execution-commitment.js";
import type {
  CommitmentId,
  EffectFamilyId,
  EffectId,
  ISO8601,
  SessionId,
} from "../../../platform/commitment/ids.js";
import type { SemanticIntent } from "../../../platform/commitment/semantic-intent.js";
import {
  createWebEvidenceCollector,
  createWebEvidenceWorldStateObserver,
  type TurnKey,
} from "../../../platform/commitment/web-evidence-world-state-observer.js";
import {
  isWebResearchFamilyEffect,
  runWebResearchTurn,
} from "./web-research-orchestrator.js";
import type {
  WebResearchComposerTransport,
  WebResearchSpecialistTransport,
} from "./web-research-runtime-adapter.js";

const SESSION_A = "session-a" as SessionId;
const TURN_KEY: TurnKey = { sessionId: SESSION_A, turnId: "turn-1" };
const TELEGRAM_CONTEXT_KEY = "telegram:chat-12345";
const FULL_TOOL_CATALOG: readonly string[] = Object.freeze([
  "read",
  "edit",
  "bash",
  "web_search",
  "pdf",
]);

const TWO_RECORD_REPLY = JSON.stringify([
  {
    url: "https://example.com/announcement",
    snippet: "first",
    title: "First",
    capturedAt: "2026-05-02T11:00:00.000Z",
  },
  {
    url: "https://example.com/blog",
    snippet: "second",
    capturedAt: "2026-05-02T11:05:00.000Z",
  },
]);

function makeCommitment(effect: EffectId, idSuffix: string): ExecutionCommitment {
  return {
    id: `commitment-${idSuffix}` as CommitmentId,
    effect,
    target: { kind: "external_channel" },
    constraints: { summary: "freshness query", deliveryContextKey: TELEGRAM_CONTEXT_KEY },
    budgets: { maxLatencyMs: 60_000, maxRetries: 0 },
    requiredEvidence: [{ kind: "web_evidence.collected", mandatory: true }],
    terminalPolicy: {
      onTimeout: "unsupported",
      onPolicyDenial: "rejected",
      onUnsatisfiedSuccess: "rejected",
    },
  };
}

function makeIntent(): SemanticIntent {
  return {
    desiredEffectFamily: "web_research" as EffectFamilyId,
    target: { kind: "external_channel" },
    operation: { kind: "create" },
    constraints: { summary: "synthesize the latest model lineup", maxRecords: 5 },
    uncertainty: [],
    confidence: 0.92,
  };
}

describe("runWebResearchTurn — Search-Composer Phase 4b'-a", () => {
  it("returns ok with both recordCount and messageId on the canonical happy path", async () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const registry = createDeliveryReceiptRegistry();
    const specialistTransport: WebResearchSpecialistTransport = vi.fn(async () => ({
      text: TWO_RECORD_REPLY,
    }));
    const composerTransport: WebResearchComposerTransport = vi.fn(async () => ({
      text: "Composed reply with citations.",
      messageId: "msg-composer-1",
    }));

    const result = await runWebResearchTurn({
      specialistCommitment: makeCommitment(WEB_EVIDENCE_COLLECTED_EFFECT, "specialist"),
      composerCommitment: makeCommitment(WEB_RESEARCH_SUMMARIZED_EFFECT, "composer"),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      specialistTransport,
      composerTransport,
      collector,
      observer,
      deliveryReceiptRegistry: registry,
      fullToolCatalog: FULL_TOOL_CATALOG,
      now: () => 1_700_000_000_000,
    });

    expect(result).toEqual({
      ok: true,
      specialist: { recordCount: 2 },
      composer: { messageId: "msg-composer-1", text: "Composed reply with citations." },
    });

    expect(specialistTransport).toHaveBeenCalledTimes(1);
    expect(composerTransport).toHaveBeenCalledTimes(1);

    const receipts = registry.list(TELEGRAM_CONTEXT_KEY);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.effect).toBe(WEB_RESEARCH_SUMMARIZED_EFFECT);
  });

  it("does NOT call the composer when the specialist fails (HTTP 400 surrogate)", async () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const registry = createDeliveryReceiptRegistry();
    const specialistTransport: WebResearchSpecialistTransport = vi.fn(async () => {
      throw new Error("HTTP 400");
    });
    const composerTransport: WebResearchComposerTransport = vi.fn();

    const result = await runWebResearchTurn({
      specialistCommitment: makeCommitment(WEB_EVIDENCE_COLLECTED_EFFECT, "specialist"),
      composerCommitment: makeCommitment(WEB_RESEARCH_SUMMARIZED_EFFECT, "composer"),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      specialistTransport,
      composerTransport,
      collector,
      observer,
      deliveryReceiptRegistry: registry,
      fullToolCatalog: FULL_TOOL_CATALOG,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("specialist");
      expect(result.specialist?.ok).toBe(false);
      if (result.specialist && !result.specialist.ok) {
        expect(result.specialist.reason).toBe("transport_error");
      }
    }
    expect(composerTransport).not.toHaveBeenCalled();
    expect(registry.list(TELEGRAM_CONTEXT_KEY)).toEqual([]);
  });

  it("does NOT call the composer when the specialist returns no_records", async () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const registry = createDeliveryReceiptRegistry();
    const specialistTransport: WebResearchSpecialistTransport = vi.fn(async () => ({
      text: "[]",
    }));
    const composerTransport: WebResearchComposerTransport = vi.fn();

    const result = await runWebResearchTurn({
      specialistCommitment: makeCommitment(WEB_EVIDENCE_COLLECTED_EFFECT, "specialist"),
      composerCommitment: makeCommitment(WEB_RESEARCH_SUMMARIZED_EFFECT, "composer"),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      specialistTransport,
      composerTransport,
      collector,
      observer,
      deliveryReceiptRegistry: registry,
      fullToolCatalog: FULL_TOOL_CATALOG,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("specialist");
      expect(result.specialist?.ok).toBe(false);
      if (result.specialist && !result.specialist.ok) {
        expect(result.specialist.reason).toBe("no_records");
      }
    }
    expect(composerTransport).not.toHaveBeenCalled();
  });

  it("returns composer failure with the specialist slice still populated when composer transport errors", async () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const registry = createDeliveryReceiptRegistry();
    const specialistTransport: WebResearchSpecialistTransport = vi.fn(async () => ({
      text: TWO_RECORD_REPLY,
    }));
    const composerTransport: WebResearchComposerTransport = vi.fn(async () => {
      throw new Error("HTTP 503");
    });

    const result = await runWebResearchTurn({
      specialistCommitment: makeCommitment(WEB_EVIDENCE_COLLECTED_EFFECT, "specialist"),
      composerCommitment: makeCommitment(WEB_RESEARCH_SUMMARIZED_EFFECT, "composer"),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      specialistTransport,
      composerTransport,
      collector,
      observer,
      deliveryReceiptRegistry: registry,
      fullToolCatalog: FULL_TOOL_CATALOG,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("composer");
      expect(result.composer?.ok).toBe(false);
      if (result.composer && !result.composer.ok) {
        expect(result.composer.reason).toBe("transport_error");
      }
    }

    // Specialist slice survives the composer failure — caller (Phase 4b'-b) can
    // decide whether to surface partial evidence to the user.
    const slice = observer.observe();
    expect(slice?.records).toHaveLength(2);
    expect(registry.list(TELEGRAM_CONTEXT_KEY)).toEqual([]);
  });

  it("rejects effect_mismatch on specialist commitment when its effect is wrong", async () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const registry = createDeliveryReceiptRegistry();
    const specialistTransport: WebResearchSpecialistTransport = vi.fn();
    const composerTransport: WebResearchComposerTransport = vi.fn();

    const result = await runWebResearchTurn({
      specialistCommitment: makeCommitment(WEB_RESEARCH_SUMMARIZED_EFFECT, "wrong"),
      composerCommitment: makeCommitment(WEB_RESEARCH_SUMMARIZED_EFFECT, "composer"),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      specialistTransport,
      composerTransport,
      collector,
      observer,
      deliveryReceiptRegistry: registry,
      fullToolCatalog: FULL_TOOL_CATALOG,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("specialist");
    }
    expect(specialistTransport).not.toHaveBeenCalled();
    expect(composerTransport).not.toHaveBeenCalled();
  });

  it("rejects effect_mismatch on composer commitment when its effect is wrong", async () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const registry = createDeliveryReceiptRegistry();
    const specialistTransport: WebResearchSpecialistTransport = vi.fn();
    const composerTransport: WebResearchComposerTransport = vi.fn();

    const result = await runWebResearchTurn({
      specialistCommitment: makeCommitment(WEB_EVIDENCE_COLLECTED_EFFECT, "specialist"),
      composerCommitment: makeCommitment(WEB_EVIDENCE_COLLECTED_EFFECT, "wrong"),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      specialistTransport,
      composerTransport,
      collector,
      observer,
      deliveryReceiptRegistry: registry,
      fullToolCatalog: FULL_TOOL_CATALOG,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("composer");
    }
    expect(specialistTransport).not.toHaveBeenCalled();
    expect(composerTransport).not.toHaveBeenCalled();
  });

  it("returns web_evidence_missing on the composer stage if the observer reports an empty slice between adapters", async () => {
    // Pathological observer: claims success on specialist but exposes empty slice
    // (would happen if a future regression broke setActiveTurn wiring).
    const collector = createWebEvidenceCollector();
    const observer = {
      observe: () => undefined,
    };
    const registry = createDeliveryReceiptRegistry();
    const specialistTransport: WebResearchSpecialistTransport = vi.fn(async () => ({
      text: TWO_RECORD_REPLY,
    }));
    const composerTransport: WebResearchComposerTransport = vi.fn();

    const result = await runWebResearchTurn({
      specialistCommitment: makeCommitment(WEB_EVIDENCE_COLLECTED_EFFECT, "specialist"),
      composerCommitment: makeCommitment(WEB_RESEARCH_SUMMARIZED_EFFECT, "composer"),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      specialistTransport,
      composerTransport,
      collector,
      observer,
      deliveryReceiptRegistry: registry,
      fullToolCatalog: FULL_TOOL_CATALOG,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("composer");
      if (result.composer && !result.composer.ok) {
        expect(result.composer.reason).toBe("web_evidence_missing");
      }
    }
    expect(composerTransport).not.toHaveBeenCalled();
  });
});

describe("isWebResearchFamilyEffect — Search-Composer Phase 4b'-a", () => {
  it("returns true for the two web_research family effect ids", () => {
    expect(isWebResearchFamilyEffect(WEB_EVIDENCE_COLLECTED_EFFECT)).toBe(true);
    expect(isWebResearchFamilyEffect(WEB_RESEARCH_SUMMARIZED_EFFECT)).toBe(true);
  });

  it("returns false for non-web_research effects (ensures the Phase 4b'-b conditional short-circuits cleanly)", () => {
    expect(isWebResearchFamilyEffect("persistent_session.created" as EffectId)).toBe(false);
    expect(isWebResearchFamilyEffect("answer.delivered" as EffectId)).toBe(false);
    expect(isWebResearchFamilyEffect("clarification_requested" as EffectId)).toBe(false);
    expect(isWebResearchFamilyEffect("external_effect.performed" as EffectId)).toBe(false);
  });
});

// `ISO8601` is intentionally imported only to satisfy the `as const`-style
// fixture branding used by the adapter helpers; suppressing unused-import
// noise without removing the brand chain.
void (null as unknown as ISO8601);
