import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  CLARIFICATION_POLICY_REASONS,
  COMMUNICATION_EFFECT_FAMILY,
  INHERITABLE_INTENT_FIELDS,
  createClarificationPolicy,
} from "../index.js";
import type { ChannelId, EffectFamilyId } from "../ids.js";
import type { OperationHint, SemanticIntent, TargetRef } from "../semantic-intent.js";

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

describe("ClarificationPolicy exported reason set (Stage 1 + 1.5 reverse-test)", () => {
  it("exposes exactly two reason codes: ambiguity_resolved_by_intent + ambiguity_resolved_by_session_history", () => {
    expect(CLARIFICATION_POLICY_REASONS).toEqual([
      "ambiguity_resolved_by_intent",
      "ambiguity_resolved_by_session_history",
    ]);
  });

  it("freezes the reason set so Stages 2+ cannot append silently", () => {
    expect(Object.isFrozen(CLARIFICATION_POLICY_REASONS)).toBe(true);
    expect(() => {
      (CLARIFICATION_POLICY_REASONS as unknown as string[]).push("requires_approval");
    }).toThrow();
  });
});

describe("INHERITABLE_INTENT_FIELDS reverse-test (Stage 1.5)", () => {
  it("exposes exactly two inheritable fields: target.kind + operation", () => {
    expect(INHERITABLE_INTENT_FIELDS).toEqual(["target.kind", "operation"]);
  });

  it("freezes the inheritable-fields set so silent extension fails", () => {
    expect(Object.isFrozen(INHERITABLE_INTENT_FIELDS)).toBe(true);
    expect(() => {
      (INHERITABLE_INTENT_FIELDS as unknown as string[]).push("constraints");
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

const TARGET_AMBIGUITY = "target unspecified for workspace operation";
const ACTION_AMBIGUITY = "action ambiguous: cannot derive operation verb";
const NEXT_STEP_AMBIGUITY = "blocking: next step unclear from short prompt";

function intentWithTarget(target: TargetRef, operation?: OperationHint): SemanticIntent {
  return {
    desiredEffectFamily: PUBLISH_FAMILY,
    target,
    ...(operation ? { operation } : {}),
    constraints: {},
    uncertainty: [],
    confidence: 0.5,
  };
}

describe("createClarificationPolicy (Stage 1.5 — PR-H session-history-aware clarify)", () => {
  const cfg = {} as OpenClawConfig;

  it("downgrades when prior intent fills target.kind and current intent leaves it unspecified", async () => {
    const gate = createClarificationPolicy({ cfg });
    const decision = await gate.evaluate({
      intent: intentWithTarget({ kind: "unspecified" }, { kind: "create" }),
      priorIntent: intentWithTarget({ kind: "workspace" }, { kind: "create" }),
      blockingReasons: [TARGET_AMBIGUITY],
    });

    expect(decision).toEqual({
      shouldClarify: false,
      downgradeReason: "ambiguity_resolved_by_session_history",
      inheritedFields: ["target.kind"],
    });
  });

  it("downgrades when prior intent fills operation and current intent leaves it undefined", async () => {
    const gate = createClarificationPolicy({ cfg });
    const decision = await gate.evaluate({
      intent: intentWithTarget({ kind: "workspace" }),
      priorIntent: intentWithTarget({ kind: "workspace" }, { kind: "create" }),
      blockingReasons: [ACTION_AMBIGUITY],
    });

    expect(decision).toEqual({
      shouldClarify: false,
      downgradeReason: "ambiguity_resolved_by_session_history",
      inheritedFields: ["operation"],
    });
  });

  it("downgrades with both inherited fields when both classes match the blocking reasons", async () => {
    const gate = createClarificationPolicy({ cfg });
    const decision = await gate.evaluate({
      intent: intentWithTarget({ kind: "unspecified" }),
      priorIntent: intentWithTarget({ kind: "workspace" }, { kind: "create" }),
      blockingReasons: [TARGET_AMBIGUITY, NEXT_STEP_AMBIGUITY],
    });

    expect(decision).toEqual({
      shouldClarify: false,
      downgradeReason: "ambiguity_resolved_by_session_history",
      inheritedFields: ["target.kind", "operation"],
    });
  });

  it("does NOT downgrade when current intent contradicts prior intent's target.kind", async () => {
    const gate = createClarificationPolicy({ cfg });
    const decision = await gate.evaluate({
      intent: intentWithTarget(
        { kind: "external_channel", channelId: COMMUNICATION_CHANNEL },
        { kind: "create" },
      ),
      priorIntent: intentWithTarget({ kind: "workspace" }, { kind: "create" }),
      blockingReasons: [TARGET_AMBIGUITY],
    });

    expect(decision).toEqual({ shouldClarify: true });
  });

  it("does NOT downgrade when current intent contradicts prior intent's operation", async () => {
    const gate = createClarificationPolicy({ cfg });
    const decision = await gate.evaluate({
      intent: intentWithTarget({ kind: "workspace" }, { kind: "observe" }),
      priorIntent: intentWithTarget({ kind: "workspace" }, { kind: "create" }),
      blockingReasons: [ACTION_AMBIGUITY],
    });

    expect(decision).toEqual({ shouldClarify: true });
  });

  it("does NOT downgrade on cold start when no priorIntent is supplied", async () => {
    const gate = createClarificationPolicy({ cfg });
    const decision = await gate.evaluate({
      intent: intentWithTarget({ kind: "unspecified" }),
      blockingReasons: [TARGET_AMBIGUITY],
    });

    expect(decision).toEqual({ shouldClarify: true });
  });

  it("does NOT downgrade when inheritable field is present but no blocking reason matches its curated class", async () => {
    const gate = createClarificationPolicy({ cfg });
    const decision = await gate.evaluate({
      intent: intentWithTarget({ kind: "unspecified" }, { kind: "create" }),
      priorIntent: intentWithTarget({ kind: "workspace" }, { kind: "create" }),
      blockingReasons: [NON_DEPLOYMENT_AMBIGUITY],
    });

    expect(decision).toEqual({ shouldClarify: true });
  });

  it("Stage 1 takes precedence over Stage 1.5 when both could fire", async () => {
    const gate = createClarificationPolicy({ cfg });
    const decision = await gate.evaluate({
      intent: intentWorkspace(),
      priorIntent: intentWithTarget({ kind: "workspace" }, { kind: "create" }),
      blockingReasons: [PUBLISH_AMBIGUITY],
    });

    expect(decision).toEqual({
      shouldClarify: false,
      downgradeReason: "ambiguity_resolved_by_intent",
    });
  });

  it("downgrades only the matched subset of inheritable fields when only one reason class matches", async () => {
    const gate = createClarificationPolicy({ cfg });
    const decision = await gate.evaluate({
      intent: intentWithTarget({ kind: "unspecified" }),
      priorIntent: intentWithTarget({ kind: "workspace" }, { kind: "create" }),
      blockingReasons: [ACTION_AMBIGUITY],
    });

    expect(decision).toEqual({
      shouldClarify: false,
      downgradeReason: "ambiguity_resolved_by_session_history",
      inheritedFields: ["operation"],
    });
  });
});
