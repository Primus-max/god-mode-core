import { describe, expect, it, vi } from "vitest";
import {
  WEB_EVIDENCE_COLLECTED_EFFECT,
  WEB_RESEARCH_SUMMARIZED_EFFECT,
} from "../../../platform/commitment/effect-family-registry.js";
import type { ExecutionCommitment } from "../../../platform/commitment/execution-commitment.js";
import type {
  CommitmentId,
  EffectFamilyId,
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
  createDeliveryReceiptRegistry,
  type DeliveryReceiptRegistry,
} from "../../../platform/commitment/delivery-receipt-registry.js";
import type { WebEvidenceWorldState } from "../../../platform/commitment/world-state.js";
import {
  runComposerAfterSearch,
  runWebResearchSpecialist,
  type WebResearchComposerTransport,
  type WebResearchSpecialistTransport,
} from "./web-research-runtime-adapter.js";

const SESSION_A = "session-a" as SessionId;
const TURN_KEY: TurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

function makeCommitment(effect = WEB_EVIDENCE_COLLECTED_EFFECT): ExecutionCommitment {
  return {
    id: "commitment-test" as CommitmentId,
    effect,
    target: { kind: "external_channel" },
    constraints: { summary: "latest model releases" },
    budgets: { maxLatencyMs: 30_000, maxRetries: 1 },
    requiredEvidence: [{ kind: "web_evidence.collected", mandatory: true }],
    terminalPolicy: {
      onTimeout: "unsupported",
      onPolicyDenial: "rejected",
      onUnsatisfiedSuccess: "rejected",
    },
  };
}

function makeIntent(constraints: Record<string, unknown> = {}): SemanticIntent {
  return {
    desiredEffectFamily: "web_research" as EffectFamilyId,
    target: { kind: "external_channel" },
    operation: { kind: "create" },
    constraints: {
      summary: "latest model releases on 2026-05-02",
      freshness: "current",
      maxRecords: 5,
      ...constraints,
    },
    uncertainty: [],
    confidence: 0.92,
  };
}

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

