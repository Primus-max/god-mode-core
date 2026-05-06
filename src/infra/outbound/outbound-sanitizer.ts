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
 * Slice I rollback (2026-05-05): the 7 `english_meta_*` regex patterns
 * landed by PR #162 have been REVERTED per master roadmap
 * `commitment_kernel_v1_release_roadmap.plan.md` §3 ("LLM-mediated, not
 * regex"). B5 leak defense is now provided by:
 *   (a) Phase 4 prompt hint (`src/agents/pi-embedded-runner/internal-reasoning-hint.ts`)
 *       — instructs the model to wrap reasoning in `<thinking>…</thinking>`;
 *   (b) extraction-path strip (`stripThinkingTagsFromText` in
 *       `src/agents/pi-embedded-utils.ts:280`) — removes the wrapped reasoning
 *       BEFORE the payload reaches this module.
 *
 * The `policy?: ReplySanitizerPolicy` parameter on
 * `sanitizeOutboundForExternalChannel` is preserved for signature stability
 * (Phase 5 wiring at `deliver.ts:404` still passes it). Post-rollback the
 * structured branch is a no-op: the 16 diagnostic patterns are NOT reasoning
 * leaks; they remain strip/replace under every policy. A future slice that
 * moves the strip-thinking-tags layer into this module will consume
 * `policy.reasoning === "structured"` to wrap (instead of strip) `<thinking>`
 * content for webchat.
 */
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
] as const;

export type OutboundSanitizerStripEvent = {
  readonly patternId: string;
  readonly count: number;
  /**
   * Optional structured detail attached by the locale-filter branch (NEW-D
   * Phase 4). Absent on the 16 diagnostic-pattern strip events (their shape
   * stays byte-identical to pre-NEW-D). Present on `locale_filter_block`
   * events so `formatOutboundSanitizerLog` can render the
   * `[outbound-sanitizer] locale_filter applied locale=… reason=…` line
   * without re-running the detector.
   */
  readonly detail?: OutboundSanitizerStripEventDetail;
};

/**
 * Structured metadata for non-diagnostic strip events. `detected` is the
 * predominant-locale verdict from `detectPredominantLocale`; `reason` records
 * which locale was missing (e.g. `no_cyrillic` when `allowedLocales=['ru']`
 * and the verdict is `en`).
 */
export type OutboundSanitizerStripEventDetail = {
  readonly detected: "ru" | "en" | "other";
  readonly reason: "no_cyrillic" | "no_latin" | "no_match";
};

export type OutboundSanitizerResult = {
  /** Обработанный текст. Пустая строка означает «всё вырезано», caller подставит fallback. */
  readonly text: string;
  /** Список сработавших patterns (id + сколько раз). Пустой массив = clean text. */
  readonly stripped: readonly OutboundSanitizerStripEvent[];
};

const DEFAULT_STRIP_POLICY: ReplySanitizerPolicy = Object.freeze({ reasoning: "strip" });

/**
 * Minimum-alphabetic-char threshold for the locale gate. Below this count the
 * gate skips the verdict — `OK` (2), `5` (0), `👍` (0) MUST NOT be blocked
 * (sub-plan §6 «threshold 8 chars»).
 */
const LOCALE_FILTER_MIN_ALPHABETIC_CHARS = 8;

/**
 * Predominant-locale detector for outbound text. Mirrors the arithmetic at
 * `src/agents/pi-embedded-subscribe.handlers.messages.ts:350-354` byte-for-
 * byte (Cyrillic via `/[Ѐ-ӿ]/g` count + Latin via `/[A-Za-z]/g` count +
 * `cyrillic > latin ? 'ru' : latin > 0 ? 'en' : 'other'`). The shared
 * arithmetic produced the literal `lang=en cyr=0` value in the L2392 evidence
 * that motivates this slice (sub-plan §2.3).
 *
 * Co-located inside this module on purpose — the predominant-locale arithmetic
 * is observational at the assistant-reply log site and structural here. NOT
 * exported beyond test access (`__detectPredominantLocaleForTests`); call
 * sites consume it implicitly via `sanitizeOutboundForExternalChannel`.
 */
function detectPredominantLocale(text: string): {
  readonly locale: "ru" | "en" | "other";
  readonly cyrillic: number;
  readonly latin: number;
  readonly ratio: number;
} {
  const cyrillic = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = cyrillic + latin;
  const locale: "ru" | "en" | "other" =
    cyrillic > latin ? "ru" : latin > 0 ? "en" : "other";
  const ratio = total === 0 ? 0 : (locale === "ru" ? cyrillic : latin) / total;
  return { locale, cyrillic, latin, ratio };
}

