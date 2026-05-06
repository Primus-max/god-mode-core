import type { OpenClawConfig } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import type { IdentityId } from "../identity/identity-id.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { EffectId } from "./ids.js";
import {
  ROLE_POLICY_REASONS,
  type RoleId,
  type RolePolicyDecision,
  type RolePolicyEvaluateInput,
  type RolePolicyReader,
  type RolePolicyReason,
} from "./policy-gate-stages.js";

/**
 * Phase 5 — Stage 4 (Role-based access) implementation of the
 * `RolePolicyReader` interface scaffolded in Phase 2
 * (`policy-gate-stages.ts`).
 *
 * Architectural notes:
 *
 *  1. **Orthogonal pattern preserved.** Reader consumes the frozen
 *     `ROLE_POLICY_REASONS = ['role_denied']` tuple. The legacy
 *     `POLICY_GATE_REASONS` (`policy-gate.ts`) stays BYTE-IDENTICAL —
 *     see `policy-gate-stages.ts` block comment §1-§2.
 *  2. **Anonymous identity is fail-closed.** When `identityId` is
 *     undefined, the reader returns
 *     `{allowed: false, reason: 'role_denied', requiredRole: <default>}`.
 *     The default-deny `requiredRole` is the first configured role-key
 *     in `policy.roles`, or the literal sentinel `'role:none'` when no
 *     role config is supplied. Fail-closed is the safety contract per
 *     sub-plan §10 invariant #5/#7 — a role gate that defaulted to allow
 *     would silently bypass every Stage 4 rule.
 *  3. **Role resolution chain.** The reader calls the injected
 *     `roleResolver({identityId})` exactly once per evaluation. The
 *     resolver returns `Promise<readonly RoleId[]>` (most production
 *     wirings read the role list from the `IdentityRecord.roles?` slot
 *     extended in Phase 5 — see `zod-schema.identities.ts`). When ANY
 *     of the identity's roles permits the effect (per
 *     `policy.roles[<role>].allowedEffects` config matrix) → `allowed:
 *     true` with that role surfaced for telemetry. When NO role permits
 *     → `allowed: false` with `requiredRole` populated.
 *  4. **Wildcard support.** A `policy.roles[<role>].allowedEffects`
 *     entry containing the literal string `"*"` permits ANY effect for
 *     identities holding that role (admin shorthand). The wildcard is
 *     scoped per-role; an `'admin'` role with `allowedEffects: ['*']`
 *     does NOT auto-allow effects for non-admin identities.
 *  5. **`requiredRole` resolution on denial.** When a denial fires the
 *     `requiredRole` is the FIRST role in `policy.roles` whose
 *     `allowedEffects` would have permitted the effect (so escalation
 *     can route the denial to whoever holds that role). When no role
 *     would have permitted the effect (effect is universally locked
 *     down or no `policy.roles` entries exist), `requiredRole` falls
 *     back to the first configured role-key, or `'role:none'` as the
 *     terminal sentinel.
 *  6. **Episodic event emission.** On `allowed=false` the reader
 *     emits a `policy_role` episodic event into the injected
 *     `MemoryStore` (when present). The store-write failure is
 *     contained — observability MUST NOT gate the calling commitment
 *     turn (invariant #15). Anonymous turns drop the event silently
 *     (the `EpisodicMemoryEvent.identityId` field is required).
 *  7. **Log-line evidence (sub-plan §3 row Phase 5).** Two lines are
 *     emitted via `defaultRuntime.log`:
 *       - `[policy-gate] event=role_checked stage=4 identity=<id>
 *          role=<r> allowed=<bool>`  on every evaluation
 *       - `[policy-gate] event=role_denied required=<r>`  on every
 *         denial
 *     These are observable in `C:\\tmp\\openclaw\\openclaw-<date>.log`
 *     during live-verify (sub-plan §3, Phase 10 acceptance).
 *  8. **`resolveEffectFamily` parity with budget gate.** Currently
 *     unused — Stage 4 matches against `effectId` only. Future
 *     extension (config rule keyed on effect family rather than
 *     individual effect ids) would land additively without breaking
 *     the v1 surface.
 */

/**
 * Config-driven entry describing one role's allowed-effects allowlist.
 * Each role in `policy.roles` carries a (possibly wildcarded) list of
 * effects identities holding that role may invoke.
 *
 * Field semantics:
 *  - `allowedEffects` — closed list of effect ids this role permits.
 *    The literal string `"*"` is a wildcard meaning "any effect for
 *    this role" (admin shorthand). The wildcard scope is per-role,
 *    NOT global.
 *  - `description` — operator-facing label. Observability-only — not
 *    consumed by the reader. Surfaced in admin tooling / config docs.
 *
 * Note: this entry is config-shaped — it lives on
 * `OpenClawConfig.policy.roles` (a `Record<roleKey, entry>`) and is
 * NOT the runtime branded `RoleId` itself; the role-key is the map
 * key, validated via the `roleResolver` against the identity's
 * `IdentityRecord.roles?` list at evaluation time.
 */
