import type { DeliveryReceiptRegistry } from "../../../platform/commitment/delivery-receipt-registry.js";
import type { ExecutionCommitment } from "../../../platform/commitment/execution-commitment.js";
import {
  WEB_EVIDENCE_COLLECTED_EFFECT,
  WEB_RESEARCH_SUMMARIZED_EFFECT,
} from "../../../platform/commitment/effect-family-registry.js";
import type { EffectId } from "../../../platform/commitment/ids.js";
import type { SemanticIntent } from "../../../platform/commitment/semantic-intent.js";
import type {
  TurnKey,
  WebEvidenceCollector,
  WebEvidenceWorldStateObserver,
} from "../../../platform/commitment/web-evidence-world-state-observer.js";
import {
  runComposerAfterSearch,
  runWebResearchSpecialist,
  type ToolSchemaName,
  type WebResearchComposerResult,
  type WebResearchComposerTransport,
  type WebResearchSpecialistResult,
  type WebResearchSpecialistTransport,
} from "./web-research-runtime-adapter.js";

export type WebResearchTurnResult =
  | {
      readonly ok: true;
      readonly specialist: { readonly recordCount: number };
      readonly composer: { readonly messageId: string };
    }
  | {
      readonly ok: false;
      readonly stage: "specialist" | "composer";
      readonly specialist?: WebResearchSpecialistResult;
      readonly composer?: WebResearchComposerResult;
    };

export type RunWebResearchTurnParams = {
  readonly specialistCommitment: ExecutionCommitment;
  readonly composerCommitment: ExecutionCommitment;
  readonly intent: SemanticIntent;
  readonly turnKey: TurnKey;
  readonly deliveryContextKey: string;
  readonly specialistTransport: WebResearchSpecialistTransport;
  readonly composerTransport: WebResearchComposerTransport;
  readonly collector: WebEvidenceCollector;
  readonly observer: WebEvidenceWorldStateObserver;
  readonly deliveryReceiptRegistry: DeliveryReceiptRegistry;
  readonly fullToolCatalog: readonly ToolSchemaName[];
  /**
   * Optional clock source for the composer receipt's `sentAt`. Defaults to
   * `Date.now()`; tests inject a fixture for determinism.
   */
  readonly now?: () => number;
  /**
   * Optional sink for `[commitment]` telemetry lines emitted by the
   * underlying adapters. Defaults to a no-op so tests don't pollute stdout.
   * Production wiring (Phase 4b'-b caller in the decision-layer dispatch
   * point) injects the gateway logger.
   */
  readonly logger?: (line: string) => void;
};

/**
 * Search-Composer Phase 4b'-a orchestrator helper.
 *
 * Drives the canonical two-affordance sequence per
 * `commitment_kernel_search_composer_pipeline.plan.md` §6.3:
 *
 * 1. Run `runWebResearchSpecialist` (sonar/sonar-pro) against the
 *    `WEB_EVIDENCE_COLLECTED_EFFECT` commitment. The adapter populates the
 *    injected `WebEvidenceCollector` and sets the active turn so the
 *    observer's snapshot exposes the slice.
 * 2. Read the slice via the injected `WebEvidenceWorldStateObserver`. If
 *    the slice is unexpectedly absent (defensive guard against ingestion
 *    failure), abort before the composer call.
 * 3. Run `runComposerAfterSearch` against the
 *    `WEB_RESEARCH_SUMMARIZED_EFFECT` commitment with the slice. The
 *    adapter filters `web_search` from the tool catalog and emits a
 *    `DeliveryReceipt` on success.
 *
 * **Phase 4b'-a is purely additive**: this helper is exported but the
 * decision-layer dispatch point (`src/platform/decision/input.ts`) does
 * not invoke it yet. Phase 4b'-b will audit that dispatch point and
 * insert the narrow conditional that routes web_research-family
 * commitments through this helper.
 *
 * Failure semantics:
 * - Specialist fails (transport / parse / no_records / no_citations):
 *   helper returns `{ ok: false, stage: "specialist", specialist }`. No
 *   composer call is made.
 * - Composer fails (transport / web_evidence_missing / empty_reply): the
 *   sonar slice is already populated and observable; helper returns
 *   `{ ok: false, stage: "composer", composer }`. Caller (Phase 4b'-b)
 *   decides whether to surface the partial state to the user or fall
 *   through to a legacy path.
 *
 * @param params - Two commitments (specialist + composer), shared intent,
 *   turn key, delivery context, both transports, observer/collector pair,
 *   delivery registry, full tool catalog, optional clock, optional logger.
 * @returns Either `{ ok: true, specialist: { recordCount }, composer: {
 *   messageId } }` after both calls succeed, or `{ ok: false, stage,
 *   specialist?, composer? }` for any structural failure.
 */
export async function runWebResearchTurn(
  params: RunWebResearchTurnParams,
): Promise<WebResearchTurnResult> {
  if (params.specialistCommitment.effect !== WEB_EVIDENCE_COLLECTED_EFFECT) {
    return {
      ok: false,
      stage: "specialist",
      specialist: { ok: false, reason: "effect_mismatch" },
    };
  }
  if (params.composerCommitment.effect !== WEB_RESEARCH_SUMMARIZED_EFFECT) {
    return {
      ok: false,
      stage: "composer",
      composer: { ok: false, reason: "effect_mismatch" },
    };
  }

  const specialist = await runWebResearchSpecialist({
    commitment: params.specialistCommitment,
    intent: params.intent,
    turnKey: params.turnKey,
    transport: params.specialistTransport,
    collector: params.collector,
    logger: params.logger,
  });
  if (!specialist.ok) {
    return { ok: false, stage: "specialist", specialist };
  }

  const slice = params.observer.observe();
  if (slice === undefined || slice.records.length === 0) {
    return {
      ok: false,
      stage: "composer",
      composer: { ok: false, reason: "web_evidence_missing" },
    };
  }

  const composer = await runComposerAfterSearch({
    commitment: params.composerCommitment,
    intent: params.intent,
    turnKey: params.turnKey,
    webEvidenceSlice: slice,
    deliveryContextKey: params.deliveryContextKey,
    transport: params.composerTransport,
    deliveryReceiptRegistry: params.deliveryReceiptRegistry,
    fullToolCatalog: params.fullToolCatalog,
    ...(params.now ? { now: params.now } : {}),
    ...(params.logger ? { logger: params.logger } : {}),
  });
  if (!composer.ok) {
    return { ok: false, stage: "composer", composer };
  }

  return {
    ok: true,
    specialist: { recordCount: specialist.recordCount },
    composer: { messageId: composer.messageId },
  };
}

/**
 * Predicate exported for the Phase 4b'-b caller wiring: the decision-layer
 * dispatch point inserts a single conditional that returns `true` when the
 * incoming commitment belongs to the `web_research` family, then routes
 * to `runWebResearchTurn`. Outside this branch, the existing single-LLM
 * flow runs untouched.
 *
 * Branded EffectId equality matches the closed-string registry constants;
 * any non-web_research effect short-circuits to `false`.
 *
 * @param effect - Commitment effect to test.
 * @returns `true` for `WEB_EVIDENCE_COLLECTED_EFFECT` or
 *   `WEB_RESEARCH_SUMMARIZED_EFFECT`; `false` otherwise.
 */
export function isWebResearchFamilyEffect(effect: EffectId): boolean {
  return (
    effect === WEB_EVIDENCE_COLLECTED_EFFECT ||
    effect === WEB_RESEARCH_SUMMARIZED_EFFECT
  );
}
