import type { PlatformRuntimeExecutionReceiptKind } from "../runtime/contracts.js";
import { defaultRuntime } from "../../runtime.js";
import {
  buildIdentityFacts,
  createProducerToolRegistry,
  createTrustedCapabilityRegistry,
  type BuildIdentityFactsOptions,
  type IdentityFacts,
  type ToolRegistry,
  type CapabilityRegistry,
} from "./identity-facts.js";
import {
  probeWorkspace,
  type ProbeWorkspaceOptions,
  type WorkspaceSnapshot,
} from "./workspace-probe.js";

export const INTENT_LEDGER_TTL_MS = 15 * 60 * 1000;
export const INTENT_LEDGER_MAX_ENTRIES = 8;
export const CLARIFY_BUDGET_WINDOW_MS_DEFAULT = 5 * 60 * 1000;
export const WORKSPACE_TTL_MS_DEFAULT = 5 * 60 * 1000;
export const IDENTITY_TTL_MS_DEFAULT = 30 * 60 * 1000;
export const GENERIC_CLARIFY_TOPIC_KEY = "*generic*";
const LEDGER_MAX_CONTEXT_LINES = 3;
const TURN_ID_SHORT_LENGTH = 8;

export type IntentLedgerKind =
  | "awaiting_confirmation"
  | "awaiting_input"
  | "promised_action"
  | "violated_promise"
  | "clarifying"
  | "receipt";

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
  clarifyTopicKey?: string;
  fingerprint?: string;
  successfulReceipts?: SuccessfulIntentReceipt[];
};

export type IntentLedgerRecordParams = {
  turnId: string;
  sessionId: string;
  channelId: string;
  summary: string;
  planOutput?: unknown;
  runtimeReceipts?: unknown;
  ambigs?: string[];
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
  clarifyBudgetWindowMs?: number;
};

export type SuccessfulIntentReceipt = {
  kind: PlatformRuntimeExecutionReceiptKind;
  name: string;
  summary?: string;
  metadata?: Record<string, unknown>;
};

export type IntentLedgerRecentReceiptMatch = {
  entry: IntentLedgerEntry;
  fingerprint: string;
  receipts: SuccessfulIntentReceipt[];
  matchedAt: number;
};

type IntentLedgerSessionState = {
  entries: IntentLedgerEntry[];
  workspace?: WorkspaceSnapshot;
  identity?: IdentityFacts;
};

export type GetOrProbeWorkspaceOptions = Pick<
  ProbeWorkspaceOptions,
  "cwd" | "extraRootsEnv" | "fs" | "readGitInfo"
> & {
  now?: () => number;
  probe?: (options: ProbeWorkspaceOptions) => Promise<WorkspaceSnapshot>;
};

export type GetOrBuildIdentityOptions = {
  personaResolver?: BuildIdentityFactsOptions["personaResolver"];
  toolRegistry?: ToolRegistry;
  capabilityRegistry?: CapabilityRegistry;
  now?: () => number;
  build?: (options: BuildIdentityFactsOptions) => IdentityFacts;
};

const CONFIRMATION_HINT_RE =
  /(подтверд(?:и|ите|ишь|ите)|confirm|confirmation|да\/нет|yes\/no)/i;
const YES_NO_RE = /(?:^|[^\p{L}])(?:да|нет|yes|no)(?=[^\p{L}]|$)/iu;
const INPUT_HINT_RE =
  /(?:^|[^\p{L}])(?:пришл(?:и|ите)|укажи(?:те)?|введи(?:те)?|напиши(?:те)?|send|provide|enter)(?=[^\p{L}]|$)/iu;
const PROMISED_ACTION_RE =
  /(запускаю|начинаем|сейчас\s+сделаю|применяю|running|starting|i\s+will)/i;
const MATCHER_EXEC_RE = /(exec|команд|node|npm|pnpm|test|build|install)/i;
const MATCHER_APPLY_PATCH_RE = /(правк|патч|apply_patch)/i;
const MATCHER_WRITE_RE = /(создам\s+файл|запишу\s+файл)/i;
const DEFAULT_PROMISED_ACTION_RECEIPT_KINDS: PlatformRuntimeExecutionReceiptKind[] = [
  "tool",
  "platform_action",
];

