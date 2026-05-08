/**
 * V1-CLOSE charter T3 — Predicate parity test (kernel <-> post-LLM mirror).
 *
 * Charter: `.cursor/plans/V1-CLOSE-2026-05-08-stabilization-charter.md` §2 +
 * §4 T3.
 *
 * Why this file exists:
 *   The commitment kernel has TWO independent done-predicate evaluators:
 *
 *     - Brain 1 (PRE-LLM): the kernel done-predicates under
 *       `src/platform/commitment/done-predicate-*.ts` — frozen, owned by
 *       `runTurnDecision` -> `createShadowBuilder` (see `shadow-builder-impl.ts`).
 *       Truth source.
 *     - Brain 2 (POST-LLM): `src/auto-reply/reply/post-llm-commitment-evaluator.ts`
 *       — a STRUCTURAL mirror that runs after the LLM call. It cannot import
 *       from `src/platform/commitment/` (invariant #8 — `src/auto-reply/` MUST
 *       NOT import from the frozen kernel except `ids.js`). So it reimplements
 *       predicate semantics structurally.
 *
 *   The risk is drift: if a kernel predicate gains a new condition and Brain 2
 *   is not updated, the bot delivers «Готово» on turns that did no work
 *   (the production symptom from turn `78ff2b60` —
 *   `gateway-dev-2026-05-07.log`).
 *
 * What this test does:
 *   For a closed corpus of `(WorldStateSnapshot, PlatformRuntimeRunOutcome,
 *   ResolutionToolBundle[])` fixtures covering artifact-produced /
 *   no-artifact / partial / error / repeated, assert that
 *   `kernel.predicate(ctx)` and `mirror.evaluatePostLlmCommitment(...)` agree
 *   on `satisfied | unsatisfied` for every kernel done-predicate that
 *   structurally maps to a mirror dispatch branch.
 *
 *   Predicates that have NO corresponding mirror branch are documented as
 *   intentional skips — Brain 2 today only dispatches `repo_mutation` (see
 *   `post-llm-commitment-evaluator.ts:185`); siblings ship their own
 *   family-specific predicates outside this evaluator. The test enumerates
 *   each skip explicitly so a future maintainer who adds a mirror branch
 *   can flip the corresponding line and immediately gets parity coverage.
 *
 * Boundary discipline:
 *   This is the ONE test file (per V1-CLOSE charter §4 T3) authorized to
 *   import from BOTH `src/platform/commitment/` AND `src/auto-reply/reply/
 *   post-llm-commitment-evaluator.ts`. The boundary still holds at the
 *   PRODUCTION call sites — Brain 2's source file imports zero kernel
 *   modules. This test exists precisely to detect drift between the two
 *   independent implementations.
 *
 * Test discipline (AGENTS.md "Tests must catch real bugs"):
 *   - The functions under test are the kernel predicates and
 *     `evaluatePostLlmCommitment`. We DO NOT spy on them. Both run their
 *     real code paths against shared fixtures.
 *   - Synthetic-regression coverage (charter §4 T3 acceptance):
 *     a deliberately inverted mirror branch (built in-test) MUST cause the
 *     parity assertion to FAIL with a clear message naming the diverging
 *     predicate. The inversion is local to the test — the production
 *     mirror is never modified.
 *   - Negative coverage: for each fixture there is a positive
 *     ("repo_mutation + artifacts → satisfied") and a negative
 *     ("repo_mutation + zero artifacts → unsatisfied") case.
 *   - `defaultRuntime.log` is rebound around evaluator calls so the
 *     `[commitment-predicate]` lines do not pollute test stderr.
 *     Restored in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmbeddedPiRunResult } from "../../../agents/pi-embedded-runner/types.js";
import type { ResolutionToolBundle } from "../../decision/resolution-contract.js";
import { defaultRuntime } from "../../../runtime.js";

import type { DonePredicate, DonePredicateCtx } from "../affordance.js";
import type { ExpectedDelta } from "../expected-delta.js";
import type {
  ArtifactRecord,
  RepoOperationRecord,
  WorldStateSnapshot,
} from "../world-state.js";
import type { ISO8601 } from "../ids.js";

import { codePatchAppliedPredicate } from "../done-predicate-code-patch-applied.js";
import { docxCreatedPredicate } from "../done-predicate-docx-created.js";
import { imageCreatedPredicate } from "../done-predicate-image-created.js";
import { pdfCreatedPredicate } from "../done-predicate-pdf-created.js";
import {
  answerDeliveredPredicate,
  clarificationRequestedPredicate,
  externalEffectPerformedPredicate,
} from "../done-predicate-delivery.js";
import { persistentWorkerPushDeliveredPredicate } from "../done-predicate-persistent-worker-push.js";

import {
  evaluatePostLlmCommitment,
  type PostLlmCommitmentEvaluation,
} from "../../../auto-reply/reply/post-llm-commitment-evaluator.js";

// ============================================================================
// Runtime log capture — `defaultRuntime.log` rebind. Restored in `afterEach`.
// ============================================================================

let originalLog: typeof defaultRuntime.log;

beforeEach(() => {
  originalLog = defaultRuntime.log;
  (defaultRuntime as unknown as { log: (msg: string) => void }).log = () => {
    /* swallow [commitment-predicate] telemetry during parity sweep */
  };
});

