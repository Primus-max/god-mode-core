import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import { applyQueueRuntimeSettings } from "../../../utils/queue-helpers.js";
import type { FollowupRun, QueueDropPolicy, QueueMode, QueueSettings } from "./types.js";

export type DeferredJobStatus = "queued" | "running" | "done" | "failed";

export type DeferredJobState = {
  turnId: string;
  status: DeferredJobStatus;
  startedAt: number;
  completedAt?: number;
  ackMessage?: string;
};

export type FollowupQueueState = {
  items: FollowupRun[];
  draining: boolean;
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  lastRun?: FollowupRun["run"];
  /**
   * Optional background job state for ack-then-defer dispatcher (P1.4 D.2).
   * When present with `status="running"`, new user-message runs on the same
   * queue key are routed through the steer/enqueue-followup path by
   * {@link resolveActiveRunQueueAction}, instead of creating a parallel turn.
   */
  deferredJob?: DeferredJobState;
};

export const DEFAULT_QUEUE_DEBOUNCE_MS = 1000;
export const DEFAULT_QUEUE_CAP = 20;
export const DEFAULT_QUEUE_DROP: QueueDropPolicy = "summarize";

/**
 * Share followup queues across bundled chunks so busy-session enqueue/drain
 * logic observes one queue registry per process.
 */
const FOLLOWUP_QUEUES_KEY = Symbol.for("openclaw.followupQueues");
const PERSISTED_FOLLOWUP_QUEUES_FILENAME = "followup-semantic-queues.json";
let didRehydratePersistedQueues = false;

export const FOLLOWUP_QUEUES = resolveGlobalMap<string, FollowupQueueState>(FOLLOWUP_QUEUES_KEY);

type PersistedFollowupQueueStore = {
  version: 1;
  queues: Array<{
    key: string;
    items: FollowupRun[];
    lastEnqueuedAt: number;
    mode: QueueMode;
    debounceMs: number;
    cap: number;
    dropPolicy: QueueDropPolicy;
    summaryLines: string[];
    lastRun?: FollowupRun["run"];
  }>;
};

function resolvePersistedFollowupQueuesPath(): string {
  return path.join(resolveStateDir(process.env), PERSISTED_FOLLOWUP_QUEUES_FILENAME);
}

function isPersistedAutomationRun(run: FollowupRun): boolean {
  return run.automation?.persisted === true;
}

function ensurePersistedQueuesRehydrated(): void {
  if (didRehydratePersistedQueues) {
    return;
  }
  didRehydratePersistedQueues = true;
  try {
    const raw = fs.readFileSync(resolvePersistedFollowupQueuesPath(), "utf8");
    const parsed = JSON.parse(raw) as PersistedFollowupQueueStore;
    if (parsed?.version !== 1 || !Array.isArray(parsed.queues)) {
      return;
    }
    for (const entry of parsed.queues) {
      if (!entry || typeof entry.key !== "string" || entry.key.trim().length === 0) {
        continue;
      }
      if (FOLLOWUP_QUEUES.has(entry.key)) {
        continue;
      }
      FOLLOWUP_QUEUES.set(entry.key, {
        items: Array.isArray(entry.items) ? entry.items.filter(isPersistedAutomationRun) : [],
        draining: false,
        lastEnqueuedAt:
          typeof entry.lastEnqueuedAt === "number" && Number.isFinite(entry.lastEnqueuedAt)
            ? entry.lastEnqueuedAt
            : 0,
        mode: entry.mode,
        debounceMs: entry.debounceMs,
        cap: entry.cap,
        dropPolicy: entry.dropPolicy,
        droppedCount: 0,
        summaryLines: Array.isArray(entry.summaryLines) ? entry.summaryLines : [],
        lastRun: entry.lastRun,
      });
    }
  } catch {
    // Ignore missing or malformed persistence files.
  }
}

