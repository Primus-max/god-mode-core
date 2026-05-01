import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../../src/config/config.js";
import {
  PERSISTENT_SESSION_EFFECT_FAMILY,
  UNKNOWN_EFFECT_FAMILY,
  type IntentContractorAdapter,
} from "../../src/platform/commitment/index.js";
import type { EffectId } from "../../src/platform/commitment/ids.js";
import type { SemanticIntent } from "../../src/platform/commitment/semantic-intent.js";
import type { ShadowBuildResult } from "../../src/platform/commitment/shadow-builder.js";
import type { ResolutionContract } from "../../src/platform/decision/resolution-contract.js";
import { runTurnDecision } from "../../src/platform/decision/run-turn-decision.js";
import {
  type TaskClassifierAdapter,
  type TaskContract,
} from "../../src/platform/decision/task-classifier.js";
import type { DecisionTrace } from "../../src/platform/decision/trace.js";
import type { RecipePlannerInput } from "../../src/platform/recipe/planner.js";
import { resolvePlatformRuntimePlan } from "../../src/platform/recipe/runtime-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EVAL_DIR = path.join(__dirname, "task-contract-eval");
const DEFAULT_CASES_PATH = path.join(EVAL_DIR, "cases.jsonl");
const DEFAULT_LABELS_PATH = path.join(EVAL_DIR, "cutover1-labels.json");
const DEFAULT_GATE_REPORT_PATH = path.join(EVAL_DIR, "cutover1-gate-report.json");
const DEFAULT_OUTPUT_DIR = path.join(EVAL_DIR, "output");
const EVAL_BACKEND = "decision-eval";
const SHADOW_EVAL_BACKEND = "decision-eval-shadow";
const PERSISTENT_SESSION_CREATED_EFFECT = "persistent_session.created" as EffectId;

type EvalMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChannelHints = {
  messageChannel?: string;
  channel?: string;
  replyChannel?: string;
};

type ExpectedDecision = {
  primaryOutcome?: string;
  interactionMode?: string;
  executionMode?: string;
  requestedTools?: string[];
  toolBundles?: string[];
  selectedRecipeId?: string;
  routingOutcomeKind?: string;
  shouldClarify?: boolean;
  deliverableKind?: string;
  deliverableFormats?: string[];
  errorTags?: string[];
};

type DecisionEvalCase = {
  id: string;
  description?: string;
  prompt?: string;
  messages?: EvalMessage[];
  fileNames?: string[];
  channelHints?: ChannelHints;
  ledgerContext?: string;
  clarifyBudgetNotice?: string;
  classifierContract: TaskContract;
  expected: ExpectedDecision;
  expectedShadowEffect?: EffectId;
  sessionId?: string;
};

type ActualDecision = {
  primaryOutcome: string;
  interactionMode: string;
  executionMode: string;
  requestedTools: string[];
  toolBundles: string[];
  selectedRecipeId: string;
  routingOutcomeKind: string;
  shouldClarify: boolean;
  deliverableKind: string | null;
  deliverableFormats: string[];
  resolutionContract: ResolutionContract;
  plannerInput: RecipePlannerInput;
};

type FieldDiff = {
  field: string;
  expected: unknown;
  actual: unknown;
};

type CaseResult = {
  id: string;
  description?: string;
  pass: boolean;
  errorTags: string[];
  diffs: FieldDiff[];
  expected: ExpectedDecision;
  expectedShadowEffect?: EffectId;
  actual: ActualDecision;
  decisionTrace?: DecisionTrace;
  shadow?: ShadowComparison;
  cutoverLabel?: Cutover1Label;
};

type ShadowDivergenceReason =
  | "shadow_unsupported_legacy_routed"
  | "shadow_committed_legacy_no_op"
  | "effect_mismatch"
  | "target_mismatch";

