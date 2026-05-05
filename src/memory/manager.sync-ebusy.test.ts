/**
 * Regression: legacy memory subsystem (`runDetachedMemorySync` and the related
 * sync-failed catch handlers in `manager.ts`) emitted noisy `[memory] sync
 * failed (...): Error: EBUSY: resource busy or locked, rename ...` warnings
 * on Windows.
 *
 * Live evidence (gateway-orchestrator-launch.log, 2026-05-05 20:38:15):
 *   [memory] sync failed (session-start): Error: EBUSY: ... rename
 *     'C:\\Users\\Tanya\\.openclaw-dev\\memory\\dev.sqlite' ->
 *     'C:\\Users\\Tanya\\.openclaw-dev\\memory\\dev.sqlite.backup-<uuid>'
 *   [memory] sync failed (search):        Error: EBUSY: ...
 *
 * These come from `swapIndexFiles -> moveIndexFiles` issuing `fs.rename` while
 * the OS still holds an open handle to the just-closed sqlite file (or while
 * another viewer such as the slice-E `SqliteVecMemoryStore` has one). The
 * legacy reindex catch path already cleans up the temp DB and reopens the
 * original — i.e. the EBUSY on the rollback rename is benign — so we should
 * not emit a `warn`-level line for it. We demote EBUSY rename failures to
 * `debug` and keep `warn` for every other class of error.
 */
import { describe, expect, it, vi } from "vitest";

import { reportLegacyMemorySyncFailure } from "./manager-sync-ops.js";

type LogCalls = {
  warn: Array<{ message: string; meta?: Record<string, unknown> }>;
  debug: Array<{ message: string; meta?: Record<string, unknown> }>;
};

function makeLog(): {
  log: { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
  calls: LogCalls;
} {
  const calls: LogCalls = { warn: [], debug: [] };
  const warn = vi.fn((message: string, meta?: Record<string, unknown>) => {
    calls.warn.push({ message, meta });
  });
  const debug = vi.fn((message: string, meta?: Record<string, unknown>) => {
    calls.debug.push({ message, meta });
  });
  return { log: { warn, debug }, calls };
}

function makeEbusyRenameError(): NodeJS.ErrnoException {
  const err = new Error(
    "EBUSY: resource busy or locked, rename 'C:\\Users\\Tanya\\.openclaw-dev\\memory\\dev.sqlite' -> 'C:\\Users\\Tanya\\.openclaw-dev\\memory\\dev.sqlite.backup-112492c6-4229-4145-8eaf-6b1ce0305499'",
  ) as NodeJS.ErrnoException;
  err.code = "EBUSY";
  err.syscall = "rename";
  return err;
}

describe("reportLegacyMemorySyncFailure", () => {
  it("demotes EBUSY rename failures (Windows sqlite handle lag) to debug", () => {
    const { log, calls } = makeLog();
    reportLegacyMemorySyncFailure(log, "session-start", makeEbusyRenameError());
    expect(calls.warn).toEqual([]);
    expect(calls.debug).toHaveLength(1);
    expect(calls.debug[0]?.message).toContain("memory sync failed (session-start)");
    expect(calls.debug[0]?.message).toContain("EBUSY");
  });

  it("demotes EBUSY for the `search` sync reason (matches live log line)", () => {
    const { log, calls } = makeLog();
    reportLegacyMemorySyncFailure(log, "search", makeEbusyRenameError());
    expect(calls.warn).toEqual([]);
    expect(calls.debug).toHaveLength(1);
    expect(calls.debug[0]?.message).toContain("memory sync failed (search)");
  });

  it("demotes EBUSY for the `watch` sync reason", () => {
    const { log, calls } = makeLog();
    reportLegacyMemorySyncFailure(log, "watch", makeEbusyRenameError());
    expect(calls.warn).toEqual([]);
    expect(calls.debug).toHaveLength(1);
  });

  it("demotes EBUSY for the `session-delta` sync reason", () => {
    const { log, calls } = makeLog();
    reportLegacyMemorySyncFailure(log, "session-delta", makeEbusyRenameError());
    expect(calls.warn).toEqual([]);
    expect(calls.debug).toHaveLength(1);
  });

  it("keeps non-EBUSY errors at warn level (negative case — guard against over-suppressing)", () => {
    const { log, calls } = makeLog();
    reportLegacyMemorySyncFailure(
      log,
      "session-start",
      new Error("openai embeddings failed: 400 bad request"),
    );
    expect(calls.debug).toEqual([]);
    expect(calls.warn).toHaveLength(1);
    expect(calls.warn[0]?.message).toContain("memory sync failed (session-start)");
    expect(calls.warn[0]?.message).toContain("400 bad request");
  });

  it("keeps EBUSY at warn when the syscall is not rename (only the rollback-rename pattern is benign)", () => {
    const { log, calls } = makeLog();
    const err = new Error("EBUSY: resource busy or locked, open ...") as NodeJS.ErrnoException;
    err.code = "EBUSY";
    err.syscall = "open";
    reportLegacyMemorySyncFailure(log, "interval", err);
    expect(calls.debug).toEqual([]);
    expect(calls.warn).toHaveLength(1);
  });

  it("keeps non-Error rejections at warn (defensive — don't silently swallow)", () => {
    const { log, calls } = makeLog();
    reportLegacyMemorySyncFailure(log, "watch", "totally unexpected scalar reject");
    expect(calls.debug).toEqual([]);
    expect(calls.warn).toHaveLength(1);
  });

  it("keeps null/undefined rejections at warn (defensive)", () => {
    const { log, calls } = makeLog();
    reportLegacyMemorySyncFailure(log, "watch", null);
    reportLegacyMemorySyncFailure(log, "watch", undefined);
    expect(calls.debug).toEqual([]);
    expect(calls.warn).toHaveLength(2);
  });

  it("recognises EBUSY by message text alone when code/syscall are missing (Windows error wrapping)", () => {
    const { log, calls } = makeLog();
    const err = new Error(
      "EBUSY: resource busy or locked, rename 'C:\\foo\\dev.sqlite' -> 'C:\\foo\\dev.sqlite.backup-abcd'",
    );
    reportLegacyMemorySyncFailure(log, "watch", err);
    expect(calls.warn).toEqual([]);
    expect(calls.debug).toHaveLength(1);
  });
});

describe("isLegacyMemoryBenignBackupError detection (Windows-specific)", () => {
  it("recognises errors thrown directly by `fs.rename` (NodeJS.ErrnoException shape)", () => {
    const { log, calls } = makeLog();
    // This mirrors exactly what `fs/promises.rename` throws on Windows when
    // the source file still has an open OS handle. We assert the helper
    // classifies it as benign even when the message format is the bare
    // libuv form.
    const err = Object.assign(new Error("EBUSY: resource busy or locked, rename"), {
      code: "EBUSY",
      syscall: "rename",
      path: "C:\\Users\\Tanya\\.openclaw-dev\\memory\\dev.sqlite",
      dest: "C:\\Users\\Tanya\\.openclaw-dev\\memory\\dev.sqlite.backup-abcd",
    });
    reportLegacyMemorySyncFailure(log, "session-start", err);
    expect(calls.warn).toEqual([]);
    expect(calls.debug).toHaveLength(1);
  });
});
