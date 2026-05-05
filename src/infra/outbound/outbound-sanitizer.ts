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
 * Invariant `no_raw_tool_call_markup_in_external_channel` (Bug A,
 * sub-plan `commitment_kernel_streaming_leak.plan.md`):
 *   Outbound payload не содержит сырые tool-call XML markers
 *   (`<tool_call>`, `<tool_use>`, `<function_call>`), их orphan
 *   (streaming-cut) формы, либо JSON tool-call envelope
 *   `{"name":"...","arguments":{...}}`. Дополняет defense-in-depth
 *   level 1 (streaming chunker `stripUniversalToolCallMarkup` в
 *   `src/agents/pi-embedded-utils.ts`).
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
 *
 * Slice I Phase 3 (sub-plan
 * `.cursor/plans/commitment_kernel_reply_sanitizer.plan.md` todo
 * `i-phase-3-meta-text-pattern-family`): добавляет curated `english_meta_*`
 * pattern family — line-anchored regex'ы на leading-imperative English
 * meta-thinking верхнего предложения assistant-ответа. Каждый такой pattern
 * помечен `codeRegionAware: true` и ВСЕГДА уходит мимо matches, попадающих
 * внутрь fenced code blocks (` ``` ` / ` ~~~ `) или inline code spans
 * (` `code` `) — это исключает false-positive на копи-паст из доков либо
 * code-snippet с teaching-tone текстом. Phase 3 ограничивается
 * `kind="strip"` поведением; `policy.reasoning === "structured"` (webchat
 * wrap) приходит в Phase 5 вместе с policy-aware call signature.
 */
import { findCodeRegions, isInsideCode } from "../../shared/text/code-regions.js";
import type { ReplySanitizerPolicy } from "./reply-sanitizer-policy.js";

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

/**
 * Replacement marker для universal tool-call XML / JSON envelopes (Bug A — sub-plan
 * `commitment_kernel_streaming_leak.plan.md`). Distinct от `TOOL_ERROR_ENVELOPE_REPLACEMENT`
 * — это маркер про сам tool-call (не про ошибку), отдельный класс leak'ов.
 */
export const TOOL_CALL_MARKUP_REPLACEMENT = "(внутренний tool-call; обработан)";

type LeakReplacement =
  /** Drop весь matched сегмент (line или substring). Используется для line-markers + stack traces. */
  | { kind: "strip" }
  /** Заменить matched сегмент на neutral marker. */
  | { kind: "replace"; with: string };

type LeakPattern = {
  readonly id: string;
  readonly pattern: RegExp;
  readonly replacement: LeakReplacement;
  /**
   * Если true — matches попадающие внутрь fenced ` ``` ` / ` ~~~ ` блоков либо
   * inline `code` span'ов будут пропущены (НЕ заменены). Защищает от false-
   * positive на teaching-snippets / copy-paste из docs / code-region текста.
   * Используется `english_meta_*` family (Slice I Phase 3); existing 16 patterns
   * остаются НЕ code-region-aware, чтобы byte-identical совпадать с pre-Phase-3
   * поведением.
   */
  readonly codeRegionAware?: boolean;
};