type ShadowComparison = {
  readonly intent: SemanticIntent;
  readonly result: ShadowBuildResult;
  readonly branchingFactor: number;
  readonly divergence?: {
    readonly reason: ShadowDivergenceReason;
    readonly note: string;
  };
};

type EvalSummary = {
  total: number;
  passed: number;
  failed: number;
  errorTagCounts: Record<string, number>;
};

type EvalPayload = {
  generatedAt: string;
  casesPath: string;
  summary: EvalSummary;
  shadowMetrics: ShadowMetrics;
  quantGate: QuantGateReport;
  results: CaseResult[];
};

type ShadowMetrics = {
  readonly commitment_correctness: number | null;
  readonly false_positive_success: 0;
  readonly state_observability_coverage: number;
  readonly divergence_count: number;
};

type Cutover1LabelSource = "auto" | "hindsight" | "human";

export type Cutover1Label = {
  readonly sessionId: string;
  readonly expected_satisfied: boolean;
  readonly label_source: Cutover1LabelSource;
};

export type QuantGateMetrics = {
  readonly state_observability_coverage: number;
  readonly commitment_correctness: number;
  readonly satisfaction_correctness: number;
  readonly false_positive_success: number;
  readonly divergence_explained: number;
  readonly labeling_window_honored: number;
};

export type QuantGateReport = {
  readonly n_turns: number;
  readonly metrics: QuantGateMetrics;
  readonly thresholds_passed: boolean;
  readonly label_source_breakdown: Record<Cutover1LabelSource, number>;
  readonly divergence_count: number;
};

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    casesPath: readFlagValue(args, "--cases") ?? DEFAULT_CASES_PATH,
    labelsPath: readFlagValue(args, "--labels") ?? DEFAULT_LABELS_PATH,
    outputPath:
      readFlagValue(args, "--output") ??
      path.join(
        DEFAULT_OUTPUT_DIR,
        `decision-eval-${new Date().toISOString().replaceAll(":", "-")}.json`,
      ),
    gateReportPath: readFlagValue(args, "--gate-report") ?? DEFAULT_GATE_REPORT_PATH,
    caseFilter: readCsvFlag(args, "--case"),
    jsonOnly: args.includes("--json"),
    sixMetrics: args.includes("--six-metrics"),
  };
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return args[index + 1];
}

function readCsvFlag(args: string[], flag: string): Set<string> | null {
  const raw = readFlagValue(args, flag)?.trim();
  if (!raw) {
    return null;
  }
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function sortUnique(values: readonly string[] | undefined): string[] {
  return Array.from(new Set(values ?? [])).toSorted();
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function arraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return stableJson(sortUnique(left)) === stableJson(sortUnique(right));
}

function pushDiff(diffs: FieldDiff[], field: string, expected: unknown, actual: unknown): void {
  diffs.push({ field, expected, actual });
}

async function readJsonlCases(filePath: string): Promise<DecisionEvalCase[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line, index) => {
      try {
        return JSON.parse(line) as DecisionEvalCase;
      } catch (error) {
        throw new Error(
          `Failed to parse ${path.basename(filePath)} line ${String(index + 1)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    });
}

export async function loadCutover1Labels(filePath: string): Promise<readonly Cutover1Label[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${path.basename(filePath)} must contain an array of cutover labels.`);
  }
  return parsed.map((entry, index) => parseCutover1Label(entry, index));
}

function parseCutover1Label(entry: unknown, index: number): Cutover1Label {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`cutover1-labels[${String(index)}] must be an object.`);
  }
  const record = entry as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  const expectedSatisfied = record.expected_satisfied;
  const labelSource = record.label_source;
  if (!sessionId) {
    throw new Error(`cutover1-labels[${String(index)}].sessionId is required.`);
  }
  if (typeof expectedSatisfied !== "boolean") {
    throw new Error(`cutover1-labels[${String(index)}].expected_satisfied must be boolean.`);
  }
  if (labelSource !== "auto" && labelSource !== "hindsight" && labelSource !== "human") {
    throw new Error(
      `cutover1-labels[${String(index)}].label_source must be auto, hindsight, or human.`,
    );
  }
  return {
    sessionId,
    expected_satisfied: expectedSatisfied,
    label_source: labelSource,
  };
}

