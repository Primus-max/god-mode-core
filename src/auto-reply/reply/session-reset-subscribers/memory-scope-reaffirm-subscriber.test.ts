import { describe, expect, it } from "vitest";

import type { SessionId } from "../../../platform/identity/branded-ids.js";
import { asIdentityId } from "../../../platform/identity/identity-id.js";
import { InMemoryMemoryStore } from "../../../platform/memory/in-memory-store.js";
import {
  createSessionResetSubscriberRegistry,
  resetTurnSession,
  type SessionResetEvent,
} from "../../../platform/session/reset.js";

import { createMemoryScopeReaffirmSubscriber } from "./memory-scope-reaffirm-subscriber.js";

/**
 * NEW-B Phase 4 — fail-first round-trip + identity-scope-survival
 * regression-guard for `subscriber:memory-scope-reaffirm`.
 *
 * The subscriber's contract is observability-only: it MUST emit
 * `kind: 'skipped'` so the structured log line surfaces the no-clear
 * decision, AND the slice E B1 contract — operator memory survives
 * `/new` — MUST hold. The slice E regression-guard explicitly stores a
 * semantic entry under an identity, runs the full `resetTurnSession()`,
 * then asserts the entry is still recallable.
 */

const VALID_ISO = "2026-05-06T18:25:00.000Z";
const SESSION_ID = "f71784c5-aaaa-bbbb-cccc-111111111111" as SessionId;
const VLADIMIR = asIdentityId("identity:vladimir");

function buildEvent(overrides: Partial<SessionResetEvent> = {}): SessionResetEvent {
  return {
    sessionId: SESSION_ID,
    sessionKey: "telegram:6533456892",
    identityId: VLADIMIR,
    reason: "reset_trigger",
    occurredAt: VALID_ISO,
    ...overrides,
  };
}

describe("subscriber:memory-scope-reaffirm — round-trip", () => {
  it("emits kind=skipped with the canonical identity-scope reason", async () => {
    const subscriber = createMemoryScopeReaffirmSubscriber();
    expect(subscriber.id).toBe("subscriber:memory-scope-reaffirm");
    expect(subscriber.category).toBe("memory-scope");
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toContain("identity-scoped");
      expect(outcome.reason).toContain("slice E B1");
    }
  });

  it("emits the same outcome for every supported reason (closed-set safety)", async () => {
    const subscriber = createMemoryScopeReaffirmSubscriber();
    for (const reason of [
      "reset_trigger",
      "daily_reset",
      "compaction",
      "forced_recovery",
      "plugin_request",
    ] as const) {
      const outcome = await subscriber.onReset(buildEvent({ reason }));
      expect(outcome.kind).toBe("skipped");
    }
  });
});

describe("subscriber:memory-scope-reaffirm — slice E B1 regression-guard", () => {
  it("identity-scoped semantic entry survives a full resetTurnSession() pass", async () => {
    const store = new InMemoryMemoryStore();
    const entryId = await store.storeSemantic({
      identityId: VLADIMIR,
      content: "operator favourite borscht recipe",
      metadata: { source: "persistent_session" },
    });
    expect(entryId).toBeDefined();

    const registry = createSessionResetSubscriberRegistry();
    registry.register(createMemoryScopeReaffirmSubscriber());
    const summary = await resetTurnSession({
      event: buildEvent(),
      registry,
    });
    expect(summary.skippedCount).toBe(1);
    expect(summary.clearedCount).toBe(0);
    expect(summary.failedCount).toBe(0);

    // Entry MUST still be recallable after reset — slice E B1 guarantee.
    const recall = await store.recall({
      identityId: VLADIMIR,
      query: "borscht",
      limit: 5,
    });
    expect(recall.entries.length).toBeGreaterThanOrEqual(1);
  });
});
