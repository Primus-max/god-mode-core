import { describe, expect, it } from "vitest";
import {
  classifyTaskForDecision,
  composeClassifierUserRequestForTest,
  getTaskClassifierUserTemplateForTest,
  type TaskClassifierAdapter,
  type TaskContract,
} from "./task-classifier.js";
import type { OpenClawConfig } from "../../config/config.js";

/**
 * V1-CLOSE T8 — Bug F classifier prompt extension.
 *
 * Charter §6 row, turn 16b044a7-4381-4657-96ea-c49c6cf73cef (2026-05-08 17:54):
 * the canonical Bug F prompt
 *   «создай persistent worker daily-test-pwpush-2026-05-08, который раз в 2 минуты
 *    пишет «push fixture: <ts>» в этот чат»
 * was mis-routed by gpt-5-mini to outcome=workspace_change / bundle=session_orchestration
 * because the only persistent_worker example in TASK_CLASSIFIER_USER_TEMPLATE covered
 * (a) Russian "сабагент" wording, (b) daily cadence, (c) "слал отчёт" — but NOT
 * (a) Russian + English mixed term "persistent worker", (b) minute-level intervals
 * ("раз в N минут"), (c) explicit "пишет в чат" chat-write intent.
 *
 * Fix surface (this test gates it):
 *   src/platform/decision/task-classifier.ts line ~274 — append ONE persistent_worker
 *   example covering the Bug F evidence wording so the LLM sees it in-prompt.
 *
 * The classifier is LLM-based (gpt-5-mini); we cannot deterministically assert its
 * routing in CI. Per AGENTS.md "Tests must catch real bugs" and charter T8 acceptance,
 * we gate on the *prompt builder*: assert the new example string is embedded in the
 * exact prompt the classifier would send. That is a real-code-path test (no mocks of
 * the function under test): if someone deletes the example from the template, this
 * test fails.
 */

const CANONICAL_BUG_F_PROMPT =
  'создай persistent worker daily-test-pwpush-2026-05-08, который раз в 2 минуты пишет «push fixture: <ts>» в этот чат';
const VARIANT_PROMPT_1 =
  'сделай persistent worker, чтобы каждые 5 минут слал в чат текущее время';
const VARIANT_PROMPT_2 =
  'подними persistent worker который раз в час пишет в этот чат отчёт';