function indexCutover1Labels(labels: readonly Cutover1Label[]): Map<string, Cutover1Label> {
  const out = new Map<string, Cutover1Label>();
  for (const label of labels) {
    if (out.has(label.sessionId)) {
      throw new Error(`Duplicate cutover1 label for sessionId=${label.sessionId}`);
    }
    out.set(label.sessionId, label);
  }
  return out;
}

export function assertCutover1LabelsPresent(
  cases: readonly DecisionEvalCase[],
  labels: ReadonlyMap<string, Cutover1Label>,
): void {
  const missing: string[] = [];
  for (const caseItem of cases) {
    if (
      caseItem.expectedShadowEffect !== PERSISTENT_SESSION_CREATED_EFFECT ||
      caseItem.classifierContract.primaryOutcome === "answer"
    ) {
      continue;
    }
    if (!caseItem.sessionId) {
      missing.push(`${caseItem.id}:missing_sessionId`);
      continue;
    }
    if (!labels.has(caseItem.sessionId)) {
      missing.push(`${caseItem.id}:missing_label:${caseItem.sessionId}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing cutover1 labels for quant-gate pool: ${missing.join(", ")}`);
  }
}

function resolvePrompt(caseItem: DecisionEvalCase): string {
  if (typeof caseItem.prompt === "string" && caseItem.prompt.trim().length > 0) {
    return caseItem.prompt;
  }
  const messages = caseItem.messages ?? [];
  const latestUser = messages.toReversed().find((message) => message.role === "user");
  if (latestUser) {
    return latestUser.content;
  }
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
}

function makeEvalConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        embeddedPi: {
          taskClassifier: {
            enabled: true,
            backend: EVAL_BACKEND,
          },
          intentContractor: {
            enabled: true,
            backend: SHADOW_EVAL_BACKEND,
          },
        },
      },
    },
  } as OpenClawConfig;
}

