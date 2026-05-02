import type { ExecutionCommitment } from "../../../platform/commitment/execution-commitment.js";
import { WEB_EVIDENCE_COLLECTED_EFFECT } from "../../../platform/commitment/effect-family-registry.js";
import type { SessionId } from "../../../platform/commitment/ids.js";
import type { SemanticIntent } from "../../../platform/commitment/semantic-intent.js";
import type {
  TurnKey,
  WebEvidenceCollector,
} from "../../../platform/commitment/web-evidence-world-state-observer.js";
import {
  webEvidenceRecordSchema,
  type WebEvidenceRecord,
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

function parseRecords(text: string): ParseResult {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, detail: "empty_reply" };
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
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
