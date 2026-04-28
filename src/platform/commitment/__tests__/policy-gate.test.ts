import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  ANSWER_DELIVERED_AFFORDANCE_ENTRY,
  CLARIFICATION_REQUESTED_AFFORDANCE_ENTRY,
  COMMUNICATION_EFFECT_FAMILY,
  EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY,
  PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
  POLICY_GATE_REASONS,
  createPolicyGate,
} from "../index.js";
import type { ChannelId } from "../ids.js";
import type { SemanticIntent } from "../semantic-intent.js";

const TG: ChannelId = "telegram" as ChannelId;
const DC: ChannelId = "discord" as ChannelId;

function intentForExternalChannel(channelId: ChannelId): SemanticIntent {
  return {
    desiredEffectFamily: COMMUNICATION_EFFECT_FAMILY,
    target: { kind: "external_channel", channelId },
    operation: { kind: "create" },
    constraints: { channelId },
    uncertainty: [],
    confidence: 0.9,
  };
}

function intentForUnspecifiedTarget(channelId?: ChannelId): SemanticIntent {
  return {
    desiredEffectFamily: COMMUNICATION_EFFECT_FAMILY,
    target: { kind: "unspecified" },
    operation: { kind: "create" },
    constraints: channelId ? { channelId } : {},
    uncertainty: [],
    confidence: 0.9,
  };
}

describe("PolicyGate exported reason set (reverse-test, sub-plan §5 row e)", () => {
  it("exposes exactly two reason codes, in alphabetical order", () => {
    expect(POLICY_GATE_REASONS).toEqual(["channel_disabled", "no_credentials"]);
  });

  it("freezes the reason set so PR-4b cannot append silently", () => {
    expect(Object.isFrozen(POLICY_GATE_REASONS)).toBe(true);
    expect(() => {
      (POLICY_GATE_REASONS as unknown as string[]).push("budget_exceeded");
    }).toThrow();
  });
});

describe("createPolicyGate (Wave B minimum scope, sub-plan §4.10)", () => {
  it("denies external_effect.performed when channel has no credentials", async () => {
    const cfg = {
      channels: {
        telegram: { enabled: true },
      },
    } as OpenClawConfig;

    const gate = createPolicyGate({ cfg });
    const decision = await gate.canUseAffordance({
      intent: intentForExternalChannel(TG),
      affordance: EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY,
    });

    expect(decision).toEqual({ allowed: false, reason: "no_credentials" });
  });

  it("allows external_effect.performed when channel has a botToken", async () => {
    const cfg = {
      channels: {
        telegram: { enabled: true, botToken: "tg-bot-token" },
      },
    } as OpenClawConfig;

    const gate = createPolicyGate({ cfg });
    const decision = await gate.canUseAffordance({
      intent: intentForExternalChannel(TG),
      affordance: EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY,
    });

    expect(decision).toEqual({ allowed: true });
  });

  it("denies any chat-bound effect when the resolved channel is explicitly disabled", async () => {
    const cfg = {
      channels: {
        discord: { enabled: false, botToken: "dc-token" },
      },
    } as OpenClawConfig;

    const gate = createPolicyGate({ cfg });

    expect(
      await gate.canUseAffordance({
        intent: intentForExternalChannel(DC),
        affordance: ANSWER_DELIVERED_AFFORDANCE_ENTRY,
      }),
    ).toEqual({ allowed: false, reason: "channel_disabled" });

    expect(
      await gate.canUseAffordance({
        intent: intentForUnspecifiedTarget(DC),
        affordance: CLARIFICATION_REQUESTED_AFFORDANCE_ENTRY,
      }),
    ).toEqual({ allowed: false, reason: "channel_disabled" });

    expect(
      await gate.canUseAffordance({
        intent: intentForExternalChannel(DC),
        affordance: EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY,
      }),
    ).toEqual({ allowed: false, reason: "channel_disabled" });
  });

  it("allows answer.delivered for an enabled channel without credential check", async () => {
    const cfg = {
      channels: {
        telegram: { enabled: true },
      },
    } as OpenClawConfig;

    const gate = createPolicyGate({ cfg });
    const decision = await gate.canUseAffordance({
      intent: intentForExternalChannel(TG),
      affordance: ANSWER_DELIVERED_AFFORDANCE_ENTRY,
    });

    expect(decision).toEqual({ allowed: true });
  });

  it("allows clarification_requested when no channel is bound yet", async () => {
    const cfg = {} as OpenClawConfig;

    const gate = createPolicyGate({ cfg });
    const decision = await gate.canUseAffordance({
      intent: intentForUnspecifiedTarget(),
      affordance: CLARIFICATION_REQUESTED_AFFORDANCE_ENTRY,
    });

    expect(decision).toEqual({ allowed: true });
  });

  it("does not gate effects outside the chat-bound communication family", async () => {
    const cfg = {} as OpenClawConfig;

    const gate = createPolicyGate({ cfg });
    const decision = await gate.canUseAffordance({
      intent: {
        desiredEffectFamily: COMMUNICATION_EFFECT_FAMILY,
        target: { kind: "session" },
        operation: { kind: "create" },
        constraints: {},
        uncertainty: [],
        confidence: 0.9,
      },
      affordance: PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    });

    expect(decision).toEqual({ allowed: true });
  });
});
