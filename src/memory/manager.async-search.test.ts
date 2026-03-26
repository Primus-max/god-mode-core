import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, MemoryIndexManager } from "./index.js";

describe("memory search async sync", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    await closeAllMemorySearchManagers();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeAllMemorySearchManagers();
  });

  it("does not await sync when searching", async () => {
    let syncSettled = false;
    const syncMock = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      syncSettled = true;
    });

    const managerLike = Object.assign(Object.create(MemoryIndexManager.prototype), {
      ensureProviderInitialized: vi.fn(async () => {}),
      warmSession: vi.fn(async () => {}),
      settings: { sync: { onSearch: true } },
      dirty: true,
      sessionsDirty: false,
      sync: syncMock,
    }) as MemoryIndexManager;

    const searchResult = await MemoryIndexManager.prototype.search.call(managerLike, "   ");
    expect(searchResult).toEqual([]);
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncSettled).toBe(false);
    await vi.waitFor(() => {
      expect(syncSettled).toBe(true);
    });
  });

  it("waits for in-flight search sync during close", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });
    const closeDb = vi.fn();
    const managerLike = Object.assign(Object.create(MemoryIndexManager.prototype), {
      ensureProviderInitialized: vi.fn(async () => {}),
      warmSession: vi.fn(async () => {}),
      settings: { sync: { onSearch: true } },
      dirty: true,
      sessionsDirty: false,
      syncing: null as Promise<void> | null,
      closed: false,
      providerInitPromise: null as Promise<void> | null,
      watchTimer: null,
      sessionWatchTimer: null,
      intervalTimer: null,
      watcher: null,
      sessionUnsubscribe: null,
      db: { close: closeDb },
      cacheKey: "memory-async-search-close-test",
      sync: vi.fn(() => {
        managerLike.syncing = pendingSync.finally(() => {
          managerLike.syncing = null;
        });
        return managerLike.syncing;
      }),
    }) as MemoryIndexManager & {
      syncing: Promise<void> | null;
      closed: boolean;
      providerInitPromise: Promise<void> | null;
      db: { close: () => void };
      cacheKey: string;
    };

    const searchResult = await MemoryIndexManager.prototype.search.call(managerLike, "   ");
    expect(searchResult).toEqual([]);
    const syncMock = managerLike.sync as ReturnType<typeof vi.fn>;
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(managerLike.syncing).not.toBeNull();

    let closed = false;
    const closePromise = MemoryIndexManager.prototype.close.call(managerLike).then(() => {
      closed = true;
    });

    await Promise.resolve();
    expect(closed).toBe(false);

    releaseSync();
    await closePromise;
    expect(closeDb).toHaveBeenCalledTimes(1);
  });
});
