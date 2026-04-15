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

type ScenarioFamilyId =
  | "document_authoring"
  | "workspace_change"
  | "browser_observation"
  | "public_research_compare";

type ScenarioPrompt = {
  label: "clean" | "noisy";
  prompt: string;
};

type ScenarioFamily = {
  id: ScenarioFamilyId;
  expectedRoute: {
    primaryOutcome: string;
    interactionMode: string;
    selectedFamily: string;
    notes: string;
  };
  prompts: [ScenarioPrompt, ScenarioPrompt];
};

type ScenarioRecord = {
  family: ScenarioFamilyId;
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
  routeSignature: {
    primaryOutcome: string;
    interactionMode: string;
    selectedFamily: string | null;
    selectedProfile: string;
    selectedRecipe: string;
  };
};

type FamilySummary = {
  family: ScenarioFamilyId;
  expectedRoute: ScenarioFamily["expectedRoute"];
  sameRouteAcrossVariants: boolean;
  variants: Array<{
    variant: ScenarioPrompt["label"];
    selectedProfile: string;
    selectedRecipe: string;
    selectedFamily: string | null;
    primaryOutcome: string;
    interactionMode: string;
  }>;
};

const SCENARIOS: readonly ScenarioFamily[] = [
  {
    id: "document_authoring",
    expectedRoute: {
      primaryOutcome: "document_package",
      interactionMode: "artifact_iteration",
      selectedFamily: "document_render",
      notes: "Expected authored-document route, not extraction-first routing.",
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
    id: "workspace_change",
    expectedRoute: {
      primaryOutcome: "workspace_change",
      interactionMode: "tool_execution",
      selectedFamily: "code_build",
      notes: "Expected repo-mutation route with runtime execution, not observational/browser-only routing.",
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
    expectedRoute: {
      primaryOutcome: "comparison_report",
      interactionMode: "tool_execution",
      selectedFamily: "analysis_transform",
      notes: "Expected observational browser route, not workspace_change.",
    },
    prompts: [
      {
        label: "clean",
        prompt:
          "Open the live signup page in a browser, inspect the flow, and summarize the visible issues from the page, console, and network activity.",
      },
      {
        label: "noisy",
        prompt:
          "Зайди на живую страницу через браузер, покликай сценарий регистрации, посмотри что видно глазами плюс по консоли/сети, и верни краткий разбор без правок в репо.",
      },
    ],
  },
  {
    id: "public_research_compare",
    expectedRoute: {
      primaryOutcome: "comparison_report",
      interactionMode: "tool_execution",
      selectedFamily: "analysis_transform",
      notes: "Expected public-web research and comparison route.",
    },
    prompts: [
      {
        label: "clean",
        prompt:
          "Research the latest public cloud GPU pricing and compare the main options with a short recommendation.",
      },
      {
        label: "noisy",
        prompt:
          "Найди актуальные публичные цены на облачные GPU, сопоставь варианты между собой и коротко объясни, что сейчас выглядит разумнее.",
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

function toRouteSignature(record: ScenarioRecord["taskContract"], runtime: {
  selectedProfile: string;
  selectedRecipe: string;
  selectedFamily: string | null;
}) {
  return {
    primaryOutcome: record.primaryOutcome,
    interactionMode: record.interactionMode,
    selectedFamily: runtime.selectedFamily,
    selectedProfile: runtime.selectedProfile,
    selectedRecipe: runtime.selectedRecipe,
  };
}

function signatureKey(signature: ScenarioRecord["routeSignature"]): string {
  return JSON.stringify(signature);
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
        cfg,
        agentDir,
        onDebugEvent: (event) => {
          debugEvents.push(event);
        },
      });
      if (!args.allowFallback && classified.source !== "llm") {
        throw new Error(
          `Expected live llm classification for ${scenario.id}/${promptCase.label}, got ${classified.source}. Debug: ${JSON.stringify(debugEvents)}`,
        );
      }
      const runtime = resolvePlatformRuntimePlan(classified.plannerInput);
      const selectedFamily = classified.resolutionContract.selectedFamily ?? null;
      records.push({
        family: scenario.id,
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
        routeSignature: toRouteSignature(classified.taskContract, {
          selectedProfile: runtime.runtime.selectedProfileId,
          selectedRecipe: runtime.runtime.selectedRecipeId,
          selectedFamily,
        }),
      });
    }
  }

  const summaries: FamilySummary[] = scenarios.map((scenario) => {
    const variants = records.filter((record) => record.family === scenario.id);
    const sameRouteAcrossVariants =
      new Set(variants.map((variant) => signatureKey(variant.routeSignature))).size === 1;
    return {
      family: scenario.id,
      expectedRoute: scenario.expectedRoute,
      sameRouteAcrossVariants,
      variants: variants.map((variant) => ({
        variant: variant.variant,
        selectedProfile: variant.selectedProfile,
        selectedRecipe: variant.selectedRecipe,
        selectedFamily: variant.resolutionContract.selectedFamily ?? null,
        primaryOutcome: variant.taskContract.primaryOutcome,
        interactionMode: variant.taskContract.interactionMode,
      })),
    };
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    classifierConfig,
    agentDir,
    allowFallback: args.allowFallback,
    families: summaries,
    records,
  };

  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  await fs.writeFile(args.outputPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(JSON.stringify(payload, null, 2));
  console.error(`Wrote live classifier smoke report to ${args.outputPath}`);
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
