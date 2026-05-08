/**
 * Slice C — focused unit tests for `evaluatePostLlmCommitment`.
 *
 * Diagnostic: `.cursor/plans/DIAGNOSTIC-2026-05-08-kernel-vs-legacy-divergence.md`.
 * Production evidence: gateway-dev-2026-05-07.log turn `78ff2b60` («Удали
 * лишних» -> bot replied «Готово. Лишнее убрал, оставил только главного»
 * without ever calling `apply_patch` / `write`).
 *
 * The companion file `agent-runner.commitment-satisfied.e2e.test.ts` pins
 * the SYMPTOM through the real `runReplyAgent → runAgentTurnWithFallback`
 * chain — that proves the wiring at the post-LLM site fires. THIS file
 * pins the helper-level dispatch table:
 *
 *   - Test A — symptom: `repo_mutation` bundle + zero artifactIds →
 *     `unsatisfied` with the kernel-aligned `artifacts.records.empty`
 *     missing key. Telemetry MUST emit
 *     `[commitment-predicate] kind=repo_operation_completed result=unsatisfied`.
 *   - Test B — positive: `repo_mutation` bundle + at least one
 *     artifactId → `satisfied`. Telemetry MUST emit
 *     `[commitment-predicate] kind=repo_operation_completed result=satisfied`.
 *   - Test C — bundle dispatch negative: `session_orchestration` bundle
 *     (or any other non-`repo_mutation` value) MUST short-circuit to
 *     `unevaluated reason=no_applicable_bundle` even when artifactIds
 *     are zero. Wrong-predicate-fired bug guard.
 *   - Test D — no-runtime fallback: undefined `completionOutcome` MUST
 *     short-circuit to `unevaluated reason=runtime_outcome_unavailable`.
 *     Regression guard for legacy / heartbeat / pre-Cutover-4 callers.
 *   - Test E — embedded-error short-circuit: when the embedded run
 *     surfaced an error (context overflow / role ordering / etc.), the
 *     evaluator MUST short-circuit to
 *     `unevaluated reason=embedded_error_present` so the
 *     `agent-runner-execution.ts` recovery branches stay the source of
 *     truth for those user-facing replies.
 *   - Test F — undefined toolBundles: legacy planner that did not yet
 *     populate `resolutionContract` MUST be treated as
 *     `no_applicable_bundle`.
 *
 * Tests E and F are the negative-coverage boundary checks required by
 * AGENTS.md "Tests must catch real bugs" rule 6 — for every "X works
 * when Y" we add at least one "X rejects Z" boundary.
 *
 * Test discipline:
 *   - The function under test is `evaluatePostLlmCommitment`. We DO NOT
 *     spy on it.
 *   - We rebind `defaultRuntime.log` to capture the structured
 *     `[commitment-predicate]` lines. The rebind is restored in
 *     `afterEach` so cross-test bleed cannot leak.
 *   - No mocking of the kernel `codePatchAppliedPredicate` — the
 *     evaluator structurally mirrors that predicate at this layer
 *     (see helper JSDoc); the predicate itself stays the truth source
 *     for the formal cutover-4 gate at `runTurnDecision`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmbeddedPiRunResult } from "../../agents/pi-embedded-runner/types.js";
import type { ResolutionToolBundle } from "../../platform/decision/resolution-contract.js";
import { defaultRuntime } from "../../runtime.js";
import { evaluatePostLlmCommitment } from "./post-llm-commitment-evaluator.js";

// ============================================================================
// Runtime log capture — `defaultRuntime.log` rebind. Restored in
// `afterEach` so the rebind cannot leak across files / tests.
// ============================================================================

let originalLog: typeof defaultRuntime.log;
let capturedLines: string[];

beforeEach(() => {
  capturedLines = [];
  originalLog = defaultRuntime.log;
  (defaultRuntime as unknown as { log: (msg: string) => void }).log = (msg: string) => {
    capturedLines.push(msg);
    originalLog.call(defaultRuntime, msg);
  };
});

afterEach(() => {
  (defaultRuntime as unknown as { log: typeof originalLog }).log = originalLog;
});

// ============================================================================
// Fixture builders — keep evidence shape stable across tests so the
// dispatch boundary is the load-bearing variable per test.
// ============================================================================

function makeRunResult(params: {
  /** When undefined, omits `completionOutcome` (Test D shape). */
  artifactIds?: readonly string[];
  /** When set, attaches an `error` slot (Test E shape). */
  errorKind?: "context_overflow" | "role_ordering" | "compaction_failure";
}): EmbeddedPiRunResult {
  const meta: EmbeddedPiRunResult["meta"] = {
    durationMs: 1,
  };
  if (params.artifactIds !== undefined) {
    meta.completionOutcome = {
      runId: "test-run",
      status: "completed",
      checkpointIds: [],
      blockedCheckpointIds: [],
      completedCheckpointIds: [],
      deniedCheckpointIds: [],
      pendingApprovalIds: [],
      artifactIds: [...params.artifactIds],
      bootstrapRequestIds: [],
      actionIds: [],
      attemptedActionIds: [],
      confirmedActionIds: [],
      failedActionIds: [],
      boundaries: [],
    };
  }
  if (params.errorKind !== undefined) {
    meta.error = {
      kind: params.errorKind,
      message: "fixture error",
    };
  }
  return {
    payloads: [{ text: "Готово, удалил" }],
    meta,
  };
}

