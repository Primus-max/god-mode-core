/**
 * Parent-side aggregation gate for subagent continuation spawn'ов.
 *
 * Cs.: `aggregation-policy.ts` — invariant module + helpers.
 *      `subagent-announce.ts::tryDeliverVerbatimToUserChannel` — verbatim path.
 *
 * Закрывает audit gaps O1 / O2 / O3 (sub-plan §4 #2). Гарантирует, что при
 * spawn'е continuation worker'а в том же user-turn'е parent НЕ публикует
 * раннюю partial-сводку: payloads parent'а заменяются ОДНИМ
 * holding-сообщением через delivery layer без повторного LLM-pass'а.
 *
 * Hard invariants (`.cursor/rules/commitment-kernel-invariants.mdc`):
 *   - #5 / #6: gate не парсит prompt-text. Решение принимается по
 *     `executionReceipts[].name === "sessions_spawn"` (typed enum значение,
 *     не текст), `SubagentRunRecord.spawnMode/expectsCompletionMessage` и
 *     literal-полям `DeliveryContext`.
 *   - #11: пять frozen decision contracts не затронуты.
 */

import {
  listSubagentRunsForRequester,
  type SubagentRunRecord,
} from "../../agents/subagent-registry.js";
import type { PlatformRuntimeExecutionReceipt } from "../../platform/runtime/contracts.js";
import { defaultRuntime } from "../../runtime.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import type { ReplyPayload } from "../types.js";
import {
  type AggregationModeConfig,
  buildHoldingIdempotencyKey,
  buildPendingChildHoldingIdempotencyKey,
  decideAggregationMode,
  formatAggregationLog,
  hasUserChannelTarget,
  HOLDING_MESSAGE_TEXT,
  PENDING_CHILD_HOLDING_MESSAGE_TEXT,
  type SpawnTurnSignal,
} from "./aggregation-policy.js";

/**
 * Окно (мс) для квалификации spawn'а как «current-turn».
 *
 * Реальные turn-ы (включая первый прогон persistent_worker'а) укладываются
 * в десятки секунд; ставим 5 минут как верхнюю безопасную границу. Если
 * spawn в registry старше этого значения, не считаем его аггрегационным
 * сигналом для текущего parent reply (защита от ложного срабатывания на
 * легаси active-children'ах).
 */
const CURRENT_TURN_WINDOW_MS = 5 * 60 * 1000;

/**
 * Cross-turn lookback (PR-G `commitment_kernel_subagent_await.plan.md`).
 *
 * Для cross-turn pending-child gate'а допускается более длительное окно,
 * чем in-turn (`CURRENT_TURN_WINDOW_MS`): persistent worker'ы могут
 * продолжать работу несколько минут поверх первого turn'а.
 */
const PENDING_CHILD_LOOKBACK_MS = 10 * 60 * 1000;

/**
 * Mandatory timeout per (parent, child) pair: если child running дольше
 * этого окна И уже было ≥ 2 holding'а в окне, gate уступает дорогу
 * (passthrough) и эмиттит telemetry `pending_child_timeout`.
 */
const PENDING_CHILD_TIMEOUT_MS = 120_000;

/**
 * Idempotency window: повторное срабатывание gate'а на ту же пару
 * (parentSessionKey, childRunId) в пределах этого окна → один holding,
 * не два.
 */
const PENDING_CHILD_IDEMPOTENCY_MS = 30_000;

/**
 * Окно сбора истории holding'ов на одну (parent, child) пару, по которому
 * считается `holdingsInWindow` для timeout-rule (≥ 2 → fall back).
 */
