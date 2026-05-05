/**
 * Slice I Phase 3 — `english_meta_*` pattern family.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_reply_sanitizer.plan.md` (todo
 * `i-phase-3-meta-text-pattern-family`). Phase 3 lands the `kind="strip"`
 * behaviour for the 7 curated leading-imperative regexes; the
 * `policy.reasoning === "structured"` branch ships in Phase 5 along with the
 * policy-aware sanitizer call signature.
 *
 * Bug B5 evidence (2026-05-04 19:38–19:42 Telegram):
 *   "Let me check memory for any context about Vladimir's preferences."
 * leaked into a Russian-language assistant turn. This file pins the contract
 * — each curated pattern strips its leading sentence; nothing inside a fenced
 * code block (or inline `code` span) is ever touched; clean Russian prose and
 * the existing 16 leak patterns are byte-identical to pre-Phase-3 behaviour.
 *
 * Test discipline (sub-plan §5 + AGENTS.md "Tests must catch real bugs"):
 *   - one positive case per pattern (the leak the regex strips)
 *   - one negative case per pattern (legitimate same-prefix usage that MUST NOT match)
 *   - one code-block-protected case per pattern (fenced or inline)
 *   - regression suite asserting the existing 16 patterns still strip identically
 *   - reverse-test on telemetry: patternId names match the documented `english_meta_*` ids
 *   - no `vi.spyOn` on the function under test
 */

import { describe, expect, it } from "vitest";
import {
  __OUTBOUND_LEAK_PATTERN_IDS_FOR_TESTS,
  sanitizeOutboundForExternalChannel,
} from "./outbound-sanitizer.js";

const ENGLISH_META_PATTERN_IDS = [
  "english_meta_let_me",
  "english_meta_ill",
  "english_meta_i_should",
  "english_meta_first_ill",
  "english_meta_lets",
  "english_meta_looking_at",
  "english_meta_checking",
] as const;

type EnglishMetaPatternId = (typeof ENGLISH_META_PATTERN_IDS)[number];

interface PatternCase {
  readonly id: EnglishMetaPatternId;
  /** Leading meta-thinking line that MUST be stripped. */
  readonly positive: string;
  /** Sentence sharing the same prefix in legitimate context that MUST NOT match. */
  readonly negative: string;
  /** Same leak appearing inside a fenced code block — MUST be preserved verbatim. */
  readonly codeBlockProtected: string;
}

const CASES: readonly PatternCase[] = [
  {
    id: "english_meta_let_me",
    positive: "Let me check memory for any context about Vladimir's preferences.",
    // "know" is not in the curated verb list (check|look|search|verify|see)
    negative: "Let me know if that works for you.",
    codeBlockProtected: "Let me check the database row before commit",
  },
  {
    id: "english_meta_ill",
    positive: "I'll search the registry for matching plugins first.",
    negative: "I'll be there in five minutes — promise.",
    codeBlockProtected: "I'll verify with assert(x === 1)",
  },
  {
    id: "english_meta_i_should",
    positive: "I should verify this before responding.",
    negative: "I shouldn't worry about that yet.",
    codeBlockProtected: "I should call doThing() here",
  },
  {
    id: "english_meta_first_ill",
    positive: "First, I'll search through the conversation log.",
    negative: "First the user said hello, then they asked a question.",
    codeBlockProtected: "First, I'll set x = 1",
  },
  {
    id: "english_meta_lets",
    positive: "Let's check the audit trail real quick.",
    negative: "Let's go to the park later.",
    codeBlockProtected: "Let's verify with strict mode on",
  },
  {
    id: "english_meta_looking_at",
    positive: "Looking at the previous turn, the user asked about plugins.",
    negative: "Look at this — totally unrelated.",
    codeBlockProtected: "Looking at registry size",
  },
  {
    id: "english_meta_checking",
    positive: "Checking memory for any prior preferences.",
    negative: "Checking out tomorrow morning, see you then.",
    codeBlockProtected: "Checking memory bounds",
  },
];