export function syncPersistedFollowupQueues(): void {
  ensurePersistedQueuesRehydrated();
  const queues = Array.from(FOLLOWUP_QUEUES.entries())
    .map(([key, queue]) => {
      const persistedItems = queue.items.filter(isPersistedAutomationRun);
      if (persistedItems.length === 0) {
        return undefined;
      }
      return {
        key,
        items: persistedItems,
        lastEnqueuedAt: queue.lastEnqueuedAt,
        mode: queue.mode,
        debounceMs: queue.debounceMs,
        cap: queue.cap,
        dropPolicy: queue.dropPolicy,
        summaryLines: queue.summaryLines,
        lastRun: queue.lastRun,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  const filePath = resolvePersistedFollowupQueuesPath();
  try {
    if (queues.length === 0) {
      fs.rmSync(filePath, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({ version: 1, queues } satisfies PersistedFollowupQueueStore, null, 2),
      "utf8",
    );
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Persistence is best-effort; in-memory queue behavior remains canonical.
  }
}

export function resetPersistedFollowupQueuesForTests(): void {
  didRehydratePersistedQueues = false;
  try {
    fs.rmSync(resolvePersistedFollowupQueuesPath(), { force: true });
  } catch {
    // Ignore test cleanup failures.
  }
}

export function resetInMemoryFollowupQueuesForTests(params?: { keepPersisted?: boolean }): void {
  FOLLOWUP_QUEUES.clear();
  didRehydratePersistedQueues = false;
  if (params?.keepPersisted) {
    return;
  }
  resetPersistedFollowupQueuesForTests();
}

export function getExistingFollowupQueue(key: string): FollowupQueueState | undefined {
  ensurePersistedQueuesRehydrated();
  const cleaned = key.trim();
  if (!cleaned) {
    return undefined;
  }
  return FOLLOWUP_QUEUES.get(cleaned);
}

export function listExistingFollowupQueues(): Array<{ key: string; queue: FollowupQueueState }> {
  ensurePersistedQueuesRehydrated();
  return Array.from(FOLLOWUP_QUEUES.entries()).map(([key, queue]) => ({ key, queue }));
}

export function getFollowupQueue(key: string, settings: QueueSettings): FollowupQueueState {
  ensurePersistedQueuesRehydrated();
  const existing = FOLLOWUP_QUEUES.get(key);
  if (existing) {
    applyQueueRuntimeSettings({
      target: existing,
      settings,
    });
    return existing;
  }

  const created: FollowupQueueState = {
    items: [],
    draining: false,
    lastEnqueuedAt: 0,
    mode: settings.mode,
    debounceMs:
      typeof settings.debounceMs === "number"
        ? Math.max(0, settings.debounceMs)
        : DEFAULT_QUEUE_DEBOUNCE_MS,
    cap:
      typeof settings.cap === "number" && settings.cap > 0
        ? Math.floor(settings.cap)
        : DEFAULT_QUEUE_CAP,
    dropPolicy: settings.dropPolicy ?? DEFAULT_QUEUE_DROP,
    droppedCount: 0,
    summaryLines: [],
  };
  applyQueueRuntimeSettings({
    target: created,
    settings,
  });
  FOLLOWUP_QUEUES.set(key, created);
  return created;
}

/**
 * Returns true when a deferred bg-job is currently running for this queue key.
 * Used by {@link resolveActiveRunQueueAction} to route new user messages to
 * steer/enqueue-followup while the background job owns the turn.
 */
export function isDeferredJobRunningForQueue(key: string): boolean {
  const queue = getExistingFollowupQueue(key);
  return queue?.deferredJob?.status === "running";
}

export function markDeferredJobRunning(
  key: string,
  params: {
    turnId: string;
    ackMessage?: string;
    startedAt?: number;
  },
): void {
  ensurePersistedQueuesRehydrated();
  const cleaned = key.trim();
  if (!cleaned) {
    return;
  }
  let queue = FOLLOWUP_QUEUES.get(cleaned);
  if (!queue) {
    queue = {
      items: [],
      draining: false,
      lastEnqueuedAt: 0,
      mode: "deferred_job",
      debounceMs: DEFAULT_QUEUE_DEBOUNCE_MS,
      cap: DEFAULT_QUEUE_CAP,
      dropPolicy: DEFAULT_QUEUE_DROP,
      droppedCount: 0,
      summaryLines: [],
    };
    FOLLOWUP_QUEUES.set(cleaned, queue);
  }
  queue.deferredJob = {
    turnId: params.turnId,
    status: "running",
    startedAt: params.startedAt ?? Date.now(),
    ...(params.ackMessage ? { ackMessage: params.ackMessage } : {}),
  };
}

export function markDeferredJobComplete(
  key: string,
  params: { turnId: string; status: "done" | "failed"; completedAt?: number },
): void {
  const queue = getExistingFollowupQueue(key);
  if (!queue || !queue.deferredJob) {
    return;
  }
  if (queue.deferredJob.turnId !== params.turnId) {
    return;
  }
  queue.deferredJob = {
    ...queue.deferredJob,
    status: params.status,
    completedAt: params.completedAt ?? Date.now(),
  };
}

export function clearDeferredJob(key: string): void {
  const queue = getExistingFollowupQueue(key);
  if (!queue) {
    return;
  }
  queue.deferredJob = undefined;
}

export function clearFollowupQueue(key: string): number {
  ensurePersistedQueuesRehydrated();
  const cleaned = key.trim();
  const queue = getExistingFollowupQueue(cleaned);
  if (!queue) {
    return 0;
  }
  const cleared = queue.items.length + queue.droppedCount;
  queue.items.length = 0;
  queue.droppedCount = 0;
  queue.summaryLines = [];
  queue.lastRun = undefined;
  queue.lastEnqueuedAt = 0;
  FOLLOWUP_QUEUES.delete(cleaned);
  syncPersistedFollowupQueues();
  return cleared;
}
