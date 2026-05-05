/**
 * Slice I Phase 5 — policy-aware `sanitizeOutboundForExternalChannel(text, policy?)`.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_reply_sanitizer.plan.md`.
 *
 * Slice I rollback (PR #162 / english_meta_* family reverted on 2026-05-05 per
 * master roadmap `commitment_kernel_v1_release_roadmap.plan.md` §3
 * "LLM-mediated, not regex"). The 7 `english_meta_*` regex patterns are gone;
 * B5 leak defense is now provided by (a) Phase 4 prompt hint in
 * `src/agents/pi-embedded-runner/internal-reasoning-hint.ts` instructing the
 * model to wrap reasoning in `<thinking>…</thinking>` and (b) the existing
 * extraction-path `stripThinkingTagsFromText` strip in
 * `src/agents/pi-embedded-utils.ts:280`.
 *
 * The `policy?: ReplySanitizerPolicy` parameter on
 * `sanitizeOutboundForExternalChannel` stays (signature is stable for future
 * tag-based wrap work) but the structured branch is currently a no-op for the
 * 16 diagnostic patterns — those are NOT reasoning leaks; they remain
 * strip/replace under every policy. This file therefore retains:
 *
 *   - signature compatibility (no-arg form == explicit strip policy);
 *   - resolver integration (telegram → strip, webchat → structured,
 *     slack → deferred) — the resolver still produces three distinct policy
 *     values for future tag-based wrap consumers;
 *   - regression on the 16 existing patterns (byte-identical across policies).
 *
 * Drops: every assertion that depended on regex-matching free-form English
 * (`english_meta_let_me` etc.). Such assertions were the architecturally
 * discouraged path and contradicted invariants #5/#6 in spirit (regex on
 * model output that approximates user text).
 *
 * Test discipline (sub-plan §5 + AGENTS.md "Tests must catch real bugs"):
 *   - No `vi.spyOn` on `sanitizeOutboundForExternalChannel` /
 *     `resolveReplySanitizerPolicy` — all cases use real instances.
 *   - Existing 16 leak patterns MUST be byte-identical regardless of policy.
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
      "Извини.\n[tools] cron failed: bad target.\nПопробуй ещё раз.";
    const noArg = sanitizeOutboundForExternalChannel(input);
    const explicitStrip = sanitizeOutboundForExternalChannel(input, STRIP_POLICY);
    expect(noArg).toEqual(explicitStrip);
  });

  it("accepts an explicit { reasoning: 'strip' } policy with byte-identical strip behaviour", () => {
    const input =
      "[planner] step=1\nПривет!";
    const noArg = sanitizeOutboundForExternalChannel(input);
    const explicit = sanitizeOutboundForExternalChannel(input, STRIP_POLICY);
    expect(explicit).toEqual(noArg);
  });

  it("clean Russian text with no leak patterns is untouched under every policy", () => {
    const input = "Привет! Это нормальный ответ от ассистента.\n\nВторой абзац.";
    for (const policy of [STRIP_POLICY, STRUCTURED_POLICY, DEFERRED_POLICY]) {
      const result = sanitizeOutboundForExternalChannel(input, policy);
      expect(result.text).toBe(input);
      expect(result.stripped).toEqual([]);
    }
  });
});

describe("sanitizeOutboundForExternalChannel / existing 16 patterns — byte-identical across policies", () => {
  // Slice I rollback: the 16 diagnostic patterns are NOT reasoning leaks; they
  // remain strip/replace under every policy. The structured branch becomes a
  // no-op here (future tag-based wrap will consume it for `<thinking>` content
  // when the strip-thinking-tags layer is moved into this module).
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

describe("sanitizeOutboundForExternalChannel / policy resolver integration", () => {
  // Resolver still produces three distinct policy values; each is consumable
  // by `sanitizeOutboundForExternalChannel(text, policy)` even though the
  // post-rollback sanitizer treats them identically for the existing 16
  // diagnostic patterns. Future tag-based wrap (move strip-thinking-tags into
  // this module) will branch on `policy.reasoning === "structured"` to
  // preserve `<thinking>` content for webchat instead of stripping it.

  it("policy resolved from telegram channel id has reasoning=strip and works on diagnostic leak", () => {
    const policy = resolveReplySanitizerPolicy("telegram");
    expect(policy.reasoning).toBe("strip");
    const result = sanitizeOutboundForExternalChannel(
      "[planner] step=1\nПривет!",
      policy,
    );
    expect(result.text).toContain("Привет!");
    expect(result.text).not.toContain("[planner]");
  });

  it("policy resolved from webchat channel id has reasoning=structured and is consumable by sanitizer", () => {
    const policy = resolveReplySanitizerPolicy("webchat");
    expect(policy.reasoning).toBe("structured");
    const result: OutboundSanitizerResult = sanitizeOutboundForExternalChannel(
      "[task-classifier] decision=internal\nПривет!",
      policy,
    );
    // Diagnostic patterns still strip on webchat — they are NOT reasoning;
    // they are raw internal markers that should never reach any external UI:
    expect(result.text).toContain("Привет!");
    expect(result.text).not.toContain("[task-classifier]");
  });

  it("policy resolved from slack channel id has reasoning=deferred and behaves like strip for diagnostics", () => {
    const policy = resolveReplySanitizerPolicy("slack");
    expect(policy.reasoning).toBe("deferred");
    const result = sanitizeOutboundForExternalChannel(
      "[planner] step=1\nПривет!",
      policy,
    );
    expect(result.text).toContain("Привет!");
    expect(result.text).not.toContain("[planner]");
  });
});
