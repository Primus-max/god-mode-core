/**
 * Slice I Phase 5 — policy-aware `sanitizeOutboundForExternalChannel(text, policy?)`.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_reply_sanitizer.plan.md` (todo
 * `i-phase-5-policy-aware-sanitizer-call`). Phase 5 wires the per-channel
 * `ReplySanitizerPolicy` resolved by `resolveReplySanitizerPolicy(channel)`
 * into the existing sanitizer call so the new `english_meta_*` family
 * branches on `policy.reasoning`:
 *
 *   - `"strip"`      — drop the matched leak line entirely (existing
 *                     plaintext-channel behaviour, byte-identical to Phase 3).
 *   - `"structured"` — wrap the matched line in `<thinking lang="en">…</thinking>`
 *                     so the webchat UI can render it.
 *   - `"deferred"`   — strip for the inline payload (slack/discord adapters
 *                     can later opt into a sidebar without re-touching this
 *                     module). v1 = `strip` semantics.
 *
 * Test discipline (sub-plan §5 + AGENTS.md "Tests must catch real bugs"):
 *   - Fail-first: every assertion below MUST fail against the current Phase-3
 *     `sanitizeOutboundForExternalChannel(text)` signature (it ignores the
 *     second positional argument; structured wrap and deferred branches do not
 *     exist yet on `dev` HEAD).
 *   - No `vi.spyOn` on `sanitizeOutboundForExternalChannel` /
 *     `resolveReplySanitizerPolicy` — all cases use real instances.
 *   - Existing 16 leak patterns MUST be byte-identical regardless of the
 *     policy passed (regression).
 *   - Cross-policy fuzz (sub-plan §5 Phase 5): 20 random combinations of
 *     existing-pattern leak + new-pattern leak + clean Russian text; assert
 *     the result is identical to applying patterns sequentially in
 *     policy-aware mode.
 */

import { describe, expect, it } from "vitest";
import {
  sanitizeOutboundForExternalChannel,
  type OutboundSanitizerResult,
} from "./outbound-sanitizer.js";
import {
  resolveReplySanitizerPolicy,
  type ReplySanitizerPolicy,
} from "./reply-sanitizer-policy.js";

const STRIP_POLICY: ReplySanitizerPolicy = { reasoning: "strip" };
const STRUCTURED_POLICY: ReplySanitizerPolicy = { reasoning: "structured" };
const DEFERRED_POLICY: ReplySanitizerPolicy = { reasoning: "deferred" };

describe("sanitizeOutboundForExternalChannel / signature compatibility", () => {
  it("preserves the no-arg form (defaults to strip policy) — existing call sites unaffected", () => {
    const input =
      "Let me check memory for any context about Vladimir's preferences.\n\nПривет!";
    const noArg = sanitizeOutboundForExternalChannel(input);
    const explicitStrip = sanitizeOutboundForExternalChannel(input, STRIP_POLICY);
    expect(noArg).toEqual(explicitStrip);
    expect(noArg.text).toBe("Привет!");
    expect(noArg.stripped.find((e) => e.patternId === "english_meta_let_me")?.count).toBe(1);
  });

  it("accepts an explicit { reasoning: 'strip' } policy with byte-identical strip behaviour", () => {
    const input =
      "Let me check memory for any context.\n[planner] step=1\nПривет!";
    const noArg = sanitizeOutboundForExternalChannel(input);
    const explicit = sanitizeOutboundForExternalChannel(input, STRIP_POLICY);
    expect(explicit).toEqual(noArg);
  });
});

describe("sanitizeOutboundForExternalChannel / policy=strip — english_meta_* branch", () => {
  it("strips B5 leak verbatim and emits english_meta_let_me telemetry", () => {
    const input =
      "Let me check memory for any context about Vladimir's preferences.\n\nПривет!";
    const result = sanitizeOutboundForExternalChannel(input, STRIP_POLICY);
    expect(result.text).toBe("Привет!");
    const event = result.stripped.find((e) => e.patternId === "english_meta_let_me");
    expect(event?.count).toBe(1);
  });

  it("strips each english_meta_* family member when policy=strip (matches Phase 3 behaviour)", () => {
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
    const result = sanitizeOutboundForExternalChannel(input, STRIP_POLICY);
    expect(result.text).toContain("Привет!");
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
    expect(result.text).not.toContain("<thinking");
  });
});