async function runCase(
  caseItem: DecisionEvalCase,
  cutoverLabels: ReadonlyMap<string, Cutover1Label>,
): Promise<CaseResult> {
  const prompt = resolvePrompt(caseItem);
  const adapter: TaskClassifierAdapter = {
    classify: async () => caseItem.classifierContract,
  };
  let shadowIntent = makeShadowIntent(caseItem);
  const intentAdapter: IntentContractorAdapter = {
    classify: async () => {
      shadowIntent = makeShadowIntent(caseItem);
      return shadowIntent;
    },
  };
  const { legacyDecision: classified, shadowCommitment } = await runTurnDecision({
    prompt,
    fileNames: caseItem.fileNames ?? [],
    ledgerContext: caseItem.ledgerContext,
    clarifyBudgetNotice: caseItem.clarifyBudgetNotice,
    cfg: makeEvalConfig(),
    classifierInput: {
      prompt,
      ...(caseItem.fileNames?.length ? { fileNames: caseItem.fileNames } : {}),
      ...(caseItem.channelHints ? { channelHints: caseItem.channelHints } : {}),
    },
    classifierAdapterRegistry: {
      [EVAL_BACKEND]: adapter,
    },
    intentContractorAdapterRegistry: {
      [SHADOW_EVAL_BACKEND]: intentAdapter,
    },
  });
  const runtimePlan = resolvePlatformRuntimePlan(classified.plannerInput);
  const runtime = runtimePlan.runtime;
  const actual: ActualDecision = {
    primaryOutcome: classified.taskContract.primaryOutcome,
    interactionMode: classified.taskContract.interactionMode,
    executionMode: classified.taskContract.interactionMode,
    requestedTools: sortUnique(
      runtime.requestedToolNames ?? classified.plannerInput.requestedTools,
    ),
    toolBundles: sortUnique(classified.resolutionContract.toolBundles),
    selectedRecipeId: runtime.selectedRecipeId,
    routingOutcomeKind: runtime.routingOutcome?.kind ?? "unknown",
    shouldClarify:
      classified.taskContract.primaryOutcome === "clarification_needed" ||
      classified.taskContract.interactionMode === "clarify_first" ||
      runtime.lowConfidenceStrategy === "clarify" ||
      runtime.routingOutcome?.kind === "low_confidence_clarify",
    deliverableKind: runtime.deliverable?.kind ?? null,
    deliverableFormats: sortUnique(runtime.deliverable?.acceptedFormats),
    resolutionContract: classified.resolutionContract,
    plannerInput: classified.plannerInput,
  };
  const decisionTrace = runtime.decisionTrace;
  const diffs = diffExpected(caseItem.expected, actual);
  const errorTags = deriveErrorTags(caseItem.expected, actual, diffs, decisionTrace);
  const expectedTags = sortUnique(caseItem.expected.errorTags ?? []);
  const pass = arraysEqual(expectedTags, errorTags);
  return {
    id: caseItem.id,
    ...(caseItem.description ? { description: caseItem.description } : {}),
    pass,
    errorTags,
    diffs,
    expected: caseItem.expected,
    ...(caseItem.expectedShadowEffect
      ? { expectedShadowEffect: caseItem.expectedShadowEffect }
      : {}),
    actual,
    shadow: buildShadowComparison(caseItem, actual, shadowIntent, shadowCommitment),
    ...(caseItem.sessionId && cutoverLabels.has(caseItem.sessionId)
      ? { cutoverLabel: cutoverLabels.get(caseItem.sessionId)! }
      : {}),
    ...(!pass && decisionTrace ? { decisionTrace } : {}),
  };
}

function makeShadowIntent(caseItem: DecisionEvalCase): SemanticIntent {
  if (caseItem.expectedShadowEffect === PERSISTENT_SESSION_CREATED_EFFECT) {
    return {
      desiredEffectFamily: PERSISTENT_SESSION_EFFECT_FAMILY,
      target: { kind: "session" },
      operation: { kind: "create" },
      constraints: {},
      uncertainty: [],
      confidence: 0.95,
    };
  }
  return {
    desiredEffectFamily: UNKNOWN_EFFECT_FAMILY,
    target: { kind: "unspecified" },
    constraints: {},
    uncertainty: ["decision_eval_unlabeled"],
    confidence: 0,
  };
}

function buildShadowComparison(
  caseItem: DecisionEvalCase,
  actual: ActualDecision,
  intent: SemanticIntent,
  result: ShadowBuildResult,
): ShadowComparison {
  return {
    intent,
    result,
    branchingFactor: result.kind === "commitment" ? 1 : 0,
    ...deriveShadowDivergence(caseItem, actual, result),
  };
}

function deriveShadowDivergence(
  caseItem: DecisionEvalCase,
  actual: ActualDecision,
  result: ShadowBuildResult,
): Pick<ShadowComparison, "divergence"> {
  if (
    caseItem.expectedShadowEffect &&
    result.kind === "commitment" &&
    result.value.effect !== caseItem.expectedShadowEffect
  ) {
    return {
      divergence: {
        reason: "effect_mismatch",
        note: `expected ${caseItem.expectedShadowEffect}, got ${result.value.effect}`,
      },
    };
  }
  if (
    caseItem.expectedShadowEffect &&
    result.kind === "unsupported" &&
    actual.routingOutcomeKind !== "unknown"
  ) {
    return {
      divergence: {
        reason: "shadow_unsupported_legacy_routed",
        note: `legacy routed with ${actual.routingOutcomeKind}`,
      },
    };
  }
  if (!caseItem.expectedShadowEffect && result.kind === "commitment") {
    return {
      divergence: {
        reason: "shadow_committed_legacy_no_op",
        note: "shadow committed on an unlabeled scenario",
      },
    };
  }
  return {};
}

