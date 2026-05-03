import type { DeliveryReceiptRegistry } from "../../../platform/commitment/delivery-receipt-registry.js";
import type { ExecutionCommitment } from "../../../platform/commitment/execution-commitment.js";
import {
  WEB_EVIDENCE_COLLECTED_EFFECT,
  WEB_RESEARCH_SUMMARIZED_EFFECT,
} from "../../../platform/commitment/effect-family-registry.js";
import type { EffectId, SessionId } from "../../../platform/commitment/ids.js";
import type { SemanticIntent } from "../../../platform/commitment/semantic-intent.js";
import type {
  TurnKey,
  WebEvidenceCollector,
} from "../../../platform/commitment/web-evidence-world-state-observer.js";
import {
  webEvidenceRecordSchema,
  type WebEvidenceRecord,
  type WebEvidenceWorldState,
} from "../../../platform/commitment/world-state.js";

export type WebResearchSpecialistFailureReason =
  | "effect_mismatch"
  | "transport_error"
  | "parse_error"
  | "no_records"
  | "no_citations";

export type WebResearchSpecialistResult =
  | { readonly ok: true; readonly recordCount: number }
  | {
      readonly ok: false;
      readonly reason: WebResearchSpecialistFailureReason;
      readonly detail?: string;
    };

export type WebResearchSpecialistTransport = (params: {
  readonly prompt: string;
  readonly systemMessage: string;
}) => Promise<{ readonly text: string }>;

export type RunWebResearchSpecialistParams = {
  readonly commitment: ExecutionCommitment;
  readonly intent: SemanticIntent;
  readonly turnKey: TurnKey;
  readonly transport: WebResearchSpecialistTransport;
  readonly collector: WebEvidenceCollector;
  /**
   * Optional sink for `[commitment]` telemetry lines. Defaults to a no-op so
   * tests don't pollute stdout. Production wiring (Phase 4b caller in
   * `attempt.ts`) injects the gateway logger.
   */
  readonly logger?: (line: string) => void;
};

const DEFAULT_SYSTEM_MESSAGE =
  'Return ONLY a JSON array matching the shape `[{ "url": string, "snippet": string, "title"?: string, "capturedAt": ISO8601 }]`. Each entry MUST cite a real URL from your search. No prose, no code fences, no preamble.';

const SUMMARY_FALLBACK = "(no_summary)";

/**
 * Search-Composer Phase 4a sonar runtime adapter.
 *
 * Drives the search specialist (sonar / sonar-pro through Hydra) for a
 * `web_research` family commitment. The adapter:
 *
 * 1. Builds a closed-shape prompt from `SemanticIntent` (commitment-derived
 *    structural fields only — invariant #6: raw user text never crosses this
 *    boundary, IntentContractor is the sole reader).
 * 2. Invokes the injected `transport` with empty tool schema (Perplexity
 *    rejects custom tools — see PR-#129 handoff).
 * 3. Parses the reply via `webEvidenceRecordSchema.array()`. On parse
 *    failure / no records / no citations / transport error, returns
 *    `{ ok: false, reason }` so the caller can fall through to the legacy
 *    single-model path with no regression.
 * 4. On success, pushes every record into the injected
 *    `WebEvidenceCollector` keyed by `(sessionId, turnId)` and emits a
 *    `[commitment] effect=web_evidence.collected records=<N>` telemetry
 *    line through the optional logger.
 *
 * Phase 4a is purely additive — no production caller invokes this yet
 * (Phase 4b wires `attempt.ts`). The function and its types are the
 * contract Phase 4b will plug into.
 *
 * @param params - Commitment, intent, turn key, transport, collector, and
 *   optional logger.
 * @returns Either `{ ok: true, recordCount }` after successful ingestion, or
 *   `{ ok: false, reason }` for any structural failure.
 */
