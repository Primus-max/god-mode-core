/**
 * Outbound sanitizer — single boundary against raw internal diagnostics
 * leaking into external channels (telegram, signal, whatsapp, slack,
 * discord, sms, voice, imessage, googlechat).
 *
 * Invariant `no_raw_internal_diagnostics_in_external_channel`:
 *   Outbound payload, доставляемый в external channel, не содержит curated
 *   set of internal-diagnostic markers (`[tools] X failed:`, `[task-classifier]`,
 *   `[planner]`, `[provenance-guard]`, `[subagent-aggregation]`, `[intent-ledger]`,
 *   `[DEBUG ...]`, raw tool-error JSON envelope, Node stack traces).
 *
 * Boundary type. Sanitizer работает на OUTPUT (payload.text эмитится LLM либо
 * системой), а не на UserPrompt/RawUserTurn. Pattern-list curated на known
 * internal-diagnostic markers, расширяется только под evidence в логах.
 * Структурный gate работает по `EXTERNAL_DELIVERY_SURFACES` allowlist
 * (default-bypass для unknown/internal каналов — diagnostics там нужны
 * для отладки).
 *
 * Соответствие 16 hard invariants (`.cursor/rules/commitment-kernel-invariants.mdc`):
 * - #5: text-rule matching на UserPrompt outside whitelist запрещён;
 *       тут patterns применяются на OUTPUT, не на UserPrompt — invariant соблюдён.
 * - #6: IntentContractor — единственный reader сырого user text; sanitizer
 *       НЕ читает user text — усиливает invariant в spirit-форме.
 * - #11: 5 frozen decision contracts не тронуты.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_outbound_sanitizer.plan.md`.
 */

const EXTERNAL_DELIVERY_SURFACE_LIST = [
  "telegram",
  "signal",
  "whatsapp",
  "slack",
  "discord",
  "sms",
  "voice",
  "imessage",
  "googlechat",
] as const;

export type ExternalDeliverySurface = (typeof EXTERNAL_DELIVERY_SURFACE_LIST)[number];

const EXTERNAL_DELIVERY_SURFACES: ReadonlySet<string> = new Set(EXTERNAL_DELIVERY_SURFACE_LIST);

/** Returns true когда channel в allowlist для outbound sanitization. */
export function isExternalDeliverySurface(channel: string): channel is ExternalDeliverySurface {
  return EXTERNAL_DELIVERY_SURFACES.has(channel);
}

/** Empty-after-sanitization fallback (Q2 signoff: нейтрально, без «оператора»). */
export const EMPTY_AFTER_SANITIZATION_FALLBACK_TEXT = "Запрос не удалось выполнить.";

/** Replacement marker для tool-error JSON envelope (Q1 signoff). */
export const TOOL_ERROR_ENVELOPE_REPLACEMENT = "(внутренняя ошибка инструмента; обработана)";

type LeakReplacement =
  /** Drop весь matched сегмент (line или substring). Используется для line-markers + stack traces. */
  | { kind: "strip" }
  /** Заменить matched сегмент на neutral marker. */
  | { kind: "replace"; with: string };

type LeakPattern = {
  readonly id: string;
  readonly pattern: RegExp;
  readonly replacement: LeakReplacement;
};

/**
 * Curated leak patterns. Расширения — только под evidence в gateway logs
 * либо session transcripts. На старте (10 patterns):
 * - 7 line-markers (logger prefixes от kernel/decision/aggregation путей);
 * - 1 JSON envelope (raw tool-error результат, попадающий в LLM context);
 * - 2 Node stack-trace shapes.
 */
