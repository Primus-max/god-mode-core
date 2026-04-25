import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../../src/config/config.js";
import type { ResolutionContract } from "../../src/platform/decision/resolution-contract.js";
import {
  classifyTaskForDecision,
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
const DEFAULT_OUTPUT_DIR = path.join(EVAL_DIR, "output");
const EVAL_BACKEND = "decision-eval";

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
  actual: ActualDecision;
  decisionTrace?: DecisionTrace;
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
  results: CaseResult[];
};

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    casesPath: readFlagValue(args, "--cases") ?? DEFAULT_CASES_PATH,
    outputPath:
      readFlagValue(args, "--output") ??
      path.join(
        DEFAULT_OUTPUT_DIR,
        `decision-eval-${new Date().toISOString().replaceAll(":", "-")}.json`,
      ),
    caseFilter: readCsvFlag(args, "--case"),
    jsonOnly: args.includes("--json"),
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
        },
      },
    },
  } as OpenClawConfig;
}

async function runCase(caseItem: DecisionEvalCase): Promise<CaseResult> {
  const prompt = resolvePrompt(caseItem);
  const adapter: TaskClassifierAdapter = {
    classify: async () => caseItem.classifierContract,
  };
  const classified = await classifyTaskForDecision({
    prompt,
    fileNames: caseItem.fileNames ?? [],
    ledgerContext: caseItem.ledgerContext,
    clarifyBudgetNotice: caseItem.clarifyBudgetNotice,
    cfg: makeEvalConfig(),
    input: {
      prompt,
      ...(caseItem.fileNames?.length ? { fileNames: caseItem.fileNames } : {}),
      ...(caseItem.channelHints ? { channelHints: caseItem.channelHints } : {}),
    },
    adapterRegistry: {
      [EVAL_BACKEND]: adapter,
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
    actual,
    ...(!pass && decisionTrace ? { decisionTrace } : {}),
  };
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

function renderHumanReport(payload: EvalPayload): string {
  const lines = [
    `Decision eval: ${String(payload.summary.passed)}/${String(payload.summary.total)} passed`,
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
  if (args.caseFilter) {
    cases = cases.filter((caseItem) => args.caseFilter?.has(caseItem.id));
  }
  if (cases.length === 0) {
    throw new Error("No decision eval cases selected.");
  }
  const results: CaseResult[] = [];
  for (const caseItem of cases) {
    results.push(await runCase(caseItem));
  }
  const payload: EvalPayload = {
    generatedAt: new Date().toISOString(),
    casesPath: args.casesPath,
    summary: summarize(results),
    results,
  };
  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  await fs.writeFile(args.outputPath, JSON.stringify(payload, null, 2), "utf8");
  if (args.jsonOnly) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderHumanReport(payload));
    console.log(`JSON: ${args.outputPath}`);
  }
  if (payload.summary.failed > 0) {
    process.exitCode = 1;
  }
}

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