function normalizeClarifyToken(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function clarifyTopicKey(ambigs: string[]): string {
  const words = ambigs
    .flatMap((entry) => normalizeClarifyToken(entry))
    .sort((left, right) => left.localeCompare(right));
  const joined = words.join("|");
  if (!joined) {
    return "";
  }
  return joined.slice(0, 80);
}

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

function normalizeMetadata(record: unknown): Record<string, unknown> | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  return { ...(record as Record<string, unknown>) };
}

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
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

function shortSessionId(sessionId: string): string {
  return shortTurnId(sessionId);
}

function cloneSuccessfulReceipt(receipt: SuccessfulIntentReceipt): SuccessfulIntentReceipt {
  return {
    ...receipt,
    ...(receipt.metadata ? { metadata: { ...receipt.metadata } } : {}),
  };
}

function cloneWorkspaceSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return {
    ...snapshot,
    roots: snapshot.roots.map((root) => ({
      ...root,
      topLevelDirs: [...root.topLevelDirs],
    })),
  };
}

function cloneIdentityFacts(identity: IdentityFacts): IdentityFacts {
  return {
    ...identity,
    availableTools: [...identity.availableTools],
    availableCapabilities: [...identity.availableCapabilities],
  };
}

function hasSessionStateData(state: IntentLedgerSessionState | undefined): boolean {
  if (!state) {
    return false;
  }
  return state.entries.length > 0 || Boolean(state.workspace) || Boolean(state.identity);
}

function isSuccessfulRuntimeReceipt(receipt: unknown): receipt is {
  kind: PlatformRuntimeExecutionReceiptKind;
  name: string;
  status: string;
  summary?: string;
  metadata?: Record<string, unknown>;
} {
  if (!receipt || typeof receipt !== "object") {
    return false;
  }
  const candidate = receipt as {
    kind?: unknown;
    name?: unknown;
    status?: unknown;
    summary?: unknown;
    metadata?: unknown;
  };
  return (
    typeof candidate.kind === "string" &&
    typeof candidate.name === "string" &&
    (candidate.status === "success" || candidate.status === "partial") &&
    (candidate.summary === undefined || typeof candidate.summary === "string") &&
    (candidate.metadata === undefined ||
      (candidate.metadata !== null &&
        typeof candidate.metadata === "object" &&
        !Array.isArray(candidate.metadata)))
  );
}

function extractSuccessfulReceipts(runtimeReceipts: unknown): SuccessfulIntentReceipt[] {
  if (!Array.isArray(runtimeReceipts)) {
    return [];
  }
  return runtimeReceipts
    .filter(isSuccessfulRuntimeReceipt)
    .map((receipt) => ({
      kind: receipt.kind,
      name: receipt.name,
      ...(typeof receipt.summary === "string" && receipt.summary.trim()
        ? { summary: receipt.summary.trim() }
        : {}),
      ...(normalizeMetadata(receipt.metadata) ? { metadata: normalizeMetadata(receipt.metadata) } : {}),
    }));
}

function cloneIntentLedgerEntry(entry: IntentLedgerEntry): IntentLedgerEntry {
  return {
    ...entry,
    ...(entry.receiptMatchers
      ? {
          receiptMatchers: {
            ...(entry.receiptMatchers.receiptKinds
              ? { receiptKinds: [...entry.receiptMatchers.receiptKinds] }
              : {}),
            ...(entry.receiptMatchers.toolNames
              ? { toolNames: [...entry.receiptMatchers.toolNames] }
              : {}),
          },
        }
      : {}),
    ...(entry.successfulReceipts
      ? { successfulReceipts: entry.successfulReceipts.map(cloneSuccessfulReceipt) }
      : {}),
  };
}

export class IntentLedger {
  private readonly sessionState = new Map<string, IntentLedgerSessionState>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clarifyBudgetWindowMs: number;

  constructor(options: IntentLedgerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? INTENT_LEDGER_TTL_MS;
    this.maxEntries = options.maxEntries ?? INTENT_LEDGER_MAX_ENTRIES;
    this.clarifyBudgetWindowMs = options.clarifyBudgetWindowMs ?? CLARIFY_BUDGET_WINDOW_MS_DEFAULT;
  }

