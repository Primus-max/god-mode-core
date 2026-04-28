/**
 * Subagent result aggregation policy.
 *
 * Closes audit-gap O3 from `commitment_kernel_subagent_result_aggregation.plan.md`:
 * на каждый внешний user-prompt parent-сессия выпускает РОВНО ОДНО финальное
 * user-facing сообщение в исходный канал. Промежуточные partial-summary'и
 * между моментом spawn'а subagent'а и его terminal-state запрещены.
 *
 * Structural invariant (`single_final_user_facing_message_per_user_turn`):
 *   - Если parent emit'ит `sessions_spawn` с `mode === "session"` (continuation =
 *     persistent_worker) или `expectsCompletionMessage === true` (continuation =
 *     followup) И user-channel ожидает final reply, parent ДОЛЖЕН либо:
 *       (A) отправить ОДНО фиксированное holding-сообщение СЕЙЧАС и
 *           закрыть turn (final delivery приходит позже verbatim'ом из worker'а),
 *           ЛИБО
 *       (B) блокирующе дождаться `terminalState=complete` и доставить
 *           verbatim worker.content одним сообщением.
 *   - LLM-summarize этого worker.content между моментами (1) и terminal-state
 *     ЗАПРЕЩЁН: provenance gate отрезает classifier, verbatim path обходит
 *     parent-LLM целиком.
 *
 * Aggregation policy касается ТОЛЬКО first_pass'а (immediate continuation
 * сразу после spawn'а в том же user-turn'е). Cron-driven persistent_worker
 * push'ы — отдельный codepath / sub-plan (Bug F, см. §8 sub-plan'а).
 *
 * Hard invariants reference (`.cursor/rules/commitment-kernel-invariants.mdc`):
 *   - #5 / #6: gate работает по `SpawnSubagentMode` enum + `SubagentRunOutcome.status`
 *     literals + типизированному `DeliveryContext`, БЕЗ парсинга raw user text.
 *   - #11: пять frozen decision contracts не затронуты.
 */

import type { SpawnSubagentMode } from "../../agents/subagent-spawn.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";

export type AggregationMode = "holding" | "await" | "none";

export type AggregationModeConfig = "holding" | "await";

export const DEFAULT_AGGREGATION_MODE: AggregationModeConfig = "holding";

/**
 * Holding-template, отправляемый user-у в момент spawn'а continuation worker'а
 * (Option A). Намеренно генерический и без доменных формулировок: parent
 * не угадывает за worker'а, что именно тот будет делать.
 *
 * Никаких эмодзи (per user rules).
 */
export const HOLDING_MESSAGE_TEXT =
  "Запустил воркера. Полный результат пришлю отдельным сообщением, когда будет готов.";

/**
 * Telemetry event names (for `[subagent-aggregation]` log prefix).
 *
 * - `holding_sent`: parent отправил holding-template и закрыл turn.
 * - `worker_terminal_complete_verbatim`: worker завершил, parent доставил
 *   verbatim worker.content в external channel ОДНИМ сообщением.
 * - `worker_terminal_failed_fallback`: worker завершил с ошибкой, отправляем
 *   compact failure-сообщение через verbatim path.
 * - `verbatim_skipped`: условие verbatim не сработало (например, нет
 *   deliverable channel/to); fallback на legacy announce-flow.
 * - `policy_passthrough`: aggregation policy не применялась (turn не содержит
 *   continuation spawn'а; legacy reply-flow без изменений).
 */
export const AGGREGATION_LOG_PREFIX = "[subagent-aggregation]" as const;

export type AggregationTelemetryEvent =
  | "holding_sent"
  | "worker_terminal_complete_verbatim"
  | "worker_terminal_failed_fallback"
  | "verbatim_skipped"
  | "policy_passthrough";

/**
 * Описание spawn-result'а в текущем parent-turn'е, нужное для решения
 * aggregation policy. Структурное, без доступа к prompt-тексту.
 */
export type SpawnTurnSignal = {
  readonly accepted: boolean;
  readonly mode?: SpawnSubagentMode;
  readonly expectsCompletionMessage?: boolean;
  readonly childSessionKey?: string;
  readonly label?: string;
};

/**
 * Извлекает наличие deliverable target'а в исходном user-channel.
 *
 * Используется gate'ами и verbatim-path'ом, чтобы решить, можно ли
 * структурно доставить final reply в TG/Discord/etc. без parent-LLM.
 */
export function hasUserChannelTarget(
  origin: DeliveryContext | undefined,
): origin is DeliveryContext & { channel: string; to: string } {
  if (!origin) {
    return false;
  }
  const channel = typeof origin.channel === "string" ? origin.channel.trim() : "";
  const to = typeof origin.to === "string" ? origin.to.trim() : "";
  return channel.length > 0 && to.length > 0;
}

/**
 * Решает, должен ли parent-turn быть aggregation-managed.
 *
 * - `none`: ни один из tool-call'ов turn'а не выглядит как continuation spawn,
 *   либо нет deliverable user-channel target'а — стандартный reply-flow.
 * - `holding` (Option A, default): parent шлёт ОДНО holding-сообщение через
 *   delivery layer без LLM-pass; worker-completion придёт verbatim'ом
 *   отдельным сообщением.
 * - `await` (Option B): parent блокирующе ждёт worker.complete до
 *   `timeoutMs`, после чего собирает один aggregated reply из worker.content.
 *
 * Default = `holding`: timeout-неблокирующий путь (лучший UX для long-running
 * worker'ов: первый прогон может занять минуты).
 */
