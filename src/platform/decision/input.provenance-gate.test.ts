/**
 * Tests for the typed-provenance short-circuit added to
 * `buildClassifiedExecutionDecisionInput`.
 *
 * The structural invariant under test: when the inbound prompt has a typed
 * `InputProvenance.kind` that is anything other than `external_user`, the
 * classifier must NOT be invoked and the resulting planner input must NOT
 * request `sessions_spawn` or any other tool. This breaks the
 * outbound→inbound self-feedback loop described in
 * `.cursor/plans/commitment_kernel_self_feedback_loop_fix.plan.md`.
 *
 * Reference invariants from `.cursor/rules/commitment-kernel-invariants.mdc`:
 * - #5 (no phrase / text-rule matching on UserPrompt outside whitelist) — gate
 *   keys off `InputProvenance.kind`, not text.
 * - #6 (`IntentContractor` is the only reader of raw user text) — for
 *   non-user provenance the classifier never reads the text at all.
 */

import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildClassifiedExecutionDecisionInput } from "./input.js";

function buildStubCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        embeddedPi: {
          taskClassifier: {
            backend: "stub-backend",
          },
        },
      },
    },
  } as OpenClawConfig;
}

describe("buildClassifiedExecutionDecisionInput — non-user provenance gate", () => {
  it("short-circuits inter_session prompts to a respond-only baseline without invoking the classifier", async () => {
    const classify = vi.fn();

    const plannerInput = await buildClassifiedExecutionDecisionInput({
      // Real receipt text observed in `terminals/384164.txt:99-104` which the
      // classifier had been mis-tagging as a fresh `persistent_worker` intent.
      prompt: [
        "Квитанция:",
        "- создана follow-up сессия: Федот",
        "- статус: активен",
        "- назначение: ежедневно готовить краткие отчёты",
      ].join("\n"),
      sessionEntry: {
        sessionId: "session-feedback-loop",
        sessionFile: "session-feedback-loop.jsonl",
      },
      channelHints: { messageChannel: "telegram" },
      cfg: buildStubCfg(),
      adapterRegistry: {
        "stub-backend": { classify },
      },
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "subagent_announce",
        sourceSessionKey: "agent:main:subagent:fedot",
        sourceChannel: "internal",
      },
    });

    expect(classify).not.toHaveBeenCalled();
    expect(plannerInput.requestedTools ?? []).toEqual([]);
    expect(plannerInput.artifactKinds ?? []).toEqual([]);
    expect(plannerInput.outcomeContract).toBe("text_response");
    expect(plannerInput.executionContract?.requiresTools).toBe(false);
    expect(plannerInput.executionContract?.requiresWorkspaceMutation).toBe(false);
    expect(plannerInput.executionContract?.requiresDeliveryEvidence).toBe(false);
    expect(plannerInput.classifierTelemetry?.source).toBe("provenance_guard");
    expect(plannerInput.classifierTelemetry?.primaryOutcome).toBe("answer");
    expect(plannerInput.classifierTelemetry?.interactionMode).toBe("respond_only");
  });

  it("short-circuits internal_system prompts the same way as inter_session", async () => {
    const classify = vi.fn();

    const plannerInput = await buildClassifiedExecutionDecisionInput({
      prompt: "[Subagent Context] Your prior run ended while waiting for descendant subagent completions.",
      sessionEntry: {
        sessionId: "session-internal",
        sessionFile: "session-internal.jsonl",
      },
      channelHints: { messageChannel: "telegram" },
      cfg: buildStubCfg(),
      adapterRegistry: {
        "stub-backend": { classify },
      },
      inputProvenance: {
        kind: "internal_system",
        sourceTool: "post_compaction_context",
      },
    });

    expect(classify).not.toHaveBeenCalled();
    expect(plannerInput.requestedTools ?? []).toEqual([]);
    expect(plannerInput.classifierTelemetry?.source).toBe("provenance_guard");
  });

  it("invokes the classifier normally when provenance kind is external_user", async () => {
    const classify = vi.fn().mockResolvedValue({
      primaryOutcome: "answer",
      requiredCapabilities: [],
      interactionMode: "respond_only",
      confidence: 0.95,
      ambiguities: [],
    });

    await buildClassifiedExecutionDecisionInput({
      prompt: "Расскажи кратко про реакторы на расплавленных солях.",
      sessionEntry: {
        sessionId: "session-external-user",
        sessionFile: "session-external-user.jsonl",
      },
      channelHints: { messageChannel: "telegram" },
      cfg: buildStubCfg(),
      adapterRegistry: {
        "stub-backend": { classify },
      },
      inputProvenance: {
        kind: "external_user",
        sourceChannel: "telegram",
      },
    });

    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("preserves legacy behaviour when inputProvenance is undefined (back-compat)", async () => {
    const classify = vi.fn().mockResolvedValue({
      primaryOutcome: "answer",
      requiredCapabilities: [],
      interactionMode: "respond_only",
      confidence: 0.95,
      ambiguities: [],
    });

    await buildClassifiedExecutionDecisionInput({
      prompt: "Привет",
      sessionEntry: {
        sessionId: "session-legacy-undefined",
        sessionFile: "session-legacy-undefined.jsonl",
      },
      channelHints: { messageChannel: "telegram" },
      cfg: buildStubCfg(),
      adapterRegistry: {
        "stub-backend": { classify },
      },
    });

    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("does NOT request sessions_spawn when fed the persistent_worker receipt text under inter_session provenance", async () => {
    // This is the focused regression test for the bug report. Feeding the
    // exact «Квитанция: follow-up сессия Федот активна…» payload that the
    // classifier had been classifying as `persistent_worker` must not produce
    // a planner input asking for `sessions_spawn` once the provenance gate is
    // in place — even when the classifier mock would still misfire on the
    // raw text.
    const classify = vi.fn().mockResolvedValue({
      primaryOutcome: "persistent_worker",
      requiredCapabilities: ["needs_session_orchestration"],
      interactionMode: "tool_execution",
      confidence: 0.9,
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
    });

    const plannerInput = await buildClassifiedExecutionDecisionInput({
      prompt: "Квитанция: follow-up сессия «Федот» активна, на связи и жду дальнейших инструкций.",
      sessionEntry: {
        sessionId: "5a8c7ab1-61b7-49ef-badf-1412e7a25d52",
        sessionFile: "session.jsonl",
      },
      channelHints: { messageChannel: "telegram" },
      cfg: buildStubCfg(),
      adapterRegistry: {
        "stub-backend": { classify },
      },
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "subagent_announce",
        sourceSessionKey: "agent:main:subagent:fedot",
      },
    });

    expect(classify).not.toHaveBeenCalled();
    expect(plannerInput.requestedTools ?? []).not.toContain("sessions_spawn");
    expect(plannerInput.requestedTools ?? []).toEqual([]);
  });
});