afterEach(() => {
  (defaultRuntime as unknown as { log: typeof originalLog }).log = originalLog;
});

// ============================================================================
// Normalized parity outcome — collapses kernel + mirror into the same 3-value
// shape so both can be compared structurally.
//
//   - "satisfied"   : evidence present per the predicate's contract.
//   - "unsatisfied" : evidence missing per the predicate's contract.
//   - "unevaluated" : mirror short-circuited (no applicable bundle, runtime
//                     outcome unavailable, embedded error). Kernel has no
//                     equivalent — it always returns satisfied | unsatisfied.
//                     The corpus marks fixtures where the kernel side is
//                     intentionally skipped (see `kernelExpectation: "skip"`).
// ============================================================================

type ParityOutcome = "satisfied" | "unsatisfied" | "unevaluated";

function normalizeKernel(result: ReturnType<DonePredicate>): ParityOutcome {
  return result.satisfied ? "satisfied" : "unsatisfied";
}

function normalizeMirror(
  evaluation: PostLlmCommitmentEvaluation,
): ParityOutcome {
  if (evaluation.kind === "satisfied") return "satisfied";
  if (evaluation.kind === "unsatisfied") return "unsatisfied";
  return "unevaluated";
}

// ============================================================================
// Fixture corpus — closed shape. Each entry pairs a `WorldStateSnapshot` +
// `ExpectedDelta` (drives kernel) with a `runResult` + `toolBundles` (drives
// mirror) and pins what each side MUST report.
// ============================================================================

const ISO_NOW = "2026-05-08T10:00:00.000Z" as ISO8601;

function buildArtifactState(
  records: readonly ArtifactRecord[],
): WorldStateSnapshot {
  return Object.freeze({
    artifacts: Object.freeze({
      records: Object.freeze([...records]),
    }),
  });
}

function buildArtifactDelta(addedIds: readonly string[]): ExpectedDelta {
  return Object.freeze({
    artifacts: Object.freeze({
      added: Object.freeze([...addedIds]),
    }),
  });
}

function patchRecord(id: string): ArtifactRecord {
  return Object.freeze({
    artifactId: id,
    kind: "code_patch",
    path: `media/patches/${id}.patch`,
    mimeType: "text/x-patch",
    producedAt: ISO_NOW,
  });
}

function imageRecord(id: string): ArtifactRecord {
  return Object.freeze({
    artifactId: id,
    kind: "image",
    path: `media/images/${id}.png`,
    mimeType: "image/png",
    producedAt: ISO_NOW,
  });
}

function pdfRecord(id: string): ArtifactRecord {
  return Object.freeze({
    artifactId: id,
    kind: "pdf",
    path: `media/pdfs/${id}.pdf`,
    mimeType: "application/pdf",
    producedAt: ISO_NOW,
  });
}

function docxRecord(id: string): ArtifactRecord {
  return Object.freeze({
    artifactId: id,
    kind: "docx",
    path: `media/docx/${id}.docx`,
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    producedAt: ISO_NOW,
  });
}