export function decideAggregationMode(params: {
  spawn: SpawnTurnSignal;
  userChannelTarget: boolean;
  configMode?: AggregationModeConfig;
}): AggregationMode {
  if (!params.spawn.accepted) {
    return "none";
  }
  if (!params.userChannelTarget) {
    return "none";
  }
  // Continuation = persistent_worker (mode="session") или followup
  // (mode="run" + expectsCompletionMessage=true). One-shot run без
  // expectsCompletionMessage не требует aggregation gate'а.
  const isContinuation =
    params.spawn.mode === "session" || params.spawn.expectsCompletionMessage === true;
  if (!isContinuation) {
    return "none";
  }
  return params.configMode ?? DEFAULT_AGGREGATION_MODE;
}

/**
 * Условия, при которых worker-completion announce должен идти verbatim'ом
 * в external user-channel (без parent-LLM round-trip'а).
 *
 * Вызывается из `runSubagentAnnounceFlow` ПЕРЕД `deliverSubagentAnnouncement`.
 * Provenance gate из PR self-feedback-loop остаётся safety-net для случая,
 * когда verbatim path не сработал (`verbatim_skipped`).
 */
export function shouldVerbatimForwardCompletion(params: {
  expectsCompletionMessage: boolean;
  requesterIsSubagent: boolean;
  outcomeStatus: "ok" | "error" | "timeout" | "unknown" | undefined;
  completionDirectOrigin: DeliveryContext | undefined;
  reply: string | undefined;
}): boolean {
  if (!params.expectsCompletionMessage) {
    return false;
  }
  if (params.requesterIsSubagent) {
    return false;
  }
  if (!hasUserChannelTarget(params.completionDirectOrigin)) {
    return false;
  }
  // На first_pass scope доставляем verbatim только при status="ok"
  // ("complete"). Для error/timeout у нас нет полноценного worker.content;
  // оставляем legacy announce-flow как fallback (через provenance gate
  // он всё равно не превратится в новый sessions_spawn).
  if (params.outcomeStatus !== "ok") {
    return false;
  }
  return Boolean(params.reply && params.reply.trim().length > 0);
}

/**
 * Минимальная обёртка для verbatim worker.content. Сохраняем структуру
 * worker'а; добавляем только короткий префикс «Готово:», чтобы в чате
 * было понятно, что это финальный результат запущенной задачи. Префикс
 * можно отключить через `withReadyPrefix=false` (для тестов / специальных
 * каналов).
 */
export function formatVerbatimWorkerContent(params: {
  reply: string;
  withReadyPrefix?: boolean;
}): string {
  const trimmed = params.reply.trim();
  if (params.withReadyPrefix === false) {
    return trimmed;
  }
  return `Готово:\n\n${trimmed}`;
}

/**
 * Идемпотентный ключ для verbatim-доставки. Привязан к childRunId
 * (один и тот же worker → один и тот же idempotency key) → safe retry.
 */
export function buildVerbatimIdempotencyKey(params: {
  childRunId: string;
  childSessionKey: string;
}): string {
  return `subagent-aggregation:verbatim:${params.childSessionKey}:${params.childRunId}`;
}

/**
 * Идемпотентный ключ для holding-сообщения parent-side. Привязан к
 * spawn-time идентификатору (childSessionKey, runId), чтобы rerun
 * того же turn'а не дублировал holding в чате.
 */
export function buildHoldingIdempotencyKey(params: {
  parentSessionKey: string;
  childSessionKey: string;
  childRunId?: string;
}): string {
  const suffix = params.childRunId ? `:${params.childRunId}` : "";
  return `subagent-aggregation:holding:${params.parentSessionKey}:${params.childSessionKey}${suffix}`;
}

/**
 * Compact telemetry message builder. Используется обоими гейтами
 * (parent-side holding и announce-side verbatim) для единого формата лога.
 */
export function formatAggregationLog(params: {
  event: AggregationTelemetryEvent;
  mode?: AggregationMode;
  parentSessionKey?: string;
  childSessionKey?: string;
  childRunId?: string;
  label?: string;
  contentBytes?: number;
  reason?: string;
}): string {
  const parts: string[] = [`event=${params.event}`];
  if (params.mode) {
    parts.push(`mode=${params.mode}`);
  }
  if (params.parentSessionKey) {
    parts.push(`parent=${params.parentSessionKey}`);
  }
  if (params.childSessionKey) {
    parts.push(`child=${params.childSessionKey}`);
  }
  if (params.childRunId) {
    parts.push(`runId=${params.childRunId}`);
  }
  if (params.label) {
    parts.push(`label=${params.label}`);
  }
  if (typeof params.contentBytes === "number") {
    parts.push(`content_bytes=${params.contentBytes}`);
  }
  if (params.reason) {
    parts.push(`reason=${params.reason}`);
  }
  return `${AGGREGATION_LOG_PREFIX} ${parts.join(" ")}`;
}
