/**
 * NEW-B Phase 4 — `subscriber:plugin-hooks`.
 *
 * Adapter that fans the existing `getGlobalHookRunner()` `session_end`
 * + `session_start` events through the unified-reset bus. Per Phase 1
 * audit §a row 9, the auto-reply path
 * (`src/auto-reply/reply/session.ts:601-630`) calls the hook surface
 * inline today; the gateway-RPC reset path does NOT — and that is one
 * of the symmetry breaks the unified bus closes once Phase 5 wires it
 * into `session.ts`.
 *
 * Phase 4 ships ONLY the adapter; the inline call at `session.ts:601-630`
 * is replaced in Phase 5 (per `commitment_kernel_unified_session_reset.plan.md`
 * todo `usr-phase-5-wire-into-new-handler`). This subscriber is
 * therefore safe to register today: when Phase 5 wires
 * `resetTurnSession()` into `session.ts`, the inline block is removed
 * AND this subscriber takes over both paths. Until then registering
 * this subscriber alongside the inline block would double-fire the
 * hooks — which is why production bootstrap (Phase 5) is the call
 * site that registers it, not Phase 4. Phase 4 tests register it
 * inside an isolated registry only.
 *
 * Boundary discipline: lives in
 * `src/auto-reply/reply/session-reset-subscribers/` per spec table
 * row 7. Does NOT touch `src/platform/commitment/`.
 */

import {
  asSessionResetSubscriberId,
  type SessionResetEvent,
  type SessionResetSubscriber,
  type SessionResetSubscriberOutcome,
} from "../../../platform/session/reset.js";
import type {
  PluginHookSessionContext,
  PluginHookSessionEndEvent,
  PluginHookSessionStartEvent,
} from "../../../plugins/types.js";

/**
 * Minimal structural shape the subscriber needs from the hook runner.
 * Defined here (rather than importing the concrete `HookRunner`
 * interface) so tests can pass a fixture without spinning up the full
 * plugin-loader pipeline.
 */
export type PluginHookFanOut = {
  hasHooks(name: "session_start" | "session_end"): boolean;
  runSessionStart(
    event: PluginHookSessionStartEvent,
    ctx: PluginHookSessionContext,
  ): Promise<void>;
  runSessionEnd(
    event: PluginHookSessionEndEvent,
    ctx: PluginHookSessionContext,
  ): Promise<void>;
};

export type PluginHooksSubscriberDeps = {
  /**
   * Resolve the active hook runner. `null` when plugins haven't been
   * loaded yet — the production binding wraps `getGlobalHookRunner()`
   * which can return `null` during the early-boot window. Wrapping it
   * in a closure keeps the subscriber decoupled from the global state
   * symbol.
   */
  readonly resolveHookRunner: () => PluginHookFanOut | null;
  /**
   * Resolve the agent id for the (sessionKey, sessionId) pair so the
   * session-end / session-start payloads carry the same `agentId` the
   * inline call at `session.ts:601-630` builds today via
   * `resolveSessionAgentId`. Optional: when omitted the subscriber
   * still fires the hooks but with `agentId` unset (some plugins may
   * choose to derive it themselves).
   */
  readonly resolveAgentId?: (params: {
    sessionId: string;
    sessionKey: string;
  }) => string | undefined;
};

const SUBSCRIBER_ID = asSessionResetSubscriberId("subscriber:plugin-hooks");

export function createPluginHooksSubscriber(
  deps: PluginHooksSubscriberDeps,
): SessionResetSubscriber {
  return {
    id: SUBSCRIBER_ID,
    category: "plugin",
    async onReset(
      event: SessionResetEvent,
    ): Promise<SessionResetSubscriberOutcome> {
      const hookRunner = deps.resolveHookRunner();
      if (hookRunner === null) {
        return {
          kind: "skipped",
          reason: "no_global_hook_runner",
        };
      }
      const agentId = deps.resolveAgentId
        ? deps.resolveAgentId({
            sessionId: event.sessionId,
            sessionKey: event.sessionKey,
          })
        : undefined;
      let firedEnd = false;
      let firedStart = false;
      try {
        // Mirror session.ts:604-614: fire session_end for the
        // pre-rotation sessionId iff one is supplied AND it differs
        // from the post-rotation sessionId.
        if (
          event.previousSessionId !== undefined &&
          event.previousSessionId !== event.sessionId &&
          hookRunner.hasHooks("session_end")
        ) {
          await hookRunner.runSessionEnd(
            {
              sessionId: event.previousSessionId,
              sessionKey: event.sessionKey,
              messageCount: 0,
            },
            {
              sessionId: event.previousSessionId,
              sessionKey: event.sessionKey,
              ...(agentId === undefined ? {} : { agentId }),
            },
          );
          firedEnd = true;
        }
        // Mirror session.ts:617-625: fire session_start for the new
        // sessionId.
        if (hookRunner.hasHooks("session_start")) {
          await hookRunner.runSessionStart(
            {
              sessionId: event.sessionId,
              sessionKey: event.sessionKey,
              ...(event.previousSessionId === undefined
                ? {}
                : { resumedFrom: event.previousSessionId }),
            },
            {
              sessionId: event.sessionId,
              sessionKey: event.sessionKey,
              ...(agentId === undefined ? {} : { agentId }),
            },
          );
          firedStart = true;
        }
      } catch (error: unknown) {
        const reason =
          error instanceof Error ? error.message : `non_error_throw:${String(error)}`;
        return { kind: "failed", reason };
      }
      if (!firedEnd && !firedStart) {
        return { kind: "skipped", reason: "no_session_hooks_registered" };
      }
      return {
        kind: "cleared",
        details: {
          firedSessionEnd: firedEnd,
          firedSessionStart: firedStart,
        },
      };
    },
  };
}