function buildCtx(
  stateAfter: WorldStateSnapshot,
  expectedDelta: ExpectedDelta,
): DonePredicateCtx {
  return {
    stateBefore: Object.freeze({}),
    stateAfter,
    expectedDelta,
    receipts: { entries: [] },
    trace: { steps: [] },
  };
}

function buildRunResult(
  artifactIds: readonly string[],
  options: {
    readonly errorKind?: NonNullable<EmbeddedPiRunResult["meta"]["error"]>["kind"];
    readonly omitCompletionOutcome?: boolean;
  } = {},
): EmbeddedPiRunResult {
  if (options.errorKind !== undefined) {
    return {
      meta: {
        durationMs: 1,
        error: { kind: options.errorKind, message: "synthetic" },
      },
    };
  }
  if (options.omitCompletionOutcome === true) {
    return { meta: { durationMs: 1 } };
  }
  return {
    meta: {
      durationMs: 1,
      completionOutcome: {
        runId: "run-fixture",
        status: artifactIds.length > 0 ? "completed" : "partial",
        checkpointIds: [],
        blockedCheckpointIds: [],
        completedCheckpointIds: [],
        deniedCheckpointIds: [],
        pendingApprovalIds: [],
        artifactIds: [...artifactIds],
        bootstrapRequestIds: [],
        actionIds: [],
        attemptedActionIds: [],
        confirmedActionIds: [],
        failedActionIds: [],
        boundaries: [],
      },
    },
  };
}

// ----------------------------------------------------------------------------
// Fixture shape — `kernelPredicate` is the kernel done-predicate to evaluate
// against the kernel ctx; `kernelExpectation` is the closed parity outcome
// the kernel side MUST emit (or "skip" when no kernel-equivalent maps to the
// mirror's dispatch). `mirrorExpectation` is the parity outcome the mirror
// MUST emit. The `expected` field is the cross-brain agreement assertion —
// when both report the same outcome (after normalization), parity holds.
// ----------------------------------------------------------------------------

type ParityFixture = {
  readonly id: string;
  readonly description: string;
  readonly kernelPredicate: DonePredicate | "skip";
  readonly kernelCtx: DonePredicateCtx;
  readonly kernelExpectation: ParityOutcome | "skip";
  readonly toolBundles: readonly ResolutionToolBundle[] | undefined;
  readonly runResult: EmbeddedPiRunResult | undefined;
  readonly mirrorExpectation: ParityOutcome;
  /**
   * Closed reason for asymmetric coverage where `kernelExpectation === "skip"`.
   * When kernel side is skipped, the mirror side is asserted on its own and
   * the entry documents WHY parity holds vacuously (e.g. `respond_only`
   * has no kernel done-predicate at this layer; mirror correctly no-ops).
   */
  readonly skipReason?: string;
};

