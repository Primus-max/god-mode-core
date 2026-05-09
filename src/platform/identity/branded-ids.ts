/**
 * Branded ID types for cross-cutting identity / time concerns.
 *
 * Originally lived in `src/platform/commitment/ids.ts`. Relocated to
 * `src/platform/identity/` as part of S11a (V1-CUTOVER kernel-delete
 * preparation): the brand types have no kernel runtime semantics and
 * blocked the kernel tree from being deleted because ~22 non-kernel
 * files imported from it. Moving them out of the doomed `commitment/`
 * tree unblocks S11/S11b (`src/platform/commitment/**` delete).
 *
 * `src/platform/commitment/ids.ts` is preserved as a thin re-export
 * shim during the migration and will be removed with the rest of the
 * commitment kernel in S11b.
 *
 * No runtime code lives here — all symbols are pure compile-time
 * brands on `string`. Importing this module has zero side effects.
 */

declare const CommitmentIdBrand: unique symbol;
export type CommitmentId = string & { readonly [CommitmentIdBrand]: true };

declare const AffordanceIdBrand: unique symbol;
export type AffordanceId = string & { readonly [AffordanceIdBrand]: true };

declare const EffectFamilyIdBrand: unique symbol;
export type EffectFamilyId = string & { readonly [EffectFamilyIdBrand]: true };

declare const EffectIdBrand: unique symbol;
export type EffectId = string & { readonly [EffectIdBrand]: true };

declare const PreconditionIdBrand: unique symbol;
export type PreconditionId = string & { readonly [PreconditionIdBrand]: true };

declare const ChannelIdBrand: unique symbol;
export type ChannelId = string & { readonly [ChannelIdBrand]: true };

declare const SessionIdBrand: unique symbol;
export type SessionId = string & { readonly [SessionIdBrand]: true };

declare const AgentIdBrand: unique symbol;
export type AgentId = string & { readonly [AgentIdBrand]: true };

declare const SessionKeyBrand: unique symbol;
export type SessionKey = string & { readonly [SessionKeyBrand]: true };

declare const ISO8601Brand: unique symbol;
export type ISO8601 = string & { readonly [ISO8601Brand]: true };

export type ReadonlyRecord<K extends string, V> = { readonly [P in K]: V };