const PENDING_CHILD_HOLDING_HISTORY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Минимальная shape parent-run-result'а, нужная гейту. Совпадает с тем
 * что возвращает `runEmbeddedPiAgent` — `EmbeddedPiRunResult`. Берём
 * только поле, которое читаем (execution receipts из meta'ы). Не
 * привязываемся к точному типу runtime'а, чтобы не тащить лишних
 * импортов в `agent-runner.ts`.
 */
export type RunResultProbe = {
  meta?: {
    executionVerification?: {
      receipts?: ReadonlyArray<PlatformRuntimeExecutionReceipt>;
    };
  };
};

function detectSpawnToolInvocation(runResult: RunResultProbe): boolean {
  const receipts = runResult.meta?.executionVerification?.receipts ?? [];
  for (const receipt of receipts) {
    if (
      receipt.kind === "tool" &&
      receipt.name === "sessions_spawn" &&
      receipt.status === "success"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Из active children parent'а отбирает запись с самым свежим `createdAt`,
 * относящуюся к текущему turn'у (создана не позже `CURRENT_TURN_WINDOW_MS`
 * назад) и являющуюся continuation'ом (persistent / followup).
 */
function findCurrentTurnContinuationChild(
  parentSessionKey: string,
  nowMs: number,
): SubagentRunRecord | undefined {
  let best: SubagentRunRecord | undefined;
  const records = listSubagentRunsForRequester(parentSessionKey);
  for (const record of records) {
    if (typeof record.endedAt === "number") {
      continue;
    }
    if (typeof record.createdAt !== "number") {
      continue;
    }
    if (nowMs - record.createdAt > CURRENT_TURN_WINDOW_MS) {
      continue;
    }
    const isPersistent = record.spawnMode === "session";
    const isFollowupExpectingCompletion =
      record.spawnMode === "run" && record.expectsCompletionMessage === true;
    if (!isPersistent && !isFollowupExpectingCompletion) {
      continue;
    }
    if (!best || record.createdAt > best.createdAt) {
      best = record;
    }
  }
  return best;
}

export type AggregationOverrideResult =
  | {
      kind: "passthrough";
    }
  | {
      kind: "holding";
      payloads: ReplyPayload[];
      childSessionKey: string;
      childRunId: string;
      label?: string;
      idempotencyKey: string;
    };

/**
 * Принимает решение, нужно ли подменить payload-массив parent'а на
 * holding-сообщение. Не делает доставку (это не задача run-builder'а);
 * caller просто использует возвращённые payloads вместо runResult.payloads.
 *
 * Sub-plan §4 #2 default = Option A `holding`. Опция `await` зарезервирована
 * за future cron/persistent_worker push sub-plan'ом (Bug F).
 */
export function evaluateAggregationOverride(params: {
  runResult: RunResultProbe;
  parentSessionKey: string | undefined;
  userChannelOrigin: DeliveryContext | undefined;
  configMode?: AggregationModeConfig;
  nowMs?: number;
}): AggregationOverrideResult {
  const parentSessionKey = (params.parentSessionKey ?? "").trim();
  if (!parentSessionKey) {
    return { kind: "passthrough" };
  }
  if (!hasUserChannelTarget(params.userChannelOrigin)) {
    return { kind: "passthrough" };
  }
  if (!detectSpawnToolInvocation(params.runResult)) {
    return { kind: "passthrough" };
  }
  const nowMs = params.nowMs ?? Date.now();
  const continuationChild = findCurrentTurnContinuationChild(parentSessionKey, nowMs);
  if (!continuationChild) {
    return { kind: "passthrough" };
  }
  const spawn: SpawnTurnSignal = {
    accepted: true,
    ...(continuationChild.spawnMode ? { mode: continuationChild.spawnMode } : {}),
    ...(continuationChild.expectsCompletionMessage !== undefined
      ? { expectsCompletionMessage: continuationChild.expectsCompletionMessage }
      : {}),
    ...(continuationChild.childSessionKey
      ? { childSessionKey: continuationChild.childSessionKey }
      : {}),
    ...(continuationChild.label ? { label: continuationChild.label } : {}),
  };
  const decision = decideAggregationMode({
    spawn,
    userChannelTarget: true,
    ...(params.configMode ? { configMode: params.configMode } : {}),
  });
  if (decision !== "holding") {
    // 'await' mode зарезервирован для будущего sub-plan'а; на cutover-1
    // first_pass scope он трактуется как passthrough — каркас не блокирует
    // parent reply, но и не подменяет на holding. Telemetry signals это.
    if (decision === "await") {
      defaultRuntime.log(
        formatAggregationLog({
          event: "policy_passthrough",
          mode: "await",
          parentSessionKey,
          childSessionKey: continuationChild.childSessionKey,
          childRunId: continuationChild.runId,
          ...(continuationChild.label ? { label: continuationChild.label } : {}),
          reason: "await_mode_reserved_for_future_subplan",
        }),
      );
    }
    return { kind: "passthrough" };
  }
  const idempotencyKey = buildHoldingIdempotencyKey({
    parentSessionKey,
    childSessionKey: continuationChild.childSessionKey,
    childRunId: continuationChild.runId,
  });
  const holdingPayload: ReplyPayload = { text: HOLDING_MESSAGE_TEXT };
  return {
    kind: "holding",
    payloads: [holdingPayload],
    childSessionKey: continuationChild.childSessionKey,
    childRunId: continuationChild.runId,
    ...(continuationChild.label ? { label: continuationChild.label } : {}),
    idempotencyKey,
  };
}

/**
 * Удобный wrapper: получает override-результат и логирует telemetry-event.
 * Caller вызывает один раз и получает либо null (passthrough), либо
 * массив payloads для подмены.
 *
 * Order matters (PR-G): сначала пробуется in-turn check
 * (`evaluateAggregationOverride`); если он passthrough — fall back на
 * cross-turn pending-child check (`evaluatePendingChildOverride`).
 */
export function applyAggregationOverride(params: {
  runResult: RunResultProbe;
  parentSessionKey: string | undefined;
  userChannelOrigin: DeliveryContext | undefined;
  configMode?: AggregationModeConfig;
  nowMs?: number;
  pendingChildLookbackMs?: number;
}): { payloads: ReplyPayload[] } | null {
  const inTurn = evaluateAggregationOverride(params);
  if (inTurn.kind === "holding") {
    defaultRuntime.log(
      formatAggregationLog({
        event: "holding_sent",
        mode: "holding",
        ...(params.parentSessionKey ? { parentSessionKey: params.parentSessionKey } : {}),
        childSessionKey: inTurn.childSessionKey,
        childRunId: inTurn.childRunId,
        ...(inTurn.label ? { label: inTurn.label } : {}),
      }),
    );
    return { payloads: inTurn.payloads };
  }

  const crossTurn = evaluatePendingChildOverride({
    runResult: params.runResult,
    parentSessionKey: params.parentSessionKey,
    userChannelOrigin: params.userChannelOrigin,
    ...(typeof params.nowMs === "number" ? { nowMs: params.nowMs } : {}),
    ...(typeof params.pendingChildLookbackMs === "number"
      ? { lookbackMs: params.pendingChildLookbackMs }
      : {}),
  });
  if (crossTurn.kind === "holding") {
    defaultRuntime.log(
      formatAggregationLog({
        event: "pending_child_holding_sent",
        ...(params.parentSessionKey ? { parentSessionKey: params.parentSessionKey } : {}),
        childSessionKey: crossTurn.childSessionKey,
        childRunId: crossTurn.childRunId,
        ...(crossTurn.label ? { label: crossTurn.label } : {}),
      }),
    );
    return { payloads: crossTurn.payloads };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cross-turn pending-child gate (PR-G `commitment_kernel_subagent_await.plan.md`).
// ---------------------------------------------------------------------------

/**
 * Возвращает самый старый pending continuation child для данного
 * `parentSessionKey`. "Pending" = `endedAt === undefined`. "Continuation" =
 * `spawnMode === "session"` (persistent) или (`spawnMode === "run"` И
 * `expectsCompletionMessage === true`).
 *
 * Lookback (`lookbackMs`, default `PENDING_CHILD_LOOKBACK_MS`) ограничивает
 * учитываемые records: те, что старше lookback'а, считаем мусором (registry
 * мог не дочистить `endedAt`).
 *
 * Read-only: не мутирует registry, не вызывает побочных эффектов.
 *
 * Hard invariant #5: решение принимается ТОЛЬКО по `record.spawnMode`,
 * `record.expectsCompletionMessage`, `record.endedAt`, `record.createdAt` —
 * без чтения assistant text / classifier output / raw user prompt.
 */
export function findOldestPendingContinuationChild(
  parentSessionKey: string,
  nowMs: number,
  lookbackMs: number = PENDING_CHILD_LOOKBACK_MS,
): SubagentRunRecord | undefined {
  let oldest: SubagentRunRecord | undefined;
  const records = listSubagentRunsForRequester(parentSessionKey) ?? [];
  for (const record of records) {
    if (typeof record.endedAt === "number") {
      continue;
    }
    if (typeof record.createdAt !== "number") {
      continue;
    }
    if (nowMs - record.createdAt > lookbackMs) {
      continue;
    }
    const isPersistent = record.spawnMode === "session";
    const isFollowupExpectingCompletion =
      record.spawnMode === "run" && record.expectsCompletionMessage === true;
    if (!isPersistent && !isFollowupExpectingCompletion) {
      continue;
    }
    if (!oldest || record.createdAt < oldest.createdAt) {
      oldest = record;
    }
  }
  return oldest;
}

/**
 * In-process map per (parentSessionKey, childRunId) → таймштампы предыдущих
 * holding'ов. Используется для idempotency (30s window) и timeout (≥2
 * holdings + child running > 120s → passthrough).
 *
 * Forward-compat: keyed по композитному ключу `${parent}:${runId}`,
 * никаких глобальных счётчиков / single-flight mutex'ов; concurrent
 * re-entry безопасен (в худшем случае при гонке оба пути запишут timestamp
 * — это не нарушает идемпотентность для следующих 30s).
 */
const pendingChildHoldingHistory = new Map<string, number[]>();

/**
 * Жёсткий потолок размера map'а. Переход через этот порог запускает LRU
 * cleanup (`pruneOldestEntries`).
 */
const PENDING_CHILD_HISTORY_MAX_ENTRIES = 1024;

function pruneStaleHoldingTimestamps(timestamps: number[], nowMs: number): number[] {
  return timestamps.filter(
    (ts) => nowMs - ts <= PENDING_CHILD_HOLDING_HISTORY_WINDOW_MS,
  );
}

function pruneOldestEntries(): void {
  if (pendingChildHoldingHistory.size <= PENDING_CHILD_HISTORY_MAX_ENTRIES) {
    return;
  }
  const overflow = pendingChildHoldingHistory.size - PENDING_CHILD_HISTORY_MAX_ENTRIES;
  let removed = 0;
  for (const key of pendingChildHoldingHistory.keys()) {
    if (removed >= overflow) {
      break;
    }
    pendingChildHoldingHistory.delete(key);
    removed += 1;
  }
}

function buildHoldingHistoryKey(parentSessionKey: string, childRunId: string): string {
  return `${parentSessionKey}::${childRunId}`;
}

/**
 * Test-only helper: очищает in-process idempotency map. Вызывается из
 * `beforeEach` тестов, чтобы они были изолированы. В production-flow не
 * используется.
 */
export function __resetPendingChildHoldingHistoryForTesting(): void {
  pendingChildHoldingHistory.clear();
}

export type PendingChildOverrideResult =
  | { kind: "passthrough" }
  | {
      kind: "holding";
      payloads: ReplyPayload[];
      childSessionKey: string;
      childRunId: string;
      label?: string;
      idempotencyKey: string;
    };

/**
 * Cross-turn gate: срабатывает на turn'е, где `runResult` НЕ содержит
 * `sessions_spawn` (in-turn check уже пропустил) и при этом для текущей
 * parent-сессии в registry есть pending continuation child из предыдущего
 * turn'а (running, не ended, в окне `lookbackMs`).
 *
 * Поведение:
 *  - Если pending child running > `PENDING_CHILD_TIMEOUT_MS` И уже было
 *    ≥ 2 holding'а в окне `PENDING_CHILD_HOLDING_HISTORY_WINDOW_MS`,
 *    эмиттим telemetry `pending_child_timeout` и возвращаем passthrough
 *    (UX safety-valve).
 *  - Если в окне `PENDING_CHILD_IDEMPOTENCY_MS` уже был holding на эту
 *    же `(parent, childRunId)` пару — `pending_child_idempotent_skip`
 *    + passthrough (без double-emission).
 *  - Иначе записываем `nowMs` в `pendingChildHoldingHistory[key]` и
 *    возвращаем `holding` payload `PENDING_CHILD_HOLDING_MESSAGE_TEXT`.
 */
export function evaluatePendingChildOverride(params: {
  runResult: RunResultProbe;
  parentSessionKey: string | undefined;
  userChannelOrigin: DeliveryContext | undefined;
  nowMs?: number;
  lookbackMs?: number;
}): PendingChildOverrideResult {
  const parentSessionKey = (params.parentSessionKey ?? "").trim();
  if (!parentSessionKey) {
    return { kind: "passthrough" };
  }
  if (!hasUserChannelTarget(params.userChannelOrigin)) {
    return { kind: "passthrough" };
  }
  // Cross-turn путь активируется ТОЛЬКО когда in-turn detection не
  // сработал. Если в текущем runResult есть `sessions_spawn`, это уже
  // обработано `evaluateAggregationOverride`; здесь — passthrough,
  // чтобы не дублировать holding.
  if (detectSpawnToolInvocation(params.runResult)) {
    return { kind: "passthrough" };
  }
  const nowMs = params.nowMs ?? Date.now();
  const child = findOldestPendingContinuationChild(
    parentSessionKey,
    nowMs,
    params.lookbackMs ?? PENDING_CHILD_LOOKBACK_MS,
  );
  if (!child) {
    return { kind: "passthrough" };
  }

  const historyKey = buildHoldingHistoryKey(parentSessionKey, child.runId);
  const previousRaw = pendingChildHoldingHistory.get(historyKey) ?? [];
  const history = pruneStaleHoldingTimestamps(previousRaw, nowMs);

  const childAgeMs = nowMs - child.createdAt;
  if (childAgeMs > PENDING_CHILD_TIMEOUT_MS && history.length >= 2) {
    defaultRuntime.log(
      formatAggregationLog({
        event: "pending_child_timeout",
        ...(parentSessionKey ? { parentSessionKey } : {}),
        childSessionKey: child.childSessionKey,
        childRunId: child.runId,
        ...(child.label ? { label: child.label } : {}),
        reason: "child_terminal_pending_too_long",
      }),
    );
    return { kind: "passthrough" };
  }

  const lastEmittedAt = history.length > 0 ? history[history.length - 1] : undefined;
  if (
    typeof lastEmittedAt === "number" &&
    nowMs - lastEmittedAt < PENDING_CHILD_IDEMPOTENCY_MS
  ) {
    defaultRuntime.log(
      formatAggregationLog({
        event: "pending_child_idempotent_skip",
        ...(parentSessionKey ? { parentSessionKey } : {}),
        childSessionKey: child.childSessionKey,
        childRunId: child.runId,
        ...(child.label ? { label: child.label } : {}),
        reason: "within_idempotency_window",
      }),
    );
    return { kind: "passthrough" };
  }

  const updatedHistory = [...history, nowMs];
  pendingChildHoldingHistory.set(historyKey, updatedHistory);
  pruneOldestEntries();

  const idempotencyKey = buildPendingChildHoldingIdempotencyKey({
    parentSessionKey,
    childSessionKey: child.childSessionKey,
    childRunId: child.runId,
  });
  return {
    kind: "holding",
    payloads: [{ text: PENDING_CHILD_HOLDING_MESSAGE_TEXT }],
    childSessionKey: child.childSessionKey,
    childRunId: child.runId,
    ...(child.label ? { label: child.label } : {}),
    idempotencyKey,
  };
}
