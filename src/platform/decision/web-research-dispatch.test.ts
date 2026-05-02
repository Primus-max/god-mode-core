import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createDeliveryReceiptRegistry } from "../commitment/delivery-receipt-registry.js";
import {
  WEB_EVIDENCE_COLLECTED_EFFECT,
  WEB_RESEARCH_SUMMARIZED_EFFECT,
} from "../commitment/effect-family-registry.js";
import type { ExecutionCommitment } from "../commitment/execution-commitment.js";
import type {
  CommitmentId,
  EffectFamilyId,
  EffectId,
  SessionId,
} from "../commitment/ids.js";
import type { SemanticIntent } from "../commitment/semantic-intent.js";
import {
  createWebEvidenceCollector,
  createWebEvidenceWorldStateObserver,
  type TurnKey,
} from "../commitment/web-evidence-world-state-observer.js";
import type {
  WebResearchComposerTransport,
  WebResearchSpecialistTransport,
} from "../../agents/pi-embedded-runner/run/web-research-runtime-adapter.js";
import { runWebResearchDispatch } from "./web-research-dispatch.js";

const SESSION_A = "session-a" as SessionId;
const TURN_KEY: TurnKey = { sessionId: SESSION_A, turnId: "turn-1" };
const TELEGRAM_CONTEXT_KEY = "telegram:chat-12345";
const FULL_TOOL_CATALOG: readonly string[] = Object.freeze(["read", "edit", "bash", "web_search", "pdf"]);

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

const cfg: OpenClawConfig = { agents: { defaults: {} } } as OpenClawConfig;

function makeSpecialistCommitment(): ExecutionCommitment {
  return {
    id: "commitment-specialist" as CommitmentId,
    effect: WEB_EVIDENCE_COLLECTED_EFFECT,
    target: { kind: "external_channel" },
    constraints: { summary: "freshness query", deliveryContextKey: TELEGRAM_CONTEXT_KEY },
    budgets: { maxLatencyMs: 30_000, maxRetries: 1 },
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

describe("runWebResearchDispatch — Search-Composer Phase 4b''-e3", () => {
  it("orchestrates specialist + composer when commitment.effect is WEB_EVIDENCE_COLLECTED_EFFECT", async () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const deliveryReceiptRegistry = createDeliveryReceiptRegistry();
    const specialistTransport: WebResearchSpecialistTransport = vi.fn(async () => ({
      text: TWO_RECORD_REPLY,
    }));
    const composerTransport: WebResearchComposerTransport = vi.fn(async () => ({
      text: "Composed reply with citations.",
      messageId: "msg-composer-1",
    }));

    const result = await runWebResearchDispatch({
      derivedCommitment: makeSpecialistCommitment(),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      cfg,
      fullToolCatalog: FULL_TOOL_CATALOG,
      collector,
      observer,
      deliveryReceiptRegistry,
      specialistTransport,
      composerTransport,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("Composed reply with citations.");
      expect(result.messageId).toBe("msg-composer-1");
      expect(result.recordCount).toBe(2);
    }
    expect(specialistTransport).toHaveBeenCalledTimes(1);
    expect(composerTransport).toHaveBeenCalledTimes(1);
    expect(deliveryReceiptRegistry.list(TELEGRAM_CONTEXT_KEY)).toHaveLength(1);
  });

  it("returns effect_not_dispatchable when commitment.effect is outside the web_research family", async () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const deliveryReceiptRegistry = createDeliveryReceiptRegistry();
    const specialistTransport: WebResearchSpecialistTransport = vi.fn();
    const composerTransport: WebResearchComposerTransport = vi.fn();
    const offCommitment: ExecutionCommitment = {
      ...makeSpecialistCommitment(),
      effect: "answer.delivered" as EffectId,
    };

    const result = await runWebResearchDispatch({
      derivedCommitment: offCommitment,
      intent: makeIntent(),
      turnKey: TURN_KEY,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      cfg,
      fullToolCatalog: FULL_TOOL_CATALOG,
      collector,
      observer,
      deliveryReceiptRegistry,
      specialistTransport,
      composerTransport,
    });

    expect(result).toEqual({ ok: false, stage: "effect_not_dispatchable" });
    expect(specialistTransport).not.toHaveBeenCalled();
    expect(composerTransport).not.toHaveBeenCalled();
  });

  it("returns effect_not_dispatchable when commitment.effect is the composer effect (WEB_RESEARCH_SUMMARIZED_EFFECT) — only the specialist effect is the entry", async () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const deliveryReceiptRegistry = createDeliveryReceiptRegistry();
    const specialistTransport: WebResearchSpecialistTransport = vi.fn();
    const composerTransport: WebResearchComposerTransport = vi.fn();
    const composerCommitment: ExecutionCommitment = {
      ...makeSpecialistCommitment(),
      effect: WEB_RESEARCH_SUMMARIZED_EFFECT,
    };

    const result = await runWebResearchDispatch({
      derivedCommitment: composerCommitment,
      intent: makeIntent(),
      turnKey: TURN_KEY,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      cfg,
      fullToolCatalog: FULL_TOOL_CATALOG,
      collector,
      observer,
      deliveryReceiptRegistry,
      specialistTransport,
      composerTransport,
    });

    expect(result).toEqual({ ok: false, stage: "effect_not_dispatchable" });
    expect(specialistTransport).not.toHaveBeenCalled();
    expect(composerTransport).not.toHaveBeenCalled();
  });

  it("propagates specialist failure (transport error) without invoking composer", async () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const deliveryReceiptRegistry = createDeliveryReceiptRegistry();
    const specialistTransport: WebResearchSpecialistTransport = vi.fn(async () => {
      throw new Error("HTTP 502");
    });
    const composerTransport: WebResearchComposerTransport = vi.fn();

    const result = await runWebResearchDispatch({
      derivedCommitment: makeSpecialistCommitment(),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      cfg,
      fullToolCatalog: FULL_TOOL_CATALOG,
      collector,
      observer,
      deliveryReceiptRegistry,
      specialistTransport,
      composerTransport,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("specialist");
    }
    expect(composerTransport).not.toHaveBeenCalled();
  });

  it("propagates composer failure when specialist succeeds but composer transport errors", async () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const deliveryReceiptRegistry = createDeliveryReceiptRegistry();
    const specialistTransport: WebResearchSpecialistTransport = vi.fn(async () => ({
      text: TWO_RECORD_REPLY,
    }));
    const composerTransport: WebResearchComposerTransport = vi.fn(async () => {
      throw new Error("composer 503");
    });

    const result = await runWebResearchDispatch({
      derivedCommitment: makeSpecialistCommitment(),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      cfg,
      fullToolCatalog: FULL_TOOL_CATALOG,
      collector,
      observer,
      deliveryReceiptRegistry,
      specialistTransport,
      composerTransport,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("composer");
    }
    expect(specialistTransport).toHaveBeenCalledTimes(1);
    expect(composerTransport).toHaveBeenCalledTimes(1);
  });
});
