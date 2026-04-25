/**
 * Default core implementation of the subagent thread-binding hooks.
 *
 * Channel plugins (Discord, Feishu, Matrix, ...) historically owned both
 * `subagent_spawning` and `subagent_delivery_target` hooks because each one
 * needed its own thread/session provisioning. Channels that do not need any
 * channel-specific provisioning (Telegram, Webchat, Control UI, ...) ended up
 * with no handler at all, which made `sessions_spawn` with `thread=true` fail
 * with "no channel plugin registered subagent_spawning hooks" even though the
 * gateway is perfectly capable of routing follow-ups back to the original
 * conversation/thread on its own.
 *
 * This module provides a generic fallback that:
 *
 *   1. Accepts any thread-bound spawn and records the requester's
 *      `{ channel, accountId, to, threadId }` keyed by `childSessionKey`.
 *   2. Replies to subagent_delivery_target lookups with the recorded origin so
 *      the parent receives child output on the same thread it spawned from.
 *   3. Cleans up the in-memory map when `subagent_ended` fires.
 *
 * It is registered conditionally at gateway boot only when no plugin has
 * already supplied a `subagent_spawning` and `subagent_delivery_target` pair,
 * so channel-specific plugin behaviour is never clobbered.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type {
  PluginHookSubagentContext,
  PluginHookSubagentDeliveryTargetEvent,
  PluginHookSubagentDeliveryTargetResult,
  PluginHookSubagentEndedEvent,
  PluginHookSubagentSpawningEvent,
  PluginHookSubagentSpawningResult,
} from "../plugins/types.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";

const log = createSubsystemLogger("plugins");

export const DEFAULT_SUBAGENT_HOOKS_PLUGIN_ID = "core:default-subagent-thread";
const DEFAULT_HOOK_SOURCE = "core/default-subagent-spawning-hook";

// TODO: Single-process map. A multi-process gateway (e.g. clustered or
// horizontally scaled) would need shared storage (SQLite, Redis, the session
// store, ...) so a child spawned on one process can still resolve its
// requester origin on another.
const requesterOriginByChildSessionKey = new Map<string, DeliveryContext>();

function pickRequesterOrigin(
  event: PluginHookSubagentSpawningEvent,
): DeliveryContext | undefined {
  return normalizeDeliveryContext({
    channel: event.requester?.channel,
    accountId: event.requester?.accountId,
    to: event.requester?.to,
    threadId: event.requester?.threadId,
  });
}

/**
 * Default `subagent_spawning` handler. Always succeeds — the gateway does not
 * need any channel-specific provisioning to bind a thread; it just remembers
 * where the parent was and lets the existing announce/route plumbing send
 * child output back there.
 */
export function defaultSubagentSpawningHandler(
  event: PluginHookSubagentSpawningEvent,
  _ctx: PluginHookSubagentContext,
): PluginHookSubagentSpawningResult | undefined {
  if (!event.threadRequested) {
    return undefined;
  }
  const childSessionKey = event.childSessionKey?.trim();
  if (!childSessionKey) {
    return { status: "ok", threadBindingReady: true };
  }
  const origin = pickRequesterOrigin(event);
  if (origin) {
    requesterOriginByChildSessionKey.set(childSessionKey, origin);
  }
  return { status: "ok", threadBindingReady: true };
}

/**
 * Default `subagent_delivery_target` handler. Returns the recorded requester
 * origin so the parent receives follow-ups on the same channel/thread it
 * spawned from. Returns undefined when no mapping exists, which lets the
 * caller fall back to the live `requesterOrigin` already on the event.
 */
