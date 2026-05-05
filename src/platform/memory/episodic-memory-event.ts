import { z } from "zod";

import { asIdentityId, isIdentityId, type IdentityId } from "../identity/identity-id.js";

/**
 * Effect-family discriminator for episodic memory events.
 *
 * Slice E (this slice) ships only `persistent_session.created` as a
 * payload-bearing event. The other three variants — `subagent.created`,
 * `reminder.set`, `artifact.created` — are typed but inert: their
 * payload shapes are defined here so consumers (slices F / G / J / K)
 * can wire them by adding emit sites WITHOUT modifying this discriminated
 * union. Until those slices land, no production code path emits them.
 *
 * Adding a new variant later is a discriminated-union extension, NOT a
 * breaking change for existing consumers; the exhaustiveness compile
 * check (`memory-store.contract.test.ts`) guarantees `recall` /
 * `storeEpisodic` callers cover every case.
 */
export type EpisodicEffectFamily =
  | "persistent_session"
  | "subagent"
  | "reminder"
  | "artifact";

/**
 * `persistent_session.created` — emitted when a commitment-runtime turn
 * settles successfully and a conversation message has been persisted to
 * the operator's session log. This is the only payload-emitting variant
 * in slice E; B1 ("memory across `/new`") is closed by recall over
 * these entries.
 *
 * Fields:
 * - `messageRole` — "user" | "assistant"; the originator of the message
 *   that was persisted. Operator-side, "user" is the operator and
 *   "assistant" is the agent reply that satisfied the commitment.
 * - `messageText` — the persisted text. NOTE: this is NOT raw user
 *   input on the way in (per invariants #5, #6); the writer is the
 *   commitment-runtime hook (slice E Phase 5) which only fires AFTER
 *   the contractor has classified the turn and the runtime has
 *   attested `commitmentSatisfied === true`. The text is then a
 *   downstream artefact, not a raw-text-read.
 * - `messageId` — opaque session-side message id (the persistent
 *   session log already assigns these); used for de-duplication when
 *   the same turn replays.
 * - `occurredAt` — ISO-8601 timestamp, captured at write time.
 */
export type PersistentSessionCreatedPayload = {
  readonly messageRole: "user" | "assistant";
  readonly messageText: string;
  readonly messageId: string;
  readonly occurredAt: string;
};

/**
 * `subagent.created` — STUB (slice G consumer). Reserved fields only;
 * slice G defines the canonical shape when it wires the emit site. The
 * shape here is a "minimum viable record" so the discriminated union
 * compiles and store impls can round-trip a marker entry; slice G may
 * extend the payload (additive — no breaking change) by adding optional
 * fields.
 */
export type SubagentCreatedPayload = {
  readonly subagentId: string;
  readonly displayName: string;
  readonly occurredAt: string;
};

/**
 * `reminder.set` — STUB (slice F / J consumer). Same rationale as
 * `subagent.created`.
 */
export type ReminderSetPayload = {
  readonly reminderId: string;
  readonly fireAt: string;
  readonly occurredAt: string;
};

/**
 * `artifact.created` — STUB (slice K consumer). Same rationale as
 * `subagent.created`.
 */
export type ArtifactCreatedPayload = {
  readonly artifactId: string;
  readonly kind: string;
  readonly occurredAt: string;
};

/**
 * Episodic memory event — the input shape for `MemoryStore.storeEpisodic`.
 *
 * Discriminated by `effectFamily`. The store is responsible for:
 * - assigning a `MemoryEntryId` (the input does NOT carry one — that is
 *   a write-time concern, not a caller concern);
 * - associating the event with the operator's `IdentityId`;
 * - persisting `payload` opaquely (JSON-serialised in the sqlite-vec
 *   impl, in-memory in the test impl).
 *
 * Per invariant #5/#6, the payload is structured at write time — the
 * store NEVER receives a `RawUserTurn` / `UserPrompt` and never does
 * regex/text-rule matching against operator text on the way in.
 */