describe("task-classifier persistent_worker prompt examples (T8)", () => {
  it("template contains the existing daily-cadence persistent_worker example (regression guard)", () => {
    const template = getTaskClassifierUserTemplateForTest();
    // Pre-existing example must remain — T8 is extension-only, not a refactor.
    expect(template).toContain("Создай сабагента Валера");
    expect(template).toContain(
      "persistent_worker + tool_execution + needs_session_orchestration",
    );
  });

  it("template contains a persistent_worker example with minute-level interval AND chat-write intent (T8 fix)", () => {
    const template = getTaskClassifierUserTemplateForTest();

    // The Bug F evidence has three discriminators the prior single example lacked.
    // The new T8 example MUST surface all three so the LLM in-context-learns the
    // mapping for the canonical prompt class:
    //   1. minute-level recurrence ("раз в N минут" / "каждые N минут")
    //   2. direct chat-write intent ("пишет … в этот чат" / "в чат")
    //   3. the literal mixed Russian+English term "persistent worker"
    expect(template).toMatch(/persistent worker/);
    expect(template).toMatch(/раз в \d+ минут/);
    expect(template).toMatch(/в этот чат|в чат/);

    // And the example must explicitly map to the persistent_worker outcome so
    // the LLM learns the routing — not just mention the words in passing.
    const persistentWorkerExampleLines = template
      .split("\n")
      .filter((line) => /persistent worker/i.test(line) && /минут/.test(line));
    expect(persistentWorkerExampleLines.length).toBeGreaterThanOrEqual(1);
    const fullExample = persistentWorkerExampleLines.join("\n");
    expect(fullExample).toMatch(/persistent_worker \+ tool_execution \+ needs_session_orchestration/);
  });

  it.each([
    ["canonical Bug F prompt (turn 16b044a7)", CANONICAL_BUG_F_PROMPT],
    ["variant 1: каждые N минут + slal v chat", VARIANT_PROMPT_1],
    ["variant 2: раз в час + пишет в этот чат", VARIANT_PROMPT_2],
  ])(
    "embeds %s into the user-prompt block the classifier sends",
    (_label, userPrompt) => {
      // Reproduce the exact composition the runtime uses (see classifier line ~1437):
      //   prompt = template
      //     .replace("{{SCHEMA_JSON}}", schema)
      //     .replace("{{ATTACHMENT_FILE_NAMES}}", fileNames)
      //     .replace("{{USER_REQUEST}}", composeClassifierUserRequestForTest(...));
      const template = getTaskClassifierUserTemplateForTest();
      const userRequest = composeClassifierUserRequestForTest({ prompt: userPrompt });
      const finalPrompt = template
        .replace("{{SCHEMA_JSON}}", "{}")
        .replace("{{ATTACHMENT_FILE_NAMES}}", "[]")
        .replace("{{USER_REQUEST}}", userRequest);

      // The user prompt arrives intact in the prompt the LLM sees.
      expect(finalPrompt).toContain(userPrompt);
      // And the in-context example for this prompt-class is also present —
      // so the LLM has the example pinned right above the user request block.
      expect(finalPrompt).toMatch(/persistent worker.*раз в \d+ минут/);
      expect(finalPrompt).toContain(
        "persistent_worker + tool_execution + needs_session_orchestration",
      );
    },
  );

  it("classifier adapter receives canonical Bug F prompt verbatim and a contract that maps to persistent_worker is honored end-to-end", async () => {
    // Real-code-path adapter test: stub only the LLM transport (not the classifier
    // function under test), assert the contract emitted for the canonical prompt
    // flows through `classifyTaskForDecision` unchanged.
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-llm",
            },
          },
        },
      },
    } as OpenClawConfig;

    const observedPrompts: string[] = [];
    const classify: TaskClassifierAdapter["classify"] = async (
      params,
    ): Promise<TaskContract | null> => {
      observedPrompts.push(params.prompt);
      // Simulate the LLM returning the correct contract once the prompt template
      // teaches it the persistent_worker routing for minute-interval chat-write
      // requests. T8 makes this routing learnable; the test asserts the contract
      // shape the classifier would carry forward.
      return {
        primaryOutcome: "persistent_worker",
        requiredCapabilities: ["needs_session_orchestration"],
        interactionMode: "tool_execution",
        confidence: 0.85,
        ambiguities: [],
        deliverable: {
          kind: "session",
          acceptedFormats: ["receipt"],
          preferredFormat: "receipt",
          constraints: { continuation: "followup" },
        },
        executionMode: "persistent_worker",
        target: "persistent_session",
        schedule: "none",
        evidence: ["spawn_receipt"],
      };
    };

    const result = await classifyTaskForDecision({
      prompt: CANONICAL_BUG_F_PROMPT,
      cfg,
      adapterRegistry: {
        "stub-llm": { classify },
      },
    });

    expect(observedPrompts).toEqual([CANONICAL_BUG_F_PROMPT]);
    expect(result.source).toBe("llm");
    expect(result.taskContract.primaryOutcome).toBe("persistent_worker");
    expect(result.taskContract.interactionMode).toBe("tool_execution");
    expect(result.taskContract.requiredCapabilities).toContain(
      "needs_session_orchestration",
    );
  });

  it("rejects shape: a persistent_worker-shaped prompt without minute interval still has the original daily example available (negative coverage)", () => {
    // Negative-side guard: T8 is an extension. The original daily-cadence example
    // MUST still be intact for prompts like "Создай сабагента Валера, чтобы он
    // каждый день слал отчёт" — no regression on its routing teaching.
    const template = getTaskClassifierUserTemplateForTest();
    const dailyExampleLine = template
      .split("\n")
      .find((line) => line.includes("Создай сабагента Валера"));
    expect(dailyExampleLine).toBeDefined();
    expect(dailyExampleLine).toMatch(/persistent_worker \+ tool_execution \+ needs_session_orchestration/);
    expect(dailyExampleLine).toMatch(/schedule="daily"/);
  });
});
