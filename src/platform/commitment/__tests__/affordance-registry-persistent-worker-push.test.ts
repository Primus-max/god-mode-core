import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANSWER_DELIVERED_AFFORDANCE_ENTRY,
  ARTIFACT_EFFECT_FAMILY,
  CLARIFICATION_REQUESTED_AFFORDANCE_ENTRY,
  COMMUNICATION_EFFECT_FAMILY,
  EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY,
  IDENTITY_RESOLVED_PRECONDITION,
  PERSISTENT_SESSION_EFFECT_FAMILY,
  PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY,
  REMINDER_EFFECT_FAMILY,
  REPO_EFFECT_FAMILY,
  WEB_RESEARCH_EFFECT_FAMILY,
  createAffordanceRegistry,
} from "../index.js";
import {
  PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT,
  WORKER_REPORT_AVAILABLE_PRECONDITION,
} from "../../persistent-worker/persistent-worker-push-types.js";
import type { ChannelId } from "../ids.js";

describe("affordance registry — persistent_worker.subsequent_push (Bug F Phase 3)", () => {
  it("registers PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY under COMMUNICATION_EFFECT_FAMILY with effect PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT", () => {
    expect(PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.effectFamily).toBe(
      COMMUNICATION_EFFECT_FAMILY,
    );
    expect(PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.effect).toBe(
      PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT,
    );
    expect(PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.id).toBe(
      "persistent_worker.subsequent_push",
    );
    expect(Object.isFrozen(PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY)).toBe(
      true,
    );
  });

  it("declares operationKinds=['create'] only (audit §h Phase 3 — 'push' is not in the OperationHint union; 'create' matches cron-fire-boundary semantics)", () => {
    expect([
      ...PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.operationKinds,
    ]).toEqual(["create"]);
  });

  it("declares dual preconditions [IDENTITY_RESOLVED_PRECONDITION, WORKER_REPORT_AVAILABLE_PRECONDITION] — anonymous fail-closed + structural worker-report gate (sub-plan §3.1)", () => {
    expect([
      ...PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.requiredPreconditions,
    ]).toEqual([
      IDENTITY_RESOLVED_PRECONDITION,
      WORKER_REPORT_AVAILABLE_PRECONDITION,
    ]);
    expect(WORKER_REPORT_AVAILABLE_PRECONDITION).toBe("worker.report.available");
  });

  it("declares the per-spec budget envelope (15s latency / ZERO retries — mutation idempotency unsafe per Cutover-4 P4 / Cron-Scheduler P4 precedent)", () => {
    expect(
      PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.defaultBudgets,
    ).toEqual({
      maxLatencyMs: 15_000,
      maxRetries: 0,
    });
  });

  it("flags persistent_worker.subsequent_push as medium risk-tier (state crosses /new + outbound push at fire-time, asymmetric vs in-turn answer.delivered/low)", () => {
    expect(PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.riskTier).toBe(
      "medium",
    );
  });

  it("declares 'persistent_worker.subsequent_push' as the mandatory required evidence kind", () => {
    expect(
      PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.requiredEvidence,
    ).toEqual([
      { kind: "persistent_worker.subsequent_push", mandatory: true },
    ]);
  });

  it("routes persistent_worker.subsequent_push through the persistent_worker_report_world_state observer", () => {
    expect(
      PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.observerHandle.id,
    ).toBe("persistent_worker_report_world_state");
  });

  it("registry size grows by 1: createAffordanceRegistry().all() now has 17 entries (16 pre-Bug F + 1 new)", () => {
    const registry = createAffordanceRegistry();
    expect(registry.all()).toHaveLength(17);
    expect(
      registry.all().map((entry) => entry.id),
    ).toContain("persistent_worker.subsequent_push");
  });

  it("findByFamily(communication, {kind:'external_channel'}, 'create') — disjoint from answer.delivered via dual-precondition gate", () => {
    const registry = createAffordanceRegistry();
    const channelTarget = {
      kind: "external_channel",
      channelId: "telegram" as ChannelId,
    } as const;

    // Both answer.delivered AND persistent_worker.subsequent_push share
    // (COMMUNICATION_EFFECT_FAMILY, external_channel, create) — they are
    // disjoint at the precondition layer (PolicyGate Stage 0/1), NOT at the
    // findByFamily layer (which is the structural-shape selector). So this
    // call returns BOTH candidates; downstream PolicyGate filters on
    // requiredPreconditions before runtime adapter resolution.
    const candidates = registry.findByFamily(
      COMMUNICATION_EFFECT_FAMILY,
      channelTarget,
      { kind: "create" },
    );
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain(ANSWER_DELIVERED_AFFORDANCE_ENTRY.id);
    expect(ids).toContain(PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.id);

    // Sanity: the entry resolves under unspecified target too (cron-fire
    // boundary may resolve before channel id is bound).
    const unspecCandidates = registry.findByFamily(
      COMMUNICATION_EFFECT_FAMILY,
      { kind: "unspecified" },
      { kind: "create" },
    );
    const unspecIds = unspecCandidates.map((c) => c.id);
    expect(unspecIds).toContain(PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.id);
    // clarification_requested also matches unspecified+create — both
    // legitimate candidates at the structural layer.
    expect(unspecIds).toContain(CLARIFICATION_REQUESTED_AFFORDANCE_ENTRY.id);
  });

  it("done-predicate is reachable from registered entry — invoking it on empty state surfaces the closed sentinel", () => {
    const ctx = {
      stateBefore: Object.freeze({}),
      stateAfter: Object.freeze({}),
      expectedDelta: Object.freeze({}),
      receipts: { entries: [] },
      trace: { steps: [] },
    } as const;
    const result = PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.donePredicate(
      ctx,
    );
    expect(result.satisfied).toBe(false);
    expect(result.satisfied === false ? result.missing : []).toEqual([
      "persistent_worker_reports.slice_absent",
    ]);
  });

  it("does not resolve under any other effect-family — persistent_worker entry stays scoped to communication", () => {
    const registry = createAffordanceRegistry();
    const targets = [
      { kind: "external_channel", channelId: "telegram" as ChannelId } as const,
      { kind: "unspecified" } as const,
    ];
    for (const target of targets) {
      for (const family of [
        PERSISTENT_SESSION_EFFECT_FAMILY,
        WEB_RESEARCH_EFFECT_FAMILY,
        ARTIFACT_EFFECT_FAMILY,
        REPO_EFFECT_FAMILY,
        REMINDER_EFFECT_FAMILY,
      ]) {
        const ids = registry
          .findByFamily(family, target, { kind: "create" })
          .map((c) => c.id);
        expect(ids).not.toContain(
          PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.id,
        );
      }
    }
  });

  it("does not resolve under operationKinds other than 'create' on the communication family", () => {
    const registry = createAffordanceRegistry();
    const channelTarget = {
      kind: "external_channel",
      channelId: "telegram" as ChannelId,
    } as const;
    for (const opKind of ["update", "cancel", "observe"] as const) {
      const ids = registry
        .findByFamily(COMMUNICATION_EFFECT_FAMILY, channelTarget, {
          kind: opKind,
        })
        .map((c) => c.id);
      expect(ids).not.toContain(
        PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.id,
      );
    }

    // observe operation on external_channel resolves only the
    // external_effect.performed sibling — not persistent_worker.
    const observeIds = registry
      .findByFamily(COMMUNICATION_EFFECT_FAMILY, channelTarget, {
        kind: "observe",
      })
      .map((c) => c.id);
    expect(observeIds).toEqual([EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY.id]);
  });

  it("preserves communication-family branching factor — entry count grows from 3 to 4 (answer.delivered + clarification_requested + external_effect.performed + persistent_worker.subsequent_push)", () => {
    const registry = createAffordanceRegistry();
    const communicationEntries = registry
      .all()
      .filter((entry) => entry.effectFamily === COMMUNICATION_EFFECT_FAMILY);
    expect(communicationEntries).toHaveLength(4);
    const ids = communicationEntries.map((entry) => entry.id);
    expect(ids).toContain(ANSWER_DELIVERED_AFFORDANCE_ENTRY.id);
    expect(ids).toContain(CLARIFICATION_REQUESTED_AFFORDANCE_ENTRY.id);
    expect(ids).toContain(EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY.id);
    expect(ids).toContain(PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.id);
  });
});

