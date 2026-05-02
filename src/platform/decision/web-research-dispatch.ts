import {
  isWebResearchFamilyEffect,
  runWebResearchTurn,
  type WebResearchTurnResult,
} from "../../agents/pi-embedded-runner/run/web-research-orchestrator.js";
import type {
  ToolSchemaName,
  WebResearchComposerTransport,
  WebResearchSpecialistTransport,
} from "../../agents/pi-embedded-runner/run/web-research-runtime-adapter.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  WEB_EVIDENCE_COLLECTED_EFFECT,
  WEB_RESEARCH_SUMMARIZED_EFFECT,
  type DeliveryReceiptRegistry,
  type ExecutionCommitment,
  type SemanticIntent,
} from "../commitment/index.js";
import type {
  TurnKey,
  WebEvidenceCollector,
  WebEvidenceWorldStateObserver,
} from "../commitment/web-evidence-world-state-observer.js";
import {
  createWebResearchComposerTransport,
  createWebResearchSpecialistTransport,
} from "./web-research-transports.js";

/**
 * Result of a Phase 4b''-e3 dispatch attempt. The kernel side is fully wired
 * (specialist + observer + composer + delivery registry), so callers only need
 * the user-visible composer text on success and the structural failure on
 * skip/failure to decide whether to fall through to the legacy single-LLM path.
 */
export type WebResearchDispatchResult =
  | {
      readonly ok: true;
      /** Composer-produced text intended for direct user delivery. */
      readonly text: string;
      /** Composer messageId (real, transport-supplied, or synthesised). */
      readonly messageId: string;
      /** How many evidence records the specialist captured. */
      readonly recordCount: number;
    }
  | {
      readonly ok: false;
      /** Either the orchestrator's structured failure or `effect_not_dispatchable`. */
      readonly stage: WebResearchTurnResult extends { ok: false; stage: infer S } ? S : never;
      readonly turnResult?: WebResearchTurnResult;
    }
  | {
      readonly ok: false;
      readonly stage: "effect_not_dispatchable";
    };

export type RunWebResearchDispatchParams = {
  readonly derivedCommitment: ExecutionCommitment;
  readonly intent: SemanticIntent;
  readonly turnKey: TurnKey;
  readonly deliveryContextKey: string;
  readonly cfg: OpenClawConfig;
  readonly agentDir?: string;
  readonly fullToolCatalog: readonly ToolSchemaName[];
  readonly collector: WebEvidenceCollector;
  readonly observer: WebEvidenceWorldStateObserver;
  readonly deliveryReceiptRegistry: DeliveryReceiptRegistry;
  /** Optional override for the specialist model ref (defaults to `hydra/sonar-pro`). */
  readonly specialistModelRef?: string;
  /** Optional override for the composer model ref (defaults to `hydra/claude-opus-4.6`). */
  readonly composerModelRef?: string;
  /** Optional transport overrides (used in tests; production wiring leaves them undefined). */
  readonly specialistTransport?: WebResearchSpecialistTransport;
  readonly composerTransport?: WebResearchComposerTransport;
  /** Optional clock + logger forwarded to the orchestrator. */
  readonly now?: () => number;
  readonly logger?: (line: string) => void;
};

/**
 * Synthesises a `web_research.summarized` composer commitment from a
 * `web_research.collected` specialist commitment. The kernel currently emits
 * one commitment per turn; the two-phase pipeline needs both. Per
 * `commitment_kernel_search_composer_pipeline.plan.md` §8.5 (Phase 4b''-e3),
 * the architectural cleanup of this synthetic-commitment pattern is deferred
 * to a later phase — the synthesis is contained to this helper.
 */
function deriveComposerCommitment(specialist: ExecutionCommitment): ExecutionCommitment {
  return {
    ...specialist,
    effect: WEB_RESEARCH_SUMMARIZED_EFFECT,
  };
}

/**
 * Phase 4b''-e3 dispatch helper. Builds production transports (or accepts
 * test overrides), synthesises the composer commitment, and invokes
 * `runWebResearchTurn`. Returns `{ ok: true, text }` on success so the future
 * Phase 4b''-e4 caller wiring can route the composed answer back to the user
 * (Path B(ii) — directResponse). Behaviour-neutral on production: no caller
 * invokes this helper yet.
 */
export async function runWebResearchDispatch(
  params: RunWebResearchDispatchParams,
): Promise<WebResearchDispatchResult> {
  if (!isWebResearchFamilyEffect(params.derivedCommitment.effect)) {
    return { ok: false, stage: "effect_not_dispatchable" };
  }
  if (params.derivedCommitment.effect !== WEB_EVIDENCE_COLLECTED_EFFECT) {
    return { ok: false, stage: "effect_not_dispatchable" };
  }

  const specialistTransport =
    params.specialistTransport ??
    createWebResearchSpecialistTransport({
      cfg: params.cfg,
      ...(params.agentDir ? { agentDir: params.agentDir } : {}),
      ...(params.specialistModelRef ? { modelRef: params.specialistModelRef } : {}),
    });
  const composerTransport =
    params.composerTransport ??
    createWebResearchComposerTransport({
      cfg: params.cfg,
      ...(params.agentDir ? { agentDir: params.agentDir } : {}),
      ...(params.composerModelRef ? { modelRef: params.composerModelRef } : {}),
    });

  const composerCommitment = deriveComposerCommitment(params.derivedCommitment);

  const turnResult = await runWebResearchTurn({
    specialistCommitment: params.derivedCommitment,
    composerCommitment,
    intent: params.intent,
    turnKey: params.turnKey,
    deliveryContextKey: params.deliveryContextKey,
    specialistTransport,
    composerTransport,
    collector: params.collector,
    observer: params.observer,
    deliveryReceiptRegistry: params.deliveryReceiptRegistry,
    fullToolCatalog: params.fullToolCatalog,
    ...(params.now ? { now: params.now } : {}),
    ...(params.logger ? { logger: params.logger } : {}),
  });

  if (!turnResult.ok) {
    return {
      ok: false,
      stage: turnResult.stage as WebResearchDispatchResult extends { ok: false; stage: infer S }
        ? S
        : never,
      turnResult,
    };
  }
  return {
    ok: true,
    text: turnResult.composer.text,
    messageId: turnResult.composer.messageId,
    recordCount: turnResult.specialist.recordCount,
  };
}
