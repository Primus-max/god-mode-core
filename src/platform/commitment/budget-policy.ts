import { defaultRuntime } from "../../runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { IdentityId } from "../identity/identity-id.js";
import type { MemoryStore } from "../memory/memory-store.js";

import type { EffectFamilyId, EffectId } from "./ids.js";
import {
  BUDGET_POLICY_REASONS,
  type BudgetPolicyDecision,
  type BudgetPolicyEvaluateInput,
  type BudgetPolicyReader,
  type BudgetPolicyReason,
  type BudgetWindowId,
} from "./policy-gate-stages.js";
import {
  buildBudgetWindowId,
  type BudgetDimension,
  type BudgetIncrementInput,
  type BudgetReadQuery,
  type BudgetStore,
  type BudgetWindow,
} from "./budget-store.js";

/**
 * Phase 4 — Stage 3 (Budgets) implementation of the
 * `BudgetPolicyReader` interface scaffolded in Phase 2
 * (`policy-gate-stages.ts`).
 *
 * Architectural notes:
 *
 *  1. **Orthogonal pattern preserved.** Reader consumes the frozen
 *     `BUDGET_POLICY_REASONS = ['budget_exceeded_user',
 *     'budget_exceeded_channel', 'budget_exceeded_effect']` tuple.
 *     `POLICY_GATE_REASONS` (`policy-gate.ts`) stays
 *     BYTE-IDENTICAL across Phases 2-4 (audit §b).
 *  2. **Three orthogonal sub-reasons.** Phase 1 audit fixed the
 *     dimension as part of the reason enum (not a payload field) so
 *     observability log lines (`event=budget_exceeded
 *     dimension=…`) and escalation routing per dimension are closed-set
 *     decisions, not payload reads.
 *  3. **Anonymous identity is fail-closed for `dimension: 'user'`.**
 *     When `identityId` is undefined and a `'user'` rule applies, the
 *     reader denies (`reason='budget_exceeded_user'`). A `'channel'`
 *     rule still evaluates (channel-level budgets are agnostic to
 *     operator). A `'effect'` rule applies unconditionally. Mirrors
 *     Phase 3 approval-policy discipline.
 *  4. **Sibling reuse for storage.** This module never opens the
 *     SQLite file itself; production wiring binds the
 *     `BudgetStore` interface to `SqliteBudgetStore.open(...)` at
 *     construction time. Tests inject an in-memory fake.
 *  5. **Episodic event emission.** On `within=false` the reader
 *     emits a `policy_budget` episodic event into the injected
 *     `MemoryStore` (when present). The store-write failure is
 *     contained — observability MUST NOT gate the calling commitment
 *     turn (invariant #15). Anonymous turns drop the event silently
 *     (the `EpisodicMemoryEvent.identityId` field is required).
 *  6. **Log-line evidence (sub-plan §3 row Phase 4).** Two lines
 *     emitted via `defaultRuntime.log`:
 *       - `[policy-gate] event=budget_checked stage=3
 *          dimension=<user|channel|effect> within=<bool>
 *          used=<n>/<limit>` on every evaluation that matches a rule.
 *       - `[policy-gate] event=budget_exceeded
 *          window_id=<id> reset_at=<ts>` on every denial.
 *     These are observable in `C:\\tmp\\openclaw\\openclaw-<date>.log`
 *     during live-verify (sub-plan §3, Phase 10 acceptance).
 *  7. **Match-priority discipline.** When multiple
 *     `policy.budgets[]` entries match the same dimension, the
 *     reader evaluates them in order. The first denial short-circuits
 *     — it carries the `windowId` and the matching rule's
 *     `(used, limit)`. Within-limit charges still bump the counter on
 *     EVERY matching rule (so a request that satisfies the
 *     per-channel rule still consumes the per-user budget).
 *  8. **Per-effectFamily filter on `'user'` and `'channel'`
 *     entries.** A `policy.budgets[]` entry MAY carry `effectFamily`
 *     — when present, the rule applies only when the request
 *     `effectFamily` matches. This is the orthogonal matrix the
 *     audit calls out: a rule "Vladimir gets 5 web_research per day"
 *     is `dimension='user', identityId=Vlad, effectFamily='web_research'`,
 *     distinct from "any user gets 100 effects per day"
 *     (`dimension='user', identityId=undefined`, but that shape is
 *     not supported in v1 — `identityId` is required for `dimension='user'`
 *     rules per Zod schema).
 */

