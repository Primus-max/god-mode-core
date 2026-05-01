import { AsyncLocalStorage } from "node:async_hooks";
import { createSubsystemLogger } from "../../logging/subsystem.js";

export type ProgressPhase =
  | "classifying"
  | "planning"
  | "preflight"
  | "ack_deferred"
  | "tool_call"
  | "producing"
  | "streaming"
  | "waiting_user"
  | "evidence"
  | "done"
  | "error";

export type ProgressFrameMeta = {
  toolName?: string;
  modelAlias?: string;
  violationAction?: string;
  [key: string]: unknown;
};

export type ProgressFrame = {
  sessionId: string;
  channelId: string;
  turnId: string;
  seq: number;
  phase: ProgressPhase;
  detail?: string;
  meta?: ProgressFrameMeta;
  ts: number;
};

export type ProgressFrameSubscriber = (frame: ProgressFrame) => void;

export const PROGRESS_BUS_PER_TURN_LIMIT = 20;
const DETAIL_MAX_LEN = 200;

const log = createSubsystemLogger("progress");

function isBusDisabled(): boolean {
  return process.env.OPENCLAW_PROGRESS_BUS_DISABLED === "1";
}

type TurnCounter = {
  emitted: number;
  dropped: number;
};

export class ProgressBus {
  private readonly targeted = new Map<string, Set<ProgressFrameSubscriber>>();
  private readonly allSubs = new Set<ProgressFrameSubscriber>();
  private readonly turnCounters = new Map<string, TurnCounter>();

  hasSubscribers(sessionId: string, channelId: string): boolean {
    if (this.allSubs.size > 0) {
      return true;
    }
    const set = this.targeted.get(this.keyFor(sessionId, channelId));
    return Boolean(set && set.size > 0);
  }

  publish(frame: ProgressFrame): void {
    if (isBusDisabled()) {
      return;
    }
    const hasAll = this.allSubs.size > 0;
    const key = this.keyFor(frame.sessionId, frame.channelId);
    const targetedSet = this.targeted.get(key);
    const hasTargeted = Boolean(targetedSet && targetedSet.size > 0);
    if (!hasAll && !hasTargeted) {
      // No subscribers: cheap no-op on the hot path.
      // Still manage turn counters for terminal phase cleanup if this bus is somehow tracking us.
      if (frame.phase === "done" || frame.phase === "error") {
        this.turnCounters.delete(frame.turnId);
      }
      return;
    }
    const counter = this.turnCounters.get(frame.turnId) ?? { emitted: 0, dropped: 0 };
    const isTerminal = frame.phase === "done" || frame.phase === "error";
    if (counter.emitted >= PROGRESS_BUS_PER_TURN_LIMIT && !isTerminal) {
      counter.dropped += 1;
      this.turnCounters.set(frame.turnId, counter);
      if (counter.dropped === 1) {
        log.warn(
          `[progress] turn=${frame.turnId} rate-limit exceeded after ${String(PROGRESS_BUS_PER_TURN_LIMIT)} frames; dropping further non-terminal frames`,
          { turnId: frame.turnId, limit: PROGRESS_BUS_PER_TURN_LIMIT },
        );
      }
      return;
    }
    counter.emitted += 1;
    this.turnCounters.set(frame.turnId, counter);
    if (targetedSet) {
      for (const cb of targetedSet) {
        try {
          cb(frame);
        } catch (err) {
          log.warn(`[progress] targeted subscriber threw: ${String((err as Error)?.message ?? err)}`);
        }
      }
    }
    for (const cb of this.allSubs) {
      try {
        cb(frame);
      } catch (err) {
        log.warn(`[progress] subscribeAll subscriber threw: ${String((err as Error)?.message ?? err)}`);
      }
    }
    if (isTerminal) {
      if (counter.dropped > 0) {
        log.info(
          `[progress] turn=${frame.turnId} droppedTotal=${String(counter.dropped)}`,
          { turnId: frame.turnId, dropped: counter.dropped },
        );
      }
      this.turnCounters.delete(frame.turnId);
    }
  }

