import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { QualificationExecutionContract } from "../decision/qualification-contract.js";
import type { DeliverableSpec } from "../produce/registry.js";
import type { ExecutionRecipe } from "../schemas/index.js";
import {
  ACK_DEFER_THRESHOLD_ENV,
  DEFAULT_ACK_DEFER_THRESHOLD_MS,
  decideAckThenDefer,
  estimateRecipeDurationMs,
  planExecutionRecipe,
  resolveAckDeferThresholdMs,
} from "./planner.js";

const RECIPE_RESPOND_ONLY: ExecutionRecipe = {
  id: "general_reasoning",
  purpose: "General reasoning",
  acceptedInputs: [{ type: "text" }],
  riskLevel: "low",
};

const EXEC_LOCAL_PROCESS_CONTRACT: QualificationExecutionContract = {
  requiresTools: true,
  requiresWorkspaceMutation: true,
  requiresLocalProcess: true,
  requiresArtifactEvidence: false,
  requiresDeliveryEvidence: false,
  mayNeedBootstrap: true,
};

const EXEC_ONESHOT_CONTRACT: QualificationExecutionContract = {
  requiresTools: true,
  requiresWorkspaceMutation: false,
  requiresLocalProcess: true,
  requiresArtifactEvidence: false,
  requiresDeliveryEvidence: false,
  mayNeedBootstrap: true,
};