/**
 * Применяет curated leak-patterns к outbound payload-text. Вызывается ТОЛЬКО
 * для каналов из `REPLY_SANITIZER_SURFACES` (caller проверяет через
 * `isReplySanitizerSurface(channel)`).
 *
 * Алгоритм:
 * 1. Для каждого pattern: replaceAll match на kind=strip ('') либо kind=replace.with.
 *    Все 16 patterns — diagnostic markers (НЕ reasoning leaks); они strip/replace
 *    под все три значения `policy.reasoning` (`"strip"`, `"structured"`,
 *    `"deferred"`).
 * 2. После всех patterns — collapse 3+ blank lines в 2 (стрипнутые line-markers
 *    оставляют пустые строки).
 * 3. Trim trailing whitespace но НЕ leading: leading может быть значимым
 *    (markdown / code blocks).
 *
 * @param text - raw payload text (после `sanitizeForPlainText` если применимо)
 * @param policy - per-channel structural policy. Default = `{ reasoning: "strip" }`
 *   so existing call sites без policy продолжают работать byte-identical.
 *   Slice I rollback (2026-05-05): post-rollback the policy is currently a
 *   no-op for the 16 diagnostic patterns — the parameter is preserved for
 *   signature stability and consumed by a future slice that moves the
 *   strip-thinking-tags layer into this module (`policy.reasoning ===
 *   "structured"` will then wrap `<thinking>` content for webchat).
 * @returns обработанный text + audit-trail strip-events.
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

  // NEW-D Phase 3 — locale gate (additive in-function branch). Runs ONLY when
  // `policy.localeFilter` is defined; channels without an entry in
  // `CHANNEL_LOCALE_DEFAULTS` resolve to `localeFilter === undefined` and
  // skip this branch — behavior byte-identical to pre-Phase-3 sanitizer.
  // See sub-plan §5 / phase 3 todo + audit deliverable
  // `extensions/AUDIT-locale-aware-sanitizer.md` §c.
  //
  // Order matters: runs AFTER the 16-pattern strip path. The post-strip text
  // is the locale-gate input — diagnostic-only payloads (e.g. a bare
  // `[planner] ...` line) become empty before the locale check and the gate
  // does NOT fire on empty text (regression case (f)).
  if (policy.localeFilter && working.length > 0) {
    const verdict = detectPredominantLocale(working);
    const alphaCount = verdict.cyrillic + verdict.latin;
    if (
      alphaCount >= LOCALE_FILTER_MIN_ALPHABETIC_CHARS &&
      verdict.ratio >= policy.localeFilter.minimumRatio &&
      !policy.localeFilter.allowedLocales.includes(verdict.locale)
    ) {
      // NEW-D Phase 4 — structured detail surfaces detected locale + the
      // reason the gate fired so `formatOutboundSanitizerLog` can render
      // the `[outbound-sanitizer] locale_filter applied locale=…
      // reason=…` line without re-running the detector. `reason` derives
      // from which locale is missing from `allowedLocales`:
      //   - `allowedLocales=['ru']` → `no_cyrillic`
      //   - `allowedLocales=['en']` → `no_latin`
      //   - any other configuration → `no_match`
      const allowed = policy.localeFilter.allowedLocales;
      const reason: OutboundSanitizerStripEventDetail["reason"] =
        allowed.length === 1 && allowed[0] === "ru"
          ? "no_cyrillic"
          : allowed.length === 1 && allowed[0] === "en"
            ? "no_latin"
            : "no_match";
      events.push({
        patternId: "locale_filter_block",
        count: 1,
        detail: { detected: verdict.locale, reason },
      });
      working = "";
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
 *
 * NEW-D Phase 4 — when one of the strip events is `locale_filter_block`
 * (locale-gate fired; populated by the Phase 3 branch above with structured
 * detail), the formatter PREPENDS an additional line of shape
 * `[outbound-sanitizer] locale_filter applied locale=<detected>
 * blocked=true reason=<no_cyrillic|no_latin|no_match> channel=<c>`
 * separated by `\n` — `log.warn` handles multi-line strings as-is. The
 * existing `event=stripped` line shape stays byte-identical so existing
 * fixtures continue to match.
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
  const strippedLine = `[outbound-sanitizer] event=stripped channel=${params.channel} patterns=[${patterns}]${sessionPart} bytes_before=${params.bytesBefore} bytes_after=${params.bytesAfter}`;
  const localeEvent = params.stripped.find(
    (event): event is OutboundSanitizerStripEvent & {
      readonly detail: OutboundSanitizerStripEventDetail;
    } => event.patternId === "locale_filter_block" && event.detail !== undefined,
  );
  if (!localeEvent) {
    return strippedLine;
  }
  const localeLine = `[outbound-sanitizer] locale_filter applied locale=${localeEvent.detail.detected} blocked=true reason=${localeEvent.detail.reason} channel=${params.channel}`;
  return `${localeLine}\n${strippedLine}`;
}

/**
 * @internal Test-only: список сконфигурированных patternIds. Используется
 * в `outbound-sanitizer.test.ts` для смок-проверки coverage.
 */
export const __OUTBOUND_LEAK_PATTERN_IDS_FOR_TESTS: readonly string[] = OUTBOUND_LEAK_PATTERNS.map(
  (p) => p.id,
);

/**
 * @internal Test-only: pure-function alias for the predominant-locale detector
 * exercised by `detect-predominant-locale.test.ts`. The detector is otherwise
 * private to this module; call sites consume it implicitly via the locale
 * gate inside `sanitizeOutboundForExternalChannel`.
 */
export const __detectPredominantLocaleForTests = detectPredominantLocale;