function diffExpected(expected: ExpectedDecision, actual: ActualDecision): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  if (expected.primaryOutcome !== undefined && expected.primaryOutcome !== actual.primaryOutcome) {
    pushDiff(diffs, "primaryOutcome", expected.primaryOutcome, actual.primaryOutcome);
  }
  const expectedMode = expected.executionMode ?? expected.interactionMode;
  if (expectedMode !== undefined && expectedMode !== actual.executionMode) {
    pushDiff(diffs, "executionMode", expectedMode, actual.executionMode);
  }
  if (
    expected.interactionMode !== undefined &&
    expected.interactionMode !== actual.interactionMode
  ) {
    pushDiff(diffs, "interactionMode", expected.interactionMode, actual.interactionMode);
  }
  if (
    expected.requestedTools !== undefined &&
    !arraysEqual(expected.requestedTools, actual.requestedTools)
  ) {
    pushDiff(diffs, "requestedTools", sortUnique(expected.requestedTools), actual.requestedTools);
  }
  if (
    expected.toolBundles !== undefined &&
    !arraysEqual(expected.toolBundles, actual.toolBundles)
  ) {
    pushDiff(diffs, "toolBundles", sortUnique(expected.toolBundles), actual.toolBundles);
  }
  if (
    expected.selectedRecipeId !== undefined &&
    expected.selectedRecipeId !== actual.selectedRecipeId
  ) {
    pushDiff(diffs, "selectedRecipeId", expected.selectedRecipeId, actual.selectedRecipeId);
  }
  if (
    expected.routingOutcomeKind !== undefined &&
    expected.routingOutcomeKind !== actual.routingOutcomeKind
  ) {
    pushDiff(diffs, "routingOutcomeKind", expected.routingOutcomeKind, actual.routingOutcomeKind);
  }
  if (expected.shouldClarify !== undefined && expected.shouldClarify !== actual.shouldClarify) {
    pushDiff(diffs, "shouldClarify", expected.shouldClarify, actual.shouldClarify);
  }
  if (
    expected.deliverableKind !== undefined &&
    expected.deliverableKind !== actual.deliverableKind
  ) {
    pushDiff(diffs, "deliverableKind", expected.deliverableKind, actual.deliverableKind);
  }
  if (
    expected.deliverableFormats !== undefined &&
    !arraysEqual(expected.deliverableFormats, actual.deliverableFormats)
  ) {
    pushDiff(
      diffs,
      "deliverableFormats",
      sortUnique(expected.deliverableFormats),
      actual.deliverableFormats,
    );
  }
  return diffs;
}

function deriveErrorTags(
  expected: ExpectedDecision,
  actual: ActualDecision,
  diffs: readonly FieldDiff[],
  decisionTrace?: DecisionTrace,
): string[] {
  const tags = new Set<string>();
  for (const diff of diffs) {
    switch (diff.field) {
      case "primaryOutcome":
        tags.add("wrong_primary_outcome");
        break;
      case "executionMode":
      case "interactionMode":
        tags.add("wrong_execution_mode");
        break;
      case "requestedTools":
        tags.add("missing_required_tool");
        break;
      case "toolBundles":
        tags.add("bundle_recipe_mismatch");
        break;
      case "selectedRecipeId":
      case "routingOutcomeKind":
        tags.add("bundle_recipe_mismatch");
        break;
      case "deliverableKind":
      case "deliverableFormats":
        tags.add("wrong_deliverable");
        break;
      case "shouldClarify":
        tags.add(
          expected.shouldClarify === false && actual.shouldClarify
            ? "unnecessary_clarify"
            : "missed_clarify",
        );
        break;
      default:
        tags.add("decision_mismatch");
        break;
    }
  }
  if (
    actual.shouldClarify &&
    (actual.requestedTools.length > 0 ||
      actual.toolBundles.some((bundle) => bundle !== "respond_only"))
  ) {
    tags.add("policy_denial_leak_risk");
  }
  for (const tag of decisionTrace?.errorTags ?? []) {
    tags.add(tag);
  }
  return sortUnique(Array.from(tags));
}

