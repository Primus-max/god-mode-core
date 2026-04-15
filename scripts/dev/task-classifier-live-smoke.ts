import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawAgentDir } from "../../src/agents/agent-paths.js";
import { loadConfig } from "../../src/config/config.js";
import {
  classifyTaskForDecision,
  resolveTaskClassifierConfig,
  type TaskContract,
  type TaskClassifierDebugEvent,
} from "../../src/platform/decision/task-classifier.js";
import type { ResolutionContract } from "../../src/platform/decision/resolution-contract.js";
import type { RecipePlannerInput } from "../../src/platform/recipe/planner.js";
import { resolvePlatformRuntimePlan } from "../../src/platform/recipe/runtime-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.join(__dirname, "task-contract-eval", "output");

// Smoke scenarios test invariants, not family labels.
// Source of truth: primaryOutcome + interactionMode + requiredCapabilities + toolBundles.
type ScenarioId =
  | "general_answer"
  | "document_authoring"
  | "document_extraction"
  | "visual_asset_generation"
  | "tabular_compare"
  | "calculation_result"
  | "workspace_change"
  | "browser_observation"
  | "public_research"
  | "external_delivery";

type ScenarioPrompt = {
  label: "clean" | "noisy";
  prompt: string;
};

// Invariant-based expectations — not family labels
type ExpectedContract = {
  primaryOutcome: string;
  interactionMode: string;
  expectedCapabilities: string[];
  prohibitedCapabilities?: string[];
  notes: string;
};

type ScenarioDef = {
  id: ScenarioId;
  expected: ExpectedContract;
  fileNames?: string[];
  prompts: [ScenarioPrompt, ScenarioPrompt];
};

type ScenarioRecord = {
  scenario: ScenarioId;
  variant: ScenarioPrompt["label"];
  rawPrompt: string;
  classifierSource: "llm" | "heuristic";
  debugEvents: TaskClassifierDebugEvent[];
  taskContract: TaskContract;
  plannerInput: RecipePlannerInput;
  resolutionContract: ResolutionContract;
  selectedProfile: string;
  selectedRecipe: string;
  runtimeRoutingHints: RecipePlannerInput["routing"];
  // Contract-based signature — source of truth
  contractSignature: {
    primaryOutcome: string;
    interactionMode: string;
    requiredCapabilities: string[];
    toolBundles: string[];
  };
  // Invariant check results
  invariants: {
    sameContractAsClean: boolean;
    matchesExpectedPrimaryOutcome: boolean;
    matchesExpectedInteractionMode: boolean;
    expectedCapabilitiesMet: boolean;
    prohibitedCapabilitiesAbsent: boolean;
    noHeuristicFallback: boolean;
  };
};

type ScenarioSummary = {
  scenario: ScenarioId;
  expected: ExpectedContract;
  invariantResults: {
    contractStableAcrossVariants: boolean;
    toolBundlesStableAcrossVariants: boolean;
    expectedPrimaryOutcomeMatched: boolean;
    expectedInteractionModeMatched: boolean;
    allExpectedCapabilitiesPresent: boolean;
    noProhibitedCapabilitiesPresent: boolean;
    noHeuristicFallback: boolean;
  };
  variants: Array<{
    variant: ScenarioPrompt["label"];
    primaryOutcome: string;
    interactionMode: string;
    requiredCapabilities: string[];
    toolBundles: string[];
    classifierSource: "llm" | "heuristic";
  }>;
};