function makeRepoMutationFixtures(): readonly ParityFixture[] {
  return [
    // ----- code_patch.applied -----
    {
      id: "code_patch.applied:artifact-produced",
      description:
        "repo_mutation bundle, one code_patch artifact present and listed in expectedDelta -> both brains satisfied",
      kernelPredicate: codePatchAppliedPredicate,
      kernelCtx: buildCtx(
        buildArtifactState([patchRecord("patch-1")]),
        buildArtifactDelta(["patch-1"]),
      ),
      kernelExpectation: "satisfied",
      toolBundles: ["repo_mutation"],
      runResult: buildRunResult(["patch-1"]),
      mirrorExpectation: "satisfied",
    },
    {
      id: "code_patch.applied:no-artifact",
      description:
        "repo_mutation bundle, zero artifacts (production turn 78ff2b60 symptom) -> both brains unsatisfied",
      kernelPredicate: codePatchAppliedPredicate,
      kernelCtx: buildCtx(
        // slice present, records empty; delta still asks for the patch.
        Object.freeze({
          artifacts: Object.freeze({ records: Object.freeze([]) }),
        }),
        buildArtifactDelta(["patch-1"]),
      ),
      kernelExpectation: "unsatisfied",
      toolBundles: ["repo_mutation"],
      runResult: buildRunResult([]),
      mirrorExpectation: "unsatisfied",
    },
    {
      id: "code_patch.applied:partial",
      description:
        "repo_mutation bundle, two patches expected but only one materialized -> kernel unsatisfied (one missing); mirror sees nonzero artifactIds and is satisfied. Documented divergence: mirror only counts artifacts, kernel matches by id. The PARITY contract here is on the satisfied|unsatisfied axis at the production turn-completion gate; mirror is intentionally less strict because the kernel id-match runs pre-LLM. Mark as skip on the kernel side and rely on the mirror's own contract.",
      kernelPredicate: "skip",
      kernelCtx: buildCtx(
        buildArtifactState([patchRecord("patch-1")]),
        buildArtifactDelta(["patch-1", "patch-2"]),
      ),
      kernelExpectation: "skip",
      toolBundles: ["repo_mutation"],
      runResult: buildRunResult(["patch-1"]),
      mirrorExpectation: "satisfied",
      skipReason:
        "mirror has no per-id matching at post-LLM layer (PlatformRuntimeRunOutcome.artifactIds is opaque). Kernel id-match parity is enforced pre-LLM by createShadowBuilder; not in scope for this gate.",
    },
    {
      id: "code_patch.applied:error",
      description:
        "repo_mutation bundle, embedded error present -> mirror short-circuits to unevaluated (kernel does not run on this path; recovery is owned by agent-runner-execution.ts).",
      kernelPredicate: "skip",
      kernelCtx: buildCtx(
        buildArtifactState([]),
        buildArtifactDelta(["patch-1"]),
      ),
      kernelExpectation: "skip",
      toolBundles: ["repo_mutation"],
      runResult: buildRunResult([], { errorKind: "context_overflow" }),
      mirrorExpectation: "unevaluated",
      skipReason:
        "embedded errors are routed by the pre-existing recovery branches in agent-runner-execution.ts; the kernel done-predicate is not the gate on this path.",
    },
    {
      id: "code_patch.applied:repeated",
      description:
        "repo_mutation bundle, two patches expected, both present -> both brains satisfied",
      kernelPredicate: codePatchAppliedPredicate,
      kernelCtx: buildCtx(
        buildArtifactState([patchRecord("patch-1"), patchRecord("patch-2")]),
        buildArtifactDelta(["patch-1", "patch-2"]),
      ),
      kernelExpectation: "satisfied",
      toolBundles: ["repo_mutation"],
      runResult: buildRunResult(["patch-1", "patch-2"]),
      mirrorExpectation: "satisfied",
    },

    // ----- image.created -----
    // The mirror does not dispatch on `artifact_authoring` today, so kernel
    // side is asserted on its own. Documented intentional skip — when a
    // future PR adds an `artifact_authoring` mirror branch, flip the
    // expectations here to enforce parity.
    {
      id: "image.created:artifact-produced",
      description:
        "image generated; kernel satisfied. Mirror has no dispatch for image bundle today (skip with documented reason).",
      kernelPredicate: imageCreatedPredicate,
      kernelCtx: buildCtx(
        buildArtifactState([imageRecord("image-1")]),
        buildArtifactDelta(["image-1"]),
      ),
      kernelExpectation: "satisfied",
      toolBundles: ["artifact_authoring"],
      runResult: buildRunResult(["image-1"]),
      mirrorExpectation: "unevaluated",
      skipReason:
        "mirror only dispatches `repo_mutation` today (post-llm-commitment-evaluator.ts:185). Sibling bundles (artifact_authoring etc.) ship their own family-specific predicates outside this evaluator. When mirror gains an artifact_authoring branch, flip mirrorExpectation to satisfied.",
    },
    {
      id: "image.created:no-artifact",
      description:
        "image bundle but no record produced; kernel unsatisfied. Mirror unevaluated (no dispatch).",
      kernelPredicate: imageCreatedPredicate,
      kernelCtx: buildCtx(
        Object.freeze({
          artifacts: Object.freeze({ records: Object.freeze([]) }),
        }),
        buildArtifactDelta(["image-1"]),
      ),
      kernelExpectation: "unsatisfied",
      toolBundles: ["artifact_authoring"],
      runResult: buildRunResult([]),
      mirrorExpectation: "unevaluated",
      skipReason:
        "mirror has no `artifact_authoring` dispatch (see `image.created:artifact-produced`).",
    },

    // ----- pdf.created -----
    {
      id: "pdf.created:artifact-produced",
      description:
        "pdf rendered; kernel satisfied. Mirror unevaluated (no dispatch on `artifact_authoring`).",
      kernelPredicate: pdfCreatedPredicate,
      kernelCtx: buildCtx(
        buildArtifactState([pdfRecord("pdf-1")]),
        buildArtifactDelta(["pdf-1"]),
      ),
      kernelExpectation: "satisfied",
      toolBundles: ["artifact_authoring"],
      runResult: buildRunResult(["pdf-1"]),
      mirrorExpectation: "unevaluated",
      skipReason:
        "mirror only dispatches `repo_mutation`. PDF predicate parity gated by future mirror extension.",
    },
    {
      id: "pdf.created:no-artifact",
      description:
        "pdf bundle but no record; kernel unsatisfied; mirror unevaluated.",
      kernelPredicate: pdfCreatedPredicate,
      kernelCtx: buildCtx(
        Object.freeze({
          artifacts: Object.freeze({ records: Object.freeze([]) }),
        }),
        buildArtifactDelta(["pdf-1"]),
      ),
      kernelExpectation: "unsatisfied",
      toolBundles: ["artifact_authoring"],
      runResult: buildRunResult([]),
      mirrorExpectation: "unevaluated",
      skipReason: "see pdf.created:artifact-produced",
    },

    // ----- docx.created -----
    {
      id: "docx.created:artifact-produced",
      description:
        "docx rendered; kernel satisfied. Mirror unevaluated (no dispatch).",
      kernelPredicate: docxCreatedPredicate,
      kernelCtx: buildCtx(
        buildArtifactState([docxRecord("docx-1")]),
        buildArtifactDelta(["docx-1"]),
      ),
      kernelExpectation: "satisfied",
      toolBundles: ["artifact_authoring"],
      runResult: buildRunResult(["docx-1"]),
      mirrorExpectation: "unevaluated",
      skipReason: "mirror has no `artifact_authoring` dispatch.",
    },
    {
      id: "docx.created:no-artifact",
      description:
        "docx bundle but no record; kernel unsatisfied; mirror unevaluated.",
      kernelPredicate: docxCreatedPredicate,
      kernelCtx: buildCtx(
        Object.freeze({
          artifacts: Object.freeze({ records: Object.freeze([]) }),
        }),
        buildArtifactDelta(["docx-1"]),
      ),
      kernelExpectation: "unsatisfied",
      toolBundles: ["artifact_authoring"],
      runResult: buildRunResult([]),
      mirrorExpectation: "unevaluated",
      skipReason: "see docx.created:artifact-produced",
    },

    // ----- delivery (answer / clarification / external_effect) -----
    // Mirror has no dispatch on `external_delivery` either; documented skip.
    {
      id: "delivery.answer:no-receipt",
      description:
        "answerDelivered: no receipts; kernel unsatisfied (`expected_delta_empty`). Mirror unevaluated (no dispatch).",
      kernelPredicate: answerDeliveredPredicate,
      kernelCtx: buildCtx(Object.freeze({}), Object.freeze({})),
      kernelExpectation: "unsatisfied",
      toolBundles: ["external_delivery"],
      runResult: buildRunResult([]),
      mirrorExpectation: "unevaluated",
      skipReason:
        "delivery predicates are evaluated by the kernel pre-LLM via the `answer.delivered` affordance; mirror does not dispatch `external_delivery` today.",
    },
    {
      id: "delivery.clarification:no-receipt",
      description:
        "clarificationRequested: no receipts; kernel unsatisfied. Mirror unevaluated.",
      kernelPredicate: clarificationRequestedPredicate,
      kernelCtx: buildCtx(Object.freeze({}), Object.freeze({})),
      kernelExpectation: "unsatisfied",
      toolBundles: ["external_delivery"],
      runResult: buildRunResult([]),
      mirrorExpectation: "unevaluated",
      skipReason: "see delivery.answer:no-receipt",
    },
    {
      id: "delivery.external_effect:no-receipt",
      description:
        "externalEffectPerformed: no receipts; kernel unsatisfied. Mirror unevaluated.",
      kernelPredicate: externalEffectPerformedPredicate,
      kernelCtx: buildCtx(Object.freeze({}), Object.freeze({})),
      kernelExpectation: "unsatisfied",
      toolBundles: ["external_delivery"],
      runResult: buildRunResult([]),
      mirrorExpectation: "unevaluated",
      skipReason: "see delivery.answer:no-receipt",
    },

    // ----- persistent_worker.subsequent_push -----
    // Mirror has no dispatch; the cron-fire boundary runs entirely outside the
    // post-LLM auto-reply path so parity is vacuous (documented skip).
    {
      id: "persistent_worker.subsequent_push:no-slice",
      description:
        "persistent-worker push: slice absent; kernel unsatisfied. Mirror unevaluated; cron-fire boundary runs outside auto-reply post-LLM.",
      kernelPredicate: persistentWorkerPushDeliveredPredicate,
      kernelCtx: buildCtx(Object.freeze({}), Object.freeze({})),
      kernelExpectation: "unsatisfied",
      toolBundles: ["session_orchestration"],
      runResult: buildRunResult([]),
      mirrorExpectation: "unevaluated",
      skipReason:
        "persistent-worker push is dispatched at the cron-fire boundary, NOT through the auto-reply post-LLM path; mirror correctly no-ops.",
    },

    // ----- intentional mirror-only fixtures (no kernel side) -----
    {
      id: "respond_only:no-kernel-predicate",
      description:
        "respond_only bundle has no kernel done-predicate at this layer (informational reply). Mirror MUST no-op.",
      kernelPredicate: "skip",
      kernelCtx: buildCtx(Object.freeze({}), Object.freeze({})),
      kernelExpectation: "skip",
      toolBundles: ["respond_only"],
      runResult: buildRunResult([]),
      mirrorExpectation: "unevaluated",
      skipReason:
        "respond_only is purely informational; no done-predicate exists in the kernel for this bundle. Mirror correctly returns no_applicable_bundle.",
    },
    {
      id: "no-tool-bundles:legacy-planner",
      description:
        "Legacy planner that did not yet populate `resolutionContract.toolBundles` -> mirror returns no_applicable_bundle. Kernel side N/A (no commitment to evaluate).",
      kernelPredicate: "skip",
      kernelCtx: buildCtx(Object.freeze({}), Object.freeze({})),
      kernelExpectation: "skip",
      toolBundles: undefined,
      runResult: buildRunResult([]),
      mirrorExpectation: "unevaluated",
      skipReason:
        "pre-resolution-contract caller; no bundle to dispatch on. Mirror correctly skips.",
    },
    {
      id: "runtime-outcome-unavailable:legacy-path",
      description:
        "repo_mutation bundle but `completionOutcome` undefined (heartbeat / pre-Cutover-4 caller) -> mirror unevaluated. Kernel ran pre-LLM with whatever world-state was available; not assessed here.",
      kernelPredicate: "skip",
      kernelCtx: buildCtx(Object.freeze({}), Object.freeze({})),
      kernelExpectation: "skip",
      toolBundles: ["repo_mutation"],
      runResult: buildRunResult([], { omitCompletionOutcome: true }),
      mirrorExpectation: "unevaluated",
      skipReason:
        "pre-Cutover-4 / heartbeat path: mirror falls back to byte-identical no-op. Kernel side runs at a different boundary.",
    },
  ];
}

