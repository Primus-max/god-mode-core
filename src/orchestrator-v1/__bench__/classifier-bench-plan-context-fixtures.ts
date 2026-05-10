/**
 * Plan-context classifier bench fixtures.
 *
 * Golden set for the SECOND Stage-A entry point
 * (`classifyTurnWithPendingContext`) — used when a `PendingTurn` exists
 * for the current chat. Each fixture is a (pendingPlan + userMessage)
 * pair plus the expected `kind` (and tool_names where the kind is one
 * of the plan-shape variants).
 *
 * These fixtures are HARDER than single-turn (the LLM has to reason
 * about plan correction vs. fresh args vs. abandonment). The bench
 * documents baseline accuracy in the PR body but does NOT enforce 100%
 * — separate from the 58-fixture single-turn bench which DOES enforce
 * 100% (see `classifier-bench-fixtures.ts`).
 *
 * Canonical entries:
 *   - PC1 (12:09→12:17 real Telegram turn 2026-05-10). Operator pasted
 *     a plan, bot stashed [write, image_generate], operator typed "Надо
 *     скачать, а не генерировать". Vanilla Stage A on the new text in
 *     isolation says refuse; plan-context Stage A is expected to say
 *     `edit_plan` with web_fetch/web_search.
 *   - PC11 (12:54 real Telegram turn 2026-05-10). Pending plan was
 *     [pdf, image_generate, write]. User reply combined TWO
 *     substitutions: drop pdf (templates are .docx) + replace
 *     image_generate with web_search ("найти, а не генерировать").
 *     Pre-enrichment Stage A dropped pdf correctly but kept
 *     image_generate. The enriched prompt teaches both at once.
 */

import type { PartialAction } from "../turn-state/types.js";

export type ExpectedPlanContextRouting =
  | { kind: "add_args" }
  | {
      kind: "edit_plan";
      tool_names: string[];
      /**
       * Optional alternative tool sets that also count as correct
       * (handles e.g. web_fetch vs web_search ambiguity when the user
       * said "скачать" without an explicit URL).
       */
      tool_names_alts?: string[][];
      sequencing?: "sequential" | "parallel";
    }
  | {
      kind: "replace_plan";
      tool_names: string[];
      tool_names_alts?: string[][];
      sequencing?: "sequential" | "parallel";
    }
  | {
      kind: "abandon";
      intent: "conversation" | "refuse";
    };

export type PlanContextFixture = {
  id: string;
  pendingPlan: PartialAction[];
  userMessage: string;
  expected: ExpectedPlanContextRouting;
  rationale: string;
};