/**
 * Curated leak patterns. Расширения — только под evidence в gateway logs
 * либо session transcripts. Текущий состав:
 * - 7 line-markers (logger prefixes от kernel/decision/aggregation путей);
 * - 1 JSON envelope (raw tool-error результат, попадающий в LLM context);
 * - 2 Node stack-trace shapes;
 * - 6 universal tool-call markers (Bug A `commitment_kernel_streaming_leak.plan.md`):
 *   3 balanced XML blocks (`<tool_call>`, `<tool_use>`, `<function_call>`),
 *   2 orphan tag forms (streaming-cut), 1 JSON tool-call envelope.
 *
 * Порядок применения важен: сначала balanced XML blocks (#11-13), затем
 * JSON envelope (#14), и только потом orphan tags (#15-16) — иначе orphan-
 * regex может выгрызть закрывающий тег у валидного балансного блока.
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
  {
    id: "universal_tool_call_xml",
    pattern: /<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/giu,
    replacement: { kind: "replace", with: TOOL_CALL_MARKUP_REPLACEMENT },
  },
  {
    id: "universal_tool_use_xml",
    pattern: /<tool_use\b[^>]*>[\s\S]*?<\/tool_use>/giu,
    replacement: { kind: "replace", with: TOOL_CALL_MARKUP_REPLACEMENT },
  },
  {
    id: "universal_function_call_xml",
    pattern: /<function_call\b[^>]*>[\s\S]*?<\/function_call>/giu,
    replacement: { kind: "replace", with: TOOL_CALL_MARKUP_REPLACEMENT },
  },
  {
    id: "universal_tool_call_json_envelope",
    // Tool-call shape: {"name":"...","arguments":{...}}. Distinct from
    // `tool_error_envelope` (status/error keys) — этот pattern целит на сам
    // call. Arguments допускают inner JSON значения, но без вложенных объектов
    // (depth ≤ 1) — иначе риск false-positive на произвольные JSON структуры
    // в prose / docs / code blocks. Curated до evidence на более глубокую форму.
    pattern:
      /\{\s*"name"\s*:\s*"[A-Za-z_][\w.-]{0,127}"\s*,\s*"arguments"\s*:\s*\{(?:[^{}]|"(?:[^"\\]|\\.)*")*\}\s*\}/gu,
    replacement: { kind: "replace", with: TOOL_CALL_MARKUP_REPLACEMENT },
  },
  {
    id: "universal_tool_call_orphan_open",
    // Streaming-cut tail: open tag без соответствующего закрытия.
    // Применяется ПОСЛЕ balanced patterns — закрытые блоки уже вырезаны выше.
    pattern: /<(?:tool_call|tool_use|function_call)\b[^>]*>/giu,
    replacement: { kind: "strip" },
  },
  {
    id: "universal_tool_call_orphan_close",
    // Streaming-cut head: closing tag без соответствующего открытия.
    pattern: /<\/(?:tool_call|tool_use|function_call)\s*>/giu,
    replacement: { kind: "strip" },
  },
  // ---------------------------------------------------------------------------
  // Slice I Phase 3 — `english_meta_*` family. Line-anchored, code-region-aware.
  //
  // Каждый pattern целит на leading-imperative English meta-thinking sentence
  // (B5 evidence: 2026-05-04 Telegram, «Let me check memory for any context
  // about Vladimir's preferences»). Regex consume'ит до конца строки
  // (`[^\n]*$`), чтобы strip убирал ПОЛНОЕ предложение, а не только prefix.
  //
  // Verb whitelist (check|look|search|verify|see) и аналоги curated по
  // evidence — добавление новых требует gateway-log entry в signoff request
  // (per sub-plan §6.2). False-positive на mid-paragraph leak-prefix исключён
  // line-anchor'ом `^\s*…`; false-positive на code-snippet с teaching tone —
  // флагом `codeRegionAware: true` (см. `findCodeRegions` в
  // `src/shared/text/code-regions.ts`).
  // ---------------------------------------------------------------------------
  {
    id: "english_meta_let_me",
    pattern: /^\s*Let me\s+(?:check|look|search|verify|see)\b[^\n]*$/gmu,
    replacement: { kind: "strip" },
    codeRegionAware: true,
  },
  {
    id: "english_meta_ill",
    pattern: /^\s*I'?ll\s+(?:check|look|search|verify|see)\b[^\n]*$/gmu,
    replacement: { kind: "strip" },
    codeRegionAware: true,
  },
  {
    id: "english_meta_i_should",
    pattern: /^\s*I should\s+\w+[^\n]*$/gmu,
    replacement: { kind: "strip" },
    codeRegionAware: true,
  },
  {
    id: "english_meta_first_ill",
    pattern: /^\s*First,?\s+I'?ll\b[^\n]*$/gmu,
    replacement: { kind: "strip" },
    codeRegionAware: true,
  },
  {
    id: "english_meta_lets",
    pattern: /^\s*Let'?s\s+(?:check|look|verify|see)\b[^\n]*$/gmu,
    replacement: { kind: "strip" },
    codeRegionAware: true,
  },
  {
    id: "english_meta_looking_at",
    pattern: /^\s*Looking at\s+\w+[^\n]*$/gmu,
    replacement: { kind: "strip" },
    codeRegionAware: true,
  },
  {
    id: "english_meta_checking",
    pattern: /^\s*Checking\s+(?:memory|context|the|for)\b[^\n]*$/gmu,
    replacement: { kind: "strip" },
    codeRegionAware: true,
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

const DEFAULT_STRIP_POLICY: ReplySanitizerPolicy = Object.freeze({ reasoning: "strip" });

/**
 * Escapes `<` / `>` / `&` for placement inside a `<thinking lang="en">…</thinking>`
 * wrap so the wrap stays a single well-formed element even when the leak line
 * itself contains angle brackets (e.g. `Let me check <important> bounds`).
 *
 * Order matters: `&` first so a literal `&` in input does not get re-encoded by
 * the subsequent `<`/`>` substitutions producing `&amp;lt;` etc.
 */