export async function runWebResearchSpecialist(
  params: RunWebResearchSpecialistParams,
): Promise<WebResearchSpecialistResult> {
  if (params.commitment.effect !== WEB_EVIDENCE_COLLECTED_EFFECT) {
    return { ok: false, reason: "effect_mismatch" };
  }

  const prompt = buildSpecialistPrompt({
    intent: params.intent,
    sessionId: params.turnKey.sessionId,
  });

  let reply: { readonly text: string };
  try {
    reply = await params.transport({
      prompt,
      systemMessage: DEFAULT_SYSTEM_MESSAGE,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "transport_error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const parsed = parseRecords(reply.text);
  if (!parsed.ok) {
    params.logger?.(
      `[commitment] effect=web_evidence.parse_failed detail=${parsed.detail} replyHead="${reply.text.slice(0, 240).replace(/\s+/g, " ")}" sessionId=${params.turnKey.sessionId} turnId=${params.turnKey.turnId}`,
    );
    return { ok: false, reason: "parse_error", detail: parsed.detail };
  }

  if (parsed.records.length === 0) {
    return { ok: false, reason: "no_records" };
  }

  const cited = parsed.records.filter((record) => record.url.length > 0);
  if (cited.length === 0) {
    return { ok: false, reason: "no_citations" };
  }

  params.collector.resetForTurn(params.turnKey);
  for (const record of cited) {
    params.collector.record(record, params.turnKey);
  }
  params.collector.setActiveTurn(params.turnKey);

  params.logger?.(
    `[commitment] effect=web_evidence.collected records=${cited.length} sessionId=${params.turnKey.sessionId} turnId=${params.turnKey.turnId}`,
  );

  return { ok: true, recordCount: cited.length };
}

function buildSpecialistPrompt(params: {
  readonly intent: SemanticIntent;
  readonly sessionId: SessionId;
}): string {
  const summary = readConstraintString(params.intent.constraints, "summary") ?? SUMMARY_FALLBACK;
  const freshness = readConstraintString(params.intent.constraints, "freshness");
  const region = readConstraintString(params.intent.constraints, "region");
  const maxRecords = readConstraintNumber(params.intent.constraints, "maxRecords") ?? 8;

  const payload: Record<string, unknown> = {
    user_query: summary,
    max_records: maxRecords,
  };
  if (freshness) {
    payload["freshness"] = freshness;
  }
  if (region) {
    payload["region"] = region;
  }
  return JSON.stringify(payload);
}

function readConstraintString(
  constraints: SemanticIntent["constraints"],
  key: string,
): string | undefined {
  const value = (constraints as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readConstraintNumber(
  constraints: SemanticIntent["constraints"],
  key: string,
): number | undefined {
  const value = (constraints as Record<string, unknown> | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

type ParseResult =
  | { readonly ok: true; readonly records: readonly WebEvidenceRecord[] }
  | { readonly ok: false; readonly detail: string };

function extractJsonArrayCandidate(raw: string): string | undefined {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/iu.exec(raw);
  const candidate = (fenceMatch?.[1] ?? raw).trim();
  if (candidate.startsWith("[")) {
    return candidate;
  }
  const firstBracket = candidate.indexOf("[");
  const lastBracket = candidate.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    return candidate.slice(firstBracket, lastBracket + 1);
  }
  return undefined;
}

function parseRecords(text: string): ParseResult {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, detail: "empty_reply" };
  }
  const jsonCandidate = extractJsonArrayCandidate(trimmed) ?? trimmed;
  let json: unknown;
  try {
    json = JSON.parse(jsonCandidate);
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? `invalid_json:${error.message}` : "invalid_json",
    };
  }
  if (!Array.isArray(json)) {
    return { ok: false, detail: "not_an_array" };
  }
  const records: WebEvidenceRecord[] = [];
  for (let index = 0; index < json.length; index += 1) {
    const result = webEvidenceRecordSchema.safeParse(json[index]);
    if (!result.success) {
      return {
        ok: false,
        detail: `record_${index}_invalid:${result.error.issues[0]?.code ?? "unknown"}`,
      };
    }
    records.push(result.data as WebEvidenceRecord);
  }
  return { ok: true, records };
}

export type WebResearchComposerFailureReason =
  | "effect_mismatch"
  | "web_evidence_missing"
  | "transport_error"
  | "empty_reply";

export type WebResearchComposerResult =
  | { readonly ok: true; readonly messageId: string; readonly text: string }
  | {
      readonly ok: false;
      readonly reason: WebResearchComposerFailureReason;
      readonly detail?: string;
    };

export type ToolSchemaName = string;

export type WebResearchComposerTransport = (params: {
  readonly prompt: string;
  readonly systemMessage: string;
  /**
   * Closed list of tool names the composer is allowed to call. The adapter
   * passes the `allowedTools` filter (full set MINUS `web_search`) when web
   * evidence is already populated; the transport implementation enforces
   * the filter against its concrete tool catalog (Phase 4b' caller wires
   * this against `applyModelProviderToolPolicy`).
   */
  readonly allowedTools: readonly ToolSchemaName[];
}) => Promise<{ readonly text: string; readonly messageId?: string }>;

export type RunComposerAfterSearchParams = {
  readonly commitment: ExecutionCommitment;
  readonly intent: SemanticIntent;
  readonly turnKey: TurnKey;
  readonly webEvidenceSlice: WebEvidenceWorldState | undefined;
  readonly deliveryContextKey: string;
  readonly transport: WebResearchComposerTransport;
  readonly deliveryReceiptRegistry: DeliveryReceiptRegistry;
  /**
   * Full tool catalog the composer-class model normally exposes. The adapter
   * filters out `web_search` when web evidence is already present so the
   * model cannot redundantly invoke it (and stumble into bot-detection on
   * the local DDG fallback). The default tool list passed by the Phase 4b'
   * caller wiring is the same set returned by the existing
   * `createOpenClawCodingTools()` factory minus `web_search`.
   */
  readonly fullToolCatalog: readonly ToolSchemaName[];
  /**
   * Optional clock source for the receipt's `sentAt` field. Defaults to
   * `Date.now()`; tests inject a fixture for determinism.
   */
  readonly now?: () => number;
  /**
   * Optional sink for `[commitment]` telemetry lines. Defaults to a no-op so
   * tests don't pollute stdout. Production wiring (Phase 4b' caller in
   * `attempt.ts`) injects the gateway logger.
   */
  readonly logger?: (line: string) => void;
};

const COMPOSER_SYSTEM_MESSAGE_PREFIX =
  "You MUST use cited URLs from `web_evidence.records` as ground truth. Do NOT call `web_search` yourself — the search specialist has already run and the records below are the result.";

const COMPOSER_SUMMARY_FALLBACK = "(no_summary)";

/**
 * Search-Composer Phase 4b composer runtime adapter.
 *
 * Drives the composer-class model (claude-opus-4.6 / gpt-5.4 / hydra-gpt-pro)
 * for a `web_research.summarized` commitment after the specialist (Phase 4a)
 * has populated `WebEvidenceWorldState.records`. The adapter:
 *
 * 1. Guards on `commitment.effect === WEB_RESEARCH_SUMMARIZED_EFFECT` and
 *    `webEvidenceSlice.records.length >= 1`. Returns `web_evidence_missing`
 *    when the slice is absent or empty so the caller can fall through to the
 *    legacy single-model path with no regression.
 * 2. Builds a closed-shape composer prompt with a structural
 *    `<web_evidence>{ records, summary }</web_evidence>` block (NOT user
 *    text — invariant #5 safe per sub-plan §6.2).
 * 3. Filters `web_search` out of the tool catalog the transport is allowed
 *    to use (the model cannot redundantly invoke it).
 * 4. On success, emits a `DeliveryReceipt` with
 *    `effect=WEB_RESEARCH_SUMMARIZED_EFFECT` and `kind=answer` so the
 *    Phase 4b composer predicate (also in this PR) flips to satisfied;
 *    emits `[commitment] effect=web_research.summarized` telemetry.
 *
 * Caller wiring at `attempt.ts` is deferred to Phase 4b' per the §8.5
 * amendment: this helper is exported but only invoked from tests until the
 * caller wiring slice lands.
 *
 * @param params - Commitment, intent, turn key, slice, delivery context,
 *   transport, registry, tool catalog, optional clock, and optional logger.
 * @returns Either `{ ok: true, messageId }` after successful delivery, or
 *   `{ ok: false, reason }` for any structural failure.
 */
export async function runComposerAfterSearch(
  params: RunComposerAfterSearchParams,
): Promise<WebResearchComposerResult> {
  if (params.commitment.effect !== WEB_RESEARCH_SUMMARIZED_EFFECT) {
    return { ok: false, reason: "effect_mismatch" };
  }
  const records = params.webEvidenceSlice?.records;
  if (!records || records.length === 0) {
    return { ok: false, reason: "web_evidence_missing" };
  }

  const allowedTools = params.fullToolCatalog.filter((name) => name !== "web_search");
  const summary = readConstraintString(params.intent.constraints, "summary") ?? COMPOSER_SUMMARY_FALLBACK;
  const systemMessage = buildComposerSystemMessage({ records, summary });
  const prompt = JSON.stringify({ user_query: summary });

  let reply: { readonly text: string; readonly messageId?: string };
  try {
    reply = await params.transport({ prompt, systemMessage, allowedTools });
  } catch (error) {
    return {
      ok: false,
      reason: "transport_error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (reply.text.trim() === "") {
    return { ok: false, reason: "empty_reply" };
  }

  const now = params.now ?? Date.now;
  const sentAt = now();
  const messageId = reply.messageId ?? `composer:${params.turnKey.sessionId}:${params.turnKey.turnId}:${sentAt}`;

  params.deliveryReceiptRegistry.record({
    deliveryContextKey: params.deliveryContextKey,
    messageId,
    sentAt,
    effect: WEB_RESEARCH_SUMMARIZED_EFFECT as EffectId,
    kind: "answer",
  });

  params.logger?.(
    `[commitment] effect=web_research.summarized recordCount=${records.length} sessionId=${params.turnKey.sessionId} turnId=${params.turnKey.turnId} messageId=${messageId}`,
  );

  return { ok: true, messageId, text: reply.text };
}

function buildComposerSystemMessage(params: {
  readonly records: readonly WebEvidenceRecord[];
  readonly summary: string;
}): string {
  const block = JSON.stringify({
    records: params.records.map((record) => ({
      url: record.url,
      snippet: record.snippet,
      title: record.title,
      capturedAt: record.capturedAt,
    })),
    summary: params.summary,
  });
  return `${COMPOSER_SYSTEM_MESSAGE_PREFIX}\n<web_evidence>${block}</web_evidence>`;
}
