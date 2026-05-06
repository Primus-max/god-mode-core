import { describe, expect, it } from "vitest";
import {
  EMPTY_AFTER_SANITIZATION_FALLBACK_TEXT,
  TOOL_CALL_MARKUP_REPLACEMENT,
  TOOL_ERROR_ENVELOPE_REPLACEMENT,
  __OUTBOUND_LEAK_PATTERN_IDS_FOR_TESTS,
  formatOutboundSanitizerLog,
  isExternalDeliverySurface,
  sanitizeOutboundForExternalChannel,
} from "./outbound-sanitizer.js";

describe("outbound-sanitizer / EXTERNAL_DELIVERY_SURFACES", () => {
  it("recognizes signoff-approved external surfaces", () => {
    for (const ch of [
      "telegram",
      "signal",
      "whatsapp",
      "slack",
      "discord",
      "sms",
      "voice",
      "imessage",
      "googlechat",
    ]) {
      expect(isExternalDeliverySurface(ch)).toBe(true);
    }
  });

  it("treats internal/unknown surfaces as bypass", () => {
    for (const ch of ["webchat", "tui", "stdout", "log", "control", "fooplugin"]) {
      expect(isExternalDeliverySurface(ch)).toBe(false);
    }
  });
});

describe("outbound-sanitizer / pattern coverage", () => {
  it("ships exactly the 16 curated patternIds (10 Bug E diagnostics + 6 Bug A universal tool-call)", () => {
    // Slice I rollback (PR #162 reverted): the 7 `english_meta_*` regex patterns
    // were dropped — see master roadmap
    // `commitment_kernel_v1_release_roadmap.plan.md` §3 ("LLM-mediated, not
    // regex"). B5 leak defense is now (a) Phase 4 prompt hint instructing the
    // model to wrap reasoning in `<thinking>` + (b) extraction-path
    // `stripThinkingTagsFromText` strip in `pi-embedded-utils.ts`. The
    // post-filter regex layer intentionally avoids regex-on-free-English
    // (false-positive on legitimate prose, false-negative on mid-line leaks).
    expect([...__OUTBOUND_LEAK_PATTERN_IDS_FOR_TESTS].sort()).toEqual(
      [
        "tool_error_marker",
        "tool_error_envelope",
        "task_classifier_marker",
        "planner_marker",
        "provenance_guard_marker",
        "subagent_aggregation_marker",
        "intent_ledger_marker",
        "debug_marker",
        "node_stack_trace",
        "node_error_path",
        "universal_tool_call_xml",
        "universal_tool_use_xml",
        "universal_function_call_xml",
        "universal_tool_call_json_envelope",
        "universal_tool_call_orphan_open",
        "universal_tool_call_orphan_close",
      ].sort(),
    );
  });
});