export type RolePolicyConfigEntry = {
  readonly allowedEffects: readonly EffectId[];
  readonly description?: string;
};

/**
 * Identity → role resolution hook. Production wiring binds this to a
 * lookup against `IdentityRecord.roles?` (the additive Phase 5 slot on
 * `zod-schema.identities.ts`). Tests inject a deterministic resolver
 * — the policy reader never reaches into a registry singleton itself,
 * keeping the commitment layer free of identity-store coupling.
 *
 * Returns an empty array for identities without roles (anonymous
 * fallback for the role-list dimension; the gate fail-closes on the
 * resulting empty list).
 */
export type RoleResolver = (params: {
  readonly identityId: IdentityId;
}) => Promise<readonly RoleId[]> | readonly RoleId[];

/**
 * Subset of `OpenClawConfig` the role policy reads. Defined locally so
 * callers do not need to plumb the full config when the rest of it is
 * irrelevant (especially in tests).
 */
type RolePolicyConfigShape = {
  readonly policy?: {
    readonly roles?: Readonly<Record<string, RolePolicyConfigEntry>>;
  };
};

export type CreateRolePolicyOptions = {
  readonly cfg: OpenClawConfig;
  readonly roleResolver: RoleResolver;
  readonly memoryStore?: MemoryStore;
};

/**
 * Sentinel `requiredRole` returned when no `policy.roles` entries
 * exist AND the caller is anonymous. Formatted as a brand-compatible
 * string (matches the `RoleId` brand at runtime); operators see this
 * in escalation telemetry as "no role configured to permit this
 * effect".
 */
const ROLE_NONE_SENTINEL = "role:none" as RoleId;

/**
 * Wildcard literal recognised in `policy.roles[<role>].allowedEffects`.
 * A single `"*"` entry (sole or among other ids) permits any effect
 * for identities holding the role. Mixed entries are tolerated — a
 * role with `['effect.A', '*']` is functionally equivalent to one
 * with `['*']`.
 */
const WILDCARD_EFFECT = "*";

/**
 * Creates the Stage 4 (Role-based access) policy reader.
 *
 * The returned reader is async — `roleResolver` may consult an async
 * identity store. The `evaluate(...)` signature matches the Phase 2
 * interface so a future remote-role-server impl can `await` without
 * breaking callers.
 *
 * @param options - Config + role resolver + optional memory store.
 * @returns Frozen `RolePolicyReader`.
 */
