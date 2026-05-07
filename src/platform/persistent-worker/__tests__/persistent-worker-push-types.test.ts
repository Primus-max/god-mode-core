import { describe, expect, it } from "vitest";

import { asIdentityId } from "../../identity/identity-id.js";

import {
  PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT,
  WORKER_REPORT_AVAILABLE_PRECONDITION,
  WORKER_REPORT_CONTENT_MAX_LENGTH,
  WorkerReportRefSchema,
  isPersistentWorkerPushTriggerId,
  type PersistentWorkerPushTriggerId,
  type WorkerReportRef,
} from "../persistent-worker-push-types.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");
const VALID_COMPLETED_AT = "2026-05-07T11:00:00.000Z";

describe("WorkerReportRefSchema — round-trip on the closed shape", () => {
  it("accepts a well-formed WorkerReportRef and freezes the output", () => {
    const payload = {
      workerRunId: "wrk-001",
      ownerIdentityId: VLADIMIR,
      completedAt: VALID_COMPLETED_AT,
      channel: "telegram:6533456892",
      to: "6533456892",
      content: "Daily push: 3 new artifacts.",
    };
    const parsed = WorkerReportRefSchema.parse(payload);
    expect(parsed.workerRunId).toBe("wrk-001");
    expect(parsed.ownerIdentityId).toBe(VLADIMIR);
    expect(parsed.completedAt).toBe(VALID_COMPLETED_AT);
    expect(parsed.channel).toBe("telegram:6533456892");
    expect(parsed.to).toBe("6533456892");
    expect(parsed.content).toBe("Daily push: 3 new artifacts.");
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("accepts empty content as structurally legal (worker completed with no output)", () => {
    // A persistent_worker run that produces no output is still a
    // sanctioned completion — the operator sees the bare push event.
    // Schema-level: content must respect the length cap but may be
    // empty. Length-cap rejection is covered by a separate test.
    const parsed = WorkerReportRefSchema.parse({
      workerRunId: "wrk-002",
      ownerIdentityId: VLADIMIR,
      completedAt: VALID_COMPLETED_AT,
      channel: "telegram:6533456892",
      to: "6533456892",
      content: "",
    });
    expect(parsed.content).toBe("");
  });
});

describe("WorkerReportRefSchema — strict-mode rejection of unknown keys", () => {
  it("rejects an extra unknown field at the top level (closed-shape discipline)", () => {
    const result = WorkerReportRefSchema.safeParse({
      workerRunId: "wrk-001",
      ownerIdentityId: VLADIMIR,
      completedAt: VALID_COMPLETED_AT,
      channel: "telegram:6533456892",
      to: "6533456892",
      content: "ok",
      injectedField: "bad",
    });
    expect(result.success).toBe(false);
  });
});

describe("WorkerReportRefSchema — workerRunId discipline", () => {
  it("rejects an empty workerRunId", () => {
    const result = WorkerReportRefSchema.safeParse({
      workerRunId: "",
      ownerIdentityId: VLADIMIR,
      completedAt: VALID_COMPLETED_AT,
      channel: "telegram:6533456892",
      to: "6533456892",
      content: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only workerRunId (trim-then-min(1))", () => {
    const result = WorkerReportRefSchema.safeParse({
      workerRunId: "   ",
      ownerIdentityId: VLADIMIR,
      completedAt: VALID_COMPLETED_AT,
      channel: "telegram:6533456892",
      to: "6533456892",
      content: "ok",
    });
    expect(result.success).toBe(false);
  });
});

describe("WorkerReportRefSchema — completedAt ISO-8601 boundary discipline", () => {
  it("rejects a malformed completedAt (no T separator)", () => {
    // Same shape rule as `ReminderQueryShapeSchema`: the regex is a
    // structural check, not a calendar validator — but missing the
    // literal `T` between date and time is rejected.
    const result = WorkerReportRefSchema.safeParse({
      workerRunId: "wrk-001",
      ownerIdentityId: VLADIMIR,
      completedAt: "2026-05-07 11:00:00Z",
      channel: "telegram:6533456892",
      to: "6533456892",
      content: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO-8601 free-form date string", () => {
    const result = WorkerReportRefSchema.safeParse({
      workerRunId: "wrk-001",
      ownerIdentityId: VLADIMIR,
      completedAt: "yesterday at 11am",
      channel: "telegram:6533456892",
      to: "6533456892",
      content: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a completedAt with explicit timezone offset (slice K parity)", () => {
    const parsed = WorkerReportRefSchema.parse({
      workerRunId: "wrk-001",
      ownerIdentityId: VLADIMIR,
      completedAt: "2026-05-07T11:00:00+03:00",
      channel: "telegram:6533456892",
      to: "6533456892",
      content: "ok",
    });
    expect(parsed.completedAt).toBe("2026-05-07T11:00:00+03:00");
  });
});

describe("WorkerReportRefSchema — content length-cap discipline", () => {
  it("rejects content exceeding WORKER_REPORT_CONTENT_MAX_LENGTH", () => {
    const oversized = "x".repeat(WORKER_REPORT_CONTENT_MAX_LENGTH + 1);
    const result = WorkerReportRefSchema.safeParse({
      workerRunId: "wrk-001",
      ownerIdentityId: VLADIMIR,
      completedAt: VALID_COMPLETED_AT,
      channel: "telegram:6533456892",
      to: "6533456892",
      content: oversized,
    });
    expect(result.success).toBe(false);
  });

  it("accepts content at exactly WORKER_REPORT_CONTENT_MAX_LENGTH (boundary)", () => {
    const exact = "x".repeat(WORKER_REPORT_CONTENT_MAX_LENGTH);
    const parsed = WorkerReportRefSchema.parse({
      workerRunId: "wrk-001",
      ownerIdentityId: VLADIMIR,
      completedAt: VALID_COMPLETED_AT,
      channel: "telegram:6533456892",
      to: "6533456892",
      content: exact,
    });
    expect(parsed.content.length).toBe(WORKER_REPORT_CONTENT_MAX_LENGTH);
  });

  it("WORKER_REPORT_CONTENT_MAX_LENGTH matches slice K reminder-content cap precedent (4096)", () => {
    // Sub-plan §3.2: «content length-capped (slice K P2 reminder-
    // content cap precedent)». The slice K cap is
    // `SCHEDULED_REMINDER_CONTENT_MAX_LENGTH = 4096` at
    // `src/platform/commitment/world-state.ts:191`. Mirror exactly.
    expect(WORKER_REPORT_CONTENT_MAX_LENGTH).toBe(4096);
  });
});

describe("WorkerReportRefSchema — ownerIdentityId brand discipline (#16)", () => {
  it("rejects an ownerIdentityId that fails the IdentityId guard", () => {
    const result = WorkerReportRefSchema.safeParse({
      workerRunId: "wrk-001",
      ownerIdentityId: "raw-string-not-an-identity",
      completedAt: VALID_COMPLETED_AT,
      channel: "telegram:6533456892",
      to: "6533456892",
      content: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects ownerIdentityId without the identity: prefix (slug-only fails-closed)", () => {
    const result = WorkerReportRefSchema.safeParse({
      workerRunId: "wrk-001",
      ownerIdentityId: "vladimir",
      completedAt: VALID_COMPLETED_AT,
      channel: "telegram:6533456892",
      to: "6533456892",
      content: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects WorkerReportRef substitution from raw string at compile-time", () => {
    // Brand discipline — IdentityId is non-substitutable from string.
    const _bad: WorkerReportRef = {
      workerRunId: "wrk-001",
      // @ts-expect-error — raw string cannot be assigned to IdentityId
      ownerIdentityId: "raw-string",
      completedAt: VALID_COMPLETED_AT,
      // @ts-expect-error — raw string cannot be assigned to ChannelId
      channel: "telegram:6533456892",
      to: "6533456892",
      content: "ok",
    };
    void _bad;

    // Sanity: the runtime guard ALSO rejects the same payload.
    const result = WorkerReportRefSchema.safeParse({
      workerRunId: "wrk-001",
      ownerIdentityId: "raw-string",
      completedAt: VALID_COMPLETED_AT,
      channel: "telegram:6533456892",
      to: "6533456892",
      content: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("two distinct operator IdentityIds round-trip without collapsing (operator isolation sanity)", () => {
    const a = WorkerReportRefSchema.parse({
      workerRunId: "wrk-A",
      ownerIdentityId: VLADIMIR,
      completedAt: VALID_COMPLETED_AT,
      channel: "telegram:1",
      to: "1",
      content: "A",
    });
    const b = WorkerReportRefSchema.parse({
      workerRunId: "wrk-B",
      ownerIdentityId: ALICE,
      completedAt: VALID_COMPLETED_AT,
      channel: "telegram:2",
      to: "2",
      content: "B",
    });
    expect(a.ownerIdentityId).not.toBe(b.ownerIdentityId);
  });
});

describe("WorkerReportRefSchema — channel + to discipline", () => {
  it("rejects an empty channel", () => {
    const result = WorkerReportRefSchema.safeParse({
      workerRunId: "wrk-001",
      ownerIdentityId: VLADIMIR,
      completedAt: VALID_COMPLETED_AT,
      channel: "",
      to: "6533456892",
      content: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty to (channel address)", () => {
    const result = WorkerReportRefSchema.safeParse({
      workerRunId: "wrk-001",
      ownerIdentityId: VLADIMIR,
      completedAt: VALID_COMPLETED_AT,
      channel: "telegram:6533456892",
      to: "",
      content: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only to (trim-then-min(1))", () => {
    const result = WorkerReportRefSchema.safeParse({
      workerRunId: "wrk-001",
      ownerIdentityId: VLADIMIR,
      completedAt: VALID_COMPLETED_AT,
      channel: "telegram:6533456892",
      to: "   ",
      content: "ok",
    });
    expect(result.success).toBe(false);
  });
});

describe("isPersistentWorkerPushTriggerId — minimal type-guard", () => {
  it("accepts a non-empty string", () => {
    expect(isPersistentWorkerPushTriggerId("trigger-001")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isPersistentWorkerPushTriggerId("")).toBe(false);
  });

  it("rejects non-string inputs (defensive against unknown boundaries)", () => {
    expect(isPersistentWorkerPushTriggerId(undefined)).toBe(false);
    expect(isPersistentWorkerPushTriggerId(null)).toBe(false);
    expect(isPersistentWorkerPushTriggerId(123)).toBe(false);
    expect(isPersistentWorkerPushTriggerId({ id: "x" })).toBe(false);
    expect(isPersistentWorkerPushTriggerId([])).toBe(false);
  });
});

describe("PersistentWorkerPushTriggerId — brand discipline (#16)", () => {
  it("rejects raw-string substitution at compile-time (non-substitutable from string)", () => {
    // Brand discipline — PersistentWorkerPushTriggerId is
    // non-substitutable from string. Phase 4's runtime adapter mints
    // the brand internally; callers cannot smuggle an arbitrary
    // string in without going through the guard.
    function consume(_id: PersistentWorkerPushTriggerId): void {
      void _id;
    }
    // @ts-expect-error — raw string cannot be assigned to PersistentWorkerPushTriggerId
    consume("raw-string");

    // Sanity: positive case to balance the @ts-expect-error above.
    const raw: unknown = "trigger-001";
    if (isPersistentWorkerPushTriggerId(raw)) {
      consume(raw);
    }
  });
});

describe("Effect + precondition id constants", () => {
  it("PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT carries the canonical literal", () => {
    expect(PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT).toBe(
      "persistent_worker.subsequent_push",
    );
  });

  it("WORKER_REPORT_AVAILABLE_PRECONDITION carries the canonical literal", () => {
    expect(WORKER_REPORT_AVAILABLE_PRECONDITION).toBe(
      "worker.report.available",
    );
  });

  it("PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT does NOT collide with answer.delivered", () => {
    // Both effects share `COMMUNICATION_EFFECT_FAMILY` (sub-plan
    // §3.1) so the literal MUST be distinct — Phase 3's
    // `findByFamily('communication', target, op)` lookup keys on
    // (effectFamily, target, operationKind) and would collide if
    // these two effects shared the same literal.
    expect(PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT).not.toBe(
      "answer.delivered",
    );
  });

  it("PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT does NOT collide with reminder.set (slice K)", () => {
    // Distinct effect family, distinct literal — slice K Phase 2's
    // `REMINDER_SET_EFFECT` is `'reminder.set'`.
    expect(PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT).not.toBe("reminder.set");
  });
});
