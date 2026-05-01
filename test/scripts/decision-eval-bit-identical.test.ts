import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const baselinePath = path.join(
  repoRoot,
  "scripts",
  "dev",
  "decision-eval-baseline",
  "baseline.json",
);
const evalScript = path.join(repoRoot, "scripts", "dev", "decision-eval.ts");

type DecisionEvalSummary = {
  total: number;
  passed: number;
  failed: number;
  errorTagCounts: Record<string, number>;
};

type DecisionEvalSlice = {
  summary: DecisionEvalSummary;
  results: unknown[];
};

type DecisionEvalRawPayload = DecisionEvalSlice & {
  generatedAt: string;
  casesPath: string;
  shadowMetrics?: unknown;
};

async function runEval(): Promise<DecisionEvalRawPayload> {
  const workDir = await mkdtemp(path.join(tmpdir(), "decision-eval-"));
  const outputPath = path.join(workDir, "out.json");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", evalScript, "--output", outputPath, "--json"],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stdout?.on("data", () => {});
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `decision-eval exited with code ${String(code)}. stderr: ${stderr}`,
          ),
        );
      });
    });
    const raw = await fs.readFile(outputPath, "utf8");
    return JSON.parse(raw) as DecisionEvalRawPayload;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function sliceDeterministic(payload: DecisionEvalRawPayload): DecisionEvalSlice {
  return {
    summary: payload.summary,
    results: payload.results.map((result) => {
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        return result;
      }
      const { shadow: _shadow, expectedShadowEffect: _expectedShadowEffect, ...legacy } =
        result as Record<string, unknown>;
      return stripShadowCommitment(legacy);
    }),
  };
}

function stripShadowCommitment(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripShadowCommitment);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "shadowCommitment" || key === "cutoverGate") {
      continue;
    }
    out[key] = stripShadowCommitment(entry);
  }
  return out;
}

describe("PR-1 bit-identical decision-eval snapshot", () => {
  it(
    "produces results identical to baseline.json (excluding generatedAt, casesPath)",
    { timeout: 120_000 },
    async () => {
      const baselineRaw = await fs.readFile(baselinePath, "utf8");
      const baseline = JSON.parse(baselineRaw) as DecisionEvalSlice;
      const live = await runEval();
      const sliced = sliceDeterministic(live);
      expect(sliced).toEqual(baseline);
    },
  );
});
