import {
  ProgressBus,
  progressBus,
  type ProgressFrame,
  type ProgressPhase,
} from "openclaw/plugin-sdk/progress";

export type TelegramProgressLogger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
};

export type TelegramProgressBotApi = {
  sendMessage: (
    chatId: number | string,
    text: string,
    opts?: { message_thread_id?: number; disable_notification?: boolean },
  ) => Promise<{ message_id: number } | null | undefined>;
  editMessageText?: (
    chatId: number | string,
    messageId: number,
    text: string,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>;
};

export type TelegramProgressTarget = {
  chatId: number | string;
  messageThreadId?: number;
};

export type TelegramProgressResolver = (
  frame: ProgressFrame,
) => TelegramProgressTarget | null | undefined;

export type TelegramProgressScheduleTimer = (cb: () => void, ms: number) => unknown;
export type TelegramProgressClearTimer = (handle: unknown) => void;

export type CreateTelegramProgressAdapterOptions = {
  getApi: () => TelegramProgressBotApi | null | undefined;
  resolveTarget: TelegramProgressResolver;
  bus?: ProgressBus;
  logger?: TelegramProgressLogger;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Optional timer scheduler used to defer throttled edits. Defaults to setTimeout. */
  scheduleTimer?: TelegramProgressScheduleTimer;
  /** Optional timer canceller paired with `scheduleTimer`. Defaults to clearTimeout. */
  clearTimer?: TelegramProgressClearTimer;
};

export type TelegramProgressAdapterHandle = {
  readonly enabled: boolean;
  unsubscribe: () => void;
};

const STATUS_HEADER = "⏳ openclaw";
const MIN_EDIT_GAP_MS = 150;

const PHASE_LABELS: Record<ProgressPhase, string> = {
  classifying: "classifying request",
  planning: "planning",
  preflight: "preflight",
  ack_deferred: "accepted, working in background",
  tool_call: "tool call",
  producing: "producing",
  streaming: "streaming",
  waiting_user: "waiting for user",
  evidence: "evidence reconciliation",
  done: "done",
  error: "error",
};

function formatFrameText(frame: ProgressFrame): string {
  const label = PHASE_LABELS[frame.phase] ?? frame.phase;
  const parts: string[] = [STATUS_HEADER, `• ${label}`];
  if (frame.detail) {
    parts.push(`  ${frame.detail}`);
  }
  return parts.join("\n");
}

export function isTelegramProgressEnabled(env: NodeJS.ProcessEnv | undefined): boolean {
  const raw = env?.OPENCLAW_PROGRESS_TELEGRAM;
  if (raw === undefined || raw === "") {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no") {
    return false;
  }
  return true;
}

type SessionState = {
  messageId?: number;
  lastText?: string;
  lastEditAt: number;
  chatId?: number | string;
  messageThreadId?: number;
  busy: boolean;
  pendingFrame?: ProgressFrame;
  drainTimer?: unknown;
  sentCount: number;
  editedCount: number;
  skippedCount: number;
};

type SkipReason =
  | "no_api"
  | "no_target"
  | "duplicate_text"
  | "throttled"
  | "edit_failed_no_fallback";

export function createTelegramProgressAdapter(
  options: CreateTelegramProgressAdapterOptions,
): TelegramProgressAdapterHandle {
  const env = options.env ?? process.env;
  const enabled = isTelegramProgressEnabled(env);
  const logger: TelegramProgressLogger = options.logger ?? {
    info: () => {},
    warn: () => {},
  };

  if (!enabled) {
    logger.info("[tg-progress] adapter disabled via OPENCLAW_PROGRESS_TELEGRAM");
    return {
      enabled: false,
      unsubscribe: () => {},
    };
  }

  const bus = options.bus ?? progressBus;
  const now = options.now ?? (() => Date.now());
  const scheduleTimer: TelegramProgressScheduleTimer =
    options.scheduleTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer: TelegramProgressClearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const sessions = new Map<string, SessionState>();

  const sessionLogMeta = (state: SessionState, frame: ProgressFrame) => ({
    sessionId: frame.sessionId,
    channelId: frame.channelId,
    turnId: frame.turnId,
    phase: frame.phase,
    seq: frame.seq,
    messageId: state.messageId,
    sent: state.sentCount,
    edited: state.editedCount,
    skipped: state.skippedCount,
  });

  const logSummary = (state: SessionState, frame: ProgressFrame, reason: string) => {
    logger.info(
      `[tg-progress] sent=${String(state.sentCount)} edited=${String(state.editedCount)} skipped=${String(state.skippedCount)} reason=${reason} phase=${frame.phase}${state.messageId !== undefined ? ` msg_id=${String(state.messageId)}` : ""}`,
      sessionLogMeta(state, frame),
    );
  };

  const recordSkip = (state: SessionState, frame: ProgressFrame, reason: SkipReason) => {
    state.skippedCount += 1;
    logSummary(state, frame, reason);
  };

  const cancelDrainTimer = (state: SessionState) => {
    if (state.drainTimer !== undefined) {
      try {
        clearTimer(state.drainTimer);
      } catch {
        // best-effort
      }
      state.drainTimer = undefined;
    }
  };

  const scheduleDrain = (key: string, delayMs: number) => {
    const state = sessions.get(key);
    if (!state) {
      return;
    }
    cancelDrainTimer(state);
    state.drainTimer = scheduleTimer(() => {
      const current = sessions.get(key);
      if (!current) {
        return;
      }
      current.drainTimer = undefined;
      void drain(key);
    }, Math.max(0, delayMs));
  };

  const performApiCall = async (
    state: SessionState,
    frame: ProgressFrame,
    text: string,
    api: TelegramProgressBotApi,
  ): Promise<void> => {
    const editMessageText = api.editMessageText;
    const canEdit = state.messageId !== undefined && typeof editMessageText === "function";
    if (canEdit && editMessageText) {
      try {
        await editMessageText(state.chatId ?? "", state.messageId as number, text);
        state.editedCount += 1;
        state.lastText = text;
        state.lastEditAt = now();
        logSummary(state, frame, "edit_ok");
        return;
      } catch (err) {
        const errMsg = String((err as Error)?.message ?? err);
        const isNotModified = /not modified|message is not modified/i.test(errMsg);
        if (isNotModified) {
          state.skippedCount += 1;
          state.lastText = text;
          state.lastEditAt = now();
          logger.warn(
            `[tg-progress] edit returned 'not modified': ${errMsg}`,
            sessionLogMeta(state, frame),
          );
          logSummary(state, frame, "edit_not_modified");
          return;
        }
        logger.warn(
          `[tg-progress] edit failed, falling back to send: ${errMsg}`,
          sessionLogMeta(state, frame),
        );
        state.messageId = undefined;
      }
    }

    const sendOpts: { message_thread_id?: number; disable_notification?: boolean } = {
      disable_notification: true,
    };
    if (state.messageThreadId !== undefined) {
      sendOpts.message_thread_id = state.messageThreadId;
    }
    try {
      const sent = await api.sendMessage(state.chatId ?? "", text, sendOpts);
      if (sent && typeof sent.message_id === "number") {
        state.messageId = sent.message_id;
      }
      state.sentCount += 1;
      state.lastText = text;
      state.lastEditAt = now();
      logSummary(state, frame, "send_ok");
    } catch (err) {
      logger.warn(
        `[tg-progress] sendMessage failed: ${String((err as Error)?.message ?? err)}`,
        sessionLogMeta(state, frame),
      );
      logSummary(state, frame, "send_failed");
    }
  };

  const drain = async (key: string): Promise<void> => {
    const state = sessions.get(key);
    if (!state || state.busy) {
      return;
    }
    state.busy = true;
    try {
      while (state.pendingFrame !== undefined) {
        const frame = state.pendingFrame;
        const api = options.getApi();
        if (!api) {
          recordSkip(state, frame, "no_api");
          state.pendingFrame = undefined;
          break;
        }

        const text = formatFrameText(frame);
        const isTerminal = frame.phase === "done" || frame.phase === "error";

        if (state.lastText === text && !isTerminal) {
          recordSkip(state, frame, "duplicate_text");
          state.pendingFrame = undefined;
          continue;
        }

        if (!isTerminal && state.messageId !== undefined) {
          const gap = now() - state.lastEditAt;
          if (gap < MIN_EDIT_GAP_MS) {
            recordSkip(state, frame, "throttled");
            state.busy = false;
            scheduleDrain(key, MIN_EDIT_GAP_MS - gap);
            return;
          }
        }

        state.pendingFrame = undefined;
        await performApiCall(state, frame, text, api);

        if (isTerminal) {
          cancelDrainTimer(state);
          sessions.delete(key);
          return;
        }
      }
    } finally {
      const current = sessions.get(key);
      if (current) {
        current.busy = false;
      }
    }
  };

  const ensureState = (frame: ProgressFrame, target: TelegramProgressTarget): SessionState => {
    const key = `${frame.sessionId}::${frame.channelId}`;
    let state = sessions.get(key);
    if (!state) {
      state = {
        chatId: target.chatId,
        ...(target.messageThreadId !== undefined ? { messageThreadId: target.messageThreadId } : {}),
        lastEditAt: 0,
        busy: false,
        sentCount: 0,
        editedCount: 0,
        skippedCount: 0,
      };
      sessions.set(key, state);
    } else {
      state.chatId = target.chatId;
      if (target.messageThreadId !== undefined) {
        state.messageThreadId = target.messageThreadId;
      }
    }
    return state;
  };

  const onFrame = (frame: ProgressFrame): void => {
    const target = options.resolveTarget(frame);
    if (!target) {
      logger.warn(
        `[tg-progress] no_target for frame phase=${frame.phase} session=${frame.sessionId} channel=${frame.channelId}`,
        {
          sessionId: frame.sessionId,
          channelId: frame.channelId,
          turnId: frame.turnId,
          phase: frame.phase,
          seq: frame.seq,
        },
      );
      return;
    }
    const state = ensureState(frame, target);
    state.pendingFrame = frame;
    const key = `${frame.sessionId}::${frame.channelId}`;
    if (state.busy) {
      return;
    }
    if (state.drainTimer !== undefined) {
      return;
    }
    void drain(key);
  };

  const unsubscribe = bus.subscribeAll(onFrame);
  logger.info("[tg-progress] adapter attached");

  return {
    enabled: true,
    unsubscribe: () => {
      try {
        unsubscribe();
      } finally {
        for (const state of sessions.values()) {
          cancelDrainTimer(state);
        }
        sessions.clear();
        logger.info("[tg-progress] adapter detached");
      }
    },
  };
}