describe("sanitizeOutboundForExternalChannel / policy=deferred — same as strip in v1", () => {
  it("treats deferred as strip for english_meta_* (no inline wrap, no leak in payload)", () => {
    const input =
      "Let me check memory for any context about Vladimir's preferences.\n\nПривет!";
    const stripResult = sanitizeOutboundForExternalChannel(input, STRIP_POLICY);
    const deferredResult = sanitizeOutboundForExternalChannel(input, DEFERRED_POLICY);
    expect(deferredResult.text).toBe(stripResult.text);
    expect(deferredResult.stripped).toEqual(stripResult.stripped);
    expect(deferredResult.text).not.toContain("<thinking");
  });

  it("strips multi-pattern english_meta_* leak under deferred policy (slack v1 inline)", () => {
    const input = [
      "I'll search the registry first.",
      "Looking at the previous turn.",
      "",
      "Привет, как дела?",
    ].join("\n");
    const result = sanitizeOutboundForExternalChannel(input, DEFERRED_POLICY);
    expect(result.text).toContain("Привет, как дела?");
    expect(result.text).not.toContain("I'll search");
    expect(result.text).not.toContain("Looking at");
    expect(result.text).not.toContain("<thinking");
  });
});

describe("sanitizeOutboundForExternalChannel / policy=structured — webchat wrap", () => {
  it("wraps a B5-style leak line in <thinking lang=\"en\">…</thinking>, NOT strip", () => {
    const input =
      "Let me check memory for any context about Vladimir's preferences.\n\nПривет!";
    const result = sanitizeOutboundForExternalChannel(input, STRUCTURED_POLICY);
    // The leak line MUST be wrapped, not removed:
    expect(result.text).toContain('<thinking lang="en">');
    expect(result.text).toContain("</thinking>");
    expect(result.text).toContain(
      "Let me check memory for any context about Vladimir's preferences.",
    );
    // The Russian reply MUST survive verbatim:
    expect(result.text).toContain("Привет!");
    // Telemetry still fires — pattern matched, just rendered differently:
    const event = result.stripped.find((e) => e.patternId === "english_meta_let_me");
    expect(event?.count).toBe(1);
  });

  it("places the wrap on the SAME line that matched (no extra newline injection)", () => {
    const input =
      "Let me check memory for prior preferences.\n\nПривет!";
    const result = sanitizeOutboundForExternalChannel(input, STRUCTURED_POLICY);
    // Find the wrapped fragment:
    const wrappedFragment =
      '<thinking lang="en">Let me check memory for prior preferences.</thinking>';
    expect(result.text).toContain(wrappedFragment);
  });

  it("wraps each english_meta_* family member when policy=structured", () => {
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
    const result = sanitizeOutboundForExternalChannel(input, STRUCTURED_POLICY);
    // Every leak line is wrapped (not stripped):
    for (const sample of [
      "Let me check the registry",
      "I'll search for hits",
      "I should verify",
      "First, I'll start",
      "Let's check this",
      "Looking at logs",
      "Checking memory now",
    ]) {
      expect(result.text).toContain(sample);
    }
    // The user-facing reply survives:
    expect(result.text).toContain("Привет!");
    // Each wrap is `<thinking lang="en">…</thinking>` — count >= number of patterns:
    const wrapCount = (result.text.match(/<thinking lang="en">/g) ?? []).length;
    expect(wrapCount).toBe(7);
    const closeCount = (result.text.match(/<\/thinking>/g) ?? []).length;
    expect(closeCount).toBe(7);
  });

  it("escapes < and > in the wrapped line content (JSON-tagged form: `lang` attribute, content escaped)", () => {
    // A hypothetical leak line that itself contains an angle bracket (e.g. "Let me check <foo>"):
    const input = "Let me check <important> memory bounds.\n\nПривет!";
    const result = sanitizeOutboundForExternalChannel(input, STRUCTURED_POLICY);
    // Inside the wrap, the literal `<` MUST be escaped to `&lt;` so the wrap
    // stays a single well-formed `<thinking>` element:
    expect(result.text).toMatch(
      /<thinking lang="en">Let me check &lt;important&gt; memory bounds\.<\/thinking>/u,
    );
    expect(result.text).toContain("Привет!");
  });

  it("does NOT double-wrap a line the model already emitted as <thinking>…</thinking>", () => {
    // The streaming chunker `stripBlockTags` and `extractAssistantText` already
    // strip provider-emitted <thinking> tags before reaching the sanitizer.
    // But if a tag-shaped leak survives, the sanitizer MUST NOT wrap it again —
    // the sanitizer only wraps lines whose content matches an `english_meta_*`
    // regex, and such lines should not start with `<` after extraction.
    const input = "<thinking>Let me check memory.</thinking>\nПривет!";
    const result = sanitizeOutboundForExternalChannel(input, STRUCTURED_POLICY);
    // The english_meta regex is line-anchored on `^\s*Let me\s+(check|...)`;
    // if the line starts with `<thinking>` it should NOT match. Assert:
    const fired = result.stripped.find((e) => e.patternId === "english_meta_let_me");
    expect(fired).toBeUndefined();
    expect(result.text).toContain("Привет!");
  });

  it("does NOT wrap inside fenced code blocks (code-region awareness preserved)", () => {
    const input = [
      "Привет! Вот пример скрипта:",
      "```bash",
      "Let me check the database row before commit",
      "echo done",
      "```",
      "Конец.",
    ].join("\n");
    const result = sanitizeOutboundForExternalChannel(input, STRUCTURED_POLICY);
    // The leak is inside a fenced block — NO wrap injection:
    expect(result.text).not.toContain('<thinking lang="en">');
    expect(result.text).toContain(
      "Let me check the database row before commit",
    );
    // No english_meta_* event fired either:
    expect(
      result.stripped.find((e) => e.patternId.startsWith("english_meta_")),
    ).toBeUndefined();
  });

  it("preserves Russian content verbatim (no false-positive wrap on Cyrillic text)", () => {
    const input =
      "Я проверю память и контекст. Сейчас вернусь.\n\nГотово.";
    const result = sanitizeOutboundForExternalChannel(input, STRUCTURED_POLICY);
    expect(result.text).toBe(input);
    expect(result.stripped).toEqual([]);
    expect(result.text).not.toContain("<thinking");
  });
});