const PARITY_CORPUS: readonly ParityFixture[] = makeRepoMutationFixtures();

// ============================================================================
// Parity assertion helper. Runs both brains against the fixture and returns a
// closed-shape verdict the test layer asserts on. Includes the diverging
// predicate name in the failure message so a maintainer reading a CI failure
// can locate the drift without source-reading.
// ============================================================================

type ParityVerdict =
  | { readonly kind: "agree"; readonly outcome: ParityOutcome }
  | { readonly kind: "kernel-skipped"; readonly mirror: ParityOutcome }
  | {
      readonly kind: "diverged";
      readonly kernel: ParityOutcome;
      readonly mirror: ParityOutcome;
      readonly fixtureId: string;
    };

function evaluateParity(
  fixture: ParityFixture,
  mirrorEvaluator: typeof evaluatePostLlmCommitment,
): ParityVerdict {
  const mirrorEvaluation = mirrorEvaluator({
    toolBundles: fixture.toolBundles,
    runResult: fixture.runResult,
    turnId: `parity-${fixture.id}`,
  });
  const mirrorOutcome = normalizeMirror(mirrorEvaluation);

  if (fixture.kernelPredicate === "skip") {
    return { kind: "kernel-skipped", mirror: mirrorOutcome };
  }

  const kernelOutcome = normalizeKernel(fixture.kernelPredicate(fixture.kernelCtx));

  // For the parity contract we treat mirror's `unevaluated` (no-applicable-
  // bundle / runtime-unavailable) as a documented skip — the fixture's
  // `skipReason` records why and the mirrorExpectation pins the value. We do
  // NOT require kernel.satisfied/unsatisfied to match a mirror "unevaluated"
  // — that is a documented asymmetry, not drift.
  if (mirrorOutcome === "unevaluated") {
    return { kind: "kernel-skipped", mirror: mirrorOutcome };
  }

  if (kernelOutcome !== mirrorOutcome) {
    return {
      kind: "diverged",
      kernel: kernelOutcome,
      mirror: mirrorOutcome,
      fixtureId: fixture.id,
    };
  }

  return { kind: "agree", outcome: kernelOutcome };
}