const OUTBOUND_LEAK_PATTERNS: readonly LeakPattern[] = [
  {
    id: "tool_error_marker",
    pattern: /^[ \t]*\[tools\][ \t]+\S+[ \t]+failed:.*$/gmu,
    replacement: { kind: "strip" },
  },
  {
    id: "tool_error_envelope",
    pattern:
      /\{\s*"status"\s*:\s*"error"\s*,\s*"tool"\s*:\s*"[^"]+"\s*,\s*"error"\s*:\s*"[^"]*"\s*\}/gu,
    replacement: { kind: "replace", with: TOOL_ERROR_ENVELOPE_REPLACEMENT },
  },
  {
    id: "task_classifier_marker",
    pattern: /^[ \t]*\[task-classifier\][^\n]*$/gmu,
    replacement: { kind: "strip" },
  },
  {
    id: "planner_marker",
    pattern: /^[ \t]*\[planner\][^\n]*$/gmu,
    replacement: { kind: "strip" },
  },
  {
    id: "provenance_guard_marker",
    pattern: /^[ \t]*\[provenance-guard\][^\n]*$/gmu,
    replacement: { kind: "strip" },
  },
  {
    id: "subagent_aggregation_marker",
    pattern: /^[ \t]*\[subagent-aggregation\][^\n]*$/gmu,
    replacement: { kind: "strip" },
  },
  {
    id: "intent_ledger_marker",
    pattern: /^[ \t]*\[intent-ledger\][^\n]*$/gmu,
    replacement: { kind: "strip" },
  },
  {
    id: "debug_marker",
    pattern: /^[ \t]*\[DEBUG[^\]]*\][^\n]*$/gmu,
    replacement: { kind: "strip" },
  },
  {
    id: "node_stack_trace",
    pattern: /^[ \t]*at[ \t]+\S+[ \t]+\([^()\n]+:\d+:\d+\)[ \t]*$/gmu,
    replacement: { kind: "strip" },
  },
  {
    id: "node_error_path",
    pattern: /[ \t]+at[ \t]+(?:async[ \t]+)?\S+[ \t]+\(file:\/\/\/[^)\s]+\)/gu,
    replacement: { kind: "strip" },
  },
] as const;

export type OutboundSanitizerStripEvent = {
  readonly patternId: string;
  readonly count: number;
};

export type OutboundSanitizerResult = {
  /** Обработанный текст. Пустая строка означает «всё вырезано», caller подставит fallback. */
  readonly text: string;
  /** Список сработавших patterns (id + сколько раз). Пустой массив = clean text. */
  readonly stripped: readonly OutboundSanitizerStripEvent[];
};

/**
 * Применяет curated leak-patterns к outbound payload-text. Вызывается ТОЛЬКО
 * для каналов из `EXTERNAL_DELIVERY_SURFACES` (caller проверяет).
 *
 * Алгоритм:
 * 1. Для каждого pattern: replaceAll match на kind=strip ('') либо kind=replace.with.
 * 2. После всех patterns — collapse 3+ blank lines в 2 (стрипнутые line-markers
 *    оставляют пустые строки).
 * 3. Trim trailing whitespace но НЕ leading: leading может быть значимым
 *    (markdown / code blocks).
 *
 * @param text - raw payload text (после `sanitizeForPlainText` если применимо)
 * @returns обработанный text + audit-trail strip-events
 */
export function sanitizeOutboundForExternalChannel(text: string): OutboundSanitizerResult {
  if (!text) {
    return { text, stripped: [] };
  }

  let working = text;
  const events: OutboundSanitizerStripEvent[] = [];

  for (const { id, pattern, replacement } of OUTBOUND_LEAK_PATTERNS) {
    let matchCount = 0;
    const replaced = working.replace(pattern, () => {
      matchCount += 1;
      return replacement.kind === "strip" ? "" : replacement.with;
    });
    if (matchCount > 0) {
      events.push({ patternId: id, count: matchCount });
      working = replaced;
    }
  }

  if (events.length === 0) {
    return { text, stripped: [] };
  }

  const collapsed = working.replace(/\n{3,}/gu, "\n\n").replace(/[ \t]+$/gmu, "");
  return { text: collapsed.trim(), stripped: events };
}

/**
 * Telemetry-event для `[outbound-sanitizer]`. Caller log'ает это в gateway log
 * на каждый strip (по одной строке per delivery, summary всех patterns).
 */
export function formatOutboundSanitizerLog(params: {
  readonly channel: string;
  readonly stripped: readonly OutboundSanitizerStripEvent[];
  readonly sessionKey?: string;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}): string {
  const patterns = params.stripped
    .map(({ patternId, count }) => (count > 1 ? `${patternId}*${count}` : patternId))
    .join(",");
  const sessionPart = params.sessionKey ? ` session=${params.sessionKey}` : "";
  return `[outbound-sanitizer] event=stripped channel=${params.channel} patterns=[${patterns}]${sessionPart} bytes_before=${params.bytesBefore} bytes_after=${params.bytesAfter}`;
}

/**
 * @internal Test-only: список сконфигурированных patternIds. Используется
 * в `outbound-sanitizer.test.ts` для смок-проверки coverage.
 */
export const __OUTBOUND_LEAK_PATTERN_IDS_FOR_TESTS: readonly string[] = OUTBOUND_LEAK_PATTERNS.map(
  (p) => p.id,
);
