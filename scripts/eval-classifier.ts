#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config/io.js";
import {
  assertUniqueIds,
  loadGoldenSet,
  DEFAULT_GOLDEN_SET_PATH,
} from "../src/platform/decision/eval/golden-set.js";
import { renderMarkdownReport } from "../src/platform/decision/eval/render.js";
import { runEvaluation } from "../src/platform/decision/eval/runner.js";
import {
  DEFAULT_TASK_CLASSIFIER_BACKEND,
  DEFAULT_TASK_CLASSIFIER_MAX_TOKENS,
  DEFAULT_TASK_CLASSIFIER_MODEL,
  DEFAULT_TASK_CLASSIFIER_TIMEOUT_MS,
  resolveTaskClassifierAdapter,
  type ResolvedTaskClassifierConfig,
  type TaskClassifierAdapter,
} from "../src/platform/decision/task-classifier.js";

type CliArgs = {
  backend: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  outputDir: string;
  goldenSetPath: string;
  limit: number | null;
  dryRun: boolean;
  filterTag: string | null;
  label: string | null;
};

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    backend: DEFAULT_TASK_CLASSIFIER_BACKEND,
    model: DEFAULT_TASK_CLASSIFIER_MODEL,
    timeoutMs: DEFAULT_TASK_CLASSIFIER_TIMEOUT_MS,
    maxTokens: DEFAULT_TASK_CLASSIFIER_MAX_TOKENS,
    outputDir: path.resolve("eval-results"),
    goldenSetPath: DEFAULT_GOLDEN_SET_PATH,
    limit: null,
    dryRun: false,
    filterTag: null,
    label: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`missing value for ${arg}`);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case "--backend":
        args.backend = next();
        break;
      case "--model":
        args.model = next();
        break;
      case "--timeout-ms":
        args.timeoutMs = Number.parseInt(next(), 10);
        break;
      case "--max-tokens":
        args.maxTokens = Number.parseInt(next(), 10);
        break;
      case "--output-dir":
        args.outputDir = path.resolve(next());
        break;
      case "--golden-set":
        args.goldenSetPath = path.resolve(next());
        break;
      case "--limit":
        args.limit = Number.parseInt(next(), 10);
        break;
      case "--filter-tag":
        args.filterTag = next();
        break;
      case "--label":
        args.label = next();
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: pnpm eval:classifier [options]",
      "",
      "Options:",
      `  --backend <id>          Classifier backend (default: ${DEFAULT_TASK_CLASSIFIER_BACKEND})`,
      `  --model <ref>           Model ref e.g. hydra/gpt-5-mini (default: ${DEFAULT_TASK_CLASSIFIER_MODEL})`,
      `  --timeout-ms <n>        Per-call timeout (default: ${DEFAULT_TASK_CLASSIFIER_TIMEOUT_MS})`,
      `  --max-tokens <n>        Max output tokens (default: ${DEFAULT_TASK_CLASSIFIER_MAX_TOKENS})`,
      "  --golden-set <path>     Override golden-set.json path",
      "  --output-dir <dir>      Where to write the JSON snapshot (default: eval-results/)",
      "  --limit <n>             Run only first N cases (smoke run)",
      "  --filter-tag <tag>      Run only cases that include this tag",
      "  --label <name>          Custom run label appended to snapshot filename",
      "  --dry-run               Validate golden set + adapter resolution; do not call the model",
      "  -h, --help              Show this help",
    ].join("\n") + "\n",
  );
}

function snapshotFileName(args: CliArgs, timestamp: string): string {
  const safeBackend = args.backend.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeModel = args.model.replace(/[^a-zA-Z0-9_-]/g, "_");
  const labelSuffix = args.label ? `__${args.label.replace(/[^a-zA-Z0-9_-]/g, "_")}` : "";
  return `${timestamp}__${safeBackend}__${safeModel}${labelSuffix}.json`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const goldenSet = await loadGoldenSet(args.goldenSetPath);
  assertUniqueIds(goldenSet);
  let cases = goldenSet;
  if (args.filterTag) {
    cases = cases.filter((c) => c.tags.includes(args.filterTag as string));
    if (cases.length === 0) {
      throw new Error(`no cases match --filter-tag ${args.filterTag}`);
    }
  }
  if (args.limit !== null) {
    cases = cases.slice(0, args.limit);
  }

  const config: ResolvedTaskClassifierConfig = {
    enabled: true,
    backend: args.backend,
    model: args.model,
    timeoutMs: args.timeoutMs,
    maxTokens: args.maxTokens,
  };
  const adapter: TaskClassifierAdapter | undefined = resolveTaskClassifierAdapter(args.backend);
  if (!adapter) {
    throw new Error(
      `unknown backend "${args.backend}". Built-in backends: ${DEFAULT_TASK_CLASSIFIER_BACKEND}`,
    );
  }

  if (args.dryRun) {
    process.stdout.write(
      `# Dry run: ${cases.length} cases, backend=${args.backend}, model=${args.model}\n`,
    );
    process.stdout.write(`# Golden set: ${args.goldenSetPath}\n`);
    process.stdout.write(`# Output dir: ${args.outputDir}\n`);
    return;
  }

  const cfg = loadConfig();
  process.stderr.write(
    `[eval:classifier] running ${cases.length} cases against ${args.backend}/${args.model}\n`,
  );
  const snapshot = await runEvaluation({
    adapter,
    cases,
    config,
    cfg,
    onCaseResult: (result, index, total) => {
      const status = result.error
        ? `ERR(${result.error.message.slice(0, 40)})`
        : `${result.actualTaskContract?.primaryOutcome ?? "?"}/${result.actualTaskContract?.interactionMode ?? "?"}`;
      process.stderr.write(
        `[eval:classifier] ${index + 1}/${total} ${result.id} -> ${status} (${result.latencyMs}ms)\n`,
      );
    },
  });

  await mkdir(args.outputDir, { recursive: true });
  const filename = snapshotFileName(
    args,
    snapshot.meta.timestamp.replace(/[:.]/g, "-"),
  );
  const filePath = path.join(args.outputDir, filename);
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  process.stderr.write(`[eval:classifier] snapshot saved: ${filePath}\n`);

  process.stdout.write(renderMarkdownReport(snapshot));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `eval:classifier failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
