import { z } from "zod";
import { DeliverableSpecSchema } from "../../produce/registry.js";

/**
 * Eval harness for TaskClassifier.
 *
 * This module is decision-adjacent but never parses user prompt text. It only:
 *   1. Loads pre-authored golden cases (data, not heuristics).
 *   2. Invokes a TaskClassifierAdapter through the shared interface.
 *   3. Compares structured TaskContract fields with exact / set-similarity matches.
 *
 * Anything that would touch the prompt as text MUST live in the classifier itself,
 * not in the eval harness. See `lint:routing:no-prompt-parsing`.
 */

const PrimaryOutcomeEnum = z.enum([
  "answer",
  "workspace_change",
  "external_delivery",
  "comparison_report",
  "calculation_result",
  "document_package",
  "document_extraction",
  "clarification_needed",
]);

const InteractionModeEnum = z.enum([
  "respond_only",
  "clarify_first",
  "tool_execution",
  "artifact_iteration",
]);

const CapabilityEnum = z.enum([
  "needs_visual_composition",
  "needs_multimodal_authoring",
  "needs_repo_execution",
  "needs_document_extraction",
  "needs_local_runtime",
  "needs_interactive_browser",
  "needs_high_reliability_provider",
  "needs_workspace_mutation",
  "needs_external_delivery",
  "needs_tabular_reasoning",
  "needs_web_research",
]);

const ExpectedDeliverableSchema = z
  .object({
    kind: DeliverableSpecSchema.shape.kind,
    acceptedFormats: z.array(z.string().min(1)).min(1).optional(),
    preferredFormat: z.string().min(1).optional(),
  })
  .strict();

export const GoldenCaseSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    fileNames: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).default([]),
    expectedTaskContract: z
      .object({
        primaryOutcome: PrimaryOutcomeEnum.optional(),
        interactionMode: InteractionModeEnum.optional(),
        requiredCapabilities: z.array(CapabilityEnum).optional(),
        deliverable: ExpectedDeliverableSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

export const GoldenSetSchema = z.array(GoldenCaseSchema).min(1);
export type GoldenSet = z.infer<typeof GoldenSetSchema>;

export type FieldScore = {
  expected: string | undefined;
  actual: string | undefined;
  match: boolean;
  graded: boolean;
};

export type SetScore = {
  expected: string[] | undefined;
  actual: string[];
  jaccard: number | undefined;
  exactMatch: boolean | undefined;
  graded: boolean;
};

export type CaseResult = {
  id: string;
  tags: string[];
  prompt: string;
  fileNames: string[];
  expectedTaskContract: GoldenCase["expectedTaskContract"];
  actualTaskContract:
    | {
        primaryOutcome: string;
        interactionMode: string;
        requiredCapabilities: string[];
        confidence: number;
        ambiguities: string[];
        deliverable?: {
          kind: string;
          acceptedFormats: string[];
          preferredFormat?: string;
        };
      }
    | null;
  scores: {
    primaryOutcome: FieldScore;
    interactionMode: FieldScore;
    deliverableKind: FieldScore;
    deliverablePreferredFormat: FieldScore;
    requiredCapabilities: SetScore;
  };
  latencyMs: number;
  error?: { message: string };
};

export type AggregateMetrics = {
  cases: number;
  errors: number;
  accuracy: {
    primaryOutcome: { matched: number; graded: number; ratio: number | null };
    interactionMode: { matched: number; graded: number; ratio: number | null };
    deliverableKind: { matched: number; graded: number; ratio: number | null };
    deliverablePreferredFormat: { matched: number; graded: number; ratio: number | null };
    requiredCapabilitiesExact: { matched: number; graded: number; ratio: number | null };
  };
  jaccard: {
    requiredCapabilities: { sum: number; graded: number; mean: number | null };
  };
  latencyMs: {
    samples: number;
    mean: number | null;
    p50: number | null;
    p95: number | null;
  };
};

export type EvalSnapshot = {
  meta: {
    schemaVersion: 1;
    backend: string;
    model: string;
    timestamp: string;
    durationMs: number;
    casesTotal: number;
    casesWithContract: number;
    errors: number;
    datasetSha256: string;
  };
  metrics: AggregateMetrics;
  perTag: Array<{ tag: string; n: number; metrics: AggregateMetrics }>;
  cases: CaseResult[];
};
