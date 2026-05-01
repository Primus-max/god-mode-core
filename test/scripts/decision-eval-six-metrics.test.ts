import { describe, expect, it } from "vitest";
import {
  assertCutover1LabelsPresent,
  summarizeQuantGate,
} from "../../scripts/dev/decision-eval.js";

describe("decision-eval six-metrics quant gate", () => {
  it("passes all six thresholds for a synthetic 30-turn persistent-session pool", () => {
    const results = Array.from({ length: 30 }, (_unused, index) => ({
      id: `synthetic-${String(index)}`,
      pass: true,
      errorTags: [],
      diffs: [],
      expected: {},
      expectedShadowEffect: "persistent_session.created",
      actual: {
        primaryOutcome: "persistent_worker",
        plannerInput: {
          decisionTrace: {
            cutoverGate: { kind: "gate_out", reason: "cutover_disabled" },
          },
        },
      },
      shadow: {
        result: {
          kind: "commitment",
          value: {
            effect: "persistent_session.created",
          },
        },
      },
      cutoverLabel: {
        sessionId: `agent:worker-${String(index)}:main`,
        expected_satisfied: true,
        label_source: index < 24 ? "auto" : index < 28 ? "hindsight" : "human",
      },
    }));

    expect(summarizeQuantGate(results as Parameters<typeof summarizeQuantGate>[0])).toEqual({
      n_turns: 30,
      metrics: {
        state_observability_coverage: 1,
        commitment_correctness: 1,
        satisfaction_correctness: 1,
        false_positive_success: 0,
        divergence_explained: 1,
        labeling_window_honored: 1,
      },
      thresholds_passed: true,
      label_source_breakdown: {
        auto: 24,
        hindsight: 4,
        human: 2,
      },
      divergence_count: 0,
    });
  });

  it("fails fast when persistent-session quant-gate turns have no labels", () => {
    expect(() =>
      assertCutover1LabelsPresent(
        [
          {
            id: "missing-label",
            sessionId: "agent:missing-label:main",
            classifierContract: {
              primaryOutcome: "persistent_worker",
            },
            expectedShadowEffect: "persistent_session.created",
          },
        ] as Parameters<typeof assertCutover1LabelsPresent>[0],
        new Map(),
      ),
    ).toThrow(
      "Missing cutover1 labels for quant-gate pool: missing-label:missing_label:agent:missing-label:main",
    );
  });
});