describe("ack-then-defer detection", () => {
  const prevEnv = process.env[ACK_DEFER_THRESHOLD_ENV];
  beforeEach(() => {
    delete process.env[ACK_DEFER_THRESHOLD_ENV];
  });
  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env[ACK_DEFER_THRESHOLD_ENV];
    } else {
      process.env[ACK_DEFER_THRESHOLD_ENV] = prevEnv;
    }
  });

  describe("resolveAckDeferThresholdMs", () => {
    it("defaults to 3000ms", () => {
      expect(resolveAckDeferThresholdMs({})).toBe(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });
    it("reads OPENCLAW_ACK_DEFER_MS from env", () => {
      expect(resolveAckDeferThresholdMs({ [ACK_DEFER_THRESHOLD_ENV]: "5000" })).toBe(5000);
    });
    it("falls back to default on invalid env value", () => {
      expect(resolveAckDeferThresholdMs({ [ACK_DEFER_THRESHOLD_ENV]: "abc" })).toBe(
        DEFAULT_ACK_DEFER_THRESHOLD_MS,
      );
    });
  });

  describe("estimateRecipeDurationMs", () => {
    it("does NOT use recipe.timeoutSeconds as a duration proxy (safety ceiling, not expected duration)", () => {
      const estimate = estimateRecipeDurationMs({
        recipe: { ...RECIPE_RESPOND_ONLY, timeoutSeconds: 180 },
        requestedTools: [],
      });
      expect(estimate).toBeLessThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });

    it("returns a short estimate for plain respond_only recipes", () => {
      const estimate = estimateRecipeDurationMs({
        recipe: RECIPE_RESPOND_ONLY,
        requestedTools: [],
      });
      expect(estimate).toBeLessThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });

    it("boosts estimate for capability_install tool", () => {
      const estimate = estimateRecipeDurationMs({
        recipe: RECIPE_RESPOND_ONLY,
        requestedTools: ["capability_install"],
      });
      expect(estimate).toBeGreaterThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });

    it("boosts estimate when recipe declares a long-running capability", () => {
      const estimate = estimateRecipeDurationMs({
        recipe: { ...RECIPE_RESPOND_ONLY, requiredCapabilities: ["capability_install"] },
        requestedTools: [],
      });
      expect(estimate).toBeGreaterThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });

    it("does NOT boost estimate for a short apply_patch turn (no overscope)", () => {
      const estimate = estimateRecipeDurationMs({
        recipe: RECIPE_RESPOND_ONLY,
        requestedTools: ["apply_patch"],
        outcomeContract: "workspace_change",
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: true,
          requiresLocalProcess: false,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: false,
        },
      });
      expect(estimate).toBeLessThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });

    it("does NOT boost estimate for a one-shot exec like `node --version`", () => {
      // exec alone (e.g. read-only one-shot command) is NOT enough to trigger
      // ack — without `outcomeContract === "interactive_local_result"` we
      // assume the run completes well under the 3s threshold.
      const estimate = estimateRecipeDurationMs({
        recipe: RECIPE_RESPOND_ONLY,
        requestedTools: ["exec"],
        outcomeContract: "external_operation",
        executionContract: EXEC_ONESHOT_CONTRACT,
      });
      expect(estimate).toBeLessThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });

    it("boosts estimate when classifier marks the turn as interactive_local_result (long build/dev server)", () => {
      const estimate = estimateRecipeDurationMs({
        recipe: RECIPE_RESPOND_ONLY,
        requestedTools: ["exec"],
        outcomeContract: "interactive_local_result",
        executionContract: EXEC_LOCAL_PROCESS_CONTRACT,
      });
      expect(estimate).toBeGreaterThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });

    it("does NOT boost estimate for a single image_generate render", () => {
      const deliverable: DeliverableSpec = {
        kind: "image",
        acceptedFormats: ["png"],
      };
      const estimate = estimateRecipeDurationMs({
        recipe: RECIPE_RESPOND_ONLY,
        requestedTools: ["image_generate"],
        deliverable,
      });
      expect(estimate).toBeLessThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });

    it("boosts estimate for image_generate batches greater than 1", () => {
      const deliverable: DeliverableSpec = {
        kind: "image",
        acceptedFormats: ["png"],
        constraints: { batch: 4 },
      };
      const estimate = estimateRecipeDurationMs({
        recipe: RECIPE_RESPOND_ONLY,
        requestedTools: ["image_generate"],
        deliverable,
      });
      expect(estimate).toBeGreaterThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });

    it("treats numeric string batch hint as long-run when greater than 1", () => {
      const deliverable: DeliverableSpec = {
        kind: "image",
        acceptedFormats: ["png"],
        constraints: { count: "3" },
      };
      const estimate = estimateRecipeDurationMs({
        recipe: RECIPE_RESPOND_ONLY,
        requestedTools: ["image_generate"],
        deliverable,
      });
      expect(estimate).toBeGreaterThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });

    it("does NOT boost estimate for a pdf turn without long-running signals", () => {
      const estimate = estimateRecipeDurationMs({
        recipe: RECIPE_RESPOND_ONLY,
        requestedTools: ["pdf"],
        outcomeContract: "structured_artifact",
      });
      expect(estimate).toBeLessThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });
  });

  describe("decideAckThenDefer", () => {
    it("defers when capability_install is a requested tool", () => {
      expect(
        decideAckThenDefer({
          estimatedDurationMs: 1_000,
          recipe: RECIPE_RESPOND_ONLY,
          requestedTools: ["capability_install"],
        }),
      ).toBe(true);
    });

    it("defers when estimated duration exceeds threshold", () => {
      expect(
        decideAckThenDefer({
          estimatedDurationMs: DEFAULT_ACK_DEFER_THRESHOLD_MS + 500,
          recipe: RECIPE_RESPOND_ONLY,
          requestedTools: [],
        }),
      ).toBe(true);
    });

    it("does NOT defer for simple respond_only turns", () => {
      expect(
        decideAckThenDefer({
          estimatedDurationMs: 1_500,
          recipe: RECIPE_RESPOND_ONLY,
          requestedTools: [],
        }),
      ).toBe(false);
    });

    it("does NOT defer for short apply_patch turns (no overscope)", () => {
      expect(
        decideAckThenDefer({
          estimatedDurationMs: 1_500,
          recipe: RECIPE_RESPOND_ONLY,
          requestedTools: ["apply_patch"],
        }),
      ).toBe(false);
    });

    it("does NOT defer for one-shot exec turns (no overscope)", () => {
      expect(
        decideAckThenDefer({
          estimatedDurationMs: 1_500,
          recipe: RECIPE_RESPOND_ONLY,
          requestedTools: ["exec"],
        }),
      ).toBe(false);
    });

    it("respects custom threshold from env", () => {
      process.env[ACK_DEFER_THRESHOLD_ENV] = "10000";
      expect(
        decideAckThenDefer({
          estimatedDurationMs: 5_000,
          recipe: RECIPE_RESPOND_ONLY,
          requestedTools: [],
        }),
      ).toBe(false);
    });
  });

  describe("planExecutionRecipe integration", () => {
    it("flags capability_install turns as ack-then-defer and sets estimated duration", () => {
      const plan = planExecutionRecipe({
        prompt: "install some package",
        requestedTools: ["capability_install"],
      });
      expect(plan.routingOutcome.kind).toBe("matched");
      expect(plan.ackThenDefer).toBe(true);
      expect(typeof plan.estimatedDurationMs).toBe("number");
      expect(plan.estimatedDurationMs!).toBeGreaterThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });

    it("does NOT flag a simple general_reasoning turn as ack-then-defer", () => {
      const plan = planExecutionRecipe({
        prompt: "What's 2 + 2?",
      });
      expect(plan.ackThenDefer).toBe(false);
    });

    it("does NOT flag a short apply_patch workspace_change turn as ack-then-defer", () => {
      const plan = planExecutionRecipe({
        prompt: "fix typo",
        requestedTools: ["apply_patch"],
        outcomeContract: "workspace_change",
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: true,
          requiresLocalProcess: false,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: false,
        },
      });
      expect(plan.ackThenDefer).toBe(false);
    });

    it("does NOT flag a one-shot exec turn (e.g. `node --version`) as ack-then-defer", () => {
      const plan = planExecutionRecipe({
        prompt: "run node --version",
        requestedTools: ["exec"],
        outcomeContract: "external_operation",
        executionContract: EXEC_ONESHOT_CONTRACT,
      });
      expect(plan.ackThenDefer).toBe(false);
    });

    it("flags an interactive_local_result exec turn (e.g. long build) as ack-then-defer", () => {
      const plan = planExecutionRecipe({
        prompt: "run the long build",
        requestedTools: ["exec"],
        outcomeContract: "interactive_local_result",
        executionContract: EXEC_LOCAL_PROCESS_CONTRACT,
      });
      expect(plan.ackThenDefer).toBe(true);
      expect(plan.estimatedDurationMs!).toBeGreaterThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });

    it("flags an image_generate batch>1 turn as ack-then-defer", () => {
      const plan = planExecutionRecipe({
        prompt: "render variants",
        requestedTools: ["image_generate"],
        deliverable: {
          kind: "image",
          acceptedFormats: ["png"],
          constraints: { batch: 3 },
        },
      });
      expect(plan.ackThenDefer).toBe(true);
      expect(plan.estimatedDurationMs!).toBeGreaterThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });

    it("does NOT flag a single image_generate render as ack-then-defer", () => {
      const plan = planExecutionRecipe({
        prompt: "make a thumbnail",
        requestedTools: ["image_generate"],
        deliverable: {
          kind: "image",
          acceptedFormats: ["png"],
        },
      });
      expect(plan.ackThenDefer).toBe(false);
    });
  });
});