describe("runWebResearchSpecialist — Search-Composer Phase 4a", () => {
  it("returns ok with recordCount and populates the collector on a happy reply", async () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const transport: WebResearchSpecialistTransport = vi.fn(async () => ({
      text: TWO_RECORD_REPLY,
    }));
    const logger = vi.fn();

    const result = await runWebResearchSpecialist({
      commitment: makeCommitment(),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      transport,
      collector,
      logger,
    });

    expect(result).toEqual({ ok: true, recordCount: 2 });
    expect(transport).toHaveBeenCalledTimes(1);

    const slice = observer.observe();
    expect(slice?.records.map((r) => r.url)).toEqual([
      "https://example.com/announcement",
      "https://example.com/blog",
    ]);

    expect(logger).toHaveBeenCalledTimes(1);
    const line = logger.mock.calls[0]?.[0] as string;
    expect(line).toContain("[commitment] effect=web_evidence.collected records=2");
    expect(line).toContain(`sessionId=${SESSION_A}`);
    expect(line).toContain("turnId=turn-1");
  });

  it("rejects effect_mismatch when commitment effect is not WEB_EVIDENCE_COLLECTED_EFFECT", async () => {
    const collector = createWebEvidenceCollector();
    const transport: WebResearchSpecialistTransport = vi.fn();
    const result = await runWebResearchSpecialist({
      commitment: makeCommitment(WEB_RESEARCH_SUMMARIZED_EFFECT),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      transport,
      collector,
    });
    expect(result).toEqual({ ok: false, reason: "effect_mismatch" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("returns transport_error when the transport rejects (HTTP 400 / 5xx surrogate)", async () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const transport: WebResearchSpecialistTransport = vi.fn(async () => {
      throw new Error("HTTP 400: bad request");
    });

    const result = await runWebResearchSpecialist({
      commitment: makeCommitment(),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      transport,
      collector,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("transport_error");
      expect(result.detail).toContain("HTTP 400");
    }

    collector.setActiveTurn(TURN_KEY);
    expect(observer.observe()).toBeUndefined();
  });

  it("returns parse_error when the reply is not valid JSON", async () => {
    const collector = createWebEvidenceCollector();
    const transport: WebResearchSpecialistTransport = vi.fn(async () => ({
      text: "Sorry, I cannot help with that.",
    }));

    const result = await runWebResearchSpecialist({
      commitment: makeCommitment(),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      transport,
      collector,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("parse_error");
      expect(result.detail).toMatch(/invalid_json/);
    }
  });

  it("returns parse_error with record-index detail when a record fails Zod schema", async () => {
    const collector = createWebEvidenceCollector();
    const transport: WebResearchSpecialistTransport = vi.fn(async () => ({
      text: JSON.stringify([
        {
          url: "https://ok.example.com",
          snippet: "ok",
          capturedAt: "2026-05-02T11:00:00.000Z",
        },
        { url: "", snippet: "bad", capturedAt: "2026-05-02T11:00:00.000Z" },
      ]),
    }));

    const result = await runWebResearchSpecialist({
      commitment: makeCommitment(),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      transport,
      collector,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("parse_error");
      expect(result.detail).toMatch(/^record_1_invalid:/);
    }
  });

  it("returns no_records when the reply parses to an empty array", async () => {
    const collector = createWebEvidenceCollector();
    const transport: WebResearchSpecialistTransport = vi.fn(async () => ({
      text: "[]",
    }));

    const result = await runWebResearchSpecialist({
      commitment: makeCommitment(),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      transport,
      collector,
    });

    expect(result).toEqual({ ok: false, reason: "no_records" });
  });

  it("does not invoke logger when the result is a failure (ok=false branches)", async () => {
    const collector = createWebEvidenceCollector();
    const transport: WebResearchSpecialistTransport = vi.fn(async () => ({
      text: "[]",
    }));
    const logger = vi.fn();

    await runWebResearchSpecialist({
      commitment: makeCommitment(),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      transport,
      collector,
      logger,
    });

    expect(logger).not.toHaveBeenCalled();
  });

  it("clears prior records for the same turn key before recording new ones (resetForTurn)", async () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    collector.record(
      {
        url: "https://stale.example.com",
        snippet: "stale",
        capturedAt: "2026-05-02T10:00:00.000Z" as ISO8601,
      },
      TURN_KEY,
    );

    const transport: WebResearchSpecialistTransport = vi.fn(async () => ({
      text: TWO_RECORD_REPLY,
    }));

    const result = await runWebResearchSpecialist({
      commitment: makeCommitment(),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      transport,
      collector,
    });

    expect(result.ok).toBe(true);

    const slice = observer.observe();
    expect(slice?.records.map((r) => r.url)).toEqual([
      "https://example.com/announcement",
      "https://example.com/blog",
    ]);
  });

  it("does NOT read raw user text — only commitment-derived constraints (invariant #6)", async () => {
    const collector = createWebEvidenceCollector();
    let observedPrompt = "";
    const transport: WebResearchSpecialistTransport = vi.fn(async ({ prompt }) => {
      observedPrompt = prompt;
      return { text: TWO_RECORD_REPLY };
    });

    const intent = makeIntent({ summary: "freshness-sensitive query summary" });
    await runWebResearchSpecialist({
      commitment: makeCommitment(),
      intent,
      turnKey: TURN_KEY,
      transport,
      collector,
    });

    expect(observedPrompt).toContain("freshness-sensitive query summary");
    const parsed = JSON.parse(observedPrompt) as Record<string, unknown>;
    expect(parsed["user_query"]).toBe("freshness-sensitive query summary");
    expect(parsed["max_records"]).toBe(5);
    expect(parsed["freshness"]).toBe("current");
  });
});

const TELEGRAM_CONTEXT_KEY = "telegram:chat-12345";
const FULL_TOOL_CATALOG: readonly string[] = Object.freeze([
  "read",
  "edit",
  "bash",
  "web_search",
  "pdf",
  "image_generate",
]);

function composerCommitment(effect = WEB_RESEARCH_SUMMARIZED_EFFECT): ExecutionCommitment {
  return {
    id: "commitment-composer" as CommitmentId,
    effect,
    target: { kind: "external_channel" },
    constraints: { summary: "synthesize the latest model lineup", deliveryContextKey: TELEGRAM_CONTEXT_KEY },
    budgets: { maxLatencyMs: 60_000, maxRetries: 0 },
    requiredEvidence: [{ kind: "web_research.summarized", mandatory: true }],
    terminalPolicy: {
      onTimeout: "unsupported",
      onPolicyDenial: "rejected",
      onUnsatisfiedSuccess: "rejected",
    },
  };
}

const COMPOSER_SLICE: WebEvidenceWorldState = Object.freeze({
  records: Object.freeze([
    Object.freeze({
      url: "https://example.com/announcement",
      snippet: "first",
      title: "First",
      capturedAt: "2026-05-02T11:00:00.000Z" as ISO8601,
    }),
  ]),
});

describe("runComposerAfterSearch — Search-Composer Phase 4b", () => {
  it("returns ok with messageId and emits a DeliveryReceipt with effect=WEB_RESEARCH_SUMMARIZED_EFFECT (happy path)", async () => {
    const registry: DeliveryReceiptRegistry = createDeliveryReceiptRegistry();
    const transport: WebResearchComposerTransport = vi.fn(async () => ({
      text: "Composed reply with citations [https://example.com/announcement].",
      messageId: "msg-composer-1",
    }));
    const logger = vi.fn();

    const result = await runComposerAfterSearch({
      commitment: composerCommitment(),
      intent: makeIntent({ summary: "synthesize the latest model lineup" }),
      turnKey: TURN_KEY,
      webEvidenceSlice: COMPOSER_SLICE,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      transport,
      deliveryReceiptRegistry: registry,
      fullToolCatalog: FULL_TOOL_CATALOG,
      now: () => 1_700_000_000_000,
      logger,
    });

    expect(result).toEqual({
      ok: true,
      messageId: "msg-composer-1",
      text: "Composed reply with citations [https://example.com/announcement].",
    });

    const receipts = registry.list(TELEGRAM_CONTEXT_KEY);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.effect).toBe(WEB_RESEARCH_SUMMARIZED_EFFECT);
    expect(receipts[0]?.kind).toBe("answer");
    expect(receipts[0]?.messageId).toBe("msg-composer-1");
    expect(receipts[0]?.sentAt).toBe(1_700_000_000_000);

    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger.mock.calls[0]?.[0]).toContain("[commitment] effect=web_research.summarized");
  });

  it("rejects effect_mismatch when commitment.effect is not WEB_RESEARCH_SUMMARIZED_EFFECT", async () => {
    const registry = createDeliveryReceiptRegistry();
    const transport: WebResearchComposerTransport = vi.fn();
    const result = await runComposerAfterSearch({
      commitment: composerCommitment(WEB_EVIDENCE_COLLECTED_EFFECT),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      webEvidenceSlice: COMPOSER_SLICE,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      transport,
      deliveryReceiptRegistry: registry,
      fullToolCatalog: FULL_TOOL_CATALOG,
    });
    expect(result).toEqual({ ok: false, reason: "effect_mismatch" });
    expect(transport).not.toHaveBeenCalled();
    expect(registry.list(TELEGRAM_CONTEXT_KEY)).toEqual([]);
  });

  it("returns web_evidence_missing when slice is undefined", async () => {
    const registry = createDeliveryReceiptRegistry();
    const transport: WebResearchComposerTransport = vi.fn();
    const result = await runComposerAfterSearch({
      commitment: composerCommitment(),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      webEvidenceSlice: undefined,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      transport,
      deliveryReceiptRegistry: registry,
      fullToolCatalog: FULL_TOOL_CATALOG,
    });
    expect(result).toEqual({ ok: false, reason: "web_evidence_missing" });
    expect(transport).not.toHaveBeenCalled();
    expect(registry.list(TELEGRAM_CONTEXT_KEY)).toEqual([]);
  });

  it("returns web_evidence_missing when slice has empty records list", async () => {
    const registry = createDeliveryReceiptRegistry();
    const transport: WebResearchComposerTransport = vi.fn();
    const emptySlice: WebEvidenceWorldState = Object.freeze({ records: Object.freeze([]) });
    const result = await runComposerAfterSearch({
      commitment: composerCommitment(),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      webEvidenceSlice: emptySlice,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      transport,
      deliveryReceiptRegistry: registry,
      fullToolCatalog: FULL_TOOL_CATALOG,
    });
    expect(result).toEqual({ ok: false, reason: "web_evidence_missing" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("returns transport_error when the composer transport rejects (and emits no receipt)", async () => {
    const registry = createDeliveryReceiptRegistry();
    const transport: WebResearchComposerTransport = vi.fn(async () => {
      throw new Error("HTTP 500: composer crashed");
    });
    const result = await runComposerAfterSearch({
      commitment: composerCommitment(),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      webEvidenceSlice: COMPOSER_SLICE,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      transport,
      deliveryReceiptRegistry: registry,
      fullToolCatalog: FULL_TOOL_CATALOG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("transport_error");
      expect(result.detail).toContain("HTTP 500");
    }
    expect(registry.list(TELEGRAM_CONTEXT_KEY)).toEqual([]);
  });

  it("returns empty_reply when the composer transport returns an empty/whitespace text", async () => {
    const registry = createDeliveryReceiptRegistry();
    const transport: WebResearchComposerTransport = vi.fn(async () => ({ text: "   \n  " }));
    const result = await runComposerAfterSearch({
      commitment: composerCommitment(),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      webEvidenceSlice: COMPOSER_SLICE,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      transport,
      deliveryReceiptRegistry: registry,
      fullToolCatalog: FULL_TOOL_CATALOG,
    });
    expect(result).toEqual({ ok: false, reason: "empty_reply" });
    expect(registry.list(TELEGRAM_CONTEXT_KEY)).toEqual([]);
  });

  it("filters web_search out of the tool catalog passed to the transport", async () => {
    const registry = createDeliveryReceiptRegistry();
    let observedAllowedTools: readonly string[] = [];
    const transport: WebResearchComposerTransport = vi.fn(async ({ allowedTools }) => {
      observedAllowedTools = allowedTools;
      return { text: "OK", messageId: "msg-1" };
    });
    await runComposerAfterSearch({
      commitment: composerCommitment(),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      webEvidenceSlice: COMPOSER_SLICE,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      transport,
      deliveryReceiptRegistry: registry,
      fullToolCatalog: FULL_TOOL_CATALOG,
    });

    expect(observedAllowedTools).not.toContain("web_search");
    expect(observedAllowedTools).toContain("read");
    expect(observedAllowedTools).toContain("pdf");
    expect(observedAllowedTools).toContain("image_generate");
  });

  it("injects the structural <web_evidence> block into the system message (closed-shape JSON, NOT user text — invariant #5)", async () => {
    const registry = createDeliveryReceiptRegistry();
    let observedSystemMessage = "";
    let observedPrompt = "";
    const transport: WebResearchComposerTransport = vi.fn(async ({ prompt, systemMessage }) => {
      observedPrompt = prompt;
      observedSystemMessage = systemMessage;
      return { text: "OK", messageId: "msg-1" };
    });
    await runComposerAfterSearch({
      commitment: composerCommitment(),
      intent: makeIntent({ summary: "synthesize" }),
      turnKey: TURN_KEY,
      webEvidenceSlice: COMPOSER_SLICE,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      transport,
      deliveryReceiptRegistry: registry,
      fullToolCatalog: FULL_TOOL_CATALOG,
    });

    expect(observedSystemMessage).toContain("<web_evidence>");
    expect(observedSystemMessage).toContain("https://example.com/announcement");
    expect(observedSystemMessage).toContain("Do NOT call `web_search` yourself");
    expect(observedSystemMessage).toContain("</web_evidence>");

    const promptParsed = JSON.parse(observedPrompt) as Record<string, unknown>;
    expect(promptParsed["user_query"]).toBe("synthesize");
  });

  it("synthesizes a deterministic messageId from turnKey + sentAt when transport omits messageId", async () => {
    const registry = createDeliveryReceiptRegistry();
    const transport: WebResearchComposerTransport = vi.fn(async () => ({ text: "OK" }));
    const result = await runComposerAfterSearch({
      commitment: composerCommitment(),
      intent: makeIntent(),
      turnKey: TURN_KEY,
      webEvidenceSlice: COMPOSER_SLICE,
      deliveryContextKey: TELEGRAM_CONTEXT_KEY,
      transport,
      deliveryReceiptRegistry: registry,
      fullToolCatalog: FULL_TOOL_CATALOG,
      now: () => 1_700_000_000_000,
    });
    expect(result).toEqual({
      ok: true,
      messageId: `composer:${SESSION_A}:turn-1:1700000000000`,
      text: "OK",
    });
  });
});
