import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformRuntimeExecutionReceipt } from "../runtime/contracts.js";
import { IntentLedger } from "./intent-ledger.js";
import type { WorkspaceProbeFs } from "./workspace-probe.js";
import {
  maybeInvalidateWorkspaceForReceipts,
  shouldInvalidateWorkspaceForReceipt,
} from "./workspace-invalidation.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function applyPatchSuccessReceipt(
  overrides: Partial<PlatformRuntimeExecutionReceipt> = {},
): PlatformRuntimeExecutionReceipt {
  return {
    kind: "tool",
    name: "apply_patch",
    status: "success",
    proof: "reported",
    ...overrides,
  } as PlatformRuntimeExecutionReceipt;
}

function execSuccessReceipt(): PlatformRuntimeExecutionReceipt {
  return {
    kind: "tool",
    name: "exec",
    status: "success",
    proof: "reported",
  } as PlatformRuntimeExecutionReceipt;
}

describe("shouldInvalidateWorkspaceForReceipt", () => {
  it("matches successful apply_patch tool receipts", () => {
    expect(shouldInvalidateWorkspaceForReceipt(applyPatchSuccessReceipt())).toBe(true);
  });

  it("ignores apply_patch with non-success status", () => {
    expect(
      shouldInvalidateWorkspaceForReceipt(applyPatchSuccessReceipt({ status: "failed" })),
    ).toBe(false);
    expect(
      shouldInvalidateWorkspaceForReceipt(applyPatchSuccessReceipt({ status: "blocked" })),
    ).toBe(false);
  });

  it("ignores other tool receipts", () => {
    expect(shouldInvalidateWorkspaceForReceipt(execSuccessReceipt())).toBe(false);
    expect(
      shouldInvalidateWorkspaceForReceipt({
        kind: "platform_action",
        name: "apply_patch",
        status: "success",
        proof: "reported",
      } as PlatformRuntimeExecutionReceipt),
    ).toBe(false);
  });
});

describe("maybeInvalidateWorkspaceForReceipts", () => {
  it("schedules ledger.invalidateWorkspace via defer for successful apply_patch", () => {
    const invalidate = vi.fn(() => true);
    const log = vi.fn();
    const callbacks: Array<() => void> = [];
    const defer = (cb: () => void) => {
      callbacks.push(cb);
      return cb;
    };

    const result = maybeInvalidateWorkspaceForReceipts({
      receipts: [applyPatchSuccessReceipt()],
      sessionId: "session-apply-1",
      channelId: "telegram:123",
      ledger: { invalidateWorkspace: invalidate },
      logger: { log },
      defer,
    });

    expect(result).toEqual({ scheduled: true });
    expect(invalidate).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(1);
    callbacks[0]?.();
    expect(invalidate).toHaveBeenCalledWith("session-apply-1", "telegram:123");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("[workspace-probe] invalidated reason=apply_patch"),
    );
  });

  it("does NOT schedule invalidation for exec-only receipts", () => {
    const invalidate = vi.fn(() => true);
    const callbacks: Array<() => void> = [];
    const defer = (cb: () => void) => {
      callbacks.push(cb);
      return cb;
    };

    const result = maybeInvalidateWorkspaceForReceipts({
      receipts: [execSuccessReceipt()],
      sessionId: "session-exec-1",
      channelId: "telegram:123",
      ledger: { invalidateWorkspace: invalidate },
      logger: { log: vi.fn() },
      defer,
    });

    expect(result).toEqual({ scheduled: false, reason: "no_apply_patch" });
    expect(callbacks).toHaveLength(0);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("does NOT schedule invalidation when sessionId or channelId is missing", () => {
    const invalidate = vi.fn(() => true);

    expect(
      maybeInvalidateWorkspaceForReceipts({
        receipts: [applyPatchSuccessReceipt()],
        sessionId: "",
        channelId: "telegram:123",
        ledger: { invalidateWorkspace: invalidate },
        logger: { log: vi.fn() },
        defer: () => {},
      }),
    ).toEqual({ scheduled: false, reason: "no_session" });

    expect(
      maybeInvalidateWorkspaceForReceipts({
        receipts: [applyPatchSuccessReceipt()],
        sessionId: "session-1",
        channelId: "",
        ledger: { invalidateWorkspace: invalidate },
        logger: { log: vi.fn() },
        defer: () => {},
      }),
    ).toEqual({ scheduled: false, reason: "no_channel" });

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("re-probes workspace on next getOrProbeWorkspace after simulated apply_patch invalidation", async () => {
    let now = 5_000;
    const readdir = vi.fn(async (_targetPath: string) => [
      { name: "src", isDirectory: true },
    ]);
    const fs: WorkspaceProbeFs = {
      readdir,
      realpath: async (value: string) => value,
    };
    const ledger = new IntentLedger({ now: () => now });
    const cwd = path.resolve("workspace-invalidation-apply-patch");
    const sessionId = "session-apply-patch";
    const channelId = "telegram:777";

    await ledger.getOrProbeWorkspace(sessionId, channelId, { cwd, extraRootsEnv: "", fs });
    await ledger.getOrProbeWorkspace(sessionId, channelId, { cwd, extraRootsEnv: "", fs });
    expect(readdir).toHaveBeenCalledTimes(1);

    const callbacks: Array<() => void> = [];
    const result = maybeInvalidateWorkspaceForReceipts({
      receipts: [applyPatchSuccessReceipt()],
      sessionId,
      channelId,
      ledger,
      logger: { log: vi.fn() },
      defer: (cb) => {
        callbacks.push(cb);
        return cb;
      },
    });
    expect(result.scheduled).toBe(true);
    callbacks[0]?.();

    await ledger.getOrProbeWorkspace(sessionId, channelId, { cwd, extraRootsEnv: "", fs });
    expect(readdir).toHaveBeenCalledTimes(2);
  });

  it("does NOT touch identity facts when invalidating workspace on apply_patch", async () => {
    const ledger = new IntentLedger({ now: () => 1_000 });
    const sessionId = "session-identity-untouched";
    const channelId = "telegram:identity";

    const buildIdentity = vi.fn(() => ({
      availableTools: ["exec"],
      availableCapabilities: [],
      capturedAt: 1_000,
      ttlMs: 30 * 60 * 1000,
    }));

    const first = ledger.getOrBuildIdentity(sessionId, channelId, { build: buildIdentity });
    expect(buildIdentity).toHaveBeenCalledTimes(1);
    expect(first.availableTools).toEqual(["exec"]);

    const callbacks: Array<() => void> = [];
    maybeInvalidateWorkspaceForReceipts({
      receipts: [applyPatchSuccessReceipt()],
      sessionId,
      channelId,
      ledger,
      logger: { log: vi.fn() },
      defer: (cb) => {
        callbacks.push(cb);
        return cb;
      },
    });
    callbacks[0]?.();

    ledger.getOrBuildIdentity(sessionId, channelId, { build: buildIdentity });
    expect(buildIdentity).toHaveBeenCalledTimes(1);
  });
});
