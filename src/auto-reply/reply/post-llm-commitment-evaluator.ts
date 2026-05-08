/**
 * Slice C — post-LLM `commitmentSatisfied` evaluator (Cutover-4 done-predicate
 * activation on the production turn path).
 *
 * Diagnostic: `.cursor/plans/DIAGNOSTIC-2026-05-08-kernel-vs-legacy-divergence.md`.
 * Production evidence: gateway-dev-2026-05-07.log turn `78ff2b60` («Удали
 * лишних» -> bot replied «Готово. Лишнее убрал, оставил только главного»
 * without a tool_call; the post-LLM done-predicate was NEVER evaluated, so
 * the LLM's text-only «Готово» reached the deliver path even though zero
 * repo work happened).
 *
 * What this helper does — the SECOND HALF of "Fix 2" from the diagnostic:
 *
 *   1. Reads the structural `toolBundles` list emitted by the resolution
 *      contract for this turn (closed enum at `resolution-contract.ts:12`).
 *   2. Dispatches off bundle:
 *        - `repo_mutation` → mirrors the kernel `codePatchAppliedPredicate`
 *          (`src/platform/commitment/done-predicate-code-patch-applied.ts`)
 *          done-predicate semantics: checks `runResult.meta.completionOutcome.
 *          artifactIds.length > 0`. The kernel predicate evaluates against
 *          `WorldStateSnapshot.artifacts.records` keyed on `expectedDelta.
 *          artifacts.added`; that infrastructure is owned by `monitoredRuntime`
 *          which is resolved upstream in `runTurnDecision` and not threaded
 *          past the LLM call. At THIS layer we have the runtime outcome
 *          receipts (`PlatformRuntimeRunOutcome`) which already encode whether
 *          any artifact-producing tool (apply_patch / write / image_generate /
 *          pdf_create / docx_create) ran during the turn — see
 *          `src/platform/runtime/service.ts:1497-1499` where `artifactIds` is
 *          derived from checkpoint targets at runtime. A zero-length list
 *          IS the structural evidence that no repo mutation occurred.
 *        - any other bundle → no-op (CORRECT dispatch — non-repo bundles
 *          have their own family-specific predicates living elsewhere; the
 *          repo predicate must NOT fire on `session_orchestration` /
 *          `respond_only` / `external_delivery` etc.).
 *   3. Emits structured telemetry — one log line per evaluation — so
 *      `gateway-dev-*.log` can be grepped for `[commitment-predicate] kind=
 *      repo_operation_completed result=<satisfied|unsatisfied>` to confirm
 *      the gate fired on production turns.
 *   4. Returns an outcome the caller can transform into a `cannot_complete`
 *      final reply when unsatisfied.
 *
 * Boundary discipline:
 *   - This file lives in `src/auto-reply/reply/` (caller-layer), NOT in
 *     `src/platform/commitment/` — invariant #8.
 *   - No NEW import from `src/platform/commitment/` source modules. The
 *     reference to `codePatchAppliedPredicate` is JSDoc only — the kernel
 *     predicate stays the truth source for the formal cutover-4 gate at
 *     `runTurnDecision`'s pre-LLM evaluation site.
 *   - Reads STRUCTURAL fields (`toolBundles` enum + `runOutcome.artifactIds`),
 *     never `RawUserTurn` / `UserPrompt` (invariants #5, #6).
 *   - No raw text matching anywhere — bundle dispatch is a closed-enum
 *     switch.
 *
 * Discipline of the cutover:
 *   - When `runResult.meta.completionOutcome` is undefined (legacy path or
 *     embedded run that did not register a runtime checkpoint service), we
 *     return `unevaluated` and the caller delivers normally. This is the
 *     "no runtime fallback" path required by the spec — non-repo turns,
 *     heartbeat turns, and pre-Cutover-4 callers continue to behave
 *     byte-identically.
 */

import type { ResolutionToolBundle } from "../../platform/decision/resolution-contract.js";
import type { EmbeddedPiRunResult } from "../../agents/pi-embedded-runner/types.js";
import { defaultRuntime } from "../../runtime.js";

