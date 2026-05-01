import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type {
  ResolvedTaskClassifierConfig,
  TaskClassifierAdapter,
  TaskContract,
} from "../task-classifier.js";
import { runEvaluation } from "./runner.js";
import type { GoldenCase } from "./types.js";

const baseConfig: ResolvedTaskClassifierConfig = {
  enabled: true,
  backend: "test-backend",
  model: "test-model",
  timeoutMs: 1000,
  maxTokens: 100,
};

const baseCfg: OpenClawConfig = {} as OpenClawConfig;

function answerContract(): TaskContract {
  return {
    primaryOutcome: "answer",
    interactionMode: "respond_only",
    requiredCapabilities: [],
    confidence: 0.9,
    ambiguities: [],
    deliverable: { kind: "answer", acceptedFormats: ["text"] },
  };
}

function makeAdapter(
  responses: Array<TaskContract | null | Error>,
): TaskClassifierAdapter {
  let i = 0;
  return {
    async classify(): Promise<TaskContract | null> {
      const response = responses[i] ?? null;
      i += 1;
      if (response instanceof Error) {
        throw response;
      }
      return response;
    },
  };
}

function makeCase(id: string, expected: GoldenCase["expectedTaskContract"]): GoldenCase {
  return {
    id,
    prompt: `prompt-${id}`,
    tags: ["english"],
    expectedTaskContract: expected,
  };
}

describe("runEvaluation", () => {
  it("scores hits, misses, and errors and reports them in cases[]", async () => {
    const cases: GoldenCase[] = [
      makeCase("hit", { primaryOutcome: "answer" }),
      makeCase("miss", { primaryOutcome: "workspace_change" }),
      makeCase("error", { primaryOutcome: "answer" }),
    ];
    const adapter = makeAdapter([
      answerContract(),
      answerContract(),
      new Error("boom"),
    ]);
    let stepCount = 0;
    const snapshot = await runEvaluation({
      adapter,
      cases,
      config: baseConfig,
      cfg: baseCfg,
      now: () => stepCount++ * 10,
      onCaseResult: () => {
        // observed for completeness, not asserted
      },
    });
    expect(snapshot.meta.casesTotal).toBe(3);
    expect(snapshot.meta.casesWithContract).toBe(2);
    expect(snapshot.meta.errors).toBe(1);
    expect(snapshot.cases).toHaveLength(3);
    expect(snapshot.cases[0]!.scores.primaryOutcome.match).toBe(true);
    expect(snapshot.cases[1]!.scores.primaryOutcome.match).toBe(false);
    expect(snapshot.cases[2]!.error?.message).toBe("boom");
    expect(snapshot.metrics.accuracy.primaryOutcome.matched).toBe(1);
    expect(snapshot.metrics.accuracy.primaryOutcome.graded).toBe(3);
    expect(snapshot.meta.datasetSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("flattens deliverable fields onto the actual contract output", async () => {
    const cases: GoldenCase[] = [
      makeCase("docx", {
        primaryOutcome: "document_package",
        deliverable: { kind: "document", preferredFormat: "docx" },
      }),
    ];
    const adapter = makeAdapter([
      {
        primaryOutcome: "document_package",
        interactionMode: "artifact_iteration",
        requiredCapabilities: ["needs_multimodal_authoring"],
        confidence: 0.8,
        ambiguities: [],
        deliverable: {
          kind: "document",
          acceptedFormats: ["docx"],
          preferredFormat: "docx",
        },
      },
    ]);
    const snapshot = await runEvaluation({
      adapter,
      cases,
      config: baseConfig,
      cfg: baseCfg,
    });
    expect(snapshot.cases[0]!.actualTaskContract?.deliverable).toEqual({
      kind: "document",
      acceptedFormats: ["docx"],
      preferredFormat: "docx",
    });
    expect(snapshot.cases[0]!.scores.deliverableKind.match).toBe(true);
    expect(snapshot.cases[0]!.scores.deliverablePreferredFormat.match).toBe(true);
  });

  it("emits a stable dataset hash for identical input", async () => {
    const cases: GoldenCase[] = [
      makeCase("a", { primaryOutcome: "answer" }),
      makeCase("b", { primaryOutcome: "answer" }),
    ];
    const adapter = makeAdapter([answerContract(), answerContract()]);
    const adapter2 = makeAdapter([answerContract(), answerContract()]);
    const snapA = await runEvaluation({
      adapter,
      cases,
      config: baseConfig,
      cfg: baseCfg,
    });
    const snapB = await runEvaluation({
      adapter: adapter2,
      cases,
      config: baseConfig,
      cfg: baseCfg,
    });
    expect(snapA.meta.datasetSha256).toBe(snapB.meta.datasetSha256);
  });
});