const SCENARIOS: readonly ScenarioDef[] = [
  {
    id: "general_answer",
    expected: {
      primaryOutcome: "answer",
      interactionMode: "respond_only",
      expectedCapabilities: [],
      prohibitedCapabilities: [
        "needs_workspace_mutation",
        "needs_repo_execution",
        "needs_local_runtime",
        "needs_interactive_browser",
        "needs_web_research",
      ],
      notes: "Invariant: lightweight chat should stay lightweight.",
    },
    prompts: [
      {
        label: "clean",
        prompt: "Give me three short ideas for a cozy evening at home.",
      },
      {
        label: "noisy",
        prompt: "Без лишних действий: просто предложи 3 короткие идеи для уютного вечера дома.",
      },
    ],
  },
  {
    id: "document_authoring",
    expected: {
      primaryOutcome: "document_package",
      interactionMode: "artifact_iteration",
      expectedCapabilities: ["needs_multimodal_authoring"],
      prohibitedCapabilities: ["needs_workspace_mutation"],
      notes: "Invariant: document authoring from notes should NOT trigger repo mutation.",
    },
    prompts: [
      {
        label: "clean",
        prompt:
          "Create a polished infographic PDF from these notes with a clear visual structure and supporting illustrations.",
      },
      {
        label: "noisy",
        prompt:
          "Нужно не просто текстом ответить: собери нормальный визуальный документ из этих заметок, с инфографикой, парой картинок и итоговым PDF, без ухода в правку репозитория.",
      },
    ],
  },
  {
    id: "document_extraction",
    expected: {
      primaryOutcome: "document_extraction",
      interactionMode: "tool_execution",
      expectedCapabilities: ["needs_document_extraction"],
      prohibitedCapabilities: ["needs_workspace_mutation", "needs_multimodal_authoring"],
      notes: "Invariant: extraction from supplied docs should not drift into authoring or repo edits.",
    },
    fileNames: ["invoice-pack.pdf"],
    prompts: [
      {
        label: "clean",
        prompt: "Extract vendor names, invoice dates, and totals from the attached PDF packet.",
      },
      {
        label: "noisy",
        prompt:
          "Из приложенного PDF вытащи ключевые поля по счетам: поставщик, дата и итоговая сумма, без написания нового документа.",
      },
    ],
  },
  {
    id: "visual_asset_generation",
    expected: {
      primaryOutcome: "document_package",
      interactionMode: "artifact_iteration",
      expectedCapabilities: ["needs_visual_composition"],
      prohibitedCapabilities: ["needs_workspace_mutation", "needs_document_extraction"],
      notes: "Invariant: image/visual creation should stay artifact-first and avoid repo mutation.",
    },
    prompts: [
      {
        label: "clean",
        prompt: "Create a cartoon poster image of a rasta cat with bright colors and clean composition.",
      },
      {
        label: "noisy",
        prompt:
          "Сделай именно готовую картинку: яркий мультяшный постер с котиком-раста, без разговоров про код или репозиторий.",
      },
    ],
  },
  {
    id: "tabular_compare",
    expected: {
      primaryOutcome: "comparison_report",
      interactionMode: "respond_only",
      expectedCapabilities: ["needs_tabular_reasoning"],
      prohibitedCapabilities: [
        "needs_workspace_mutation",
        "needs_interactive_browser",
        "needs_web_research",
      ],
      notes: "Invariant: comparing structured local files should stay analytical, not browser/repo driven.",
    },
    fileNames: ["vendor-a.xlsx", "vendor-b.xlsx"],
    prompts: [
      {
        label: "clean",
        prompt: "Compare the attached pricing sheets and summarize SKU-level price differences.",
      },
      {
        label: "noisy",
        prompt:
          "Сравни две приложенные таблицы с прайсами и коротко покажи расхождения по SKU и цене, без веб-ресерча.",
      },
    ],
  },
  {
    id: "calculation_result",
    expected: {
      primaryOutcome: "calculation_result",
      interactionMode: "respond_only",
      expectedCapabilities: [],
      prohibitedCapabilities: [
        "needs_workspace_mutation",
        "needs_repo_execution",
        "needs_local_runtime",
        "needs_interactive_browser",
        "needs_web_research",
      ],
      notes: "Invariant: pure calculation should not pull in tool-heavy execution by default.",
    },
    prompts: [
      {
        label: "clean",
        prompt:
          "Calculate the monthly payment for a 120000 loan over 24 months at 9% annual interest and show the result briefly.",
      },
      {
        label: "noisy",
        prompt:
          "Просто посчитай ежемесячный платёж по кредиту 120000 на 24 месяца под 9% годовых и дай короткий ответ.",
      },
    ],
  },
  {
    id: "workspace_change",
    expected: {
      primaryOutcome: "workspace_change",
      interactionMode: "tool_execution",
      expectedCapabilities: [
        "needs_workspace_mutation",
        "needs_repo_execution",
        "needs_local_runtime",
      ],
      prohibitedCapabilities: ["needs_interactive_browser", "needs_web_research"],
      notes: "Invariant: repo fix plus validation should stay code-execution focused, not browser/research.",
    },
    prompts: [
      {
        label: "clean",
        prompt:
          "Fix the failing behavior in this repo, run the relevant checks, and leave the local validation passing.",
      },
      {
        label: "noisy",
        prompt:
          "Не обсуждай абстрактно: поправь код прямо в репозитории, прогони нужные проверки и убедись, что локально всё живое перед завершением.",
      },
    ],
  },
  {
    id: "browser_observation",
    expected: {
      primaryOutcome: "comparison_report",
      interactionMode: "tool_execution",
      expectedCapabilities: ["needs_interactive_browser"],
      prohibitedCapabilities: ["needs_workspace_mutation", "needs_web_research"],
      notes: "Invariant: live page inspection should use browser capability, not repo edits or public research.",
    },
    prompts: [
      {
        label: "clean",
        prompt:
          "Open the local app, click through the signup flow, and report any visible UI or console issues.",
      },
      {
        label: "noisy",
        prompt:
          "Пройди по локальному сайту через браузер, посмотри форму регистрации и просто отчитай, если увидишь баги в UI или консоли.",
      },
    ],
  },
  {
    id: "public_research",
    expected: {
      primaryOutcome: "comparison_report",
      interactionMode: "tool_execution",
      expectedCapabilities: ["needs_web_research"],
      prohibitedCapabilities: ["needs_workspace_mutation", "needs_interactive_browser"],
      notes: "Invariant: latest public research should stay web-research-first, not browser-driving or repo editing.",
    },
    prompts: [
      {
        label: "clean",
        prompt:
          "Research current public pricing for three hosted vector databases and compare the tradeoffs.",
      },
      {
        label: "noisy",
        prompt:
          "Сделай ресёрч по актуальным публичным ценам у трёх managed vector DB и сравни плюсы-минусы для выбора.",
      },
    ],
  },
  {
    id: "external_delivery",
    expected: {
      primaryOutcome: "external_delivery",
      interactionMode: "tool_execution",
      expectedCapabilities: [
        "needs_external_delivery",
        "needs_repo_execution",
        "needs_local_runtime",
        "needs_high_reliability_provider",
      ],
      prohibitedCapabilities: ["needs_workspace_mutation", "needs_interactive_browser", "needs_web_research"],
      notes: "Invariant: explicit production delivery should stay delivery-first without silently turning into repo edits.",
    },
    prompts: [
      {
        label: "clean",
        prompt:
          "Run the release checks and publish the already-prepared build to production once validation passes.",
      },
      {
        label: "noisy",
        prompt:
          "Нужно именно выпустить уже готовую сборку в прод: сначала прогони релизные проверки, потом публикуй, без правок исходников.",
      },
    ],
  },
] as const;