export function createRolePolicy(options: CreateRolePolicyOptions): RolePolicyReader {
  const cfg = options.cfg as RolePolicyConfigShape;
  const rolesConfig = cfg.policy?.roles ?? {};
  const resolver = options.roleResolver;
  const memoryStore = options.memoryStore;

  // Pre-compute the role-key list once (declaration order preserved
  // via `Object.keys` on the config object). This is the order
  // consulted when resolving `requiredRole` on denial: first
  // permitting role wins; otherwise first configured role; otherwise
  // the sentinel.
  const configuredRoleKeys: readonly string[] = Object.keys(rolesConfig);

  const reader: RolePolicyReader = {
    async evaluate(params: RolePolicyEvaluateInput): Promise<RolePolicyDecision> {
      // Path 1: anonymous identity (the Phase 2 interface marks
      // `identityId` as required, but the wiring layer threads
      // `params.identityId` straight through from `RunTurnDecisionInput`
      // where it is optional — fail-closed defends against the
      // structural-undefined leak).
      const identityId = params.identityId as IdentityId | undefined;
      if (identityId === undefined) {
        const requiredRole = anonymousFallbackRole(configuredRoleKeys);
        emitChecked({
          identityId: undefined,
          role: undefined,
          allowed: false,
        });
        emitDenied(requiredRole);
        return {
          allowed: false,
          reason: ROLE_POLICY_REASONS[0],
          requiredRole,
        };
      }

      // Path 2: resolve the identity's roles. The resolver is consulted
      // EXACTLY ONCE per evaluation (efficiency check is part of the
      // Phase 5 acceptance — see `role-policy.test.ts`).
      const resolvedRoles = await resolver({ identityId });

      // Path 3: walk the identity's roles in order; first permitting
      // role wins. A role missing from `policy.roles` config silently
      // fails-closed (it grants no effects — its absence is a
      // structural denial, not an error).
      for (const role of resolvedRoles) {
        const entry = rolesConfig[String(role)];
        if (!entry) {
          continue;
        }
        if (rolePermits(entry, params.effectId)) {
          emitChecked({
            identityId,
            role,
            allowed: true,
          });
          return { allowed: true, role };
        }
      }

      // Path 4: denial. Determine `requiredRole` — the FIRST role in
      // `policy.roles` whose `allowedEffects` would have permitted the
      // effect (so escalation can route the denial to whoever holds
      // that role). Falls back to the first configured role-key, then
      // the terminal sentinel.
      const requiredRole = resolveRequiredRole({
        rolesConfig,
        configuredRoleKeys,
        effectId: params.effectId,
      });
      emitChecked({
        identityId,
        role: undefined,
        allowed: false,
      });
      emitDenied(requiredRole);

      // Episodic event emission — failure is contained per invariant #15.
      if (memoryStore) {
        // Memory write is observability-only. A reject is logged and
        // swallowed: the calling commitment turn proceeds with the
        // denial decision regardless of memory-layer health.
        void memoryStore
          .storeEpisodic({
            identityId,
            effectFamily: "policy_role",
            effectId: String(params.effectId),
            payload: {
              identityId,
              effectId: params.effectId,
              reason: ROLE_POLICY_REASONS[0],
              requiredRole,
            },
          })
          .catch((error: unknown) => {
            defaultRuntime.log(
              `[policy-gate] event=role_episodic_write_failed ` +
                `error=${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
      return {
        allowed: false,
        reason: ROLE_POLICY_REASONS[0],
        requiredRole,
      };
    },
  };
  return Object.freeze(reader);
}

/**
 * Predicate: does this role config entry permit the given effect?
 * Returns true when (a) the wildcard literal is in `allowedEffects`,
 * OR (b) the literal `effectId` is in `allowedEffects`.
 */
function rolePermits(entry: RolePolicyConfigEntry, effectId: EffectId): boolean {
  for (const allowed of entry.allowedEffects) {
    if (String(allowed) === WILDCARD_EFFECT) {
      return true;
    }
    if (allowed === effectId) {
      return true;
    }
  }
  return false;
}

/**
 * Anonymous-identity fallback: returns the first configured role-key
 * as `RoleId` (the role admins would need to grant the anonymous
 * caller before retry), falling back to the terminal
 * `ROLE_NONE_SENTINEL` when no roles are configured.
 */
function anonymousFallbackRole(configuredRoleKeys: readonly string[]): RoleId {
  if (configuredRoleKeys.length > 0) {
    return configuredRoleKeys[0]! as RoleId;
  }
  return ROLE_NONE_SENTINEL;
}

/**
 * Resolves `requiredRole` for a denied non-anonymous turn. Walks the
 * configured roles in declaration order; the first whose
 * `allowedEffects` would have permitted the effect is the
 * `requiredRole` for escalation. Falls back to the first configured
 * role-key, then the terminal sentinel — defensive bookkeeping so
 * downstream telemetry never sees an empty `requiredRole` slot.
 */
function resolveRequiredRole(params: {
  readonly rolesConfig: Readonly<Record<string, RolePolicyConfigEntry>>;
  readonly configuredRoleKeys: readonly string[];
  readonly effectId: EffectId;
}): RoleId {
  for (const key of params.configuredRoleKeys) {
    const entry = params.rolesConfig[key]!;
    if (rolePermits(entry, params.effectId)) {
      return key as RoleId;
    }
  }
  if (params.configuredRoleKeys.length > 0) {
    return params.configuredRoleKeys[0]! as RoleId;
  }
  return ROLE_NONE_SENTINEL;
}

function emitChecked(params: {
  readonly identityId: IdentityId | undefined;
  readonly role: RoleId | undefined;
  readonly allowed: boolean;
}): void {
  const parts = [
    "[policy-gate] event=role_checked stage=4",
    `identity=${params.identityId !== undefined ? String(params.identityId) : "anonymous"}`,
    `role=${params.role !== undefined ? String(params.role) : "none"}`,
    `allowed=${String(params.allowed)}`,
  ];
  defaultRuntime.log(parts.join(" "));
}

function emitDenied(requiredRole: RoleId): void {
  defaultRuntime.log(`[policy-gate] event=role_denied required=${String(requiredRole)}`);
}

// `RolePolicyReason` is consumed implicitly via the union type and
// the typed return shape; the `import type` above keeps the closed-set
// brand discipline at the impl boundary (a misspelled literal fails
// to compile against `RolePolicyReason`). No runtime emission needed.
