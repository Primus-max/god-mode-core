import { createSubsystemLogger } from "../logging/subsystem.js";
import { progressBus, type ProgressFrame } from "../platform/progress/progress-bus.js";

const log = createSubsystemLogger("gateway").child("progress");

// Per-session TTL guard: max ~10 fps outgoing broadcast.
const BROADCAST_MIN_GAP_MS = 100;

export type ProgressBridgeDeps = {
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: Set<string> | ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  getSessionEventSubscriberConnIds: () => Set<string> | ReadonlySet<string>;
};

export type ProgressBridgeHandle = {
  unsubscribe: () => void;
};

export function createGatewayProgressBridge(deps: ProgressBridgeDeps): ProgressBridgeHandle {
  const lastBroadcastBySession = new Map<string, number>();
  const droppedBySession = new Map<string, number>();

  const onFrame = (frame: ProgressFrame) => {
    const connIds = deps.getSessionEventSubscriberConnIds();
    if (!connIds || connIds.size === 0) {
      return;
    }

    const sessionKey = `${frame.sessionId}::${frame.channelId}`;
    const phase = frame.phase;
    const isTerminal = phase === "done" || phase === "error";

    if (!isTerminal) {
      const last = lastBroadcastBySession.get(sessionKey) ?? 0;
      const gap = frame.ts - last;
      if (gap < BROADCAST_MIN_GAP_MS) {
        const dropped = (droppedBySession.get(sessionKey) ?? 0) + 1;
        droppedBySession.set(sessionKey, dropped);
        if (dropped === 1) {
          log.warn(
            `[progress] bridge throttled frame session=${frame.sessionId} channel=${frame.channelId} phase=${phase}; min gap=${String(BROADCAST_MIN_GAP_MS)}ms`,
            {
              sessionId: frame.sessionId,
              channelId: frame.channelId,
              turnId: frame.turnId,
              phase,
              minGapMs: BROADCAST_MIN_GAP_MS,
            },
          );
        }
        return;
      }
    }

    lastBroadcastBySession.set(sessionKey, frame.ts);
    const dropped = droppedBySession.get(sessionKey);
    if (isTerminal) {
      if (dropped && dropped > 0) {
        log.info(
          `[progress] bridge session=${frame.sessionId} channel=${frame.channelId} droppedTotal=${String(dropped)}`,
          {
            sessionId: frame.sessionId,
            channelId: frame.channelId,
            turnId: frame.turnId,
            dropped,
          },
        );
      }
      droppedBySession.delete(sessionKey);
      lastBroadcastBySession.delete(sessionKey);
    }

    try {
      deps.broadcastToConnIds("progress.frame", frame, connIds, { dropIfSlow: true });
    } catch (err) {
      log.warn(
        `[progress] bridge broadcast failed: ${String((err as Error)?.message ?? err)}`,
        {
          sessionId: frame.sessionId,
          channelId: frame.channelId,
          turnId: frame.turnId,
        },
      );
    }
  };

  const unsubscribe = progressBus.subscribeAll(onFrame);
  log.info("[progress] gateway bridge attached");

  return {
    unsubscribe: () => {
      try {
        unsubscribe();
      } finally {
        lastBroadcastBySession.clear();
        droppedBySession.clear();
        log.info("[progress] gateway bridge detached");
      }
    },
  };
}