function parseArgs() {
  const args = process.argv.slice(2);
  const allowFallback = args.includes("--allow-fallback");
  const familyRaw = readFlagValue(args, "--family");
  const outputRaw = readFlagValue(args, "--output");
  return {
    allowFallback,
    familyFilter: familyRaw?.trim() || undefined,
    outputPath:
      outputRaw?.trim() ||
      path.join(
        OUTPUT_DIR,
        `task-classifier-live-smoke-${new Date().toISOString().replaceAll(":", "-")}.json`,
      ),
  };
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return args[index + 1];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toContractSignature(
  taskContract: TaskContract,
  resolutionContract: ResolutionContract,
): ScenarioRecord["contractSignature"] {
  return {
    primaryOutcome: taskContract.primaryOutcome,
    interactionMode: taskContract.interactionMode,
    requiredCapabilities: [...taskContract.requiredCapabilities].toSorted(),
    toolBundles: [...resolutionContract.toolBundles].toSorted(),
  };
}

function contractSignatureKey(signature: ScenarioRecord["contractSignature"]): string {
  return JSON.stringify(signature);
}

function checkInvariants(
  taskContract: TaskContract,
  expected: ExpectedContract,
  classifierSource: "llm" | "heuristic",
  allowFallback: boolean,
): ScenarioRecord["invariants"] {
  const capabilities = new Set(taskContract.requiredCapabilities);
  const expectedCapabilitiesMet = expected.expectedCapabilities.every((cap) =>
    capabilities.has(cap as TaskContract["requiredCapabilities"][number]),
  );
  const prohibitedCapabilitiesAbsent = (expected.prohibitedCapabilities ?? []).every(
    (cap) => !capabilities.has(cap as TaskContract["requiredCapabilities"][number]),
  );
  return {
    sameContractAsClean: true, // Will be set by caller comparing variants
    matchesExpectedPrimaryOutcome: taskContract.primaryOutcome === expected.primaryOutcome,
    matchesExpectedInteractionMode: taskContract.interactionMode === expected.interactionMode,
    expectedCapabilitiesMet,
    prohibitedCapabilitiesAbsent,
    noHeuristicFallback: allowFallback || classifierSource === "llm",
  };
}

async function main() {
  const args = parseArgs();
  const cfg = cloneJson(loadConfig());
  cfg.agents ??= {};
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.embeddedPi ??= {};
  const existingTaskClassifier = cfg.agents.defaults.embeddedPi.taskClassifier;
  cfg.agents.defaults.embeddedPi.taskClassifier = {
    ...existingTaskClassifier,
    allowHeuristicFallback: args.allowFallback,
  };

  const agentDir = resolveOpenClawAgentDir();
  const classifierConfig = resolveTaskClassifierConfig({ cfg });
  const scenarios = args.familyFilter
    ? SCENARIOS.filter((scenario) => scenario.id === args.familyFilter)
    : [...SCENARIOS];
  if (scenarios.length === 0) {
    throw new Error(`Unknown --family value: ${args.familyFilter}`);
  }

  const records: ScenarioRecord[] = [];
  for (const scenario of scenarios) {
    for (const promptCase of scenario.prompts) {
      const debugEvents: TaskClassifierDebugEvent[] = [];
      const classified = await classifyTaskForDecision({
        prompt: promptCase.prompt,
        ...(scenario.fileNames?.length ? { fileNames: scenario.fileNames } : {}),
        cfg,
        agentDir,
        onDebugEvent: (event) => {
          debugEvents.push(event);
        },
      });
      const runtime = resolvePlatformRuntimePlan(classified.plannerInput);
      const contractSignature = toContractSignature(classified.taskContract, classified.resolutionContract);
      const invariants = checkInvariants(classified.taskContract, scenario.expected, classified.source, args.allowFallback);

      records.push({
        scenario: scenario.id,
        variant: promptCase.label,
        rawPrompt: promptCase.prompt,
        classifierSource: classified.source,
        debugEvents,
        taskContract: classified.taskContract,
        plannerInput: classified.plannerInput,
        resolutionContract: classified.resolutionContract,
        selectedProfile: runtime.runtime.selectedProfileId,
        selectedRecipe: runtime.runtime.selectedRecipeId,
        runtimeRoutingHints: runtime.runtime.routing ?? classified.plannerInput.routing,
        contractSignature,
        invariants,
      });
    }
  }

  // Compare clean vs noisy variants to check contract stability
  for (const scenario of scenarios) {
    const scenarioRecords = records.filter((r) => r.scenario === scenario.id);
    const cleanRecord = scenarioRecords.find((r) => r.variant === "clean");
    const noisyRecord = scenarioRecords.find((r) => r.variant === "noisy");

    if (cleanRecord && noisyRecord) {
      const sameContract = contractSignatureKey(cleanRecord.contractSignature) ===
                          contractSignatureKey(noisyRecord.contractSignature);
      cleanRecord.invariants.sameContractAsClean = true;
      noisyRecord.invariants.sameContractAsClean = sameContract;
    }
  }

  // Build invariant-based summaries
  const summaries: ScenarioSummary[] = scenarios.map((scenario) => {
    const variants = records.filter((record) => record.scenario === scenario.id);
    const contractSignatures = variants.map((v) => contractSignatureKey(v.contractSignature));
    const toolBundleSignatures = variants.map((v) => JSON.stringify(v.contractSignature.toolBundles));

    return {
      scenario: scenario.id,
      expected: scenario.expected,
      invariantResults: {
        contractStableAcrossVariants: new Set(contractSignatures).size === 1,
        toolBundlesStableAcrossVariants: new Set(toolBundleSignatures).size === 1,
        expectedPrimaryOutcomeMatched: variants.every(
          (v) => v.invariants.matchesExpectedPrimaryOutcome,
        ),
        expectedInteractionModeMatched: variants.every(
          (v) => v.invariants.matchesExpectedInteractionMode,
        ),
        allExpectedCapabilitiesPresent: variants.every((v) => v.invariants.expectedCapabilitiesMet),
        noProhibitedCapabilitiesPresent: variants.every((v) => v.invariants.prohibitedCapabilitiesAbsent),
        noHeuristicFallback: variants.every((v) => v.invariants.noHeuristicFallback),
      },
      variants: variants.map((variant) => ({
        variant: variant.variant,
        primaryOutcome: variant.taskContract.primaryOutcome,
        interactionMode: variant.taskContract.interactionMode,
        requiredCapabilities: variant.taskContract.requiredCapabilities,
        toolBundles: variant.resolutionContract.toolBundles,
        classifierSource: variant.classifierSource,
      })),
    };
  });

  // Overall pass/fail based on invariants
  const allPassed = summaries.every((s) =>
    s.invariantResults.contractStableAcrossVariants &&
    s.invariantResults.toolBundlesStableAcrossVariants &&
    s.invariantResults.expectedPrimaryOutcomeMatched &&
    s.invariantResults.expectedInteractionModeMatched &&
    s.invariantResults.allExpectedCapabilitiesPresent &&
    s.invariantResults.noProhibitedCapabilitiesPresent &&
    s.invariantResults.noHeuristicFallback
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    classifierConfig,
    agentDir,
    allowFallback: args.allowFallback,
    allPassed,
    summaries,
    records,
  };

  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  await fs.writeFile(args.outputPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(JSON.stringify(payload, null, 2));
  console.error(`Wrote live classifier smoke report to ${args.outputPath}`);

  if (!allPassed) {
    console.error("\nINVARIANT VIOLATIONS DETECTED:");
    for (const summary of summaries) {
      const failed = [];
      if (!summary.invariantResults.contractStableAcrossVariants) {
        failed.push("contractStable");
      }
      if (!summary.invariantResults.toolBundlesStableAcrossVariants) {
        failed.push("toolBundlesStable");
      }
      if (!summary.invariantResults.expectedPrimaryOutcomeMatched) {
        failed.push("primaryOutcome");
      }
      if (!summary.invariantResults.expectedInteractionModeMatched) {
        failed.push("interactionMode");
      }
      if (!summary.invariantResults.allExpectedCapabilitiesPresent) {
        failed.push("expectedCapabilities");
      }
      if (!summary.invariantResults.noProhibitedCapabilitiesPresent) {
        failed.push("prohibitedCapabilities");
      }
      if (!summary.invariantResults.noHeuristicFallback) {
        failed.push("heuristicFallback");
      }
      if (failed.length > 0) {
        console.error(`  ${summary.scenario}: ${failed.join(", ")}`);
      }
    }
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  const failure = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
});