  private getOrCreateState(sessionId: string, channelId: string): IntentLedgerSessionState {
    const key = keyFor(sessionId, channelId);
    const existing = this.sessionState.get(key);
    if (existing) {
      return existing;
    }
    const created: IntentLedgerSessionState = { entries: [] };
    this.sessionState.set(key, created);
    return created;
  }

  private resolveWorkspaceTtlMs(): number {
    return resolvePositiveInt(process.env.OPENCLAW_WORKSPACE_TTL_MS, WORKSPACE_TTL_MS_DEFAULT);
  }

  private resolveIdentityTtlMs(): number {
    return resolvePositiveInt(process.env.OPENCLAW_IDENTITY_TTL_MS, IDENTITY_TTL_MS_DEFAULT);
  }

  recordFromBotTurn(params: IntentLedgerRecordParams): IntentLedgerEntry | undefined {
    const summary = normalizeSummary(params.summary);
    const heuristic = classifyBotTurn(summary, params.planOutput);
    const hasAmbigs = Array.isArray(params.ambigs) && params.ambigs.length > 0;
    const successfulReceipts = extractSuccessfulReceipts(params.runtimeReceipts);
    const runtimeFingerprint =
      params.planOutput && typeof params.planOutput === "object"
        ? (params.planOutput as { fingerprint?: unknown }).fingerprint
        : undefined;
    const classified: LedgerClassifierResult = hasAmbigs
      ? { kind: "clarifying", expectsFrom: "user" }
      : heuristic ??
        (successfulReceipts.length > 0 &&
        typeof runtimeFingerprint === "string" &&
        runtimeFingerprint.trim()
          ? { kind: "receipt", expectsFrom: "system" }
          : null);
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
      ...(classified.kind === "clarifying"
        ? {
            clarifyTopicKey:
              Array.isArray(params.ambigs) && params.ambigs.length > 0
                ? clarifyTopicKey(params.ambigs)
                : GENERIC_CLARIFY_TOPIC_KEY,
          }
        : {}),
      ...(typeof runtimeFingerprint === "string" && runtimeFingerprint.trim()
        ? { fingerprint: runtimeFingerprint.trim() }
        : {}),
      ...(successfulReceipts.length > 0 ? { successfulReceipts } : {}),
    };
    const state = this.getOrCreateState(params.sessionId, params.channelId);
    state.entries = [...state.entries, entry].slice(-this.maxEntries);
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
    const state = this.getOrCreateState(params.sessionId, params.channelId);
    state.entries = [...state.entries, entry].slice(-this.maxEntries);
    return entry;
  }

  peekPending(sessionId: string, channelId: string): IntentLedgerEntry[] {
    const key = keyFor(sessionId, channelId);
    const now = this.now();
    const values = this.sessionState.get(key)?.entries ?? [];
    return values
      .filter((entry) => now - entry.createdAt <= entry.ttlMs)
      .map((entry) => cloneIntentLedgerEntry(entry));
  }

  lookupRecentReceipt(params: {
    sessionId: string;
    channelId: string;
    fingerprint: string;
    windowMs?: number;
  }): IntentLedgerRecentReceiptMatch | undefined {
    const fingerprint = params.fingerprint.trim();
    const windowMs = params.windowMs ?? this.ttlMs;
    if (!fingerprint || windowMs <= 0) {
      return undefined;
    }
    const now = this.now();
    const windowStart = now - windowMs;
    const entries = this.peekPending(params.sessionId, params.channelId)
      .filter(
        (entry) =>
          entry.fingerprint === fingerprint &&
          entry.createdAt >= windowStart &&
          (entry.successfulReceipts?.length ?? 0) > 0,
      )
      .toSorted((left, right) => right.createdAt - left.createdAt);
    const entry = entries[0];
    if (!entry || !entry.successfulReceipts?.length) {
      return undefined;
    }
    return {
      entry,
      fingerprint,
      receipts: entry.successfulReceipts.map(cloneSuccessfulReceipt),
      matchedAt: now,
    };
  }

  async getOrProbeWorkspace(
    sessionId: string,
    channelId: string,
    options: GetOrProbeWorkspaceOptions = {},
  ): Promise<WorkspaceSnapshot> {
    const now = options.now?.() ?? this.now();
    const state = this.getOrCreateState(sessionId, channelId);
    if (state.workspace && now - state.workspace.capturedAt <= state.workspace.ttlMs) {
      const cachedSnapshot = cloneWorkspaceSnapshot(state.workspace);
      defaultRuntime.log(
        `[workspace-probe] session=${shortSessionId(sessionId)} roots=${String(cachedSnapshot.roots.length)} probedMs=0 cached=1 skipped=${String(cachedSnapshot.skippedRoots)}`,
      );
      return cachedSnapshot;
    }
    const probe = options.probe ?? probeWorkspace;
    const startedAt = Date.now();
    const snapshot = await probe({
      cwd: options.cwd,
      extraRootsEnv: options.extraRootsEnv,
      fs: options.fs,
      readGitInfo: options.readGitInfo,
      ttlMs: this.resolveWorkspaceTtlMs(),
    });
    const normalized: WorkspaceSnapshot = {
      ...snapshot,
      ttlMs: this.resolveWorkspaceTtlMs(),
    };
    state.workspace = normalized;
    defaultRuntime.log(
      `[workspace-probe] session=${shortSessionId(sessionId)} roots=${String(normalized.roots.length)} probedMs=${String(Date.now() - startedAt)} cached=0 skipped=${String(normalized.skippedRoots)}`,
    );
    return cloneWorkspaceSnapshot(normalized);
  }

  invalidateWorkspace(sessionId: string, channelId: string): boolean {
    const key = keyFor(sessionId, channelId);
    const state = this.sessionState.get(key);
    if (!state?.workspace) {
      return false;
    }
    delete state.workspace;
    if (!hasSessionStateData(state)) {
      this.sessionState.delete(key);
    }
    return true;
  }

  getOrBuildIdentity(
    sessionId: string,
    channelId: string,
    options: GetOrBuildIdentityOptions = {},
  ): IdentityFacts {
    const now = options.now?.() ?? this.now();
    const state = this.getOrCreateState(sessionId, channelId);
    if (state.identity && now - state.identity.capturedAt <= state.identity.ttlMs) {
      return cloneIdentityFacts(state.identity);
    }
    const identityBuilder = options.build ?? buildIdentityFacts;
    const built = identityBuilder({
      personaResolver: options.personaResolver,
      toolRegistry: options.toolRegistry ?? createProducerToolRegistry(),
      capabilityRegistry: options.capabilityRegistry ?? createTrustedCapabilityRegistry(),
      now: () => now,
      ttlMs: this.resolveIdentityTtlMs(),
    });
    const normalized: IdentityFacts = {
      ...built,
      ttlMs: this.resolveIdentityTtlMs(),
    };
    state.identity = normalized;
    return cloneIdentityFacts(normalized);
  }

  peekClarifyCount(
    sessionId: string,
    channelId: string,
    topicKey: string,
  ): { count: number; firstAt?: number; lastAt?: number } {
    const normalizedTopic = topicKey.trim();
    if (!normalizedTopic) {
      return { count: 0 };
    }
    const now = this.now();
    const windowStart = now - this.clarifyBudgetWindowMs;
    const entries = this.peekPending(sessionId, channelId).filter(
      (entry) =>
        entry.kind === "clarifying" &&
        entry.clarifyTopicKey === normalizedTopic &&
        entry.createdAt >= windowStart,
    );
    if (entries.length === 0) {
      return { count: 0 };
    }
    return {
      count: entries.length,
      firstAt: entries[0]?.createdAt,
      lastAt: entries[entries.length - 1]?.createdAt,
    };
  }

  invalidate(entryIdOrPredicate: string | ((entry: IntentLedgerEntry) => boolean)): number {
    let removed = 0;
    for (const [key, state] of this.sessionState.entries()) {
      const values = state.entries;
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
      if (nextValues.length !== values.length) {
        state.entries = nextValues;
      }
      if (!hasSessionStateData(state)) {
        this.sessionState.delete(key);
      }
    }
    return removed;
  }

  debugEntryCount(sessionId: string, channelId: string): number {
    return (this.sessionState.get(keyFor(sessionId, channelId))?.entries ?? []).length;
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
