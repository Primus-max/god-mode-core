import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  CLARIFICATION_POLICY_REASONS,
  COMMUNICATION_EFFECT_FAMILY,
  createClarificationPolicy,
} from "../index.js";
import type { ChannelId, EffectFamilyId } from "../ids.js";
import type { SemanticIntent } from "../semantic-intent.js";

const PUBLISH_AMBIGUITY = "external operation is inferred without an explicit publish target";
const DEPLOYMENT_AMBIGUITY = "deployment target is not specified";
const PRODUCTION_AMBIGUITY = "blocking: production target unclear";
const NON_DEPLOYMENT_AMBIGUITY = "credentials missing for external_delivery";

const PUBLISH_FAMILY: EffectFamilyId = "publish" as EffectFamilyId;
const COMMUNICATION_CHANNEL: ChannelId = "telegram" as ChannelId;

function intentWorkspace(): SemanticIntent {
  return {
    desiredEffectFamily: PUBLISH_FAMILY,
    target: { kind: "workspace" },
    operation: { kind: "create" },
    constraints: {},
    uncertainty: [],
    confidence: 0.9,
  };
}

function intentExternalChannelWithLocalConstraint(value: string): SemanticIntent {
  return {
    desiredEffectFamily: COMMUNICATION_EFFECT_FAMILY,
    target: { kind: "external_channel", channelId: COMMUNICATION_CHANNEL },
    operation: { kind: "create" },
    constraints: { hosting: value },
    uncertainty: [],
    confidence: 0.9,
  };
}

function intentExternalChannelWithoutLocalSignal(): SemanticIntent {
  return {
    desiredEffectFamily: COMMUNICATION_EFFECT_FAMILY,
    target: { kind: "external_channel", channelId: COMMUNICATION_CHANNEL },
    operation: { kind: "create" },
    constraints: {},
    uncertainty: [],
    confidence: 0.9,
  };
}

describe("ClarificationPolicy exported reason set (Stage 1 reverse-test)", () => {
  it("exposes exactly one reason code: ambiguity_resolved_by_intent", () => {
    expect(CLARIFICATION_POLICY_REASONS).toEqual(["ambiguity_resolved_by_intent"]);
  });

  it("freezes the reason set so Stages 2+ cannot append silently", () => {
    expect(Object.isFrozen(CLARIFICATION_POLICY_REASONS)).toBe(true);
    expect(() => {
      (CLARIFICATION_POLICY_REASONS as unknown as string[]).push("requires_approval");
    }).toThrow();
  });
});

describe("createClarificationPolicy (Stage 1 — Bug D ambiguity over-blocking)", () => {
  const cfg = {} as OpenClawConfig;

  it("downgrades when target=workspace and a publish-target ambiguity is blocking", async () => {
    const gate = createClarificationPolicy({ cfg });
    const decision = await gate.evaluate({
      intent: intentWorkspace(),
      blockingReasons: [PUBLISH_AMBIGUITY],
    });

    expect(decision).toEqual({
      shouldClarify: false,
      downgradeReason: "ambiguity_resolved_by_intent",
    });
  });

  it("downgrades for constraints.hosting='local' on a deployment-target ambiguity", async () => {
    const gate = createClarificationPolicy({ cfg });
    const decision = await gate.evaluate({
      intent: intentExternalChannelWithLocalConstraint("local"),
      blockingReasons: [DEPLOYMENT_AMBIGUITY],
    });

    expect(decision).toEqual({
      shouldClarify: false,
      downgradeReason: "ambiguity_resolved_by_intent",
    });
  });

  it("downgrades for constraints.hosting case-insensitive and trimmed", async () => {
    const gate = createClarificationPolicy({ cfg });
    const decision = await gate.evaluate({
      intent: intentExternalChannelWithLocalConstraint("  Localhost  "),
      blockingReasons: [PRODUCTION_AMBIGUITY],
    });

    expect(decision).toEqual({
      shouldClarify: false,
      downgradeReason: "ambiguity_resolved_by_intent",
    });
  });

  it("accepts the Russian local marker as a structural signal", async () => {
    const gate = createClarificationPolicy({ cfg });
    const decision = await gate.evaluate({
      intent: intentExternalChannelWithLocalConstraint("локально"),
      blockingReasons: [PUBLISH_AMBIGUITY],
    });

    expect(decision).toEqual({
      shouldClarify: false,
      downgradeReason: "ambiguity_resolved_by_intent",
    });
  });

  it("preserves clarify when intent has no local signal even if reason is deployment-flavored", async () => {
    const gate = createClarificationPolicy({ cfg });
    const decision = await gate.evaluate({
      intent: intentExternalChannelWithoutLocalSignal(),
      blockingReasons: [PUBLISH_AMBIGUITY],
    });

    expect(decision).toEqual({ shouldClarify: true });
  });

  it("preserves clarify when intent has local signal but no deployment-flavored blocking reason", async () => {
    const gate = createClarificationPolicy({ cfg });
    const decision = await gate.evaluate({
      intent: intentWorkspace(),
      blockingReasons: [NON_DEPLOYMENT_AMBIGUITY],
    });

    expect(decision).toEqual({ shouldClarify: true });
  });

  it("preserves clarify when blockingReasons list is empty regardless of intent shape", async () => {
    const gate = createClarificationPolicy({ cfg });
    const decision = await gate.evaluate({
      intent: intentWorkspace(),
      blockingReasons: [],
    });

    expect(decision).toEqual({ shouldClarify: true });
  });

  it("ignores non-string and non-allowed constraint values", async () => {
    const gate = createClarificationPolicy({ cfg });
    const intent: SemanticIntent = {
      desiredEffectFamily: PUBLISH_FAMILY,
      target: { kind: "external_channel", channelId: COMMUNICATION_CHANNEL },
      operation: { kind: "create" },
      constraints: { hosting: 42, deploymentTarget: "remote", executionTarget: { foo: "bar" } },
      uncertainty: [],
      confidence: 0.9,
    };
    const decision = await gate.evaluate({
      intent,
      blockingReasons: [PUBLISH_AMBIGUITY],
    });

    expect(decision).toEqual({ shouldClarify: true });
  });
});
