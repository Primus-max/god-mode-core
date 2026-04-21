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

export type CreateTelegramProgressAdapterOptions = {
  getApi: () => TelegramProgressBotApi | null | undefined;
  resolveTarget: TelegramProgressResolver;
  bus?: ProgressBus;
  logger?: TelegramProgressLogger;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
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
  sending: boolean;
  pendingFrame?: ProgressFrame;
};

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
    logger.info("[progress] telegram adapter disabled via OPENCLAW_PROGRESS_TELEGRAM");
    return {
      enabled: false,
      unsubscribe: () => {},
    };
  }

  const bus = options.bus ?? progressBus;
  const now = options.now ?? (() => Date.now());
  const sessions = new Map<string, SessionState>();

  const processFrame = async (frame: ProgressFrame): Promise<void> => {
    const api = options.getApi();
    if (!api) {
      return;
    }
    const target = options.resolveTarget(frame);
    if (!target) {
      return;
    }
    const key = `${frame.sessionId}::${frame.channelId}`;
    let state = sessions.get(key);
    if (!state) {
      state = {
        chatId: target.chatId,
        ...(target.messageThreadId !== undefined ? { messageThreadId: target.messageThreadId } : {}),
        lastEditAt: 0,
        sending: false,
      };
      sessions.set(key, state);
    } else {
      state.chatId = target.chatId;
      if (target.messageThreadId !== undefined) {
        state.messageThreadId = target.messageThreadId;
      }
    }

    const text = formatFrameText(frame);
    const isTerminal = frame.phase === "done" || frame.phase === "error";

    if (state.lastText === text && !isTerminal) {
      return;
    }

    if (!isTerminal) {
      const gap = now() - state.lastEditAt;
      if (state.messageId !== undefined && gap < MIN_EDIT_GAP_MS) {
        state.pendingFrame = frame;
        return;
      }
    }

    state.pendingFrame = undefined;
    state.lastText = text;
    state.lastEditAt = now();

    try {
      if (state.messageId !== undefined && typeof api.editMessageText === "function") {
        await api.editMessageText(state.chatId ?? target.chatId, state.messageId, text);
      } else {
        const sendOpts: { message_thread_id?: number; disable_notification?: boolean } = {
          disable_notification: true,
        };
        if (state.messageThreadId !== undefined) {
          sendOpts.message_thread_id = state.messageThreadId;
        }
        const sent = await api.sendMessage(state.chatId ?? target.chatId, text, sendOpts);
        if (sent && typeof sent.message_id === "number") {
          state.messageId = sent.message_id;
        }
      }
    } catch (err) {
      logger.warn(
        `[progress] telegram adapter send/edit failed: ${String((err as Error)?.message ?? err)}`,
        {
          sessionId: frame.sessionId,
          channelId: frame.channelId,
          turnId: frame.turnId,
          phase: frame.phase,
        },
      );
    }

    if (isTerminal) {
      sessions.delete(key);
    }
  };

  const onFrame = (frame: ProgressFrame): void => {
    const key = `${frame.sessionId}::${frame.channelId}`;
    const existing = sessions.get(key);
    if (existing?.sending) {
      existing.pendingFrame = frame;
      return;
    }
    const state = existing ?? {
      lastEditAt: 0,
      sending: false,
    };
    if (!existing) {
      sessions.set(key, state);
    }
    state.sending = true;
    void (async () => {
      try {
        await processFrame(frame);
        while (state.pendingFrame) {
          const next = state.pendingFrame;
          state.pendingFrame = undefined;
          await processFrame(next);
        }
      } finally {
        const current = sessions.get(key);
        if (current) {
          current.sending = false;
        }
      }
    })();
  };

  const unsubscribe = bus.subscribeAll(onFrame);
  logger.info("[progress] telegram adapter attached");

  return {
    enabled: true,
    unsubscribe: () => {
      try {
        unsubscribe();
      } finally {
        sessions.clear();
        logger.info("[progress] telegram adapter detached");
      }
    },
  };
}
