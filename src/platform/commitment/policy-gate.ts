import type { OpenClawConfig } from "../../config/config.js";
import type { RegisteredAffordance } from "./affordance-registry.js";
import type { ChannelId, EffectId } from "./ids.js";
import type { SemanticIntent, TargetRef } from "./semantic-intent.js";
import type { PolicyGateDecision, PolicyGateReader } from "./shadow-builder-impl.js";

/**
 * Closed set of denial reasons exposed by the Wave B PolicyGate (master
 * §8.5.1, sub-plan §4.10). Approvals, budgets per-user/per-channel/per-effect,
 * role-based access, retry policies, and escalation hooks are **not** in this
 * set — they belong to the future
 * `commitment_kernel_policy_gate_full.plan.md` sub-plan and must not be
 * added inside PR-4b.
 *
 * The reverse-test in `policy-gate.test.ts` asserts this exact pair to make
 * scope creep visible at PR review.
 */
export const POLICY_GATE_REASONS = Object.freeze(["channel_disabled", "no_credentials"] as const);

export type PolicyGateReason = (typeof POLICY_GATE_REASONS)[number];

export type RealPolicyGateContext = {
  readonly cfg: OpenClawConfig;
};

const ANSWER_DELIVERED_EFFECT = "answer.delivered" as EffectId;
const CLARIFICATION_REQUESTED_EFFECT = "clarification_requested" as EffectId;
const EXTERNAL_EFFECT_PERFORMED_EFFECT = "external_effect.performed" as EffectId;

const CHAT_BOUND_EFFECTS: ReadonlySet<EffectId> = new Set([
  ANSWER_DELIVERED_EFFECT,
  CLARIFICATION_REQUESTED_EFFECT,
  EXTERNAL_EFFECT_PERFORMED_EFFECT,
]);

const CREDENTIAL_REQUIRED_EFFECTS: ReadonlySet<EffectId> = new Set([
  EXTERNAL_EFFECT_PERFORMED_EFFECT,
]);

/**
 * Creates the Wave B real PolicyGate (G6.b closure, minimum scope).
 *
 * Reason codes are restricted to {`channel_disabled`, `no_credentials`}.
 * Effects outside the chat-bound communication family fall through to allow.
 *
 * @param context - Real-mode runtime context (just `cfg` for Wave B; richer
 *   contexts such as `deliveryContextKey`, `userId`, or `roleId` are reserved
 *   for the future full PolicyGate sub-plan).
 * @returns `PolicyGateReader` adapter compatible with `createShadowBuilder`.
 */
export function createPolicyGate(context: RealPolicyGateContext): PolicyGateReader {
  return Object.freeze({
    canUseAffordance({ intent, affordance }): PolicyGateDecision {
      if (!CHAT_BOUND_EFFECTS.has(affordance.effect)) {
        return { allowed: true };
      }
      const channelId = resolveChannelId(intent, affordance);
      if (channelId && isChannelDisabled(context.cfg, channelId)) {
        return { allowed: false, reason: "channel_disabled" satisfies PolicyGateReason };
      }
      if (CREDENTIAL_REQUIRED_EFFECTS.has(affordance.effect)) {
        if (!channelId) {
          return { allowed: false, reason: "no_credentials" satisfies PolicyGateReason };
        }
        if (!hasChannelCredentials(context.cfg, channelId)) {
          return { allowed: false, reason: "no_credentials" satisfies PolicyGateReason };
        }
      }
      return { allowed: true };
    },
  });
}

/**
 * Reads the explicit `enabled` flag for a known built-in channel. Returns
 * `false` only when the config has `channels[id].enabled === false`. Channels
 * that are absent from the config are treated as enabled by default; PR-4b
 * does not introduce a closed channel allow-list.
 *
 * @param cfg - OpenClaw config instance.
 * @param channelId - Branded channel id resolved from intent or affordance.
 * @returns True when the channel is explicitly disabled.
 */
function isChannelDisabled(cfg: OpenClawConfig, channelId: ChannelId): boolean {
  const config = readChannelConfig(cfg, channelId);
  return config?.enabled === false;
}

/**
 * Detects credentials presence for a channel using known config shapes.
 * For Telegram-style channels: `botToken` or `tokenFile` populated.
 * For other channels: a non-empty `accounts` map or generic `token` field
 * is treated as evidence of credentials. Custom channels added via
 * `ExtensionChannelConfig` are allowed by default — extensions own their own
 * authentication checks.
 *
 * @param cfg - OpenClaw config instance.
 * @param channelId - Branded channel id resolved from intent or affordance.
 * @returns True when the channel appears to have credentials configured.
 */
function hasChannelCredentials(cfg: OpenClawConfig, channelId: ChannelId): boolean {
  const config = readChannelConfig(cfg, channelId);
  if (!config) {
    return false;
  }
  if (typeof config.botToken === "string" && config.botToken.trim().length > 0) {
    return true;
  }
  if (typeof config.tokenFile === "string" && config.tokenFile.trim().length > 0) {
    return true;
  }
  if (typeof config.token === "string" && config.token.trim().length > 0) {
    return true;
  }
  if (config.accounts && typeof config.accounts === "object") {
    const accountValues = Object.values(config.accounts);
    if (accountValues.some((value) => value && typeof value === "object")) {
      return true;
    }
  }
  return false;
}

type ChannelConfigShape = {
  readonly enabled?: boolean;
  readonly botToken?: string;
  readonly tokenFile?: string;
  readonly token?: string;
  readonly accounts?: Record<string, unknown>;
};

function readChannelConfig(cfg: OpenClawConfig, channelId: ChannelId): ChannelConfigShape | undefined {
  const channels = cfg.channels;
  if (!channels) {
    return undefined;
  }
  const raw = (channels as Record<string, unknown>)[channelId];
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  return raw as ChannelConfigShape;
}

function resolveChannelId(
  intent: SemanticIntent,
  affordance: RegisteredAffordance,
): ChannelId | undefined {
  const fromTarget = readChannelFromTarget(intent.target);
  if (fromTarget) {
    return fromTarget;
  }
  const fromConstraints = readChannelFromConstraints(intent.constraints);
  if (fromConstraints) {
    return fromConstraints;
  }
  void affordance;
  return undefined;
}

function readChannelFromTarget(target: TargetRef): ChannelId | undefined {
  if (target.kind !== "external_channel") {
    return undefined;
  }
  if (typeof target.channelId === "string" && target.channelId.trim().length > 0) {
    return target.channelId.trim() as ChannelId;
  }
  return undefined;
}

function readChannelFromConstraints(
  constraints: SemanticIntent["constraints"],
): ChannelId | undefined {
  const value = (constraints as Record<string, unknown>).channelId;
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? (trimmed as ChannelId) : undefined;
}