/**
 * Config-driven budget rule. Each entry pins a budget on one of the
 * three orthogonal dimensions with its own window duration and
 * limit. Backward-compat: configs without `policy.budgets` get an
 * empty array (default-allow).
 */
export type BudgetPolicyConfigEntry = {
  readonly dimension: BudgetDimension;
  readonly limit: number;
  readonly windowMs: number;
  readonly identityId?: IdentityId;
  readonly channel?: string;
  readonly effectFamily?: EffectFamilyId;
};

/**
 * Subset of `OpenClawConfig` the budget policy reads. Defined
 * locally so callers do not need to plumb the full config (especially
 * in tests).
 */
type BudgetPolicyConfigShape = {
  readonly policy?: {
    readonly budgets?: readonly BudgetPolicyConfigEntry[];
  };
};

export type CreateBudgetPolicyOptions = {
  readonly cfg: OpenClawConfig;
  readonly budgetStore: BudgetStore;
  readonly memoryStore?: MemoryStore;
  /**
   * Optional `effectFamily` resolver. Production wiring threads this
   * via the `EFFECT_FAMILY_REGISTRY` so a request carrying just an
   * `EffectId` can be matched against rules keyed on
   * `effectFamily`. When absent, only `effectId`-keyed rules
   * resolve; `effectFamily`-keyed rules silently skip the request.
   * Tests pass an explicit resolver for determinism.
   */
  readonly resolveEffectFamily?: (effectId: EffectId) => EffectFamilyId | undefined;
};

/**
 * Creates the Stage 3 (Budgets) policy reader.
 *
 * The returned reader is async — `BudgetStore.read` /
 * `BudgetStore.increment` are async by interface (slice E P3 sibling
 * pattern). The returned `Promise<BudgetPolicyDecision>` resolves
 * after every applicable rule has been consulted.
 *
 * @param options - Config + budget store + optional memory store +
 *   optional effect-family resolver.
 * @returns Frozen `BudgetPolicyReader`.
 */