describe("sanitizeOutboundForExternalChannel / existing 16 patterns — byte-identical across policies", () => {
  // Sub-plan §0 todo i-phase-5: "existing 16 leak patterns remain unchanged on
  // EXTERNAL_DELIVERY_SURFACES. Only the new english_meta_* family branches on
  // policy.reasoning."
  const inputs: readonly { readonly name: string; readonly text: string }[] = [
    {
      name: "tool_error_marker",
      text: "Извини.\n[tools] cron failed: Bad target.\nПопробуй ещё раз.",
    },
    {
      name: "task_classifier_marker",
      text: "Готово.\n[task-classifier] decision=internal route=skip\nКонец.",
    },
    {
      name: "planner_marker",
      text: "Начинаю.\n[planner] plan_built=true steps=3\nДальше.",
    },
    {
      name: "tool_error_envelope",
      text: 'Я попыталась найти, но {"status":"error","tool":"web_search","error":"DuckDuckGo bot challenge"}. Продолжаю.',
    },
    {
      name: "node_stack_trace",
      text: "Произошла ошибка:\n    at runAgentTurn (/app/dist/agents/run.js:42:15)\nПодожди.",
    },
    {
      name: "universal_tool_call_xml",
      text: 'Сейчас.\n<tool_call>{"name":"web_search","arguments":{"q":"x"}}</tool_call>\nГотово.',
    },
  ];

  for (const policy of [STRIP_POLICY, STRUCTURED_POLICY, DEFERRED_POLICY]) {
    for (const { name, text } of inputs) {
      it(`[${name}] is identical under policy=${policy.reasoning} and the no-arg call`, () => {
        const noArg = sanitizeOutboundForExternalChannel(text);
        const withPolicy = sanitizeOutboundForExternalChannel(text, policy);
        expect(withPolicy.text).toBe(noArg.text);
        expect(withPolicy.stripped).toEqual(noArg.stripped);
      });
    }
  }
});