describe("outbound-sanitizer / sanitizeOutboundForExternalChannel", () => {
  it("returns clean text untouched and stripped=[]", () => {
    const input = "Привет! Это нормальный ответ от ассистента.\n\nВторой абзац.";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toBe(input);
    expect(result.stripped).toEqual([]);
  });

  it("strips [tools] X failed: marker line", () => {
    const input =
      "Извини, не получилось.\n[tools] cron failed: Reminder scheduling cannot target another session.\nПопробуй ещё раз.";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).not.toContain("[tools]");
    expect(result.text).toContain("Извини, не получилось.");
    expect(result.text).toContain("Попробуй ещё раз.");
    expect(result.stripped.find((e) => e.patternId === "tool_error_marker")?.count).toBe(1);
  });

  it("replaces raw tool-error JSON envelope with neutral marker", () => {
    const input =
      'Я попыталась найти, но {"status":"error","tool":"web_search","error":"DuckDuckGo returned a bot-detection challenge."}. Продолжаю.';
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toContain(TOOL_ERROR_ENVELOPE_REPLACEMENT);
    expect(result.text).not.toContain('"status":"error"');
    expect(result.stripped.find((e) => e.patternId === "tool_error_envelope")?.count).toBe(1);
  });

  it("strips classifier/planner/provenance/aggregation/ledger/debug line markers", () => {
    const input = [
      "Реальный ответ.",
      "[task-classifier] decision=internal route=skip",
      "[planner] plan_built=true steps=3",
      "[provenance-guard] external→internal blocked",
      "[subagent-aggregation] count=2 final=1",
      "[intent-ledger] peek=0 injected=0",
      "[DEBUG agent.run] step=42 elapsed=120ms",
      "Конец.",
    ].join("\n");
    const result = sanitizeOutboundForExternalChannel(input);
    for (const marker of [
      "[task-classifier]",
      "[planner]",
      "[provenance-guard]",
      "[subagent-aggregation]",
      "[intent-ledger]",
      "[DEBUG",
    ]) {
      expect(result.text).not.toContain(marker);
    }
    expect(result.text).toContain("Реальный ответ.");
    expect(result.text).toContain("Конец.");
    const ids = result.stripped.map((e) => e.patternId);
    expect(ids).toContain("task_classifier_marker");
    expect(ids).toContain("planner_marker");
    expect(ids).toContain("provenance_guard_marker");
    expect(ids).toContain("subagent_aggregation_marker");
    expect(ids).toContain("intent_ledger_marker");
    expect(ids).toContain("debug_marker");
  });

  it("strips Node stack-trace lines (`    at fn (path:1:2)`)", () => {
    const input = [
      "Произошла ошибка:",
      "    at runAgentTurn (/app/dist/agents/run.js:42:15)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
      "Подожди минуту.",
    ].join("\n");
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).not.toMatch(/\bat\s+\S+\s+\(/u);
    expect(result.text).toContain("Произошла ошибка:");
    expect(result.text).toContain("Подожди минуту.");
    expect(result.stripped.find((e) => e.patternId === "node_stack_trace")?.count).toBe(2);
  });

  it("strips Node ESM file:/// stack-trace fragments", () => {
    const input =
      "Boom: ReferenceError: foo is not defined at runAgent (file:///C:/openclaw/dist/run.js:10:3) Tail message.";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).not.toContain("file:///");
    expect(result.stripped.find((e) => e.patternId === "node_error_path")?.count).toBe(1);
  });

  it("returns empty text + strip-events when entire payload is leak-only (caller substitutes fallback)", () => {
    const input = "[tools] cron failed: lol\n[task-classifier] decision=internal";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toBe("");
    expect(result.stripped.length).toBe(2);
  });

  it("collapses 3+ blank lines created by stripped markers into single double-newline", () => {
    const input =
      "Первая строка.\n[tools] foo failed: bar\n\n[planner] x\n\n\n\nПоследняя строка.";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).not.toMatch(/\n{3,}/u);
    expect(result.text).toContain("Первая строка.");
    expect(result.text).toContain("Последняя строка.");
  });

  it("counts multiple matches of the same pattern correctly", () => {
    const input =
      "[tools] a failed: x\nok\n[tools] b failed: y\nok2\n[tools] c failed: z";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.stripped.find((e) => e.patternId === "tool_error_marker")?.count).toBe(3);
  });

  it("does not touch user text containing legitimate brackets like [Bug]", () => {
    const input = "[Bug] feature X is flaky on iOS — investigating.";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toBe(input);
    expect(result.stripped).toEqual([]);
  });

  it("does not match marker prefix mid-sentence (line-anchored regex only)", () => {
    const input = "Reminder: [tools] is the keyword. Не падает.";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toBe(input);
    expect(result.stripped).toEqual([]);
  });
});

