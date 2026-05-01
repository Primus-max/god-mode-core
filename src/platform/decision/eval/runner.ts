import { createHash } from "node:crypto";
import type { OpenClawConfig } from "../../../config/config.js";
import type {
  ResolvedTaskClassifierConfig,
  TaskClassifierAdapter,
  TaskContract,
} from "../task-classifier.js";
import { aggregateMetrics, aggregatePerTag, scoreCase } from "./scoring.js";
import type { CaseResult, EvalSnapshot, GoldenCase } from "./types.js";

export type RunEvaluationParams = {
  adapter: TaskClassifierAdapter;
  cases: readonly GoldenCase[];
  config: ResolvedTaskClassifierConfig;
  cfg: OpenClawConfig;
  agentDir?: string;
  now?: () => number;
  onCaseResult?: (result: CaseResult, index: number, total: number) => void;
};

function flattenContract(contract: TaskContract): NonNullable<CaseResult["actualTaskContract"]> {
  return {
    primaryOutcome: contract.primaryOutcome,
    interactionMode: contract.interactionMode,
    requiredCapabilities: [...contract.requiredCapabilities],
    confidence: contract.confidence,
    ambiguities: [...contract.ambiguities],
    ...(contract.deliverable
      ? {
          deliverable: {
            kind: contract.deliverable.kind,
            acceptedFormats: [...contract.deliverable.acceptedFormats],
            ...(contract.deliverable.preferredFormat
              ? { preferredFormat: contract.deliverable.preferredFormat }
              : {}),
          },
        }
      : {}),
  };
}

function hashCases(cases: readonly GoldenCase[]): string {
  const canonical = cases.map((c) => ({
    id: c.id,
    prompt: c.prompt,
    fileNames: c.fileNames ?? [],
    tags: [...c.tags].toSorted(),
    expected: c.expectedTaskContract,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export async function runEvaluation(params: RunEvaluationParams): Promise<EvalSnapshot> {
  const now = params.now ?? Date.now;
  const startedAt = now();
  const results: CaseResult[] = [];
  let casesWithContract = 0;
  let errors = 0;

  for (let index = 0; index < params.cases.length; index += 1) {
    const goldenCase = params.cases[index]!;
    const caseStart = now();
    let actual: CaseResult["actualTaskContract"] = null;
    let errorInfo: { message: string } | undefined;
    try {
      const contract = await params.adapter.classify({
        prompt: goldenCase.prompt,
        fileNames: goldenCase.fileNames ?? [],
        config: params.config,
        cfg: params.cfg,
        agentDir: params.agentDir,
      });
      if (contract) {
        actual = flattenContract(contract);
        casesWithContract += 1;
      } else {
        errorInfo = { message: "classifier returned null contract" };
        errors += 1;
      }
    } catch (error) {
      errorInfo = {
        message: error instanceof Error ? error.message : String(error),
      };
      errors += 1;
    }
    const latencyMs = Math.max(0, now() - caseStart);
    const result = scoreCase(goldenCase, actual, latencyMs, errorInfo);
    results.push(result);
    params.onCaseResult?.(result, index, params.cases.length);
  }

  const finishedAt = now();
  const metrics = aggregateMetrics(results);
  const perTag = aggregatePerTag(results);
  return {
    meta: {
      schemaVersion: 1,
      backend: params.config.backend,
      model: params.config.model,
      timestamp: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      casesTotal: params.cases.length,
      casesWithContract,
      errors,
      datasetSha256: hashCases(params.cases),
    },
    metrics,
    perTag,
    cases: results,
  };
}
