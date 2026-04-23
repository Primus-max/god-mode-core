#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  EvalSnapshotSchema,
  renderCompareReport,
} from "../src/platform/decision/eval/compare.js";

type CliArgs = {
  baseline: string;
  candidate: string;
};

function parseArgs(argv: readonly string[]): CliArgs {
  let baseline: string | null = null;
  let candidate: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--baseline":
        baseline = path.resolve(next());
        break;
      case "--candidate":
        candidate = path.resolve(next());
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!baseline || !candidate) {
    printHelp();
    throw new Error("both --baseline and --candidate are required");
  }
  return { baseline, candidate };
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: pnpm eval:classifier:compare --baseline <file> --candidate <file>",
      "",
      "Both files must be JSON snapshots produced by `pnpm eval:classifier`.",
    ].join("\n") + "\n",
  );
}

async function loadSnapshot(filePath: string): Promise<ReturnType<typeof EvalSnapshotSchema.parse>> {
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  return EvalSnapshotSchema.parse(parsed);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [baseline, candidate] = await Promise.all([
    loadSnapshot(args.baseline),
    loadSnapshot(args.candidate),
  ]);
  process.stdout.write(renderCompareReport(baseline, candidate));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `eval:classifier:compare failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