describe("outbound-sanitizer / Bug A — universal tool-call markers", () => {
  it("replaces balanced <tool_call>...</tool_call> XML with neutral marker", () => {
    const input =
      'Сейчас поищу.\n<tool_call>{"name":"web_search","arguments":{"q":"open models"}}</tool_call>\nГотово.';
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toContain(TOOL_CALL_MARKUP_REPLACEMENT);
    expect(result.text).not.toContain("<tool_call");
    expect(result.text).not.toContain("</tool_call>");
    expect(result.text).toContain("Сейчас поищу.");
    expect(result.text).toContain("Готово.");
    expect(
      result.stripped.find((e) => e.patternId === "universal_tool_call_xml")?.count,
    ).toBe(1);
  });

  it("replaces multiline <tool_use>...</tool_use> Anthropic-style block", () => {
    const input = [
      "Префикс.",
      '<tool_use name="exec">',
      '  {"command": "ls -la",',
      '   "cwd": "/tmp"}',
      "</tool_use>",
      "Суффикс.",
    ].join("\n");
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toContain(TOOL_CALL_MARKUP_REPLACEMENT);
    expect(result.text).not.toContain("<tool_use");
    expect(result.text).not.toContain("</tool_use>");
    expect(
      result.stripped.find((e) => e.patternId === "universal_tool_use_xml")?.count,
    ).toBe(1);
  });

  it("replaces legacy <function_call>...</function_call> OpenAI-style block", () => {
    const input =
      'Думаю...<function_call>{"name":"image","arguments":{"prompt":"кот"}}</function_call>Готово.';
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toContain(TOOL_CALL_MARKUP_REPLACEMENT);
    expect(result.text).not.toContain("<function_call");
    expect(
      result.stripped.find((e) => e.patternId === "universal_function_call_xml")?.count,
    ).toBe(1);
  });

  it("strips orphan open <tool_call ...> tag without closing (streaming-cut tail)", () => {
    const input = 'Префикс.\n<tool_call name="web_search">\nХвост обрезан…';
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).not.toContain("<tool_call");
    expect(result.text).toContain("Префикс.");
    expect(result.text).toContain("Хвост обрезан");
    expect(
      result.stripped.find((e) => e.patternId === "universal_tool_call_orphan_open")?.count,
    ).toBe(1);
  });

  it("strips orphan close </function_call> tag without opening (streaming-cut head)", () => {
    const input = "Раннее начало обрезано… </function_call>\nОстаток.";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).not.toContain("</function_call>");
    expect(result.text).toContain("Остаток.");
    expect(
      result.stripped.find((e) => e.patternId === "universal_tool_call_orphan_close")?.count,
    ).toBe(1);
  });

  it("replaces standalone JSON tool-call envelope without status/error", () => {
    const input =
      'Дальше я вызову поиск: {"name":"web_search","arguments":{"q":"open models"}}. Подожди.';
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toContain(TOOL_CALL_MARKUP_REPLACEMENT);
    expect(result.text).not.toContain('"name":"web_search"');
    expect(
      result.stripped.find((e) => e.patternId === "universal_tool_call_json_envelope")?.count,
    ).toBe(1);
  });

  it("does not confuse tool_error_envelope with tool_call_json_envelope (status/error keys win)", () => {
    const input =
      'Ошибка: {"status":"error","tool":"web_search","error":"timeout"}. Конец.';
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toContain(TOOL_ERROR_ENVELOPE_REPLACEMENT);
    expect(result.text).not.toContain(TOOL_CALL_MARKUP_REPLACEMENT);
    expect(
      result.stripped.find((e) => e.patternId === "tool_error_envelope")?.count,
    ).toBe(1);
    expect(
      result.stripped.find((e) => e.patternId === "universal_tool_call_json_envelope"),
    ).toBeUndefined();
  });

  it("combines Bug E line-marker strip with Bug A XML strip in single pass", () => {
    const input = [
      "[planner] step=1",
      "Промежуточная фраза.",
      '<tool_call>{"name":"x","arguments":{}}</tool_call>',
      "Финал.",
    ].join("\n");
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).not.toContain("[planner]");
    expect(result.text).not.toContain("<tool_call");
    expect(result.text).toContain(TOOL_CALL_MARKUP_REPLACEMENT);
    expect(result.text).toContain("Промежуточная фраза.");
    expect(result.text).toContain("Финал.");
    const ids = result.stripped.map((e) => e.patternId);
    expect(ids).toContain("planner_marker");
    expect(ids).toContain("universal_tool_call_xml");
  });

  it("does not strip prose mentioning tool_call without angle brackets", () => {
    const input =
      "В документации описан tool_call API: для function_call нужен arguments object.";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toBe(input);
    expect(result.stripped).toEqual([]);
  });

  it("does not strip code-block-like JSON without name+arguments shape", () => {
    const input = 'Конфиг: {"foo":"bar","baz":42}.';
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toBe(input);
    expect(result.stripped).toEqual([]);
  });
});

