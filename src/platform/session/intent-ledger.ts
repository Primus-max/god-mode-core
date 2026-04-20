import type { PlatformRuntimeExecutionReceiptKind } from "../runtime/contracts.js";

export const INTENT_LEDGER_TTL_MS = 15 * 60 * 1000;
export const INTENT_LEDGER_MAX_ENTRIES = 8;
const LEDGER_MAX_CONTEXT_LINES = 3;
const TURN_ID_SHORT_LENGTH = 8;

export type IntentLedgerKind =
  | "awaiting_confirmation"
  | "awaiting_input"
  | "promised_action"
  | "violated_promise"
  | "clarifying";

export type IntentLedgerExpectsFrom = "user" | "system";

export type IntentLedgerReceiptMatchers = {
  receiptKinds?: PlatformRuntimeExecutionReceiptKind[];
  toolNames?: string[];
};

export type IntentLedgerEntry = {
  id: string;
  turnId: string;
  sessionId: string;
  channelId: string;
  kind: IntentLedgerKind;
  summary: string;
  expectsFrom: IntentLedgerExpectsFrom;
  createdAt: number;
  ttlMs: number;
  receiptMatchers?: IntentLedgerReceiptMatchers;
};

export type IntentLedgerRecordParams = {
  turnId: string;
  sessionId: string;
  channelId: string;
  summary: string;
  planOutput?: unknown;
  runtimeReceipts?: unknown;
  createdAt?: number;
};

type LedgerClassifierResult = {
  kind: IntentLedgerKind;
  expectsFrom: IntentLedgerExpectsFrom;
} | null;

type IntentLedgerOptions = {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
};

const CONFIRMATION_HINT_RE =
  /(подтверд(?:и|ите|ишь|ите)|confirm|confirmation|да\/нет|yes\/no)/i;
const YES_NO_RE = /(да|нет|yes|no)/i;
const INPUT_HINT_RE = /(пришли|укажи|введи|send|provide|enter)/i;
const PROMISED_ACTION_RE =
  /(запускаю|начинаем|сейчас\s+сделаю|применяю|running|starting|i\s+will)/i;
const MATCHER_EXEC_RE = /(exec|команд|node|npm|pnpm|test|build|install)/i;
const MATCHER_APPLY_PATCH_RE = /(правк|патч|apply_patch)/i;
const MATCHER_WRITE_RE = /(создам\s+файл|запишу\s+файл)/i;
const DEFAULT_PROMISED_ACTION_RECEIPT_KINDS: PlatformRuntimeExecutionReceiptKind[] = [
  "tool",
  "platform_action",
];

function inferPromisedActionMatchers(summary: string): IntentLedgerReceiptMatchers {
  const receiptKinds = [...DEFAULT_PROMISED_ACTION_RECEIPT_KINDS];
  if (MATCHER_EXEC_RE.test(summary)) {
    return { receiptKinds, toolNames: ["exec"] };
  }
  if (MATCHER_APPLY_PATCH_RE.test(summary)) {
    return { receiptKinds, toolNames: ["apply_patch"] };
  }
  if (MATCHER_WRITE_RE.test(summary)) {
    return { receiptKinds, toolNames: ["write"] };
  }
  return { receiptKinds };
}

function normalizeSummary(summary: string): string {
  return summary.replace(/\s+/g, " ").trim();
}

function keyFor(sessionId: string, channelId: string): string {
  return `${sessionId}::${channelId}`;
}

function extractRequiresTools(planOutput: unknown): boolean {
  if (!planOutput || typeof planOutput !== "object") {
    return false;
  }
  const direct = (planOutput as { requiresTools?: unknown }).requiresTools;
  if (typeof direct === "boolean") {
    return direct;
  }
  const nested = (planOutput as { executionContract?: { requiresTools?: unknown } }).executionContract
    ?.requiresTools;
  return typeof nested === "boolean" ? nested : false;
}

function classifyBotTurn(summary: string, planOutput: unknown): LedgerClassifierResult {
  const normalized = normalizeSummary(summary);
  if (!normalized) {
    return null;
  }
  const hasQuestionMark = normalized.includes("?");
  if (hasQuestionMark && normalized.length <= 350) {
    if (CONFIRMATION_HINT_RE.test(normalized) || YES_NO_RE.test(normalized)) {
      return { kind: "awaiting_confirmation", expectsFrom: "user" };
    }
    if (INPUT_HINT_RE.test(normalized)) {
      return { kind: "awaiting_input", expectsFrom: "user" };
    }
    return { kind: "clarifying", expectsFrom: "user" };
  }
  if (PROMISED_ACTION_RE.test(normalized) && !extractRequiresTools(planOutput)) {
    return { kind: "promised_action", expectsFrom: "system" };
  }
  return null;
}

