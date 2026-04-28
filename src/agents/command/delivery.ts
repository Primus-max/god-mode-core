import crypto from "node:crypto";
import {
  reevaluateMessagingDecisionForMessagingRun,
  type MessagingDeliveryClosureCandidate,
} from "../../auto-reply/reply/agent-runner-helpers.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { createOutboundSendDeps, type CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  resolveAgentDeliveryPlan,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { buildOutboundResultEnvelope } from "../../infra/outbound/envelope.js";
import {
  formatOutboundPayloadLog,
  type NormalizedOutboundPayload,
  normalizeOutboundPayloads,
  normalizeOutboundPayloadsForJson,
} from "../../infra/outbound/payloads.js";
import type { OutboundSessionContext } from "../../infra/outbound/session-context.js";
import type { RuntimeEnv } from "../../runtime.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import type { AgentCommandOpts } from "./types.js";

type RunResult = Awaited<ReturnType<(typeof import("../pi-embedded.js"))["runEmbeddedPiAgent"]>>;
type AgentReplyPayloads = NonNullable<RunResult["payloads"]>;

const NESTED_LOG_PREFIX = "[agent:nested]";

function formatNestedLogPrefix(opts: AgentCommandOpts, sessionKey?: string): string {
  const parts = [NESTED_LOG_PREFIX];
  const session = sessionKey ?? opts.sessionKey ?? opts.sessionId;
  if (session) {
    parts.push(`session=${session}`);
  }
  if (opts.runId) {
    parts.push(`run=${opts.runId}`);
  }
  const channel = opts.messageChannel ?? opts.channel;
  if (channel) {
    parts.push(`channel=${channel}`);
  }
  if (opts.to) {
    parts.push(`to=${opts.to}`);
  }
  if (opts.accountId) {
    parts.push(`account=${opts.accountId}`);
  }
  return parts.join(" ");
}

function logNestedOutput(
  runtime: RuntimeEnv,
  opts: AgentCommandOpts,
  output: string,
  sessionKey?: string,
) {
  const prefix = formatNestedLogPrefix(opts, sessionKey);
  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    runtime.log(`${prefix} ${line}`);
  }
}

function mergePostDeliveryRuntimeMeta(params: {
  result: RunResult;
  replyPayloads: AgentReplyPayloads;
}): RunResult["meta"] {
  const reevaluated = reevaluateMessagingDecisionForMessagingRun({
    runResult: params.result as MessagingDeliveryClosureCandidate["runResult"],
    replyPayloads: params.replyPayloads ?? [],
    runPayloadsForEvidence: params.result.payloads ?? [],
  });
  if (!reevaluated) {
    return params.result.meta;
  }
  return {
    ...params.result.meta,
    ...(reevaluated.runClosure ? { runClosure: reevaluated.runClosure } : {}),
    ...(reevaluated.acceptanceOutcome ? { acceptanceOutcome: reevaluated.acceptanceOutcome } : {}),
    ...(reevaluated.executionVerification
      ? { executionVerification: reevaluated.executionVerification }
      : {}),
    ...(reevaluated.supervisorVerdict ? { supervisorVerdict: reevaluated.supervisorVerdict } : {}),
  };
}

/**
 * Resolves the runtime run id used to correlate outbound delivery actions with the
 * run closure verification path. CLI turns often omit `opts.runId`, so we fall back
 * to the completion outcome's run id to preserve verified delivery receipts.
 *
 * @param {AgentCommandOpts} opts - Agent command options for the current run.
 * @param {RunResult} result - Embedded run result that may already contain closure metadata.
 * @returns {string | undefined} Run id for durable delivery action correlation.
 */
function resolveDeliveryActionRunId(opts: AgentCommandOpts, result: RunResult): string | undefined {
  const explicitRunId = opts.runId?.trim();
  if (explicitRunId) {
    return explicitRunId;
  }
  const completionRunId = result.meta?.completionOutcome?.runId?.trim();
  return completionRunId ? completionRunId : undefined;
}