export function createBudgetPolicy(options: CreateBudgetPolicyOptions): BudgetPolicyReader {
  const cfg = options.cfg as BudgetPolicyConfigShape;
  const entries = cfg.policy?.budgets ?? [];
  const store = options.budgetStore;
  const memoryStore = options.memoryStore;
  const resolveEffectFamily = options.resolveEffectFamily;

  // Pre-bucket entries by dimension so the evaluation loop touches
  // only the slice it needs. Order within a bucket preserves the
  // declaration order — first-match-denies semantics.
  const userEntries: BudgetPolicyConfigEntry[] = [];
  const channelEntries: BudgetPolicyConfigEntry[] = [];
  const effectEntries: BudgetPolicyConfigEntry[] = [];
  for (const entry of entries) {
    if (entry.dimension === "user") {
      userEntries.push(entry);
    } else if (entry.dimension === "channel") {
      channelEntries.push(entry);
    } else if (entry.dimension === "effect") {
      effectEntries.push(entry);
    }
  }

  const reader: BudgetPolicyReader = {
    async evaluate(params: BudgetPolicyEvaluateInput): Promise<BudgetPolicyDecision> {
      const requestFamily = resolveEffectFamily?.(params.effectId);

      // Walk dimensions in the audit-fixed order: user → channel →
      // effect. The first denial short-circuits; within-limit
      // matches charge the counter and continue. `remaining` on
      // success surfaces the tightest applicable limit so the
      // caller can render soft-warn telemetry.
      let tightestRemaining = Number.POSITIVE_INFINITY;

      // ----- user dimension --------------------------------------
      for (const entry of userEntries) {
        if (!ruleMatches(entry, params, requestFamily)) {
          continue;
        }
        if (params.identityId === undefined) {
          // Fail-closed for anonymous turns when a user-rule applies.
          const windowId = anonymousWindowId(entry, "user");
          emitChecked({
            dimension: "user",
            within: false,
            used: 0,
            limit: entry.limit,
          });
          emitExceeded(windowId, undefined);
          return {
            within: false,
            reason: "budget_exceeded_user",
            windowId,
            used: 0,
            limit: entry.limit,
          };
        }
        const result = await chargeAndCheck({
          store,
          dimension: "user",
          entry,
          identityId: params.identityId,
          channel: undefined,
          effectFamily: requestFamily,
          effectId: params.effectId,
        });
        emitChecked({
          dimension: "user",
          within: result.within,
          used: result.used,
          limit: result.limit,
        });
        if (!result.within) {
          emitExceeded(result.windowId, result.windowEnd);
          await maybeEmitEpisodic({
            memoryStore,
            identityId: params.identityId,
            effectId: params.effectId,
            reason: "budget_exceeded_user",
            windowId: result.windowId,
            used: result.used,
            limit: result.limit,
          });
          return {
            within: false,
            reason: "budget_exceeded_user",
            windowId: result.windowId,
            used: result.used,
            limit: result.limit,
          };
        }
        tightestRemaining = Math.min(tightestRemaining, result.limit - result.used);
      }

      // ----- channel dimension -----------------------------------
      for (const entry of channelEntries) {
        if (!ruleMatches(entry, params, requestFamily)) {
          continue;
        }
        const result = await chargeAndCheck({
          store,
          dimension: "channel",
          entry,
          identityId: undefined,
          channel: params.channel,
          effectFamily: requestFamily,
          effectId: params.effectId,
        });
        emitChecked({
          dimension: "channel",
          within: result.within,
          used: result.used,
          limit: result.limit,
        });
        if (!result.within) {
          emitExceeded(result.windowId, result.windowEnd);
          if (params.identityId !== undefined) {
            await maybeEmitEpisodic({
              memoryStore,
              identityId: params.identityId,
              effectId: params.effectId,
              reason: "budget_exceeded_channel",
              windowId: result.windowId,
              used: result.used,
              limit: result.limit,
            });
          }
          return {
            within: false,
            reason: "budget_exceeded_channel",
            windowId: result.windowId,
            used: result.used,
            limit: result.limit,
          };
        }
        tightestRemaining = Math.min(tightestRemaining, result.limit - result.used);
      }

      // ----- effect dimension ------------------------------------
      for (const entry of effectEntries) {
        if (!ruleMatches(entry, params, requestFamily)) {
          continue;
        }
        const result = await chargeAndCheck({
          store,
          dimension: "effect",
          entry,
          identityId: undefined,
          channel: undefined,
          effectFamily: entry.effectFamily ?? requestFamily,
          effectId: params.effectId,
        });
        emitChecked({
          dimension: "effect",
          within: result.within,
          used: result.used,
          limit: result.limit,
        });
        if (!result.within) {
          emitExceeded(result.windowId, result.windowEnd);
          if (params.identityId !== undefined) {
            await maybeEmitEpisodic({
              memoryStore,
              identityId: params.identityId,
              effectId: params.effectId,
              reason: "budget_exceeded_effect",
              windowId: result.windowId,
              used: result.used,
              limit: result.limit,
            });
          }
          return {
            within: false,
            reason: "budget_exceeded_effect",
            windowId: result.windowId,
            used: result.used,
            limit: result.limit,
          };
        }
        tightestRemaining = Math.min(tightestRemaining, result.limit - result.used);
      }

      const remaining = Number.isFinite(tightestRemaining)
        ? Math.max(0, tightestRemaining)
        : Number.POSITIVE_INFINITY;
      return { within: true, remaining };
    },
  };
  return Object.freeze(reader);
}

/**
 * Predicate: does the rule apply to this request? Each rule MAY
 * carry per-(identityId | channel | effectFamily) filters on top of
 * its dimension. A filter that is set on the rule but does NOT
 * match the request causes the rule to skip the request entirely
 * (no charge, no log line for that rule). A filter left undefined
 * matches any request value.
 */
function ruleMatches(
  entry: BudgetPolicyConfigEntry,
  params: BudgetPolicyEvaluateInput,
  requestFamily: EffectFamilyId | undefined,
): boolean {
  if (entry.dimension === "user") {
    if (entry.identityId !== undefined && entry.identityId !== params.identityId) {
      return false;
    }
  } else if (entry.dimension === "channel") {
    if (entry.channel !== undefined && entry.channel !== params.channel) {
      return false;
    }
  } else if (entry.dimension === "effect") {
    if (entry.effectFamily !== undefined && entry.effectFamily !== requestFamily) {
      return false;
    }
  }
  // Cross-dimension filter: a `'user'` rule MAY carry `effectFamily`
  // to scope the per-user budget to one effect family (e.g. "Vlad
  // gets 5 PDF/day"). A `'channel'` rule MAY carry `effectFamily`
  // similarly.
  if (
    entry.effectFamily !== undefined &&
    entry.dimension !== "effect" &&
    entry.effectFamily !== requestFamily
  ) {
    return false;
  }
  return true;
}