export function defaultSubagentDeliveryTargetHandler(
  event: PluginHookSubagentDeliveryTargetEvent,
  _ctx: PluginHookSubagentContext,
): PluginHookSubagentDeliveryTargetResult | undefined {
  const childSessionKey = event.childSessionKey?.trim();
  if (!childSessionKey) {
    return undefined;
  }
  const recorded = requesterOriginByChildSessionKey.get(childSessionKey);
  if (recorded) {
    return { origin: { ...recorded } };
  }
  // Fall back to the requesterOrigin carried on the event so callers that
  // didn't go through our spawning handler (e.g. channels with their own
  // subagent_spawning but missing delivery_target) still get something useful.
  const eventOrigin = normalizeDeliveryContext({
    channel: event.requesterOrigin?.channel,
    accountId: event.requesterOrigin?.accountId,
    to: event.requesterOrigin?.to,
    threadId: event.requesterOrigin?.threadId,
  });
  if (eventOrigin) {
    return { origin: { ...eventOrigin } };
  }
  return undefined;
}

/**
 * Default `subagent_ended` cleanup. Drops the child mapping so the in-memory
 * map cannot grow unbounded across many subagent spawns.
 */
export function defaultSubagentEndedHandler(
  event: PluginHookSubagentEndedEvent,
  _ctx: PluginHookSubagentContext,
): void {
  const targetSessionKey = event.targetSessionKey?.trim();
  if (!targetSessionKey) {
    return;
  }
  requesterOriginByChildSessionKey.delete(targetSessionKey);
}

/**
 * Test-only: clear the internal map between vitest cases so cross-test state
 * cannot leak.
 */
export function __resetDefaultSubagentSpawningStateForTests(): void {
  requesterOriginByChildSessionKey.clear();
}

/**
 * Test-only: read the recorded origin for a given child session key.
 */
export function __getRecordedRequesterOriginForTests(
  childSessionKey: string,
): DeliveryContext | undefined {
  return requesterOriginByChildSessionKey.get(childSessionKey);
}

export type RegisterDefaultSubagentHooksResult = {
  registeredSpawning: boolean;
  registeredDeliveryTarget: boolean;
  registeredEnded: boolean;
};

/**
 * Conditionally register the default subagent thread-binding handlers on the
 * given plugin registry. Must be called AFTER all plugins have loaded so
 * channel plugins that already supply `subagent_spawning` /
 * `subagent_delivery_target` win and our default does nothing for them.
 *
 * Registration is treated as a unit: either both spawning and delivery target
 * defaults are added (along with the cleanup on `subagent_ended`), or neither
 * is. This avoids the asymmetric state where our delivery handler would look
 * up entries that nothing populated.
 */
export function registerDefaultSubagentHooksIfMissing(params: {
  registry: PluginRegistry;
}): RegisterDefaultSubagentHooksResult {
  const { registry } = params;

  const hasSpawning = registry.typedHooks.some((h) => h.hookName === "subagent_spawning");
  const hasDeliveryTarget = registry.typedHooks.some(
    (h) => h.hookName === "subagent_delivery_target",
  );

  if (hasSpawning || hasDeliveryTarget) {
    log.debug(
      `[plugins] core default subagent thread fallback skipped (spawning=${hasSpawning}, delivery_target=${hasDeliveryTarget})`,
    );
    return {
      registeredSpawning: false,
      registeredDeliveryTarget: false,
      registeredEnded: false,
    };
  }

  registry.typedHooks.push({
    pluginId: DEFAULT_SUBAGENT_HOOKS_PLUGIN_ID,
    hookName: "subagent_spawning",
    handler: defaultSubagentSpawningHandler,
    priority: 0,
    source: DEFAULT_HOOK_SOURCE,
  });
  registry.typedHooks.push({
    pluginId: DEFAULT_SUBAGENT_HOOKS_PLUGIN_ID,
    hookName: "subagent_delivery_target",
    handler: defaultSubagentDeliveryTargetHandler,
    priority: 0,
    source: DEFAULT_HOOK_SOURCE,
  });
  registry.typedHooks.push({
    pluginId: DEFAULT_SUBAGENT_HOOKS_PLUGIN_ID,
    hookName: "subagent_ended",
    handler: defaultSubagentEndedHandler,
    priority: 0,
    source: DEFAULT_HOOK_SOURCE,
  });

  log.info(
    "core default subagent thread hooks registered (no plugin supplied subagent_spawning/subagent_delivery_target)",
  );

  return {
    registeredSpawning: true,
    registeredDeliveryTarget: true,
    registeredEnded: true,
  };
}