/**
 * The closed enumeration of done-predicate kinds that THIS layer evaluates.
 * Kept structurally aligned with the kernel's `EffectId` taxonomy (see
 * `src/platform/commitment/effect-family-registry.ts`):
 *
 *   `repo_operation_completed` ←→ `code_patch.applied` / `repo.commit_landed`
 *   / `repo.branch_created` / `repo.merge_completed` / `repo.diff_observed`.
 *
 * The kind is emitted in the `[commitment-predicate]` telemetry line so
 * grep on `gateway-dev-*.log` can disambiguate which dispatch fired.
 */
export type PostLlmCommitmentPredicateKind = "repo_operation_completed";

/**
 * Result of evaluating a post-LLM done-predicate on a turn.
 *
 *   - `satisfied`: the structural evidence required by the bundle's
 *     family-specific predicate is present (e.g. at least one repo
 *     artifact for `repo_mutation`). The caller delivers normally.
 *   - `unsatisfied`: the bundle was applicable but the evidence is
 *     missing. The caller MUST NOT deliver the LLM's text-only reply
 *     and SHOULD substitute a `cannot_complete` shaped final reply.
 *   - `unevaluated`: bundle did not match any dispatched predicate, or
 *     the runtime outcome was unavailable (legacy path / heartbeat /
 *     pre-Cutover-4 caller). The caller delivers normally — no behavior
 *     change versus the pre-Slice-C baseline.
 */
export type PostLlmCommitmentEvaluation =
  | {
      readonly kind: "satisfied";
      readonly predicate: PostLlmCommitmentPredicateKind;
    }
  | {
      readonly kind: "unsatisfied";
      readonly predicate: PostLlmCommitmentPredicateKind;
      readonly missing: string;
    }
  | {
      readonly kind: "unevaluated";
      readonly reason:
        | "no_applicable_bundle"
        | "runtime_outcome_unavailable"
        | "embedded_error_present";
    };

export type PostLlmCommitmentEvaluatorParams = {
  /**
   * The closed-enum tool-bundles list resolved by
   * `buildClassifiedExecutionDecisionInput` for THIS turn. Source of truth
   * is `routingSnapshot.plannerInput.resolutionContract?.toolBundles`. When
   * the resolution-contract slice is absent (legacy planners), the helper
   * treats it as an empty array and returns `no_applicable_bundle`.
   */
  readonly toolBundles: readonly ResolutionToolBundle[] | undefined;
  /**
   * The result handed back by `runEmbeddedPiAgent`. The evaluator reads
   * STRUCTURAL fields only — `meta.completionOutcome.artifactIds` and
   * `meta.error?.kind` — never `payloads[*].text`.
   */
  readonly runResult: EmbeddedPiRunResult | undefined;
  /**
   * Turn id used for the `[commitment-predicate]` telemetry line. Matches
   * the `runId` threaded into the embedded run so log lines can be joined
   * against existing `[broker]` / `[evidence]` lines on the same turn.
   */
  readonly turnId: string;
};

const TELEMETRY_PREFIX = "[commitment-predicate]";

/**
 * Evaluates the post-LLM done-predicate appropriate for the bundle of this
 * turn. Returns one of three results (see {@link PostLlmCommitmentEvaluation}):
 *
 *   - `satisfied` when the bundle is `repo_mutation` AND the runtime outcome
 *     records at least one artifactId. Mirrors `codePatchAppliedPredicate`
 *     with the structural shape available at this layer (`PlatformRuntimeRunOutcome`).
 *   - `unsatisfied` when the bundle is `repo_mutation` but no artifactId is
 *     present — the symptom from production turn `78ff2b60`.
 *   - `unevaluated` when the bundle is not in the dispatch table, the run
 *     result is unavailable, or the embedded run already surfaced an error
 *     (those paths have their own user-facing recovery flows in
 *     `agent-runner-execution.ts`; we MUST NOT shadow them with a
 *     cannot-complete substitution).
 *
 * Telemetry: emits one structured log line per non-`unevaluated` outcome —
 *   `[commitment-predicate] kind=repo_operation_completed result=<r> turnId=<id> artifacts=<n>`.
 * For `unevaluated` results we emit a debug-level line with the reason so
 * grep on the gateway log can disambiguate "no applicable bundle" from
 * "runtime outcome unavailable" without source-reading.
 *
 * @param params - Bundle list + run result + turn id, see
 *   {@link PostLlmCommitmentEvaluatorParams}.
 * @returns Evaluation outcome the caller routes on.
 */
