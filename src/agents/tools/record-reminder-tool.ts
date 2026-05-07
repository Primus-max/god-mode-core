/**
 * Cron/Scheduler Phase 5 — `RecordReminderTool`.
 *
 * FIRST sanctioned reminder write surface in `god-mode-core`. Schema
 * accepts a CLOSED `ReminderSetShape` only — free-form `{when, what}`
 * fields are rejected by construction (invariants #5/#6 reverse-test;
 * sub-plan §1 todo Phase 5). `ownerIdentityId` is INJECTED from the
 * session context (slice K P4 precedent — never read from user input).
 *
 * Behavior on call:
 *  1. Validate the structured shape via `ReminderSetShapeSchema` (Zod
 *     `.strict()` — rejects extra properties; rejects free-form text).
 *  2. Reject anonymous (`ownerIdentityId` undefined / empty) BEFORE any
 *     ReminderStore / CronService.add call (sub-plan §6 acceptance —
 *     ZERO writes when identity is missing).
 *  3. Reject `fireAt` in past against the injected clock.
 *  4. Persist the record via `ReminderStore.schedule({...})`.
 *  5. Append the record into the `ScheduledReminderWorldStateCollector`
 *     via the Phase 5 `recordReminderScheduled` runtime adapter so the
 *     Phase 4 done-predicate can resolve on commitmentSatisfied.
 *  6. Register the cron callback at `fireAt` via the injected
 *     `CronService.add({schedule:{kind:'at', at:fireAt}, ...})`. v1 only
 *     uses `kind:'at'` (one-shot); recurrence is deferred (sub-plan §10).
 *  7. Return a typed result envelope. NEVER throws (invariant #15).
 *
 * Boundary discipline:
 *  - Lives in `src/agents/tools/`, NOT in `src/platform/commitment/`
 *    (invariant #8). Calls flow through the runtime adapter only — this
 *    file does NOT touch the `ScheduledReminderWorldStateCollector`
 *    directly outside the adapter.
 *  - Reads STRUCTURAL inputs only (closed `ReminderSetShape`); never
 *    reads raw operator text (#5/#6).
 *  - `CronService.add` is dependency-injected as a closed-shape function
 *    so the tool stays decoupled from the production cron surface (the
 *    integration wires `(cronService) => cronService.add.bind(...)`).
 */

import { z } from "zod";

import {
  recordReminderScheduled,
  type RecordReminderScheduledResult,
} from "../pi-embedded-runner/run/scheduled-reminder-runtime-adapter.js";
import type { ScheduledReminderWorldStateCollector } from "../../platform/commitment/scheduled-reminder-world-state-observer.js";
import type {
  ChannelId,
  ISO8601,
  SessionId,
} from "../../platform/commitment/ids.js";
import type { ExpectedDelta } from "../../platform/commitment/expected-delta.js";
import type { IdentityId } from "../../platform/identity/identity-id.js";
import { isIdentityId } from "../../platform/identity/identity-id.js";
import type { ReminderStore } from "../../platform/reminder/reminder-store.js";

const ISO8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * Soft cap on `content` length. Mirrors the
 * `WorldStateSnapshot.scheduledReminders` observer cap (4096 chars) —
 * keeps the operator-facing payload bounded so a malformed or
 * adversarial input cannot inflate the prompt-injection surface
 * (sub-plan §6).
 */
const CONTENT_MAX_CHARS = 4096;

/**
 * Closed structural schema. Free-form fields (`when`, `what`, `query`,
 * etc.) are rejected by `.strict()` — invariants #5/#6 reverse-test.
 * `reminderId` is OPTIONAL: when absent the tool mints a deterministic-
 * ish id via the injected `idGen` (production wires `crypto.randomUUID`).
 */
export const ReminderSetShapeSchema = z
  .object({
    reminderId: z.string().min(1).optional(),
    fireAt: z.string().regex(ISO8601_PATTERN, {
      message: "fireAt must be a valid ISO-8601 timestamp",
    }),
    content: z.string().min(1).max(CONTENT_MAX_CHARS),
    deliveryChannel: z.string().min(1),
    deliveryTo: z.string().min(1),
  })
  .strict();