export const PLAN_CONTEXT_FIXTURES: ReadonlyArray<PlanContextFixture> = [
  // ── canonical real symptom (12:09→12:17) ──────────────────────
  {
    id: "PC1-canonical-edit-image-to-fetch",
    pendingPlan: [
      { tool: "write", argsSoFar: {}, missingFields: ["path"] },
      { tool: "image_generate", argsSoFar: {}, missingFields: ["prompt"] },
    ],
    userMessage: "Надо скачать, а не генерировать, я тебе дал задание что надо делать.",
    expected: {
      kind: "edit_plan",
      tool_names: ["write", "web_fetch"],
      tool_names_alts: [
        ["write", "web_search"],
        ["write", "web_fetch"],
      ],
    },
    rationale:
      "Operator-stated correction: keep write, swap image_generate for the download tool. Web_fetch or web_search both acceptable since no explicit URL was given.",
  },
  // ── add_args ──────────────────────────────────────────────────
  {
    id: "PC2-add-args-write-path",
    pendingPlan: [
      { tool: "write", argsSoFar: { content: "конспект урока" }, missingFields: ["path"] },
    ],
    userMessage: "сохрани в /tmp/notes.md",
    expected: { kind: "add_args" },
    rationale: "User supplies the missing path, same single-tool plan.",
  },
  {
    id: "PC3-add-args-image-prompt",
    pendingPlan: [
      { tool: "image_generate", argsSoFar: {}, missingFields: ["prompt"] },
    ],
    userMessage: "сгенерируй картинку советского бойца ВОВ в портретном стиле",
    expected: { kind: "add_args" },
    rationale: "User supplies the prompt; same tool, same plan.",
  },
  {
    id: "PC4-add-args-multi-tool",
    pendingPlan: [
      { tool: "write", argsSoFar: {}, missingFields: ["path"] },
      { tool: "pdf", argsSoFar: {}, missingFields: ["title"] },
    ],
    userMessage:
      "путь /work/practice.md, заголовок 'Отчёт по практике', содержимое — то что выше",
    expected: { kind: "add_args" },
    rationale: "User supplies args for both pending tools without changing the plan.",
  },
  // ── edit_plan ─────────────────────────────────────────────────
  {
    id: "PC5-edit-replace-image-with-fetch",
    pendingPlan: [
      { tool: "image_generate", argsSoFar: {}, missingFields: ["prompt"] },
    ],
    userMessage: "не генерируй, скачай https://example.com/photo.jpg",
    expected: {
      kind: "edit_plan",
      tool_names: ["web_fetch"],
    },
    rationale: "User explicitly says 'don't generate', provides a URL → swap image_generate for web_fetch.",
  },
  {
    id: "PC6-edit-add-pdf-keep-write",
    pendingPlan: [
      { tool: "write", argsSoFar: {}, missingFields: ["path"] },
    ],
    userMessage: "и ещё PDF-отчёт по этой же теме",
    expected: {
      kind: "edit_plan",
      tool_names: ["write", "pdf"],
    },
    rationale: "User adds pdf without dropping write — plan grows.",
  },
  // ── replace_plan ──────────────────────────────────────────────
  {
    id: "PC7-replace-pdf-with-read",
    pendingPlan: [
      { tool: "pdf", argsSoFar: {}, missingFields: ["title"] },
    ],
    userMessage: "забудь PDF, прочитай /tmp/y.txt",
    expected: {
      kind: "replace_plan",
      tool_names: ["read"],
    },
    rationale: "Explicit 'forget the previous task, do this other one' → wholesale replace.",
  },
  {
    id: "PC8-replace-write-with-search",
    pendingPlan: [
      { tool: "write", argsSoFar: {}, missingFields: ["path"] },
    ],
    userMessage: "лучше найди мне новости вторника по этой теме",
    expected: {
      kind: "replace_plan",
      tool_names: ["web_search"],
    },
    rationale: "User pivots from write to a fresh search task.",
  },
  // ── abandon ───────────────────────────────────────────────────
  {
    id: "PC9-abandon-conversation",
    pendingPlan: [
      { tool: "write", argsSoFar: {}, missingFields: ["path"] },
    ],
    userMessage: "ладно, забей. расскажи лучше анекдот",
    expected: { kind: "abandon", intent: "conversation" },
    rationale: "User abandons the plan and asks for chitchat.",
  },
  {
    id: "PC10-abandon-refuse",
    pendingPlan: [
      { tool: "exec", argsSoFar: {}, missingFields: ["command"] },
    ],
    userMessage: "сам разбирайся",
    expected: { kind: "abandon", intent: "refuse" },
    rationale: "User explicitly disengages without giving a new direction.",
  },
  // ── canonical real symptom (2026-05-10 12:54) ─────────────────
  // Pending plan was [pdf, image_generate, write]. User reply combines
  // TWO substitutions in one message: drop pdf (templates are .docx not
  // pdf) AND replace image_generate with web_search (find existing
  // images, not generate). Pre-enrichment Stage A dropped pdf correctly
  // but kept image_generate, leaving the user stuck on image_generate's
  // missing prompt arg. The enriched prompt teaches both substitutions.
  {
    id: "PC11-real-12-54-substitute-image-with-search-and-drop-pdf",
    pendingPlan: [
      { tool: "pdf", argsSoFar: {}, missingFields: ["title"] },
      { tool: "image_generate", argsSoFar: {}, missingFields: ["prompt"] },
      { tool: "write", argsSoFar: {}, missingFields: ["path"] },
    ],
    userMessage:
      "Надо найти изображения, а не генерировать, того о ком будет практика. Я дал приложил шаблоны word, а не pdf!!!",
    expected: {
      kind: "edit_plan",
      tool_names: ["web_search", "write"],
      tool_names_alts: [
        // Acceptable orderings — write may stay where it was relative to
        // the surviving search step.
        ["web_search", "write"],
        ["write", "web_search"],
      ],
    },
    rationale:
      "Real 12:54 turn. Drop pdf (user said 'не pdf'), replace image_generate with web_search ('найти изображения, а не генерировать'), keep write. Operator-confirmed canonical for prompt-enrichment slice.",
  },
  // ── more substitution coverage ────────────────────────────────
  {
    id: "PC12-substitute-image-with-search-no-url",
    pendingPlan: [
      { tool: "image_generate", argsSoFar: {}, missingFields: ["prompt"] },
    ],
    userMessage: "не генерируй, найди в интернете подходящую картинку",
    expected: {
      kind: "edit_plan",
      tool_names: ["web_search"],
      tool_names_alts: [["web_search"]],
    },
    rationale:
      "Pure image_generate ↔ web_search substitution: 'найти' + 'не генерируй' without a URL. Tests the search semantics in isolation.",
  },
  {
    id: "PC13-substitute-pdf-with-write-docx",
    pendingPlan: [
      { tool: "pdf", argsSoFar: { title: "Отчёт" }, missingFields: [] },
    ],
    userMessage: "не PDF, сделай в word-формате .docx",
    expected: {
      kind: "edit_plan",
      tool_names: ["write"],
      tool_names_alts: [["write"]],
    },
    rationale:
      "pdf → write substitution: user pivots format from PDF to .docx, write is the only catalog tool that produces a file with arbitrary content/format.",
  },
  {
    id: "PC14-substitute-write-with-edit",
    pendingPlan: [
      { tool: "write", argsSoFar: {}, missingFields: ["path"] },
    ],
    userMessage: "не создавай новый файл, поправь существующий /tmp/notes.md",
    expected: {
      kind: "edit_plan",
      tool_names: ["edit"],
      tool_names_alts: [["edit"]],
    },
    rationale:
      "write → edit substitution: user asks for in-place modification rather than overwrite/create.",
  },
];