export function evaluatePostLlmCommitment(
  params: PostLlmCommitmentEvaluatorParams,
): PostLlmCommitmentEvaluation {
  const { toolBundles, runResult, turnId } = params;

  // Embedded errors (context overflow, role ordering, compaction failure,
  // session corruption) are handled by the pre-existing recovery branches
  // in `agent-runner-execution.ts` AFTER the LLM call site. Re-evaluating
  // the commitment on top of those branches would double-emit a
  // user-facing reply and obscure the real failure cause.
  if (runResult?.meta?.error !== undefined) {
    defaultRuntime.log(
      `${TELEMETRY_PREFIX} skipped reason=embedded_error_present errorKind=${runResult.meta.error.kind} turnId=${turnId}`,
    );
    return { kind: "unevaluated", reason: "embedded_error_present" };
  }

  // Dispatch off the structural toolBundles enum. Today only `repo_mutation`
  // is wired — siblings (`artifact_authoring`, `external_delivery`,
  // `session_orchestration`) ship their own family-specific predicates
  // outside this evaluator. Treating an unknown / absent bundle as
  // `no_applicable_bundle` is the safe default: the caller delivers
  // normally and the bundle's own gate (or lack of one) decides.
  const isRepoMutationTurn = toolBundles?.includes("repo_mutation") === true;
  if (!isRepoMutationTurn) {
    defaultRuntime.log(
      `${TELEMETRY_PREFIX} skipped reason=no_applicable_bundle bundles=[${(toolBundles ?? []).join(",")}] turnId=${turnId}`,
    );
    return { kind: "unevaluated", reason: "no_applicable_bundle" };
  }

  // We have a `repo_mutation` turn. The structural evidence required to
  // satisfy the kernel-equivalent `codePatchAppliedPredicate` is at least
  // one artifact-producing tool checkpoint registered with the platform
  // runtime. When `completionOutcome` is undefined the embedded run did
  // not register a checkpoint service for this run id (legacy path /
  // heartbeat) — fall back to byte-identical pre-Slice-C behavior.
  const completionOutcome = runResult?.meta?.completionOutcome;
  if (completionOutcome === undefined) {
    defaultRuntime.log(
      `${TELEMETRY_PREFIX} skipped reason=runtime_outcome_unavailable turnId=${turnId}`,
    );
    return { kind: "unevaluated", reason: "runtime_outcome_unavailable" };
  }

  const artifactCount = completionOutcome.artifactIds.length;
  if (artifactCount === 0) {
    defaultRuntime.log(
      `${TELEMETRY_PREFIX} kind=repo_operation_completed result=unsatisfied turnId=${turnId} artifacts=0 confirmedActions=${completionOutcome.confirmedActionIds.length} attemptedActions=${completionOutcome.attemptedActionIds.length}`,
    );
    return {
      kind: "unsatisfied",
      predicate: "repo_operation_completed",
      // Closed-string missing key mirrors the kernel predicate's
      // `artifacts.records.empty` slot for cross-layer joinability.
      missing: "artifacts.records.empty",
    };
  }

  defaultRuntime.log(
    `${TELEMETRY_PREFIX} kind=repo_operation_completed result=satisfied turnId=${turnId} artifacts=${artifactCount}`,
  );
  return { kind: "satisfied", predicate: "repo_operation_completed" };
}

/**
 * The Russian-locale `cannot_complete` user-facing copy substituted for
 * the LLM's text-only reply when the post-LLM predicate fails on a
 * `repo_mutation` turn. Phrasing mirrors the bot's own honest
 * acknowledgement in turn `78ff2b60` 60s after the false-«Готово»
 * («Не могу честно подтвердить эту правку как корректную») — the
 * second turn was already correct; this slice makes the FIRST turn
 * carry the honest message instead of «Готово».
 *
 * Kept inline as a constant (not a template) so locale changes happen
 * via a code edit reviewed in PR — invariant #5 (no raw-text rules).
 */
export const REPO_MUTATION_CANNOT_COMPLETE_REPLY_RU =
  "Не могу подтвердить выполнение правки: ни один инструмент изменения файлов не был вызван в этом turn. Попробуйте переформулировать запрос или уточнить, какой именно файл нужно изменить.";