function summarize(results: readonly CaseResult[]): EvalSummary {
  const errorTagCounts: Record<string, number> = {};
  for (const result of results) {
    for (const tag of result.errorTags) {
      errorTagCounts[tag] = (errorTagCounts[tag] ?? 0) + 1;
    }
  }
  const passed = results.filter((result) => result.pass).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    errorTagCounts,
  };
}

function summarizeShadow(results: readonly CaseResult[]): ShadowMetrics {
  const labeled = results.filter((result) => result.shadow && result.expectedShadowEffect);
  const correct = labeled.filter(
    (result) =>
      result.shadow?.result.kind === "commitment" &&
      result.shadow.result.value.effect === result.expectedShadowEffect,
  ).length;
  const runtimeErrors = results.filter(
    (result) =>
      result.shadow?.result.kind === "unsupported" &&
      result.shadow.result.reason === "shadow_runtime_error",
  ).length;
  return {
    commitment_correctness: labeled.length > 0 ? correct / labeled.length : null,
    false_positive_success: 0,
    state_observability_coverage:
      results.length > 0 ? (results.length - runtimeErrors) / results.length : 1,
    divergence_count: results.filter((result) => result.shadow?.divergence).length,
  };
}

export function summarizeQuantGate(results: readonly CaseResult[]): QuantGateReport {
  const pool = results.filter(
    (result) =>
      result.expectedShadowEffect === PERSISTENT_SESSION_CREATED_EFFECT &&
      result.actual.primaryOutcome !== "answer",
  );
  const nTurns = pool.length;
  const correctCommitments = pool.filter(
    (result) =>
      result.shadow?.result.kind === "commitment" &&
      result.shadow.result.value.effect === result.expectedShadowEffect,
  ).length;
  const observed = pool.filter((result) => result.cutoverLabel).length;
  const predictedSatisfied = (result: CaseResult): boolean =>
    result.shadow?.result.kind === "commitment" &&
    result.shadow.result.value.effect === PERSISTENT_SESSION_CREATED_EFFECT;
  const satisfactionCorrect = pool.filter((result) => {
    if (!result.cutoverLabel) {
      return false;
    }
    return predictedSatisfied(result) === result.cutoverLabel.expected_satisfied;
  }).length;
  const falsePositiveSuccess = pool.filter(
    (result) => result.cutoverLabel && predictedSatisfied(result) && !result.cutoverLabel.expected_satisfied,
  ).length;
  const divergenceCount = pool.filter((result) => result.shadow?.divergence).length;
  const divergenceExplained =
    divergenceCount === 0
      ? 1
      : pool.filter((result) => result.shadow?.divergence?.reason).length / divergenceCount;
  const labelingWindowHonoredCount = pool.filter((result) => {
    if (!result.cutoverLabel || result.cutoverLabel.label_source !== "hindsight") {
      return true;
    }
    const cutoverGate = (
      result.actual.plannerInput.decisionTrace as
        | { readonly cutoverGate?: { readonly kind?: string } }
        | undefined
    )?.cutoverGate;
    return cutoverGate?.kind === "gate_out" || cutoverGate?.kind === "gate_in_uncertain";
  }).length;
  const metrics: QuantGateMetrics = {
    state_observability_coverage: ratio(observed, nTurns, 1),
    commitment_correctness: ratio(correctCommitments, nTurns, 1),
    satisfaction_correctness: ratio(satisfactionCorrect, nTurns, 1),
    false_positive_success: falsePositiveSuccess,
    divergence_explained: divergenceExplained,
    labeling_window_honored: ratio(labelingWindowHonoredCount, nTurns, 1),
  };
  return {
    n_turns: nTurns,
    metrics,
    thresholds_passed: thresholdsPassed(nTurns, metrics),
    label_source_breakdown: labelSourceBreakdown(pool),
    divergence_count: divergenceCount,
  };
}

