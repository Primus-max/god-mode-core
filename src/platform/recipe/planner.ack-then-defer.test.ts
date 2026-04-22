import { describe, expect, it, beforeEach, afterEach } from "vitest";
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
    it("boosts estimate for capability_install tool", () => {
      const estimate = estimateRecipeDurationMs({
        recipe: RECIPE_RESPOND_ONLY,
        requestedTools: ["capability_install"],
      });
      expect(estimate).toBeGreaterThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });
    it("returns a short estimate for plain respond_only recipes", () => {
      const estimate = estimateRecipeDurationMs({
        recipe: RECIPE_RESPOND_ONLY,
        requestedTools: [],
      });
      expect(estimate).toBeLessThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
    });
    it("boosts estimate for exec tool", () => {
      const estimate = estimateRecipeDurationMs({
        recipe: RECIPE_RESPOND_ONLY,
        requestedTools: ["exec"],
      });
      expect(estimate).toBeGreaterThan(DEFAULT_ACK_DEFER_THRESHOLD_MS);
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
  });
});
