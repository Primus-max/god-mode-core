import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asIdentityId } from "../../identity/identity-id.js";
import {
  SQLITE_BUDGET_STORE_SCHEMA_VERSION,
  SqliteBudgetStore,
  defaultSqliteBudgetStorePath,
  type BudgetIncrementInput,
  type BudgetReadQuery,
} from "../index.js";
import type { EffectFamilyId } from "../ids.js";

/**
 * Phase 4 — `SqliteBudgetStore` acceptance tests. Same discipline as
 * slice E `SqliteVecMemoryStore`: real SQLite file in a tmp dir, no
 * mocking the store under test. Injected deps (`now` clock) are
 * the only stubs.
 *
 * Coverage matrix (sub-plan §4.h):
 *   (1)  schema_version row written on init
 *   (2)  Round-trip: increment then read returns updated value
 *   (3)  Reset expired clears windows past windowEnd
 *   (4)  Per-IdentityId isolation
 *   (5)  Concurrent increments via parallel Promise.all → atomic
 *   (6)  DB path resolves to <configDir>/policy/budget.sqlite by default
 *   (7)  Config-driven path override works
 *   (8)  Schema migration baseline (version=1; future migrations gated)
 *   (9)  Closed missing-window case: read on missing window → null
 *   (10) Increment on missing window → creates window
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

const COMMUNICATION_FAMILY = "communication" as EffectFamilyId;

describe("SqliteBudgetStore — Phase 4 acceptance", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "sqlite-budget-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function tmpPath(name = "budget.sqlite"): string {
    return path.join(tmpDir, name);
  }

  it("(1) writes schema_version=1 on init", async () => {
    const store = await SqliteBudgetStore.open({ dbPath: tmpPath() });
    expect(store.getSchemaVersion()).toBe(SQLITE_BUDGET_STORE_SCHEMA_VERSION);
    expect(store.getSchemaVersion()).toBe(1);
    await store.close();
  });

  it("(8) re-opens an existing DB without re-bumping schema_version", async () => {
    const dbPath = tmpPath();
    const first = await SqliteBudgetStore.open({ dbPath });
    expect(first.getSchemaVersion()).toBe(1);
    await first.close();
    const second = await SqliteBudgetStore.open({ dbPath });
    expect(second.getSchemaVersion()).toBe(1);
    await second.close();
  });

  it("(9) read returns null for a missing window", async () => {
    const store = await SqliteBudgetStore.open({ dbPath: tmpPath() });
    const w = await store.read({ dimension: "user", identityId: VLADIMIR } as BudgetReadQuery);
    expect(w).toBeNull();
    await store.close();
  });

  it("(10) increment creates the window when missing and returns used=1", async () => {
    let clock = 1_000_000;
    const store = await SqliteBudgetStore.open({ dbPath: tmpPath(), now: () => clock });
    const window = await store.increment({
      dimension: "user",
      identityId: VLADIMIR,
      limit: 5,
      windowMs: 60_000,
    } as BudgetIncrementInput);
    expect(window.used).toBe(1);
    expect(window.limit).toBe(5);
    expect(window.windowStart).toBe(clock);
    expect(window.windowEnd).toBe(clock + 60_000);
    expect(window.dimension).toBe("user");
    expect(window.identityId).toBe(VLADIMIR);
    expect(window.windowId).toContain("budget:user:identity:vladimir");
    await store.close();
  });

  it("(2) round-trip — increment then read returns updated value", async () => {
    const store = await SqliteBudgetStore.open({ dbPath: tmpPath() });
    await store.increment({
      dimension: "user",
      identityId: VLADIMIR,
      limit: 10,
      windowMs: 60_000,
    } as BudgetIncrementInput);
    await store.increment({
      dimension: "user",
      identityId: VLADIMIR,
      limit: 10,
      windowMs: 60_000,
    } as BudgetIncrementInput);
    const w = await store.read({ dimension: "user", identityId: VLADIMIR } as BudgetReadQuery);
    expect(w?.used).toBe(2);
    expect(w?.limit).toBe(10);
    await store.close();
  });

  it("(3) resetExpired rolls windows whose windowEnd <= now and returns the count", async () => {
    let clock = 1_000_000;
    const store = await SqliteBudgetStore.open({ dbPath: tmpPath(), now: () => clock });
    await store.increment({
      dimension: "user",
      identityId: VLADIMIR,
      limit: 5,
      windowMs: 1_000,
    } as BudgetIncrementInput);
    // Verify state before reset
    const before = await store.read({
      dimension: "user",
      identityId: VLADIMIR,
    } as BudgetReadQuery);
    expect(before?.used).toBe(1);

    // Advance well past the windowEnd.
    clock += 5_000;
    const count = await store.resetExpired(clock);
    expect(count).toBe(1);

    const after = await store.read({
      dimension: "user",
      identityId: VLADIMIR,
    } as BudgetReadQuery);
    expect(after?.used).toBe(0);
    await store.close();
  });

  it("(3b) read auto-rolls a window past its windowEnd (lazy reset)", async () => {
    let clock = 1_000_000;
    const store = await SqliteBudgetStore.open({ dbPath: tmpPath(), now: () => clock });
    await store.increment({
      dimension: "user",
      identityId: VLADIMIR,
      limit: 5,
      windowMs: 1_000,
    } as BudgetIncrementInput);
    clock += 10_000;
    const w = await store.read({
      dimension: "user",
      identityId: VLADIMIR,
    } as BudgetReadQuery);
    expect(w?.used).toBe(0);
    // The new windowStart should be aligned to a multiple of windowMs.
    expect((w?.windowStart ?? 0) % 1_000).toBe(0);
    await store.close();
  });

  it("(4) per-IdentityId isolation — VLADIMIR's window does NOT leak into ALICE's read", async () => {
    const store = await SqliteBudgetStore.open({ dbPath: tmpPath() });
    await store.increment({
      dimension: "user",
      identityId: VLADIMIR,
      limit: 10,
      windowMs: 60_000,
    } as BudgetIncrementInput);
    const alice = await store.read({
      dimension: "user",
      identityId: ALICE,
    } as BudgetReadQuery);
    expect(alice).toBeNull();
    const vlad = await store.read({
      dimension: "user",
      identityId: VLADIMIR,
    } as BudgetReadQuery);
    expect(vlad?.used).toBe(1);
    await store.close();
  });

  it("(5) concurrent increments via Promise.all — atomic, no lost charges", async () => {
    const store = await SqliteBudgetStore.open({ dbPath: tmpPath() });
    const N = 20;
    const charges = Array.from({ length: N }, () =>
      store.increment({
        dimension: "user",
        identityId: VLADIMIR,
        limit: 100,
        windowMs: 60_000,
      } as BudgetIncrementInput),
    );
    await Promise.all(charges);
    const w = await store.read({
      dimension: "user",
      identityId: VLADIMIR,
    } as BudgetReadQuery);
    expect(w?.used).toBe(N);
    await store.close();
  });

  it("(6) defaultSqliteBudgetStorePath resolves to <configDir>/policy/budget.sqlite", () => {
    // Use a deterministic env override so the assertion is portable.
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: tmpDir };
    const resolved = defaultSqliteBudgetStorePath(env);
    expect(resolved.endsWith(path.join("policy", "budget.sqlite"))).toBe(true);
    expect(resolved.startsWith(tmpDir)).toBe(true);
  });

  it("(7) config-driven path override — opens at the provided dbPath", async () => {
    const explicitPath = tmpPath("explicit.sqlite");
    const store = await SqliteBudgetStore.open({ dbPath: explicitPath });
    await store.increment({
      dimension: "user",
      identityId: VLADIMIR,
      limit: 5,
      windowMs: 60_000,
    } as BudgetIncrementInput);
    await store.close();
    // Re-open and verify state persisted.
    const second = await SqliteBudgetStore.open({ dbPath: explicitPath });
    const w = await second.read({
      dimension: "user",
      identityId: VLADIMIR,
    } as BudgetReadQuery);
    expect(w?.used).toBe(1);
    await second.close();
  });

  it("dimension='channel' isolation — different channels do not share the row", async () => {
    const store = await SqliteBudgetStore.open({ dbPath: tmpPath() });
    await store.increment({
      dimension: "channel",
      channel: "telegram",
      limit: 10,
      windowMs: 60_000,
    } as BudgetIncrementInput);
    const slack = await store.read({
      dimension: "channel",
      channel: "slack",
    } as BudgetReadQuery);
    expect(slack).toBeNull();
    const telegram = await store.read({
      dimension: "channel",
      channel: "telegram",
    } as BudgetReadQuery);
    expect(telegram?.used).toBe(1);
    await store.close();
  });

  it("dimension='effect' — keyed on effectFamily, not effectId", async () => {
    const store = await SqliteBudgetStore.open({ dbPath: tmpPath() });
    await store.increment({
      dimension: "effect",
      effectFamily: COMMUNICATION_FAMILY,
      limit: 10,
      windowMs: 60_000,
    } as BudgetIncrementInput);
    await store.increment({
      dimension: "effect",
      effectFamily: COMMUNICATION_FAMILY,
      limit: 10,
      windowMs: 60_000,
    } as BudgetIncrementInput);
    const w = await store.read({
      dimension: "effect",
      effectFamily: COMMUNICATION_FAMILY,
    } as BudgetReadQuery);
    expect(w?.used).toBe(2);
    expect(w?.effectFamily).toBe(COMMUNICATION_FAMILY);
    await store.close();
  });

  it("rejects malformed limit (negative) on increment", async () => {
    const store = await SqliteBudgetStore.open({ dbPath: tmpPath() });
    await expect(
      store.increment({
        dimension: "user",
        identityId: VLADIMIR,
        limit: -1,
        windowMs: 60_000,
      } as BudgetIncrementInput),
    ).rejects.toThrow(/limit must be a non-negative number/u);
    await store.close();
  });

  it("rejects malformed windowMs (zero) on increment", async () => {
    const store = await SqliteBudgetStore.open({ dbPath: tmpPath() });
    await expect(
      store.increment({
        dimension: "user",
        identityId: VLADIMIR,
        limit: 5,
        windowMs: 0,
      } as BudgetIncrementInput),
    ).rejects.toThrow(/windowMs must be a positive number/u);
    await store.close();
  });

  it("close is idempotent and re-open after close fails operations cleanly", async () => {
    const store = await SqliteBudgetStore.open({ dbPath: tmpPath() });
    await store.close();
    await store.close(); // no throw
    await expect(
      store.read({ dimension: "user", identityId: VLADIMIR } as BudgetReadQuery),
    ).rejects.toThrow(/closed/u);
  });

  it("missing dbPath throws on open", async () => {
    await expect(SqliteBudgetStore.open({ dbPath: "" })).rejects.toThrow(/dbPath is required/u);
  });
});
