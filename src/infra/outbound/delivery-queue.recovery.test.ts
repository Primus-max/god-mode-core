import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPlatformRuntimeCheckpointService,
  resetPlatformRuntimeCheckpointService,
} from "../../platform/runtime/index.js";
import {
  enqueueDelivery,
  loadPendingDeliveries,
  MAX_RETRIES,
  recoverPendingDeliveries,
  startContinuousDeliveryRecovery,
} from "./delivery-queue.js";
import {
  asDeliverFn,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

describe("delivery-queue recovery", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const baseCfg = {};

  afterEach(() => {
    resetPlatformRuntimeCheckpointService();
    vi.useRealTimers();
  });

  const enqueueCrashRecoveryEntries = async () => {
    await enqueueDelivery({ channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] }, tmpDir());
    await enqueueDelivery({ channel: "telegram", to: "2", payloads: [{ text: "b" }] }, tmpDir());
  };

  const runRecovery = async ({
    deliver,
    log = createRecoveryLog(),
    maxRecoveryMs,
  }: {
    deliver: ReturnType<typeof vi.fn>;
    log?: ReturnType<typeof createRecoveryLog>;
    maxRecoveryMs?: number;
  }) => {
    const result = await recoverPendingDeliveries({
      deliver: asDeliverFn(deliver),
      log,
      cfg: baseCfg,
      stateDir: tmpDir(),
      ...(maxRecoveryMs === undefined ? {} : { maxRecoveryMs }),
    });
    return { result, log };
  };

  it("recovers entries from a simulated crash", async () => {
    await enqueueCrashRecoveryEntries();
    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      recovered: 2,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });

    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
  });

  it("moves entries that exceeded max retries to failed/", async () => {
    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, { retryCount: MAX_RETRIES });

    const deliver = vi.fn();
    const { result } = await runRecovery({ deliver });

    expect(deliver).not.toHaveBeenCalled();
    expect(result.skippedMaxRetries).toBe(1);
    expect(result.deferredBackoff).toBe(0);
    expect(fs.existsSync(path.join(tmpDir(), "delivery-queue", "failed", `${id}.json`))).toBe(true);
  });

  it("increments retryCount on failed recovery attempt", async () => {
    await enqueueDelivery({ channel: "slack", to: "#ch", payloads: [{ text: "x" }] }, tmpDir());

    const deliver = vi.fn().mockRejectedValue(new Error("network down"));
    const { result } = await runRecovery({ deliver });

    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);

    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.lastError).toBe("network down");
  });

  it("moves entries to failed/ immediately on permanent delivery errors", async () => {
    const id = await enqueueDelivery(
      { channel: "msteams", to: "user:abc", payloads: [{ text: "hi" }] },
      tmpDir(),
    );
    const deliver = vi
      .fn()
      .mockRejectedValue(new Error("No conversation reference found for user:abc"));
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver, log });

    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir(), "delivery-queue", "failed", `${id}.json`))).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("permanent error"));
  });

  it("passes skipQueue: true to prevent re-enqueueing during recovery", async () => {
    await enqueueDelivery({ channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] }, tmpDir());

    const deliver = vi.fn().mockResolvedValue([]);
    await runRecovery({ deliver });

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ skipQueue: true }));
  });

  it("does not replay confirmed deliveries after restart recovery", async () => {
    const queueId = await enqueueDelivery(
      {
        actionId: "messaging:confirmed-once",
        channel: "whatsapp",
        to: "+1",
        payloads: [{ text: "a" }],
      },
      tmpDir(),
    );
    const runtime = getPlatformRuntimeCheckpointService({ stateDir: tmpDir() });
    runtime.stageAction({
      actionId: "messaging:confirmed-once",
      kind: "messaging_delivery",
      target: {
        operation: "deliver",
      },
    });
    runtime.markActionConfirmed("messaging:confirmed-once", {
      receipt: {
        operation: "deliver",
        deliveryResults: [
          {
            channel: "whatsapp",
            messageId: "msg-1",
            toJid: "jid-1",
          },
        ],
      },
    });

    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 1,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir(), "delivery-queue", `${queueId}.json`))).toBe(false);
  });

  it("replays stored delivery options during recovery", async () => {
    await enqueueDelivery(
      {
        channel: "whatsapp",
        to: "+1",
        payloads: [{ text: "a" }],
        bestEffort: true,
        gifPlayback: true,
        silent: true,
        mirror: {
          sessionKey: "agent:main:main",
          text: "a",
          mediaUrls: ["https://example.com/a.png"],
        },
      },
      tmpDir(),
    );

    const deliver = vi.fn().mockResolvedValue([]);
    await runRecovery({ deliver });

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        bestEffort: true,
        gifPlayback: true,
        silent: true,
        mirror: {
          sessionKey: "agent:main:main",
          text: "a",
          mediaUrls: ["https://example.com/a.png"],
        },
      }),
    );
  });

  it("respects maxRecoveryMs time budget and bumps deferred retries", async () => {
    await enqueueCrashRecoveryEntries();
    await enqueueDelivery({ channel: "slack", to: "#c", payloads: [{ text: "c" }] }, tmpDir());

    const deliver = vi.fn().mockResolvedValue([]);
    const { result, log } = await runRecovery({
      deliver,
      maxRecoveryMs: 0,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });

    const remaining = await loadPendingDeliveries(tmpDir());
    expect(remaining).toHaveLength(3);
    expect(remaining.every((entry) => entry.retryCount === 1)).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("deferred to next startup"));
  });

  it("defers entries until backoff becomes eligible", async () => {
    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, { retryCount: 3, lastAttemptAt: Date.now() });

    const deliver = vi.fn().mockResolvedValue([]);
    const { result, log } = await runRecovery({
      deliver,
      maxRecoveryMs: 60_000,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 1,
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("not ready for retry yet"));
  });

  it("continues past high-backoff entries and recovers ready entries behind them", async () => {
    const now = Date.now();
    const blockedId = await enqueueDelivery(
      { channel: "whatsapp", to: "+1", payloads: [{ text: "blocked" }] },
      tmpDir(),
    );
    const readyId = await enqueueDelivery(
      { channel: "telegram", to: "2", payloads: [{ text: "ready" }] },
      tmpDir(),
    );

    setQueuedEntryState(tmpDir(), blockedId, {
      retryCount: 3,
      lastAttemptAt: now,
      enqueuedAt: now - 30_000,
    });
    setQueuedEntryState(tmpDir(), readyId, { retryCount: 0, enqueuedAt: now - 10_000 });

    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver, maxRecoveryMs: 60_000 });

    expect(result).toEqual({
      recovered: 1,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 1,
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", to: "2", skipQueue: true }),
    );

    const remaining = await loadPendingDeliveries(tmpDir());
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(blockedId);
  });

  it("recovers deferred entries on a later restart once backoff elapsed", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);

    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1", payloads: [{ text: "later" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, { retryCount: 3, lastAttemptAt: start.getTime() });

    const firstDeliver = vi.fn().mockResolvedValue([]);
    const firstRun = await runRecovery({ deliver: firstDeliver, maxRecoveryMs: 60_000 });
    expect(firstRun.result).toEqual({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 1,
    });
    expect(firstDeliver).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(start.getTime() + 600_000 + 1));
    const secondDeliver = vi.fn().mockResolvedValue([]);
    const secondRun = await runRecovery({ deliver: secondDeliver, maxRecoveryMs: 60_000 });
    expect(secondRun.result).toEqual({
      recovered: 1,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(secondDeliver).toHaveBeenCalledTimes(1);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);

    vi.useRealTimers();
  });

  it("returns zeros when queue is empty", async () => {
    const deliver = vi.fn();
    const { result } = await runRecovery({ deliver });

    expect(result).toEqual({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("continuously drains deferred backlog once backoff elapses without a restart", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1", payloads: [{ text: "live-drain" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, { retryCount: 3, lastAttemptAt: start.getTime() });
    const deliver = vi.fn().mockResolvedValue([]);
    const loop = startContinuousDeliveryRecovery({
      deliver: asDeliverFn(deliver),
      log: createRecoveryLog(),
      cfg: baseCfg,
      stateDir: tmpDir(),
      idlePollMs: 60_000,
    });

    await vi.runOnlyPendingTimersAsync();
    await loop.waitForIdle();
    expect(deliver).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(1);

    vi.setSystemTime(new Date(start.getTime() + 600_000 + 1));
    await vi.advanceTimersByTimeAsync(600_001);
    await vi.runOnlyPendingTimersAsync();
    await loop.waitForIdle();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    loop.stop();
  });

  it("stops continuous delivery retry after max retries are exhausted", async () => {
    vi.useFakeTimers();
    const id = await enqueueDelivery(
      { channel: "slack", to: "#budget", payloads: [{ text: "bounded" }] },
      tmpDir(),
    );
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    setQueuedEntryState(tmpDir(), id, {
      retryCount: MAX_RETRIES - 1,
      lastAttemptAt: Date.now() - 700_000,
    });
    const deliver = vi.fn().mockRejectedValue(new Error("network still down"));
    const loop = startContinuousDeliveryRecovery({
      deliver: asDeliverFn(deliver),
      log: createRecoveryLog(),
      cfg: baseCfg,
      stateDir: tmpDir(),
      idlePollMs: 60_000,
    });

    await vi.runOnlyPendingTimersAsync();
    await loop.waitForIdle();
    await vi.runOnlyPendingTimersAsync();
    await loop.waitForIdle();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir(), "delivery-queue", "failed", `${id}.json`))).toBe(true);
    loop.stop();
  });
});
