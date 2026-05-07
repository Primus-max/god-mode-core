/**
 * Bug F (persistent-worker subsequent push) Phase 5 — fail-first tests
 * for the `WorldStateSnapshot.persistentWorkerReports` slice + Zod
 * schemas.
 *
 * Mirrors `world-state.test.ts` style for the `scheduledReminders` slice
 * (Cron/Scheduler P3). Validates:
 *   - Zod round-trip for `delivered` + `failed` records;
 *   - optional slice preserves backward-compat invariant #11;
 *   - strict-mode rejection on unknown extra keys.
 */

import { describe, expect, it } from "vitest";

import { asIdentityId } from "../../identity/identity-id.js";
import type { ChannelId } from "../ids.js";
import {
  deliveredWorkerReportRecordSchema,
  failedWorkerReportRecordSchema,
  type DeliveredWorkerReportRecord,
  type FailedWorkerReportRecord,
  type WorldStateSnapshot,
} from "../world-state.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const TELEGRAM = "telegram" as ChannelId;
const RECORDED_AT = "2026-05-07T12:00:30.000Z";

describe("WorldStateSnapshot.persistentWorkerReports — schema round-trip", () => {
  it("delivered record schema accepts a structurally-valid record", () => {
    const record: DeliveredWorkerReportRecord = {
      workerRunId: "wrk-001",
      ownerIdentityId: VLADIMIR,
      channel: TELEGRAM,
      to: "6533456892",
      status: "pushed",
      recordedAt: RECORDED_AT as DeliveredWorkerReportRecord["recordedAt"],
      messageId: "pwpush:wrk-001:1234567890",
    };
    const parsed = deliveredWorkerReportRecordSchema.parse(record);
    expect(parsed.workerRunId).toBe("wrk-001");
    expect(parsed.ownerIdentityId).toBe(VLADIMIR);
    expect(parsed.status).toBe("pushed");
    expect(parsed.messageId).toBe("pwpush:wrk-001:1234567890");
  });

  it("failed record schema accepts a structurally-valid record", () => {
    const record: FailedWorkerReportRecord = {
      workerRunId: "wrk-002",
      ownerIdentityId: VLADIMIR,
      channel: TELEGRAM,
      to: "6533456892",
      status: "failed",
      recordedAt: RECORDED_AT as FailedWorkerReportRecord["recordedAt"],
      reason: "dispatch_failed",
    };
    const parsed = failedWorkerReportRecordSchema.parse(record);
    expect(parsed.status).toBe("failed");
    expect(parsed.reason).toBe("dispatch_failed");
  });
});

describe("WorldStateSnapshot.persistentWorkerReports — backward-compat", () => {
  it("WorldStateSnapshot remains structurally valid without the slice (invariant #11)", () => {
    // Pre-Phase-5 callers that build a snapshot WITHOUT the new field
    // continue to typecheck — ADDITIVE optional preserves backward-compat.
    const snapshot: WorldStateSnapshot = {};
    expect(snapshot.persistentWorkerReports).toBeUndefined();
  });

  it("WorldStateSnapshot accepts an empty delivered/failed slice", () => {
    const snapshot: WorldStateSnapshot = {
      persistentWorkerReports: {
        delivered: [],
        failed: [],
      },
    };
    expect(snapshot.persistentWorkerReports?.delivered.length).toBe(0);
    expect(snapshot.persistentWorkerReports?.failed.length).toBe(0);
  });
});

describe("WorldStateSnapshot.persistentWorkerReports — strict rejection", () => {
  it("delivered record schema rejects unknown extra keys (Zod strict)", () => {
    const malformed = {
      workerRunId: "wrk-001",
      ownerIdentityId: VLADIMIR,
      channel: TELEGRAM,
      to: "6533456892",
      status: "pushed",
      recordedAt: RECORDED_AT,
      messageId: "pwpush:wrk-001:1",
      bogusExtra: "should-be-rejected",
    };
    const result = deliveredWorkerReportRecordSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });

  it("delivered record schema rejects empty workerRunId", () => {
    const malformed = {
      workerRunId: "",
      ownerIdentityId: VLADIMIR,
      channel: TELEGRAM,
      to: "6533456892",
      status: "pushed",
      recordedAt: RECORDED_AT,
    };
    const result = deliveredWorkerReportRecordSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });

  it("delivered record schema rejects unbranded ownerIdentityId", () => {
    const malformed = {
      workerRunId: "wrk-001",
      ownerIdentityId: "anonymous",
      channel: TELEGRAM,
      to: "6533456892",
      status: "pushed",
      recordedAt: RECORDED_AT,
    };
    const result = deliveredWorkerReportRecordSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });

  it("delivered record schema rejects malformed ISO-8601 recordedAt", () => {
    const malformed = {
      workerRunId: "wrk-001",
      ownerIdentityId: VLADIMIR,
      channel: TELEGRAM,
      to: "6533456892",
      status: "pushed",
      recordedAt: "2026/05/07 12:00:30",
    };
    const result = deliveredWorkerReportRecordSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });

  it("failed record schema rejects empty reason", () => {
    const malformed = {
      workerRunId: "wrk-001",
      ownerIdentityId: VLADIMIR,
      channel: TELEGRAM,
      to: "6533456892",
      status: "failed",
      recordedAt: RECORDED_AT,
      reason: "",
    };
    const result = failedWorkerReportRecordSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });

  it("failed record schema rejects status='pushed' (literal mismatch)", () => {
    const malformed = {
      workerRunId: "wrk-001",
      ownerIdentityId: VLADIMIR,
      channel: TELEGRAM,
      to: "6533456892",
      status: "pushed",
      recordedAt: RECORDED_AT,
      reason: "dispatch_failed",
    };
    const result = failedWorkerReportRecordSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });
});