  subscribe(
    sessionId: string,
    channelId: string,
    cb: ProgressFrameSubscriber,
  ): () => void {
    const key = this.keyFor(sessionId, channelId);
    let set = this.targeted.get(key);
    if (!set) {
      set = new Set();
      this.targeted.set(key, set);
    }
    set.add(cb);
    return () => {
      const current = this.targeted.get(key);
      if (!current) {
        return;
      }
      current.delete(cb);
      if (current.size === 0) {
        this.targeted.delete(key);
      }
    };
  }

  subscribeAll(cb: ProgressFrameSubscriber): () => void {
    this.allSubs.add(cb);
    return () => {
      this.allSubs.delete(cb);
    };
  }

  resetForTests(): void {
    this.targeted.clear();
    this.allSubs.clear();
    this.turnCounters.clear();
  }

  private keyFor(sessionId: string, channelId: string): string {
    return `${sessionId}::${channelId}`;
  }
}

export const progressBus = new ProgressBus();

export type TurnProgressEmitter = {
  readonly sessionId: string;
  readonly channelId: string;
  readonly turnId: string;
  readonly finalized: boolean;
  emit(phase: ProgressPhase, detail?: string, meta?: ProgressFrameMeta): void;
  done(detail?: string, meta?: ProgressFrameMeta): void;
  error(err: unknown, meta?: ProgressFrameMeta): void;
};

function truncateDetail(detail: string | undefined): string | undefined {
  if (typeof detail !== "string") {
    return undefined;
  }
  const trimmed = detail.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length <= DETAIL_MAX_LEN) {
    return trimmed;
  }
  return `${trimmed.slice(0, DETAIL_MAX_LEN - 1)}…`;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || "error";
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function createTurnProgressEmitter(params: {
  sessionId: string;
  channelId: string;
  turnId: string;
  bus?: ProgressBus;
  now?: () => number;
}): TurnProgressEmitter {
  const bus = params.bus ?? progressBus;
  const now = params.now ?? (() => Date.now());
  let seq = 0;
  let finalized = false;

  const publish = (phase: ProgressPhase, rawDetail?: string, meta?: ProgressFrameMeta) => {
    if (finalized) {
      return;
    }
    if (isBusDisabled()) {
      if (phase === "done" || phase === "error") {
        finalized = true;
      }
      return;
    }
    if (phase === "done" || phase === "error") {
      finalized = true;
    }
    seq += 1;
    const detail = truncateDetail(rawDetail);
    const frame: ProgressFrame = {
      sessionId: params.sessionId,
      channelId: params.channelId,
      turnId: params.turnId,
      seq,
      phase,
      ts: now(),
      ...(detail !== undefined ? { detail } : {}),
      ...(meta ? { meta } : {}),
    };
    const logMeta: Record<string, unknown> = {
      turnId: params.turnId,
      sessionId: params.sessionId,
      channelId: params.channelId,
      seq,
      phase,
    };
    if (detail) {
      logMeta.detail = detail;
    }
    if (meta?.toolName) {
      logMeta.toolName = meta.toolName;
    }
    if (meta?.violationAction) {
      logMeta.violationAction = meta.violationAction;
    }
    const toolNameSegment = meta?.toolName ? ` toolName=${meta.toolName}` : "";
    const detailSegment = detail ? ` detail=${detail}` : "";
    log.info(
      `[progress] turn=${params.turnId} seq=${String(seq)} phase=${phase}${toolNameSegment}${detailSegment}`,
      logMeta,
    );
    bus.publish(frame);
  };

  return {
    sessionId: params.sessionId,
    channelId: params.channelId,
    turnId: params.turnId,
    get finalized(): boolean {
      return finalized;
    },
    emit(phase, detail, meta) {
      publish(phase, detail, meta);
    },
    done(detail, meta) {
      publish("done", detail, meta);
    },
    error(err, meta) {
      publish("error", describeError(err), meta);
    },
  };
}

const turnEmitterStore = new AsyncLocalStorage<TurnProgressEmitter>();

export function withTurnProgressEmitter<T>(emitter: TurnProgressEmitter, fn: () => T): T {
  return turnEmitterStore.run(emitter, fn);
}

export function getCurrentTurnProgressEmitter(): TurnProgressEmitter | undefined {
  return turnEmitterStore.getStore();
}