function truncateSummary(summary: string, maxLength = 220): string {
  const normalized = normalizeSummary(summary);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function shortTurnId(turnId: string): string {
  const compact = turnId.trim();
  return compact.length <= TURN_ID_SHORT_LENGTH ? compact : compact.slice(0, TURN_ID_SHORT_LENGTH);
}

export class IntentLedger {
  private readonly entries = new Map<string, IntentLedgerEntry[]>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: IntentLedgerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? INTENT_LEDGER_TTL_MS;
    this.maxEntries = options.maxEntries ?? INTENT_LEDGER_MAX_ENTRIES;
  }

  recordFromBotTurn(params: IntentLedgerRecordParams): IntentLedgerEntry | undefined {
    const summary = normalizeSummary(params.summary);
    const classified = classifyBotTurn(summary, params.planOutput);
    if (!classified) {
      return undefined;
    }
    const createdAt = params.createdAt ?? this.now();
    const truncated = truncateSummary(summary);
    const entry: IntentLedgerEntry = {
      id: `${params.turnId}:${String(createdAt)}`,
      turnId: params.turnId,
      sessionId: params.sessionId,
      channelId: params.channelId,
      kind: classified.kind,
      summary: truncated,
      expectsFrom: classified.expectsFrom,
      createdAt,
      ttlMs: this.ttlMs,
      ...(classified.kind === "promised_action"
        ? { receiptMatchers: inferPromisedActionMatchers(truncated) }
        : {}),
    };
    const key = keyFor(params.sessionId, params.channelId);
    const next = [...(this.entries.get(key) ?? []), entry].slice(-this.maxEntries);
    this.entries.set(key, next);
    return entry;
  }

  recordViolatedPromise(params: {
    turnId: string;
    sessionId: string;
    channelId: string;
    summary: string;
    receiptMatchers?: IntentLedgerReceiptMatchers;
    createdAt?: number;
  }): IntentLedgerEntry {
    const createdAt = params.createdAt ?? this.now();
    const entry: IntentLedgerEntry = {
      id: `${params.turnId}:violated:${String(createdAt)}`,
      turnId: params.turnId,
      sessionId: params.sessionId,
      channelId: params.channelId,
      kind: "violated_promise",
      summary: truncateSummary(params.summary),
      expectsFrom: "system",
      createdAt,
      ttlMs: this.ttlMs,
      ...(params.receiptMatchers ? { receiptMatchers: params.receiptMatchers } : {}),
    };
    const key = keyFor(params.sessionId, params.channelId);
    const next = [...(this.entries.get(key) ?? []), entry].slice(-this.maxEntries);
    this.entries.set(key, next);
    return entry;
  }

  peekPending(sessionId: string, channelId: string): IntentLedgerEntry[] {
    const key = keyFor(sessionId, channelId);
    const now = this.now();
    const values = this.entries.get(key) ?? [];
    return values.filter((entry) => now - entry.createdAt <= entry.ttlMs).map((entry) => ({ ...entry }));
  }

  invalidate(entryIdOrPredicate: string | ((entry: IntentLedgerEntry) => boolean)): number {
    let removed = 0;
    for (const [key, values] of this.entries.entries()) {
      const nextValues = values.filter((entry) => {
        const shouldRemove =
          typeof entryIdOrPredicate === "string"
            ? entry.id === entryIdOrPredicate
            : entryIdOrPredicate(entry);
        if (shouldRemove) {
          removed += 1;
        }
        return !shouldRemove;
      });
      if (nextValues.length === 0) {
        this.entries.delete(key);
      } else if (nextValues.length !== values.length) {
        this.entries.set(key, nextValues);
      }
    }
    return removed;
  }

  debugEntryCount(sessionId: string, channelId: string): number {
    return (this.entries.get(keyFor(sessionId, channelId)) ?? []).length;
  }
}

export function buildIntentLedgerContext(entries: IntentLedgerEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  const lastEntries = entries.slice(-LEDGER_MAX_CONTEXT_LINES);
  return lastEntries
    .map((entry) => `${shortTurnId(entry.turnId)} ${entry.kind}: "${truncateSummary(entry.summary, 120)}"`)
    .join("\n");
}

export const intentLedger = new IntentLedger();