/**
 * Charges one increment against the rule's `(dimension, key)`
 * window and inspects whether the post-charge `used` exceeds the
 * configured `limit`. The store handles window creation and
 * lazy-reset internally. Returns a structured result that the
 * caller branches on.
 */
async function chargeAndCheck(params: {
  readonly store: BudgetStore;
  readonly dimension: BudgetDimension;
  readonly entry: BudgetPolicyConfigEntry;
  readonly identityId: IdentityId | undefined;
  readonly channel: string | undefined;
  readonly effectFamily: EffectFamilyId | undefined;
  readonly effectId: EffectId;
}): Promise<{
  within: boolean;
  used: number;
  limit: number;
  windowId: BudgetWindowId;
  windowEnd: number;
}> {
  const incInput: BudgetIncrementInput = {
    dimension: params.dimension,
    limit: params.entry.limit,
    windowMs: params.entry.windowMs,
    effectId: params.effectId,
    ...(params.identityId !== undefined ? { identityId: params.identityId } : {}),
    ...(params.channel !== undefined ? { channel: params.channel } : {}),
    ...(params.effectFamily !== undefined ? { effectFamily: params.effectFamily } : {}),
  };
  const window: BudgetWindow = await params.store.increment(incInput);
  return {
    within: window.used <= window.limit,
    used: window.used,
    limit: window.limit,
    windowId: window.windowId,
    windowEnd: window.windowEnd,
  };
}

function anonymousWindowId(
  entry: BudgetPolicyConfigEntry,
  dimension: BudgetDimension,
): BudgetWindowId {
  // Anonymous user-rule fail-closed: synthesise a stable
  // `windowStart=0` id (no charge against the store, no real
  // window). The caller observes this as `(used: 0, limit: <l>)`
  // — a maximally-restrictive denial.
  return buildBudgetWindowId({
    dimension,
    identityId: undefined,
    channel: entry.channel,
    effectFamily: entry.effectFamily,
    windowStart: 0,
  });
}

function emitChecked(params: {
  readonly dimension: BudgetDimension;
  readonly within: boolean;
  readonly used: number;
  readonly limit: number;
}): void {
  defaultRuntime.log(
    `[policy-gate] event=budget_checked stage=3 dimension=${params.dimension} ` +
      `within=${String(params.within)} used=${params.used}/${params.limit}`,
  );
}

function emitExceeded(windowId: BudgetWindowId, resetAt: number | undefined): void {
  const parts = [
    `[policy-gate] event=budget_exceeded`,
    `window_id=${String(windowId)}`,
  ];
  if (resetAt !== undefined) {
    parts.push(`reset_at=${resetAt}`);
  }
  defaultRuntime.log(parts.join(" "));
}

async function maybeEmitEpisodic(params: {
  readonly memoryStore: MemoryStore | undefined;
  readonly identityId: IdentityId;
  readonly effectId: EffectId;
  readonly reason: BudgetPolicyReason;
  readonly windowId: BudgetWindowId;
  readonly used: number;
  readonly limit: number;
}): Promise<void> {
  if (!params.memoryStore) {
    return;
  }
  // Memory write is observability-only. A reject is logged and
  // swallowed: the calling commitment turn proceeds with the
  // denial decision regardless of memory-layer health (invariant #15).
  try {
    await params.memoryStore.storeEpisodic({
      identityId: params.identityId,
      effectFamily: "policy_budget",
      effectId: String(params.effectId),
      payload: {
        windowId: params.windowId,
        identityId: params.identityId,
        effectId: params.effectId,
        reason: params.reason,
        used: params.used,
        limit: params.limit,
      },
    });
  } catch (error) {
    defaultRuntime.log(
      `[policy-gate] event=budget_episodic_write_failed ` +
        `error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Suppress unused-import warning for `BUDGET_POLICY_REASONS` —
// the reasons enum is consumed implicitly via the union type, but
// keeping the runtime import surfaces the closed-set discipline at
// the impl boundary (Phase 1 audit recommends importing the frozen
// tuple anywhere a denial reason is constructed so a misspelled
// literal fails to compile).
void BUDGET_POLICY_REASONS;

/**
 * Re-export sentinel: ensure `BudgetReadQuery` stays accessible from
 * this module for callers that thread it through factory wiring.
 * (Importing without re-exporting would still work, but TypeScript's
 * `import type` boundary lights up cleaner exports for the public
 * surface.)
 */
export type { BudgetReadQuery };