// ============================================================================
// Suite.
// ============================================================================

describe("evaluatePostLlmCommitment — Slice C dispatch table", () => {
  // ------------------------------------------------------------------------
  // Test A — symptom: repo_mutation + zero artifactIds → unsatisfied.
  // ------------------------------------------------------------------------
  it("A: returns unsatisfied with artifacts.records.empty when bundle=repo_mutation has zero artifactIds", () => {
    const result = evaluatePostLlmCommitment({
      toolBundles: ["repo_mutation"] satisfies readonly ResolutionToolBundle[],
      runResult: makeRunResult({ artifactIds: [] }),
      turnId: "turn-78ff2b60",
    });

    expect(result.kind).toBe("unsatisfied");
    if (result.kind === "unsatisfied") {
      expect(result.predicate).toBe("repo_operation_completed");
      expect(result.missing).toBe("artifacts.records.empty");
    }
    expect(
      capturedLines.some(
        (line) =>
          line.includes("[commitment-predicate]") &&
          line.includes("kind=repo_operation_completed") &&
          line.includes("result=unsatisfied") &&
          line.includes("turnId=turn-78ff2b60") &&
          line.includes("artifacts=0"),
      ),
      `expected unsatisfied telemetry line; got ${capturedLines.join(" | ")}`,
    ).toBe(true);
  });

  // ------------------------------------------------------------------------
  // Test B — positive: repo_mutation + at least one artifactId → satisfied.
  // ------------------------------------------------------------------------
  it("B: returns satisfied when bundle=repo_mutation has at least one artifactId", () => {
    const result = evaluatePostLlmCommitment({
      toolBundles: ["repo_mutation"],
      runResult: makeRunResult({ artifactIds: ["artifact-abc"] }),
      turnId: "turn-positive",
    });

    expect(result.kind).toBe("satisfied");
    if (result.kind === "satisfied") {
      expect(result.predicate).toBe("repo_operation_completed");
    }
    expect(
      capturedLines.some(
        (line) =>
          line.includes("[commitment-predicate]") &&
          line.includes("kind=repo_operation_completed") &&
          line.includes("result=satisfied") &&
          line.includes("turnId=turn-positive") &&
          line.includes("artifacts=1"),
      ),
      `expected satisfied telemetry line; got ${capturedLines.join(" | ")}`,
    ).toBe(true);
  });

  // ------------------------------------------------------------------------
  // Test C — bundle dispatch negative: session_orchestration MUST NOT
  // evaluate the repo predicate. Wrong-predicate-fired guard.
  // ------------------------------------------------------------------------
  it("C: short-circuits to no_applicable_bundle on bundle=session_orchestration", () => {
    const result = evaluatePostLlmCommitment({
      toolBundles: ["session_orchestration"],
      runResult: makeRunResult({ artifactIds: [] }),
      turnId: "turn-session",
    });

    expect(result.kind).toBe("unevaluated");
    if (result.kind === "unevaluated") {
      expect(result.reason).toBe("no_applicable_bundle");
    }
    expect(
      capturedLines.some(
        (line) =>
          line.includes("[commitment-predicate]") &&
          line.includes("reason=no_applicable_bundle") &&
          line.includes("turnId=turn-session"),
      ),
      `expected no_applicable_bundle skip line; got ${capturedLines.join(" | ")}`,
    ).toBe(true);
    expect(
      capturedLines.every((line) => !line.includes("kind=repo_operation_completed result=")),
      "expected NO repo_operation_completed evaluation telemetry on a non-repo bundle",
    ).toBe(true);
  });

  // ------------------------------------------------------------------------
  // Test D — no-runtime fallback: undefined completionOutcome → unevaluated.
  // ------------------------------------------------------------------------
  it("D: short-circuits to runtime_outcome_unavailable when completionOutcome is undefined", () => {
    const result = evaluatePostLlmCommitment({
      toolBundles: ["repo_mutation"],
      // Note: NO `artifactIds` -> helper omits `completionOutcome`.
      runResult: makeRunResult({}),
      turnId: "turn-legacy",
    });

    expect(result.kind).toBe("unevaluated");
    if (result.kind === "unevaluated") {
      expect(result.reason).toBe("runtime_outcome_unavailable");
    }
    expect(
      capturedLines.some(
        (line) =>
          line.includes("[commitment-predicate]") &&
          line.includes("reason=runtime_outcome_unavailable") &&
          line.includes("turnId=turn-legacy"),
      ),
      `expected runtime_outcome_unavailable skip line; got ${capturedLines.join(" | ")}`,
    ).toBe(true);
  });

  // ------------------------------------------------------------------------
  // Test E — embedded-error short-circuit: existing recovery branches in
  // `agent-runner-execution.ts` (context overflow / role ordering / etc.)
  // must remain the source of truth for those user-facing replies. The
  // evaluator MUST stand down with `embedded_error_present` so it does
  // not double-emit on top of those branches.
  // ------------------------------------------------------------------------
  it("E: short-circuits to embedded_error_present when meta.error is set", () => {
    const result = evaluatePostLlmCommitment({
      toolBundles: ["repo_mutation"],
      runResult: makeRunResult({ artifactIds: [], errorKind: "context_overflow" }),
      turnId: "turn-overflow",
    });

    expect(result.kind).toBe("unevaluated");
    if (result.kind === "unevaluated") {
      expect(result.reason).toBe("embedded_error_present");
    }
    expect(
      capturedLines.some(
        (line) =>
          line.includes("[commitment-predicate]") &&
          line.includes("reason=embedded_error_present") &&
          line.includes("errorKind=context_overflow") &&
          line.includes("turnId=turn-overflow"),
      ),
      `expected embedded_error_present skip line; got ${capturedLines.join(" | ")}`,
    ).toBe(true);
  });

  // ------------------------------------------------------------------------
  // Test F — legacy boundary: undefined toolBundles MUST be treated as
  // `no_applicable_bundle`. Pre-resolution-contract callers must continue
  // to deliver normally.
  // ------------------------------------------------------------------------
  it("F: short-circuits to no_applicable_bundle when toolBundles is undefined", () => {
    const result = evaluatePostLlmCommitment({
      toolBundles: undefined,
      runResult: makeRunResult({ artifactIds: [] }),
      turnId: "turn-legacy-planner",
    });

    expect(result.kind).toBe("unevaluated");
    if (result.kind === "unevaluated") {
      expect(result.reason).toBe("no_applicable_bundle");
    }
    expect(
      capturedLines.some(
        (line) =>
          line.includes("[commitment-predicate]") &&
          line.includes("reason=no_applicable_bundle") &&
          line.includes("turnId=turn-legacy-planner"),
      ),
      `expected no_applicable_bundle skip line; got ${capturedLines.join(" | ")}`,
    ).toBe(true);
  });

  // ------------------------------------------------------------------------
  // Edge — runResult itself is undefined (defensive boundary).
  // ------------------------------------------------------------------------
  it("E2: short-circuits to runtime_outcome_unavailable when runResult is undefined", () => {
    const result = evaluatePostLlmCommitment({
      toolBundles: ["repo_mutation"],
      runResult: undefined,
      turnId: "turn-undefined-result",
    });

    expect(result.kind).toBe("unevaluated");
    if (result.kind === "unevaluated") {
      expect(result.reason).toBe("runtime_outcome_unavailable");
    }
  });
});
