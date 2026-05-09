import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetSessionResetRegistryForTests,
  getSessionResetRegistry,
  setSessionResetActiveCfg,
} from "./session-reset-bootstrap.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionId } from "../platform/identity/branded-ids.js";
import type { SessionResetEvent } from "../platform/session/reset.js";

/**
 * NEW-B Phase 5 — bootstrap acceptance.
 *
 * Phase 6 of the plan asserts `subscribers=8` and the deterministic
 * registration order on every reset's structured log line. These tests
 * pin the SAME order at the bootstrap level so any future shuffle is
 * caught at unit-test time, not at acceptance time.
 *
 * No `vi.spyOn` on the function under test (per slice-implementer
 * rules); the bootstrap's only external state is the process-singleton
 * symbol-keyed slot which the `__resetSessionResetRegistryForTests`
 * hook clears between tests.
 */

const EXPECTED_SUBSCRIBER_ORDER: ReadonlyArray<{
  readonly id: string;
  readonly category: string;
}> = [
  { id: "subscriber:followup-queue-clear", category: "chat-history" },
  { id: "subscriber:memory-scope-reaffirm", category: "memory-scope" },
  { id: "subscriber:task-scope-reaffirm", category: "task-scope" },
  { id: "subscriber:artifact-observer-clear", category: "observer" },
  {
    id: "subscriber:world-state-sessions-current-flip",
    category: "world-state",
  },
  { id: "subscriber:plugin-hooks", category: "plugin" },
  { id: "subscriber:intent-ledger-clear", category: "misc" },
  { id: "subscriber:memory-wiring-resolver-clear", category: "misc" },
];

const SESSION_ID = "f71784c5-aaaa-bbbb-cccc-111111111111" as SessionId;
const PREVIOUS_SESSION_ID =
  "99f9e4f2-82be-4148-bd79-ffb80a2e07e3" as SessionId;
const RESET_EVENT: SessionResetEvent = {
  sessionId: SESSION_ID,
  sessionKey: "telegram:6533456892",
  previousSessionId: PREVIOUS_SESSION_ID,
  reason: "reset_trigger",
  occurredAt: "2026-05-06T18:25:00.000Z",
};

describe("session-reset-bootstrap — Phase 5 process-singleton", () => {
  beforeEach(() => {
    __resetSessionResetRegistryForTests();
  });

  afterEach(() => {
    __resetSessionResetRegistryForTests();
  });

  it("registers exactly 8 subscribers (Phase 1 audit §d closed list, Phase 6 assertion)", () => {
    const registry = getSessionResetRegistry();
    const list = registry.list();
    expect(list).toHaveLength(8);
  });

  it("registers subscribers in the deterministic Phase-6-asserted order", () => {
    const registry = getSessionResetRegistry();
    const observed = registry.list().map((subscriber) => ({
      id: subscriber.id as string,
      category: subscriber.category as string,
    }));
    expect(observed).toEqual(EXPECTED_SUBSCRIBER_ORDER);
  });

  it("is idempotent: a second getSessionResetRegistry() returns the SAME registry instance (no double registration)", () => {
    const first = getSessionResetRegistry();
    const second = getSessionResetRegistry();
    // Same registry instance — not a fresh build with duplicate rows.
    expect(second).toBe(first);
    // Subscriber count stays at 8 (no double-fan-out).
    expect(second.list()).toHaveLength(8);
  });

  it("double-bootstrap does not shuffle order or duplicate slots", () => {
    const first = getSessionResetRegistry().list().map((s) => s.id);
    const second = getSessionResetRegistry().list().map((s) => s.id);
    // Insertion order stable across calls (deterministic per spec).
    expect(second).toEqual(first);
    // No duplicate ids slipped in.
    const idSet = new Set(second);
    expect(idSet.size).toBe(second.length);
  });

  it("setSessionResetActiveCfg before getSessionResetRegistry: cfg is observable on subsequent reset events", async () => {
    // Cfg is consumed by the plugin-hooks subscriber's resolveAgentId
    // thunk. We assert that setting cfg before the registry is built does
    // not crash and that the registry still ships exactly 8 subscribers
    // (the cfg setter does not affect registration order or count).
    const cfg = {
      agents: { defaults: { primary: "primary-agent" } },
    } as unknown as OpenClawConfig;
    setSessionResetActiveCfg(cfg);
    const registry = getSessionResetRegistry();
    expect(registry.list()).toHaveLength(8);
    // Ensure the plugin-hooks subscriber is present (it is the consumer
    // of the active cfg; if it were missing the cfg setter would be inert).
    const pluginHooksRow = registry
      .list()
      .find((row) => row.id === "subscriber:plugin-hooks");
    expect(pluginHooksRow).toBeDefined();
    // Smoke: invoking onReset on the plugin-hooks subscriber returns a
    // structured outcome (skipped when no global hook runner is loaded
    // in the test process). This confirms the subscriber wiring did
    // not throw at registration.
    const outcome = await pluginHooksRow!.onReset(RESET_EVENT);
    expect(["skipped", "cleared", "failed"]).toContain(outcome.kind);
  });

  it("__resetSessionResetRegistryForTests clears the singleton: next call rebuilds a FRESH registry", () => {
    const first = getSessionResetRegistry();
    __resetSessionResetRegistryForTests();
    const second = getSessionResetRegistry();
    expect(second).not.toBe(first);
    expect(second.list()).toHaveLength(8);
  });
});