describe("outbound-sanitizer / formatOutboundSanitizerLog", () => {
  it("emits canonical telemetry line with bytes and patterns", () => {
    const line = formatOutboundSanitizerLog({
      channel: "telegram",
      stripped: [
        { patternId: "tool_error_marker", count: 2 },
        { patternId: "tool_error_envelope", count: 1 },
      ],
      sessionKey: "tg:42",
      bytesBefore: 200,
      bytesAfter: 150,
    });
    expect(line).toContain("[outbound-sanitizer]");
    expect(line).toContain("event=stripped");
    expect(line).toContain("channel=telegram");
    expect(line).toContain("patterns=[tool_error_marker*2,tool_error_envelope]");
    expect(line).toContain("session=tg:42");
    expect(line).toContain("bytes_before=200");
    expect(line).toContain("bytes_after=150");
  });

  it("omits session= when no sessionKey provided", () => {
    const line = formatOutboundSanitizerLog({
      channel: "signal",
      stripped: [{ patternId: "debug_marker", count: 1 }],
      bytesBefore: 100,
      bytesAfter: 80,
    });
    expect(line).not.toContain("session=");
  });
});

describe("outbound-sanitizer / fallback constants", () => {
  it("exports the signoff-approved fallback texts", () => {
    expect(EMPTY_AFTER_SANITIZATION_FALLBACK_TEXT).toBe("Запрос не удалось выполнить.");
    expect(TOOL_ERROR_ENVELOPE_REPLACEMENT).toBe("(внутренняя ошибка инструмента; обработана)");
    expect(TOOL_CALL_MARKUP_REPLACEMENT).toBe("(внутренний tool-call; обработан)");
  });
});