function createDeterministicDeliveryActionId(params: {
  actionRunId?: string;
  sessionKey?: string;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number | null;
  replyToId?: string | null;
  payloads: ReturnType<typeof normalizeOutboundPayloadsForJson>;
}): string | undefined {
  const actionRunId = params.actionRunId?.trim();
  const channel = params.channel?.trim();
  const to = params.to?.trim();
  if (!actionRunId || !channel || !to) {
    return undefined;
  }
  const fingerprint = crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        sessionKey: params.sessionKey ?? null,
        channel,
        to,
        accountId: params.accountId ?? null,
        threadId: params.threadId ?? null,
        replyToId: params.replyToId ?? null,
        payloads: params.payloads,
      }),
    )
    .digest("hex")
    .slice(0, 20);
  return `messaging:${actionRunId}:${fingerprint}`;
}

export async function deliverAgentCommandResult(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  runtime: RuntimeEnv;
  opts: AgentCommandOpts;
  outboundSession: OutboundSessionContext | undefined;
  sessionEntry: SessionEntry | undefined;
  result: RunResult;
  payloads: RunResult["payloads"];
}) {
  const { cfg, deps, runtime, opts, outboundSession, sessionEntry, payloads, result } = params;
  const actionRunId = resolveDeliveryActionRunId(opts, result);
  const effectiveSessionKey = outboundSession?.key ?? opts.sessionKey;
  const deliver = opts.deliver === true;
  const bestEffortDeliver = opts.bestEffortDeliver === true;
  const turnSourceChannel = opts.runContext?.messageChannel ?? opts.messageChannel;
  const turnSourceTo = opts.runContext?.currentChannelId ?? opts.to;
  const turnSourceAccountId = opts.runContext?.accountId ?? opts.accountId;
  const turnSourceThreadId = opts.runContext?.currentThreadTs ?? opts.threadId;
  const deliveryPlan = resolveAgentDeliveryPlan({
    sessionEntry,
    requestedChannel: opts.replyChannel ?? opts.channel,
    explicitTo: opts.replyTo ?? opts.to,
    explicitThreadId: opts.threadId,
    accountId: opts.replyAccountId ?? opts.accountId,
    wantsDelivery: deliver,
    turnSourceChannel,
    turnSourceTo,
    turnSourceAccountId,
    turnSourceThreadId,
  });
  let deliveryChannel = deliveryPlan.resolvedChannel;
  const explicitChannelHint = (opts.replyChannel ?? opts.channel)?.trim();
  if (deliver && isInternalMessageChannel(deliveryChannel) && !explicitChannelHint) {
    try {
      const selection = await resolveMessageChannelSelection({ cfg });
      deliveryChannel = selection.channel;
    } catch {
      // Keep the internal channel marker; error handling below reports the failure.
    }
  }
  const effectiveDeliveryPlan =
    deliveryChannel === deliveryPlan.resolvedChannel
      ? deliveryPlan
      : {
          ...deliveryPlan,
          resolvedChannel: deliveryChannel,
        };
  // Channel docking: delivery channels are resolved via plugin registry.
  const deliveryPlugin = !isInternalMessageChannel(deliveryChannel)
    ? resolveOutboundChannelPlugin({
        channel: normalizeChannelId(deliveryChannel) ?? deliveryChannel,
        cfg,
      })
    : undefined;

  const isDeliveryChannelKnown =
    isInternalMessageChannel(deliveryChannel) || Boolean(deliveryPlugin);

  const targetMode =
    opts.deliveryTargetMode ??
    effectiveDeliveryPlan.deliveryTargetMode ??
    (opts.to ? "explicit" : "implicit");
  const resolvedAccountId = effectiveDeliveryPlan.resolvedAccountId;
  const resolved =
    deliver && isDeliveryChannelKnown && deliveryChannel
      ? resolveAgentOutboundTarget({
          cfg,
          plan: effectiveDeliveryPlan,
          targetMode,
          validateExplicitTarget: true,
        })
      : {
          resolvedTarget: null,
          resolvedTo: effectiveDeliveryPlan.resolvedTo,
          targetMode,
        };
  const resolvedTarget = resolved.resolvedTarget;
  const deliveryTarget = resolved.resolvedTo;
  const resolvedThreadId = deliveryPlan.resolvedThreadId ?? opts.threadId;
  const resolvedReplyToId =
    deliveryChannel === "slack" && resolvedThreadId != null ? String(resolvedThreadId) : undefined;
  const resolvedThreadTarget = deliveryChannel === "slack" ? undefined : resolvedThreadId;

  const logDeliveryError = (err: unknown) => {
    const message = `Delivery failed (${deliveryChannel}${deliveryTarget ? ` to ${deliveryTarget}` : ""}): ${String(err)}`;
    runtime.error?.(message);
    if (!runtime.error) {
      runtime.log(message);
    }
  };

  if (deliver) {
    if (isInternalMessageChannel(deliveryChannel)) {
      const err = new Error(
        "delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel",
      );
      if (!bestEffortDeliver) {
        throw err;
      }
      logDeliveryError(err);
    } else if (!isDeliveryChannelKnown) {
      const err = new Error(`Unknown channel: ${deliveryChannel}`);
      if (!bestEffortDeliver) {
        throw err;
      }
      logDeliveryError(err);
    } else if (resolvedTarget && !resolvedTarget.ok) {
      if (!bestEffortDeliver) {
        throw resolvedTarget.error;
      }
      logDeliveryError(resolvedTarget.error);
    }
  }

  const replyPayloads = payloads ?? [];
  const normalizedPayloads = normalizeOutboundPayloadsForJson(replyPayloads);
  const deterministicActionId = createDeterministicDeliveryActionId({
    actionRunId,
    sessionKey: effectiveSessionKey,
    channel: deliveryChannel,
    to: deliveryTarget ?? undefined,
    accountId: resolvedAccountId,
    threadId: resolvedThreadTarget ?? null,
    replyToId: resolvedReplyToId ?? null,
    payloads: normalizedPayloads,
  });
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        buildOutboundResultEnvelope({
          payloads: normalizedPayloads,
          meta: result.meta,
        }),
        null,
        2,
      ),
    );
    if (!deliver) {
      return { payloads: normalizedPayloads, meta: result.meta };
    }
  }

  if (replyPayloads.length === 0) {
    runtime.log("No reply from agent.");
    return { payloads: [], meta: result.meta };
  }

  const deliveryPayloads = normalizeOutboundPayloads(replyPayloads);
  const logPayload = (payload: NormalizedOutboundPayload) => {
    if (opts.json) {
      return;
    }
    const output = formatOutboundPayloadLog(payload);
    if (!output) {
      return;
    }
    if (opts.lane === AGENT_LANE_NESTED) {
      logNestedOutput(runtime, opts, output, effectiveSessionKey);
      return;
    }
    runtime.log(output);
  };
  if (!deliver) {
    for (const payload of deliveryPayloads) {
      logPayload(payload);
    }
  }
  if (deliver && deliveryChannel && !isInternalMessageChannel(deliveryChannel)) {
    if (deliveryTarget) {
      await deliverOutboundPayloads({
        ...(deterministicActionId ? { actionId: deterministicActionId } : {}),
        ...(actionRunId ? { actionRunId } : {}),
        cfg,
        channel: deliveryChannel,
        to: deliveryTarget,
        accountId: resolvedAccountId,
        payloads: deliveryPayloads,
        session: outboundSession,
        replyToId: resolvedReplyToId ?? null,
        threadId: resolvedThreadTarget ?? null,
        bestEffort: bestEffortDeliver,
        onError: (err) => logDeliveryError(err),
        onPayload: logPayload,
        deps: createOutboundSendDeps(deps),
      });
      return {
        payloads: normalizedPayloads,
        meta: mergePostDeliveryRuntimeMeta({
          result,
          replyPayloads,
        }),
      };
    }
  }

  return { payloads: normalizedPayloads, meta: result.meta };
}