export type ReminderSetShape = z.infer<typeof ReminderSetShapeSchema>;

/**
 * Closed-shape `CronService.add` injection point. Mirrors the production
 * `CronService.add` return contract narrowed to the fields the tool
 * cares about (job id only). Production wires
 * `cronService.add.bind(cronService)`; tests inject a fixture.
 *
 * The `input` shape is intentionally `unknown` at the type boundary
 * because `CronJobCreate` is a wide cron-package type covering the full
 * scheduler surface — Phase 5 only populates a narrow subset (kind:'at',
 * agentTurn payload, announce delivery). Constraining the input shape to
 * the wide cron type would force the tool to import from `src/cron/`,
 * coupling tool code to the scheduler internals; the loose `unknown`
 * type defers that coupling to the integration site (slice F P5
 * precedent for typed-DI seams).
 */
export type CronAddFn = (input: unknown) => Promise<{ readonly id: string }>;

export type RecordReminderToolInput = {
  /**
   * Structured reminder shape. Validated via `ReminderSetShapeSchema`
   * with `.strict()` so free-form payload (`{when, what}`) and extra
   * properties are rejected.
   */
  readonly shape: ReminderSetShape;
  /**
   * Operator identity scope. Injected from the session context BEFORE
   * the tool is invoked (slice K P4 precedent + sub-plan §1 todo Phase
   * 5 — NOT user-controlled). Anonymous → fail-closed.
   */
  readonly ownerIdentityId: IdentityId | undefined;
  readonly sessionId: SessionId;
  readonly turnId: string;
  /**
   * Append-only collector backing `WorldStateSnapshot.scheduledReminders`.
   * Production wires `getProcessScheduledReminderWorldStateCollector()`;
   * tests inject a fixture. When `undefined`, fail-closed
   * `observer_unavailable` (ZERO ReminderStore calls, ZERO cron
   * registration).
   */
  readonly collector: ScheduledReminderWorldStateCollector | undefined;
  /**
   * Persistent reminder store. Production wires `SqliteReminderStore`
   * (Phase 6); Phase 5 wires `InMemoryReminderStore` as STUB. When
   * `undefined`, fail-closed `reminder_store_unavailable`.
   */
  readonly reminderStore: ReminderStore | undefined;
  /**
   * Cron registration sink. Production wires
   * `cronService.add.bind(cronService)`; tests inject a fixture. When
   * `undefined`, fail-closed `transport_error`.
   */
  readonly cronAdd: CronAddFn | undefined;
  /**
   * Injected clock — defaults to `Date.now`. Tests pin a deterministic
   * value to exercise the `fire_at_in_past` boundary.
   */
  readonly now?: () => number;
  /**
   * Reminder-id minting function. Production wires
   * `() => crypto.randomUUID()`; tests inject a fixture for deterministic
   * snapshots.
   */
  readonly idGen?: () => string;
  readonly logger?: (line: string) => void;
};

export type RecordReminderToolFailureReason =
  | "schema_invalid"
  | "transport_error"
  | "identity_unavailable"
  | "fire_at_invalid"
  | "fire_at_in_past"
  | "observer_unavailable"
  | "reminder_store_unavailable"
  | "channel_invalid";

export type RecordReminderToolResult =
  | {
      readonly ok: true;
      readonly reminderId: string;
      readonly expectedDelta: ExpectedDelta;
      readonly cronJobId: string;
    }
  | {
      readonly ok: false;
      readonly reason: RecordReminderToolFailureReason;
      readonly detail?: string;
    };

let monotonicCounter = 0;
function defaultIdGen(): string {
  monotonicCounter += 1;
  return `reminder:${Date.now()}:${monotonicCounter}`;
}

/**
 * Reverse-test guard: explicitly rejects free-form `{when, what}` keys
 * on the OUTER tool input (defense in depth — `.strict()` rejects them
 * at the inner shape, but a caller could forward them via a wider
 * outer envelope before reaching the inner schema).
 */
function rejectsFreeFormShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if ("when" in v && typeof v["when"] === "string") return true;
  if ("what" in v && typeof v["what"] === "string") return true;
  if ("query" in v && typeof v["query"] === "string") return true;
  return false;
}

export async function recordReminderTool(
  input: RecordReminderToolInput,
): Promise<RecordReminderToolResult> {
  // 0. Defensive guard: empty / missing input shape.
  if (input === null || typeof input !== "object") {
    return { ok: false, reason: "schema_invalid" };
  }
  const shapeRaw = input.shape;

  // 1. Reverse: free-form `{when, what}` rejected at the boundary.
  if (rejectsFreeFormShape(shapeRaw)) {
    input.logger?.(
      `[record-reminder-tool] schema_invalid reason=free_form_shape_rejected sessionId=${input.sessionId} turnId=${input.turnId}`,
    );
    return { ok: false, reason: "schema_invalid", detail: "free_form_shape_rejected" };
  }

  // 2. Validate the closed structured shape via Zod `.strict()`.
  const parsed = ReminderSetShapeSchema.safeParse(shapeRaw);
  if (!parsed.success) {
    input.logger?.(
      `[record-reminder-tool] schema_invalid reason=${parsed.error.issues
        .map((i) => i.path.join(".") || i.code)
        .join("|")} sessionId=${input.sessionId} turnId=${input.turnId}`,
    );
    return { ok: false, reason: "schema_invalid", detail: parsed.error.issues[0]?.message };
  }
  const shape = parsed.data;

  // 3. Identity injection — slice K P4 precedent. Anonymous fail-closed
  //    BEFORE any ReminderStore or CronService.add call.
  const ownerIdentityIdRaw =
    typeof input.ownerIdentityId === "string"
      ? (input.ownerIdentityId as string).trim()
      : "";
  if (ownerIdentityIdRaw.length === 0 || !isIdentityId(ownerIdentityIdRaw)) {
    input.logger?.(
      `[record-reminder-tool] identity_unavailable sessionId=${input.sessionId} turnId=${input.turnId}`,
    );
    return { ok: false, reason: "identity_unavailable" };
  }
  const ownerIdentityId = ownerIdentityIdRaw as IdentityId;

  // 4. ReminderStore presence — fail-closed (no fallback).
  if (!input.reminderStore || typeof input.reminderStore.schedule !== "function") {
    input.logger?.(
      `[record-reminder-tool] reminder_store_unavailable sessionId=${input.sessionId} turnId=${input.turnId}`,
    );
    return { ok: false, reason: "reminder_store_unavailable" };
  }

  // 5. Observer presence — fail-closed (no fallback). Without the
  //    collector the done-predicate cannot resolve, so we never persist
  //    the record (acceptance #4 of Phase 4 done-predicate closure).
  if (!input.collector || typeof input.collector.record !== "function") {
    input.logger?.(
      `[record-reminder-tool] observer_unavailable sessionId=${input.sessionId} turnId=${input.turnId}`,
    );
    return { ok: false, reason: "observer_unavailable" };
  }

  // 6. fireAt in-past against injected clock. The schema regex above
  //    already rejected malformed timestamps (schema_invalid arm); this
  //    branch covers the temporal-validity check the regex cannot.
  const fireAtMs = Date.parse(shape.fireAt);
  if (Number.isNaN(fireAtMs)) {
    return { ok: false, reason: "fire_at_invalid", detail: shape.fireAt };
  }
  const nowMs = (input.now ?? Date.now)();
  if (fireAtMs < nowMs) {
    input.logger?.(
      `[record-reminder-tool] fire_at_in_past fireAt=${shape.fireAt} sessionId=${input.sessionId} turnId=${input.turnId}`,
    );
    return {
      ok: false,
      reason: "fire_at_in_past",
      detail: `fireAt=${shape.fireAt}`,
    };
  }

  // 7. Mint reminderId when omitted from the shape.
  const idGen = input.idGen ?? defaultIdGen;
  const reminderId = shape.reminderId ?? idGen();

  // 8. Persist FIRST so the cron-fire callback always finds a record on
  //    fire (the cron job is the side-effect; the store is the source
  //    of truth for replay-after-restart per Phase 6 rehydration).
  try {
    await input.reminderStore.schedule({
      reminderId,
      ownerIdentityId,
      fireAt: shape.fireAt,
      content: shape.content,
      deliveryChannel: shape.deliveryChannel,
      deliveryTo: shape.deliveryTo,
    });
  } catch (err) {
    input.logger?.(
      `[record-reminder-tool] reminder_store_unavailable detail=${err instanceof Error ? err.message : String(err)} sessionId=${input.sessionId} turnId=${input.turnId}`,
    );
    return {
      ok: false,
      reason: "reminder_store_unavailable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // 9. Append into the WorldState collector via the runtime adapter.
  //    Failure here is structurally meaningful — the done-predicate
  //    cannot satisfy without it — so we surface the closed reason.
  const adapterResult: RecordReminderScheduledResult = recordReminderScheduled({
    collector: input.collector,
    sessionId: input.sessionId,
    turnId: input.turnId,
    reminderId,
    ownerIdentityId,
    fireAt: shape.fireAt,
    content: shape.content,
    deliveryChannel: shape.deliveryChannel as ChannelId,
    deliveryTo: shape.deliveryTo,
    now: input.now ?? Date.now,
    ...(input.logger ? { logger: input.logger } : {}),
  });
  if (!adapterResult.ok) {
    return { ok: false, reason: adapterResult.reason, detail: adapterResult.detail };
  }

  // 10. Register the cron callback at `fireAt`. v1 always uses `kind:'at'`
  //     (one-shot). The payload is structured `agentTurn` so the cron-
  //     fired turn flows through the existing isolated-agent path; the
  //     fire callback (Phase 5 `reminder-fire-callback.ts`) marks status
  //     and dispatches outbound.
  if (!input.cronAdd || typeof input.cronAdd !== "function") {
    return {
      ok: false,
      reason: "transport_error",
      detail: "cronAdd dependency missing",
    };
  }

  type CronJobCreateLike = {
    name: string;
    enabled: boolean;
    schedule: { kind: "at"; at: ISO8601 };
    payload: {
      kind: "agentTurn";
      message: string;
      deliver: boolean;
      channel: string;
      to: string;
    };
    delivery: {
      mode: "announce";
      channel: string;
      to: string;
    };
    sessionTarget?: "isolated";
  };

  const cronJob: CronJobCreateLike = {
    name: `reminder:${reminderId}`,
    enabled: true,
    schedule: { kind: "at", at: shape.fireAt as ISO8601 },
    payload: {
      kind: "agentTurn",
      message: shape.content,
      deliver: true,
      channel: shape.deliveryChannel,
      to: shape.deliveryTo,
    },
    delivery: {
      mode: "announce",
      channel: shape.deliveryChannel,
      to: shape.deliveryTo,
    },
    sessionTarget: "isolated",
  };

  let cronJobId: string;
  try {
    const added = await input.cronAdd(cronJob);
    cronJobId = added?.id ?? `cron:${reminderId}`;
  } catch (err) {
    input.logger?.(
      `[record-reminder-tool] cron_add_failed detail=${err instanceof Error ? err.message : String(err)} sessionId=${input.sessionId} turnId=${input.turnId}`,
    );
    return {
      ok: false,
      reason: "transport_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  input.logger?.(
    `[record-reminder-tool] ok reminderId=${reminderId} fireAt=${shape.fireAt} cronJobId=${cronJobId} sessionId=${input.sessionId} turnId=${input.turnId} identityId=${ownerIdentityId}`,
  );

  return {
    ok: true,
    reminderId,
    expectedDelta: adapterResult.expectedDelta,
    cronJobId,
  };
}