describe("frozen-layer integrity — Bug F Phase 3 byte-identical baseline (#11)", () => {
  // Pre-Phase-3 sha256 of the 5 frozen contracts at predecessor SHA
  // a2cadfafae (origin/dev HEAD post PR-#275). Computed via
  // `Get-FileHash -Algorithm SHA256` on Windows; the source of truth is
  // the file at that SHA. The 5 contracts live in the SAME `contracts.ts`
  // file in this repo; we hash the whole file once and compare on every
  // run — Phase 3 must NOT touch this file under any circumstance
  // (master-plan invariant #11).
  const FROZEN_CONTRACTS_FILE_URL = new URL(
    "../../decision/contracts.ts",
    import.meta.url,
  );

  // Captured at predecessor SHA. The test fixture is the file's sha256
  // content hash — any byte-level change to the 5 frozen contracts trips
  // this assertion. (The expected hash is computed at test-build time on
  // the worktree's checked-out copy; we compare against the frozen-at-
  // predecessor copy fetched via `git show a2cadfafae:src/platform/decision/contracts.ts`.)
  it("src/platform/decision/contracts.ts is byte-identical against the captured pre-Phase-3 baseline", () => {
    const filePath = fileURLToPath(FROZEN_CONTRACTS_FILE_URL);
    const content = readFileSync(filePath);
    const sha = createHash("sha256").update(content).digest("hex");

    // Pre-Phase-3 baseline sha256 — captured at predecessor SHA
    // a2cadfafae against `src/platform/decision/contracts.ts`. Stored as
    // a literal in the test (not in a separate fixture file) so a Phase 3
    // regression that touches the frozen file fails this test under
    // version-controlled review without an additional file dance.
    expect(sha).toBe(EXPECTED_FROZEN_CONTRACTS_SHA);
  });
});

// Captured at predecessor SHA `a2cadfafae` (origin/dev HEAD post PR-#275).
// Updated only on explicit master-plan amendment + maintainer signoff.
const EXPECTED_FROZEN_CONTRACTS_SHA =
  "57fc96305711690f5d75d99d63c673ee6389f624fdf7a6c750aad0dc02e624db";