export type EpisodicMemoryEvent =
  | {
      readonly identityId: IdentityId;
      readonly effectFamily: "persistent_session";
      readonly effectId: string;
      readonly payload: PersistentSessionCreatedPayload;
    }
  | {
      readonly identityId: IdentityId;
      readonly effectFamily: "subagent";
      readonly effectId: string;
      readonly payload: SubagentCreatedPayload;
    }
  | {
      readonly identityId: IdentityId;
      readonly effectFamily: "reminder";
      readonly effectId: string;
      readonly payload: ReminderSetPayload;
    }
  | {
      readonly identityId: IdentityId;
      readonly effectFamily: "artifact";
      readonly effectId: string;
      readonly payload: ArtifactCreatedPayload;
    };

const ISO8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

const IsoTimestampSchema = z
  .string()
  .min(1)
  .regex(ISO8601_PATTERN, {
    message: "occurredAt must be a valid ISO-8601 timestamp",
  });

const NonEmptyString = z.string().min(1);

/**
 * Zod schema for an `IdentityId`. Validates the format via the
 * upstream `isIdentityId` guard, then re-brands via `asIdentityId`.
 * Surfaces a clear rejection at decode time rather than letting a
 * malformed string slip in as a branded value.
 */
const IdentityIdSchema = z
  .string()
  .refine(isIdentityId, {
    message: "expected an IdentityId of the form `identity:<slug>`",
  })
  .transform((value) => asIdentityId(value));

export const PersistentSessionCreatedPayloadSchema = z.object({
  messageRole: z.enum(["user", "assistant"]),
  messageText: NonEmptyString,
  messageId: NonEmptyString,
  occurredAt: IsoTimestampSchema,
});

export const SubagentCreatedPayloadSchema = z.object({
  subagentId: NonEmptyString,
  displayName: NonEmptyString,
  occurredAt: IsoTimestampSchema,
});

export const ReminderSetPayloadSchema = z.object({
  reminderId: NonEmptyString,
  fireAt: IsoTimestampSchema,
  occurredAt: IsoTimestampSchema,
});

export const ArtifactCreatedPayloadSchema = z.object({
  artifactId: NonEmptyString,
  kind: NonEmptyString,
  occurredAt: IsoTimestampSchema,
});

/**
 * Zod schema for an `EpisodicMemoryEvent`. Discriminated on
 * `effectFamily`. Use at decode boundaries (e.g. when a persistent
 * store row is read back from JSON) to assert the payload matches its
 * effect-family slot at runtime, not just at compile time.
 *
 * The explicit `z.ZodType<EpisodicMemoryEvent>` annotation prevents
 * TS4023 — without it the emitted `.d.ts` would try to inline the
 * private `IdentityIdBrand` symbol from `identity-id.ts`, which is
 * not exported.
 */
export const EpisodicMemoryEventSchema: z.ZodType<EpisodicMemoryEvent> =
  z.discriminatedUnion("effectFamily", [
    z.object({
      identityId: IdentityIdSchema,
      effectFamily: z.literal("persistent_session"),
      effectId: NonEmptyString,
      payload: PersistentSessionCreatedPayloadSchema,
    }),
    z.object({
      identityId: IdentityIdSchema,
      effectFamily: z.literal("subagent"),
      effectId: NonEmptyString,
      payload: SubagentCreatedPayloadSchema,
    }),
    z.object({
      identityId: IdentityIdSchema,
      effectFamily: z.literal("reminder"),
      effectId: NonEmptyString,
      payload: ReminderSetPayloadSchema,
    }),
    z.object({
      identityId: IdentityIdSchema,
      effectFamily: z.literal("artifact"),
      effectId: NonEmptyString,
      payload: ArtifactCreatedPayloadSchema,
    }),
  ]);

/**
 * Internal-use exhaustiveness helper. Pass a value of `never` here to
 * force a TypeScript error if a switch over `EpisodicMemoryEvent` (or
 * over `EpisodicEffectFamily`) ever misses a case. The
 * `memory-store.contract.test.ts` file uses this to enforce that
 * adding a new variant breaks the build of every consumer that did
 * NOT extend their switch — the only guarantee that prevents silent
 * payload drift across slices F / G / J / K.
 */
export function assertNeverEpisodic(value: never): never {
  throw new Error(
    `assertNeverEpisodic: unhandled episodic memory event variant ${JSON.stringify(value)}`,
  );
}
