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
  decideAggregationMode,
  formatAggregationLog,
  hasUserChannelTarget,
  HOLDING_MESSAGE_TEXT,
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
 */
export function applyAggregationOverride(params: {
  runResult: RunResultProbe;
  parentSessionKey: string | undefined;
  userChannelOrigin: DeliveryContext | undefined;
  configMode?: AggregationModeConfig;
  nowMs?: number;
}): { payloads: ReplyPayload[] } | null {
  const result = evaluateAggregationOverride(params);
  if (result.kind === "passthrough") {
    return null;
  }
  defaultRuntime.log(
    formatAggregationLog({
      event: "holding_sent",
      mode: "holding",
      ...(params.parentSessionKey ? { parentSessionKey: params.parentSessionKey } : {}),
      childSessionKey: result.childSessionKey,
      childRunId: result.childRunId,
      ...(result.label ? { label: result.label } : {}),
    }),
  );
  return { payloads: result.payloads };
}