function escapeForThinkingWrap(content: string): string {
  return content
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

/**
 * Применяет curated leak-patterns к outbound payload-text. Вызывается ТОЛЬКО
 * для каналов из `REPLY_SANITIZER_SURFACES` (caller проверяет через
 * `isReplySanitizerSurface(channel)`).
 *
 * Алгоритм:
 * 1. Для каждого pattern: replaceAll match на kind=strip ('') либо kind=replace.with.
 *    Slice I Phase 5: если `policy.reasoning === "structured"` И pattern.id
 *    начинается с `english_meta_`, match не вырезается, а оборачивается в
 *    `<thinking lang="en">…</thinking>` (escaped content) — для UI-aware
 *    адаптеров (today: webchat). Existing 16 patterns остаются strip/replace
 *    под все policy values — они НЕ reasoning leaks, а raw diagnostics.
 *    `policy.reasoning === "deferred"` ведёт себя как `"strip"` для inline
 *    payload (slack/discord адаптеры могут позже opt-in в sidebar без
 *    re-touching этого модуля).
 * 2. После всех patterns — collapse 3+ blank lines в 2 (стрипнутые line-markers
 *    оставляют пустые строки).
 * 3. Trim trailing whitespace но НЕ leading: leading может быть значимым
 *    (markdown / code blocks).
 *
 * @param text - raw payload text (после `sanitizeForPlainText` если применимо)
 * @param policy - per-channel structural policy. Default = `{ reasoning: "strip" }`
 *   so existing call sites без policy продолжают работать byte-identical.
 * @returns обработанный text + audit-trail strip-events (события фиксируются
 *   и для wrap-режима — telemetry preserved).
 */
export function sanitizeOutboundForExternalChannel(
  text: string,
  policy: ReplySanitizerPolicy = DEFAULT_STRIP_POLICY,
): OutboundSanitizerResult {
  if (!text) {
    return { text, stripped: [] };
  }

  let working = text;
  const events: OutboundSanitizerStripEvent[] = [];

  for (const { id, pattern, replacement, codeRegionAware } of OUTBOUND_LEAK_PATTERNS) {
    let matchCount = 0;
    // Code-region awareness (Slice I Phase 3): re-compute regions per pattern
    // because preceding patterns могут сократить text. Это дешёвый scan
    // (linear по text, no regex re-engine на каждый match), и корректность
    // выше микро-оптимизации.
    const regions = codeRegionAware ? findCodeRegions(working) : null;
    const useStructuredWrap =
      policy.reasoning === "structured" && id.startsWith("english_meta_");
    const replaced = working.replace(pattern, (match: string, ...args: unknown[]) => {
      // String.prototype.replace передаёт offset как второй-с-конца аргумент
      // (последний — full string). Извлекаем robust'но через `args` чтобы не
      // зависеть от capture-group count в каждом regex.
      const offset = typeof args[args.length - 2] === "number"
        ? (args[args.length - 2] as number)
        : 0;
      if (regions && isInsideCode(offset, regions)) {
        return match;
      }
      matchCount += 1;
      if (useStructuredWrap) {
        return `<thinking lang="en">${escapeForThinkingWrap(match)}</thinking>`;
      }
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