describe("outbound-sanitizer / english_meta_* pattern family — pattern coverage", () => {
  it("ships exactly 23 patternIds total (16 existing + 7 english_meta_*)", () => {
    expect(__OUTBOUND_LEAK_PATTERN_IDS_FOR_TESTS).toHaveLength(23);
  });

  it("includes each documented english_meta_* id", () => {
    const ids = new Set(__OUTBOUND_LEAK_PATTERN_IDS_FOR_TESTS);
    for (const id of ENGLISH_META_PATTERN_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("preserves the existing 16 patternIds byte-identical (no rename, no removal)", () => {
    const ids = new Set(__OUTBOUND_LEAK_PATTERN_IDS_FOR_TESTS);
    for (const id of [
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
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });
});

describe("outbound-sanitizer / english_meta_* — positive (leak strip)", () => {
  for (const c of CASES) {
    it(`[${c.id}] strips leading meta-thinking line and emits matching strip-event`, () => {
      const input = `${c.positive}\n\nПривет! Это основной ответ.`;
      const result = sanitizeOutboundForExternalChannel(input);
      // The leading meta-thinking sentence MUST be gone:
      expect(result.text).not.toContain(c.positive);
      // The actual reply MUST survive verbatim:
      expect(result.text).toContain("Привет! Это основной ответ.");
      // After strip + trim, the result should not lead with empty newlines:
      expect(result.text.startsWith("\n")).toBe(false);
      // Telemetry: pattern id is the documented one, count >= 1:
      const event = result.stripped.find((e) => e.patternId === c.id);
      expect(event, `expected strip event with patternId=${c.id}`).toBeDefined();
      expect(event?.count).toBeGreaterThanOrEqual(1);
    });
  }

  it("acceptance §3: B5 verbatim leak collapses to the trailing reply only", () => {
    const input =
      "Let me check memory for any context about Vladimir's preferences.\n\nПривет!";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toBe("Привет!");
    expect(result.stripped.find((e) => e.patternId === "english_meta_let_me")?.count).toBe(1);
  });
});

describe("outbound-sanitizer / english_meta_* — negative (legitimate prefix MUST NOT match)", () => {
  for (const c of CASES) {
    it(`[${c.id}] preserves legitimate same-prefix sentence verbatim`, () => {
      const input = `${c.negative}\n\nДоп. контекст.`;
      const result = sanitizeOutboundForExternalChannel(input);
      // The legit sentence MUST survive untouched:
      expect(result.text).toContain(c.negative);
      // No english_meta_* event should fire:
      const fired = result.stripped.find((e) =>
        ENGLISH_META_PATTERN_IDS.includes(e.patternId as EnglishMetaPatternId),
      );
      expect(fired, `unexpected english_meta event: ${JSON.stringify(fired)}`).toBeUndefined();
    });
  }

  it("does not match meta-prefix mid-paragraph (line-anchored regex only)", () => {
    // "Let me check" appears mid-line, NOT at line start — must not match.
    const input = "User said: Let me check the schema. We answered with details.";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toBe(input);
    expect(result.stripped).toEqual([]);
  });

  it("does not match a code-identifier echo like letMe()", () => {
    const input = "Calling letMe() returns a Promise.";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toBe(input);
    expect(result.stripped).toEqual([]);
  });
});

describe("outbound-sanitizer / english_meta_* — fenced code block protection", () => {
  for (const c of CASES) {
    it(`[${c.id}] does NOT strip the leak when it is inside a fenced \`\`\` block`, () => {
      const input = [
        "Привет! Вот пример:",
        "```bash",
        c.codeBlockProtected,
        "echo done",
        "```",
        "Готово.",
      ].join("\n");
      const result = sanitizeOutboundForExternalChannel(input);
      // Code-block content MUST survive verbatim:
      expect(result.text).toContain(c.codeBlockProtected);
      // No english_meta event should fire — the only candidate is inside code:
      const fired = result.stripped.find((e) =>
        ENGLISH_META_PATTERN_IDS.includes(e.patternId as EnglishMetaPatternId),
      );
      expect(fired, `unexpected english_meta event: ${JSON.stringify(fired)}`).toBeUndefined();
    });
  }

  it("acceptance §4: B5 leak inside fenced ```bash``` block is NOT stripped", () => {
    const input = [
      "Пример скрипта:",
      "```bash",
      "Let me check memory for any context about Vladimir's preferences.",
      "echo ok",
      "```",
      "Конец.",
    ].join("\n");
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toContain(
      "Let me check memory for any context about Vladimir's preferences.",
    );
    // No english_meta_* strip events fired:
    const fired = result.stripped.filter((e) =>
      ENGLISH_META_PATTERN_IDS.includes(e.patternId as EnglishMetaPatternId),
    );
    expect(fired).toEqual([]);
  });

  it("does NOT strip a leak when it is inside an inline `code` span on the same line", () => {
    const input = "Запусти `Let me check the schema` как dry-run.";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toBe(input);
    const fired = result.stripped.filter((e) =>
      ENGLISH_META_PATTERN_IDS.includes(e.patternId as EnglishMetaPatternId),
    );
    expect(fired).toEqual([]);
  });

  it("strips a leak OUTSIDE the code block but preserves IDENTICAL leak INSIDE the code block", () => {
    const input = [
      "Let me check memory for context.",
      "",
      "А вот пример из документации:",
      "```",
      "Let me check memory for context.",
      "```",
      "Конец.",
    ].join("\n");
    const result = sanitizeOutboundForExternalChannel(input);
    // The first occurrence (outside code) is stripped:
    const firstIdx = result.text.indexOf("Let me check memory for context.");
    // The remaining one MUST be inside the fenced block:
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    // Verify it's inside ``` fence by checking it appears between two ``` markers:
    const beforeMatch = result.text.slice(0, firstIdx);
    const afterMatch = result.text.slice(firstIdx);
    expect(beforeMatch).toContain("```");
    expect(afterMatch).toContain("```");
    // Exactly one strip event for the outside occurrence:
    expect(result.stripped.find((e) => e.patternId === "english_meta_let_me")?.count).toBe(1);
  });
});

describe("outbound-sanitizer / english_meta_* — regression: existing 16 patterns unchanged", () => {
  it("strips [tools] failed: marker exactly as before", () => {
    const input =
      "Извини, не вышло.\n[tools] cron failed: bad target.\nПопробуй ещё раз.";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).not.toContain("[tools]");
    expect(result.text).toContain("Извини, не вышло.");
    expect(result.text).toContain("Попробуй ещё раз.");
    expect(result.stripped.find((e) => e.patternId === "tool_error_marker")?.count).toBe(1);
  });

  it("replaces tool-error JSON envelope with neutral marker exactly as before", () => {
    const input =
      'Я попыталась найти, но {"status":"error","tool":"web_search","error":"bot challenge"}. Продолжаю.';
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toContain("(внутренняя ошибка инструмента; обработана)");
    expect(result.stripped.find((e) => e.patternId === "tool_error_envelope")?.count).toBe(1);
  });

  it("strips Node stack-trace lines exactly as before", () => {
    const input = [
      "Произошла ошибка:",
      "    at runAgentTurn (/app/dist/agents/run.js:42:15)",
      "Подожди.",
    ].join("\n");
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).not.toMatch(/\bat\s+\S+\s+\(/u);
    expect(result.stripped.find((e) => e.patternId === "node_stack_trace")?.count).toBe(1);
  });

  it("strips balanced <tool_call>...</tool_call> XML exactly as before", () => {
    const input =
      'Сейчас поищу.\n<tool_call>{"name":"web_search","arguments":{"q":"x"}}</tool_call>\nГотово.';
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toContain("(внутренний tool-call; обработан)");
    expect(result.stripped.find((e) => e.patternId === "universal_tool_call_xml")?.count).toBe(1);
  });
});

describe("outbound-sanitizer / english_meta_* — fully-clean text passthrough", () => {
  it("passes a Russian-only assistant reply through unchanged", () => {
    const input = "Привет! Это нормальный ответ от ассистента.\n\nВторой абзац.";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toBe(input);
    expect(result.stripped).toEqual([]);
  });

  it("passes a fully-Russian reply containing 'код' (sounds like 'code') through unchanged", () => {
    const input = "Код проверен. Конец.";
    const result = sanitizeOutboundForExternalChannel(input);
    expect(result.text).toBe(input);
    expect(result.stripped).toEqual([]);
  });
});

describe("outbound-sanitizer / english_meta_* — telemetry contract", () => {
  it("emits patternId values prefixed exactly with 'english_meta_' (no typos)", () => {
    const input = [
      "Let me check the registry.",
      "I'll search for hits.",
      "I should verify.",
      "First, I'll start.",
      "Let's check this.",
      "Looking at logs.",
      "Checking memory now.",
      "",
      "Привет!",
    ].join("\n");
    const result = sanitizeOutboundForExternalChannel(input);
    const englishMetaEvents = result.stripped.filter((e) =>
      e.patternId.startsWith("english_meta_"),
    );
    // At least one event per curated pattern fired:
    expect(englishMetaEvents.length).toBeGreaterThanOrEqual(ENGLISH_META_PATTERN_IDS.length);
    // Final text retains the user-facing reply:
    expect(result.text).toContain("Привет!");
    // No leaked meta-thinking sentence remains:
    for (const sample of [
      "Let me check the registry",
      "I'll search for hits",
      "I should verify",
      "First, I'll start",
      "Let's check this",
      "Looking at logs",
      "Checking memory now",
    ]) {
      expect(result.text).not.toContain(sample);
    }
  });
});