describe("sanitizeOutboundForExternalChannel / cross-policy fuzz (sub-plan §5 Phase 5)", () => {
  // 20 random combinations of (existing-pattern leak + new-pattern leak + clean text)
  // — assert the result of policy-aware mode is consistent: strip and deferred
  // produce the same payload; structured wraps english_meta_* lines but leaves
  // existing 16 leak patterns identically stripped.
  const englishMetaSamples = [
    "Let me check the registry.",
    "I'll search the index.",
    "I should verify the answer.",
    "First, I'll look at memory.",
    "Let's check what's available.",
    "Looking at the previous turn.",
    "Checking memory for prefs.",
  ];
  const existingLeakSamples = [
    "[tools] cron failed: bad target",
    "[task-classifier] decision=internal",
    "[planner] step=1",
    "[DEBUG agent.run] elapsed=42ms",
    '{"status":"error","tool":"web_search","error":"x"}',
  ];
  const cleanSamples = [
    "Привет!",
    "Готово.",
    "Это нормальный ответ от ассистента.",
    "Сейчас всё проверим.",
  ];

  function rng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0xffffffff;
    };
  }
  const random = rng(42);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(random() * arr.length)] as T;

  for (let i = 0; i < 20; i += 1) {
    const englishMeta = pick(englishMetaSamples);
    const existing = pick(existingLeakSamples);
    const clean = pick(cleanSamples);
    const input = [englishMeta, existing, clean].join("\n");
    it(`fuzz[${i}] strip and deferred produce identical output, structured preserves english_meta line wrapped`, () => {
      const stripResult = sanitizeOutboundForExternalChannel(input, STRIP_POLICY);
      const deferredResult = sanitizeOutboundForExternalChannel(input, DEFERRED_POLICY);
      const structuredResult = sanitizeOutboundForExternalChannel(input, STRUCTURED_POLICY);

      // strip == deferred: both drop english_meta_* + existing leaks identically
      expect(deferredResult.text).toBe(stripResult.text);
      expect(deferredResult.stripped).toEqual(stripResult.stripped);

      // structured: english_meta line is preserved (wrapped in <thinking>);
      // existing 16 leak markers are still stripped exactly as in strip mode.
      expect(structuredResult.text).toContain(clean);
      expect(structuredResult.text).not.toContain(existing);
      // english_meta line is still present (wrapped):
      expect(structuredResult.text).toContain(englishMeta);
      expect(structuredResult.text).toContain('<thinking lang="en">');

      // Strip events for existing 16 patterns are identical between strip and structured:
      const stripExistingIds = stripResult.stripped
        .filter((e) => !e.patternId.startsWith("english_meta_"))
        .map((e) => e.patternId)
        .sort();
      const structuredExistingIds = structuredResult.stripped
        .filter((e) => !e.patternId.startsWith("english_meta_"))
        .map((e) => e.patternId)
        .sort();
      expect(structuredExistingIds).toEqual(stripExistingIds);
    });
  }
});

describe("sanitizeOutboundForExternalChannel / policy resolver integration", () => {
  it("policy resolved from telegram channel id strips english_meta leak", () => {
    const policy = resolveReplySanitizerPolicy("telegram");
    expect(policy.reasoning).toBe("strip");
    const result = sanitizeOutboundForExternalChannel(
      "Let me check memory for prior context.\nПривет!",
      policy,
    );
    expect(result.text).toBe("Привет!");
  });

  it("policy resolved from webchat channel id wraps english_meta leak structurally", () => {
    const policy = resolveReplySanitizerPolicy("webchat");
    expect(policy.reasoning).toBe("structured");
    const result: OutboundSanitizerResult = sanitizeOutboundForExternalChannel(
      "Let me check memory for prior context.\nПривет!",
      policy,
    );
    expect(result.text).toContain('<thinking lang="en">');
    expect(result.text).toContain("Let me check memory for prior context.");
    expect(result.text).toContain("Привет!");
  });

  it("policy resolved from slack channel id is deferred → strip behaviour in v1", () => {
    const policy = resolveReplySanitizerPolicy("slack");
    expect(policy.reasoning).toBe("deferred");
    const result = sanitizeOutboundForExternalChannel(
      "Let me check memory for prior context.\nПривет!",
      policy,
    );
    expect(result.text).toBe("Привет!");
    expect(result.text).not.toContain("<thinking");
  });
});