// ---------------------------------------------------------------------------
// NEW-D Phase 3 — locale gate (additive in-function branch)
// ---------------------------------------------------------------------------
//
// Sub-plan: `.cursor/plans/commitment_kernel_locale_aware_sanitizer.plan.md`
// §5 / phase 3 todo. Tests added in fail-first order BEFORE the sanitizer
// branch lands. The locale gate only fires when `policy.localeFilter` is
// defined; channels resolved without `localeFilter` (the historical default)
// MUST exhibit byte-identical behavior across all 16 existing patterns + clean
// text.
describe("outbound-sanitizer / locale_filter gate", () => {
  const localeFilterRu = {
    reasoning: "strip" as const,
    localeFilter: { allowedLocales: ["ru"] as readonly string[], minimumRatio: 0.5 },
  };
  const localeFilterEn = {
    reasoning: "strip" as const,
    localeFilter: { allowedLocales: ["en"] as readonly string[], minimumRatio: 0.5 },
  };

  it("(a) blocks ALERT-style English on a ru-only channel and emits locale_filter_block", () => {
    const input = "ALERT: Vladimir is waiting for confirmation";
    const result = sanitizeOutboundForExternalChannel(input, localeFilterRu);
    expect(result.text).toBe("");
    const ids = result.stripped.map((e) => e.patternId);
    expect(ids).toContain("locale_filter_block");
    expect(result.stripped.find((e) => e.patternId === "locale_filter_block")?.count).toBe(1);
  });

  it("(b) leaves Russian text unchanged on a ru-only channel (no locale_filter_block)", () => {
    const input = "Привет";
    const result = sanitizeOutboundForExternalChannel(input, localeFilterRu);
    expect(result.text).toBe(input);
    expect(result.stripped).toEqual([]);
  });

  it("(c) leaves English text unchanged on an en-only channel", () => {
    const input = "Hello, this is a perfectly ordinary English reply.";
    const result = sanitizeOutboundForExternalChannel(input, localeFilterEn);
    expect(result.text).toBe(input);
    expect(result.stripped).toEqual([]);
  });

  it("(d) does not block short text under the minimum-alphabetic-char threshold (e.g. 'OK')", () => {
    // 'OK' has only 2 alphabetic chars — under the documented 8-char threshold;
    // numeric-only and emoji-only inputs likewise must not fire the gate.
    expect(sanitizeOutboundForExternalChannel("OK", localeFilterRu).text).toBe("OK");
    expect(sanitizeOutboundForExternalChannel("OK", localeFilterRu).stripped).toEqual([]);
    expect(sanitizeOutboundForExternalChannel("5", localeFilterRu).text).toBe("5");
    expect(sanitizeOutboundForExternalChannel("👍", localeFilterRu).text).toBe("👍");
  });

  it("(e) blocks Latin-predominant text on a ru-only channel even when Cyrillic chars are present", () => {
    // 'Привет' = 6 cyrillic, 'here is a code block' = 17 latin → predominant=en.
    const input = "Привет, here is a code block";
    const result = sanitizeOutboundForExternalChannel(input, localeFilterRu);
    expect(result.text).toBe("");
    expect(result.stripped.map((e) => e.patternId)).toContain("locale_filter_block");
  });

  it("(f) regression: planner_marker strip wins before locale gate (text empty pre-locale-check)", () => {
    const input = "[planner] route=external lang=en step=1";
    const result = sanitizeOutboundForExternalChannel(input, localeFilterRu);
    // Existing planner_marker strip empties the text; the locale gate sees
    // empty text and MUST NOT fire (no `locale_filter_block` event).
    expect(result.text).toBe("");
    const ids = result.stripped.map((e) => e.patternId);
    expect(ids).toContain("planner_marker");
    expect(ids).not.toContain("locale_filter_block");
  });

  it("(g) backward-compat: undefined localeFilter → behavior byte-identical across 16 patterns + clean text", () => {
    // Build a payload that exercises every diagnostic pattern + a clean tail —
    // running with a policy whose `localeFilter` is undefined MUST match the
    // behavior of the no-policy default form across both `text` and `stripped`.
    const input = [
      "[tools] cron failed: scheduling",
      'Envelope: {"status":"error","tool":"web_search","error":"timeout"}',
      "[task-classifier] decision=internal",
      "[planner] step=1",
      "[provenance-guard] external→internal blocked",
      "[subagent-aggregation] count=2",
      "[intent-ledger] peek=0",
      "[DEBUG agent.run] step=42",
      "    at runAgentTurn (/app/dist/agents/run.js:42:15)",
      "Boom at runAgent (file:///C:/openclaw/dist/run.js:10:3) tail",
      '<tool_call>{"name":"a","arguments":{}}</tool_call>',
      "<tool_use>x</tool_use>",
      '<function_call>{"name":"b","arguments":{}}</function_call>',
      'JSON: {"name":"web_search","arguments":{"q":"x"}}',
      '<tool_use name="orphan">',
      "trailing </function_call>",
      "Финал — нормальный текст.",
    ].join("\n");
    const baseline = sanitizeOutboundForExternalChannel(input);
    const withUndefined = sanitizeOutboundForExternalChannel(input, { reasoning: "strip" });
    expect(withUndefined.text).toBe(baseline.text);
    expect(withUndefined.stripped).toEqual(baseline.stripped);
    // No locale_filter_block under the default policy.
    expect(baseline.stripped.find((e) => e.patternId === "locale_filter_block")).toBeUndefined();
  });
});