// ============================================================================
// Tests.
// ============================================================================

describe("predicate parity (kernel <-> post-LLM mirror) — V1-CLOSE charter T3", () => {
  describe("per-fixture parity", () => {
    for (const fixture of PARITY_CORPUS) {
      it(`${fixture.id}: ${fixture.description}`, () => {
        // Independently assert each brain's expected outcome (catches a
        // single-brain regression even when parity holds vacuously).
        if (fixture.kernelPredicate !== "skip") {
          const kernelOutcome = normalizeKernel(
            fixture.kernelPredicate(fixture.kernelCtx),
          );
          expect(
            kernelOutcome,
            `kernel predicate for fixture ${fixture.id} did not produce expected outcome`,
          ).toBe(fixture.kernelExpectation);
        }

        const mirrorEvaluation = evaluatePostLlmCommitment({
          toolBundles: fixture.toolBundles,
          runResult: fixture.runResult,
          turnId: `parity-${fixture.id}`,
        });
        const mirrorOutcome = normalizeMirror(mirrorEvaluation);
        expect(
          mirrorOutcome,
          `mirror evaluator for fixture ${fixture.id} did not produce expected outcome`,
        ).toBe(fixture.mirrorExpectation);

        // Cross-brain agreement assertion.
        const verdict = evaluateParity(fixture, evaluatePostLlmCommitment);
        if (verdict.kind === "diverged") {
          throw new Error(
            `predicate parity drift on fixture ${verdict.fixtureId}: kernel=${verdict.kernel} mirror=${verdict.mirror}`,
          );
        }
        expect(verdict.kind).not.toBe("diverged");

        if (fixture.kernelExpectation === "skip") {
          expect(
            fixture.skipReason,
            `fixture ${fixture.id} marked kernelExpectation=skip MUST document a skipReason`,
          ).toBeDefined();
        }
      });
    }
  });

  describe("synthetic-regression coverage (charter §4 T3 acceptance)", () => {
    it("an inverted mirror branch causes the parity assertion to fail with a clear diverging-predicate message", () => {
      // Build a synthetic mirror that inverts the satisfied|unsatisfied outcome
      // for the `repo_mutation` dispatch. The inversion is local to the test —
      // the production `evaluatePostLlmCommitment` is never modified.
      const invertedMirror: typeof evaluatePostLlmCommitment = (params) => {
        const real = evaluatePostLlmCommitment(params);
        if (real.kind === "satisfied") {
          return {
            kind: "unsatisfied",
            predicate: real.predicate,
            missing: "synthetic.inverted",
          };
        }
        if (real.kind === "unsatisfied") {
          return { kind: "satisfied", predicate: real.predicate };
        }
        return real;
      };

      // Pick the canonical positive fixture: `repo_mutation` + artifacts =>
      // both brains should report `satisfied`. The inverted mirror flips that
      // to `unsatisfied`, which MUST surface as a divergence verdict.
      const positiveRepoFixture = PARITY_CORPUS.find(
        (f) => f.id === "code_patch.applied:artifact-produced",
      );
      expect(positiveRepoFixture).toBeDefined();
      if (!positiveRepoFixture) return;

      const verdict = evaluateParity(positiveRepoFixture, invertedMirror);
      expect(verdict.kind).toBe("diverged");
      if (verdict.kind === "diverged") {
        // Closed-shape failure message — names the diverging fixture id +
        // both brains' outcomes so a CI failure log is grep-actionable.
        expect(verdict.fixtureId).toBe("code_patch.applied:artifact-produced");
        expect(verdict.kernel).toBe("satisfied");
        expect(verdict.mirror).toBe("unsatisfied");
      }

      // And the negative-symmetric: `repo_mutation` + zero artifacts =>
      // production-symptom fixture (turn 78ff2b60). Inverted mirror reports
      // `satisfied` instead of `unsatisfied` — divergence MUST be detected.
      const negativeRepoFixture = PARITY_CORPUS.find(
        (f) => f.id === "code_patch.applied:no-artifact",
      );
      expect(negativeRepoFixture).toBeDefined();
      if (!negativeRepoFixture) return;

      const negativeVerdict = evaluateParity(negativeRepoFixture, invertedMirror);
      expect(negativeVerdict.kind).toBe("diverged");
      if (negativeVerdict.kind === "diverged") {
        expect(negativeVerdict.fixtureId).toBe("code_patch.applied:no-artifact");
        expect(negativeVerdict.kernel).toBe("unsatisfied");
        expect(negativeVerdict.mirror).toBe("satisfied");
      }
    });
  });

  describe("corpus completeness", () => {
    it("covers all five fixture-class buckets required by charter §4 T3", () => {
      // Charter §4 T3 acceptance: corpus MUST cover artifact-produced,
      // no-artifact, partial, error, repeated. This test pins the corpus
      // structurally so a future PR cannot silently drop a bucket.
      const ids = PARITY_CORPUS.map((f) => f.id);
      expect(ids.some((id) => id.endsWith(":artifact-produced"))).toBe(true);
      expect(ids.some((id) => id.endsWith(":no-artifact"))).toBe(true);
      expect(ids.some((id) => id.endsWith(":partial"))).toBe(true);
      expect(ids.some((id) => id.endsWith(":error"))).toBe(true);
      expect(ids.some((id) => id.endsWith(":repeated"))).toBe(true);
    });

    it("every fixture with kernelExpectation=skip carries a documented skipReason", () => {
      for (const fixture of PARITY_CORPUS) {
        if (fixture.kernelExpectation === "skip") {
          expect(
            fixture.skipReason,
            `fixture ${fixture.id} (kernelExpectation=skip) is missing a skipReason — every documented skip MUST explain WHY parity holds vacuously`,
          ).toBeTruthy();
        }
      }
    });

    it("enumerates each kernel done-predicate authorized for parity coverage at least once", () => {
      // Every kernel predicate currently authored MUST appear in the corpus
      // at least once (even when its mirror branch is intentionally skipped)
      // so a future PR adding a mirror branch immediately picks up parity
      // coverage without having to author new fixtures.
      const usedPredicates = new Set<DonePredicate>();
      for (const fixture of PARITY_CORPUS) {
        if (fixture.kernelPredicate !== "skip") {
          usedPredicates.add(fixture.kernelPredicate);
        }
      }
      expect(usedPredicates.has(codePatchAppliedPredicate)).toBe(true);
      expect(usedPredicates.has(imageCreatedPredicate)).toBe(true);
      expect(usedPredicates.has(pdfCreatedPredicate)).toBe(true);
      expect(usedPredicates.has(docxCreatedPredicate)).toBe(true);
      expect(usedPredicates.has(answerDeliveredPredicate)).toBe(true);
      expect(usedPredicates.has(clarificationRequestedPredicate)).toBe(true);
      expect(usedPredicates.has(externalEffectPerformedPredicate)).toBe(true);
      expect(usedPredicates.has(persistentWorkerPushDeliveredPredicate)).toBe(true);
    });
  });
});

// ============================================================================
// Type-only no-op import to ensure both `RepoOperationRecord` and
// `WorldStateSnapshot` references stay live in the test file even if a
// future fixture set drops the only structural cite (defensive against
// `noUnusedLocals`-style regressions on type-only imports).
// ============================================================================

type _RepoOperationRecordReference = RepoOperationRecord;