function ratio(numerator: number, denominator: number, emptyValue: number): number {
  return denominator > 0 ? numerator / denominator : emptyValue;
}

function thresholdsPassed(nTurns: number, metrics: QuantGateMetrics): boolean {
  return (
    nTurns >= 30 &&
    metrics.state_observability_coverage >= 0.9 &&
    metrics.commitment_correctness >= 0.95 &&
    metrics.satisfaction_correctness >= 0.95 &&
    metrics.false_positive_success === 0 &&
    metrics.divergence_explained === 1 &&
    metrics.labeling_window_honored === 1
  );
}

function labelSourceBreakdown(
  pool: readonly CaseResult[],
): Record<Cutover1LabelSource, number> {
  const out: Record<Cutover1LabelSource, number> = {
    auto: 0,
    hindsight: 0,
    human: 0,
  };
  for (const result of pool) {
    if (result.cutoverLabel) {
      out[result.cutoverLabel.label_source] += 1;
    }
  }
  return out;
}

function renderHumanReport(payload: EvalPayload): string {
  const lines = [
    `Decision eval: ${String(payload.summary.passed)}/${String(payload.summary.total)} passed`,
    `Shadow metrics: ${JSON.stringify(payload.shadowMetrics)}`,
    `Quant gate: ${JSON.stringify(payload.quantGate)}`,
  ];
  const failed = payload.results.filter((result) => !result.pass);
  if (failed.length > 0) {
    lines.push(`Error tags: ${JSON.stringify(payload.summary.errorTagCounts)}`);
    for (const result of failed) {
      lines.push(`FAIL ${result.id}: ${result.errorTags.join(", ") || "unknown"}`);
      for (const diff of result.diffs) {
        lines.push(
          `  ${diff.field}: expected=${JSON.stringify(diff.expected)} actual=${JSON.stringify(diff.actual)}`,
        );
      }
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs();
  let cases = await readJsonlCases(args.casesPath);
  const cutoverLabels = indexCutover1Labels(await loadCutover1Labels(args.labelsPath));
  if (args.caseFilter) {
    cases = cases.filter((caseItem) => args.caseFilter?.has(caseItem.id));
  }
  if (cases.length === 0) {
    throw new Error("No decision eval cases selected.");
  }
  if (args.sixMetrics) {
    assertCutover1LabelsPresent(cases, cutoverLabels);
  }
  const results: CaseResult[] = [];
  for (const caseItem of cases) {
    results.push(await runCase(caseItem, cutoverLabels));
  }
  const payload: EvalPayload = {
    generatedAt: new Date().toISOString(),
    casesPath: args.casesPath,
    summary: summarize(results),
    shadowMetrics: summarizeShadow(results),
    quantGate: summarizeQuantGate(results),
    results,
  };
  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  await fs.writeFile(args.outputPath, JSON.stringify(payload, null, 2), "utf8");
  if (args.sixMetrics) {
    const gatePayload = {
      generatedAt: payload.generatedAt,
      n_turns: payload.quantGate.n_turns,
      metrics: payload.quantGate.metrics,
      thresholds_passed: payload.quantGate.thresholds_passed,
      label_source_breakdown: payload.quantGate.label_source_breakdown,
      divergence_count: payload.quantGate.divergence_count,
    };
    await fs.writeFile(args.gateReportPath, JSON.stringify(gatePayload, null, 2), "utf8");
  }
  if (args.jsonOnly) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderHumanReport(payload));
    console.log(`JSON: ${args.outputPath}`);
  }
  if (payload.summary.failed > 0) {
    process.exitCode = 1;
  }
  if (args.sixMetrics && !payload.quantGate.thresholds_passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  void main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
}
