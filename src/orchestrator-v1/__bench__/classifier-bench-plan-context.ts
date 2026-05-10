/**
 * Plan-context classifier bench harness.
 *
 * Runs the plan-context fixtures through one or more candidate cheap
 * models, scores `kind` accuracy + (where applicable) tool_names
 * accuracy, and prints a markdown table.
 *
 * Unlike the single-turn classifier bench (which enforces 100% on the
 * winner), this bench is informational: plan-context classification is
 * harder and the system is designed to fail closed (any mis-routing
 * still ends in a refuse the user can correct).
 *
 * Run via:
 *   pnpm tsx src/orchestrator-v1/__bench__/classifier-bench-plan-context.ts
 */

import { completeSimple, type Api, type Model, type TextContent } from "@mariozechner/pi-ai";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { resolveModelAsync } from "../../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../../agents/simple-completion-transport.js";
import { loadConfig } from "../../config/config.js";
import { buildStageAPlanContextPrompt } from "../classifier-stage-a-plan-context.js";
import {
  PLAN_CONTEXT_FIXTURES,
  type PlanContextFixture,
  type ExpectedPlanContextRouting,
} from "./classifier-bench-plan-context-fixtures.js";

type ParsedRouting = {
  kind?: string;
  tool_names?: string[];
  sequencing?: string;
  intent?: string;
  refusal_reason?: string;
};

function parseResponse(raw: string): {
  parsed?: ParsedRouting;
  failureMode?: "non_json" | "wrong_shape" | "wrong_enum";
} {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  }
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return { failureMode: "non_json" };
  }
  if (typeof obj !== "object" || obj === null) return { failureMode: "wrong_shape" };
  const o = obj as Record<string, unknown>;
  if (typeof o.kind !== "string") return { failureMode: "wrong_shape" };
  const allowed = ["add_args", "edit_plan", "replace_plan", "abandon"];
  if (!allowed.includes(o.kind)) return { failureMode: "wrong_enum" };
  const tool_names = Array.isArray(o.tool_names)
    ? (o.tool_names.filter((s) => typeof s === "string") as string[])
    : undefined;
  const sequencing = typeof o.sequencing === "string" ? o.sequencing : undefined;
  const intent = typeof o.intent === "string" ? o.intent : undefined;
  const refusal_reason = typeof o.refusal_reason === "string" ? o.refusal_reason : undefined;
  return { parsed: { kind: o.kind, tool_names, sequencing, intent, refusal_reason } };
}

function arraysEqualAsSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

function arraysEqualAsSequence(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toolNamesMatchExpected(
  actual: string[] | undefined,
  expected: ExpectedPlanContextRouting,
): boolean {
  if (expected.kind !== "edit_plan" && expected.kind !== "replace_plan") return true;
  if (!actual) return false;
  const seq = expected.sequencing ?? "sequential";
  const matchOne = (cand: string[]): boolean =>
    seq === "parallel" ? arraysEqualAsSet(actual, cand) : arraysEqualAsSequence(actual, cand);
  if (matchOne(expected.tool_names)) return true;
  for (const alt of expected.tool_names_alts ?? []) if (matchOne(alt)) return true;
  return false;
}

type CandidateModelRef = {
  label: string;
  provider: string;
  modelId: string;
};

const CANDIDATES: ReadonlyArray<CandidateModelRef> = [
  { label: "gpt-5-mini", provider: "hydra", modelId: "gpt-5-mini" },
  { label: "claude-haiku-4.5", provider: "hydra", modelId: "claude-haiku-4-5" },
  { label: "gemini-2.5-flash", provider: "hydra", modelId: "gemini-2.5-flash" },
  { label: "grok-3-mini", provider: "hydra", modelId: "grok-3-mini" },
];

const TIMEOUT_MS = 20_000;
const MAX_TOKENS = 250;

function isTextBlock(b: { type: string }): b is TextContent {
  return b.type === "text";
}

type FixtureResult = {
  fixtureId: string;
  kindMatch: boolean;
  toolsMatch: boolean;
  failureMode?: "non_json" | "wrong_shape" | "wrong_enum" | "exception" | "timeout";
  rawResponse?: string;
  latencyMs: number;
};

async function runFixtureOnModel(
  resolvedModel: Model<Api>,
  apiKey: string,
  fixture: PlanContextFixture,
): Promise<FixtureResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let raw = "";
  let failureMode: FixtureResult["failureMode"];
  try {
    const systemPrompt = buildStageAPlanContextPrompt(fixture.pendingPlan);
    const result = await completeSimple(
      resolvedModel,
      {
        messages: [
          {
            role: "user",
            content: `${systemPrompt}\n\n${fixture.userMessage}`,
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey, maxTokens: MAX_TOKENS, temperature: 0.1, signal: controller.signal },
    );
    raw = result.content.filter(isTextBlock).map((b) => b.text).join("").trim();
  } catch (err) {
    failureMode = (err as Error).name === "AbortError" ? "timeout" : "exception";
  } finally {
    clearTimeout(timeout);
  }
  const latencyMs = Date.now() - startedAt;
  if (failureMode) {
    return {
      fixtureId: fixture.id,
      kindMatch: false,
      toolsMatch: false,
      failureMode,
      rawResponse: raw,
      latencyMs,
    };
  }
  const { parsed, failureMode: parseFailure } = parseResponse(raw);
  if (!parsed) {
    return {
      fixtureId: fixture.id,
      kindMatch: false,
      toolsMatch: false,
      failureMode: parseFailure,
      rawResponse: raw,
      latencyMs,
    };
  }
  const expected = fixture.expected;
  const kindMatch = parsed.kind === expected.kind;
  // For abandon, additionally require intent match.
  const intentOk =
    expected.kind === "abandon" ? parsed.intent === expected.intent : true;
  const toolsMatch = toolNamesMatchExpected(parsed.tool_names, expected);
  return {
    fixtureId: fixture.id,
    kindMatch: kindMatch && intentOk,
    toolsMatch,
    rawResponse: raw,
    latencyMs,
  };
}

type ModelScore = {
  candidate: CandidateModelRef;
  fixtureResults: FixtureResult[];
  kindAccuracy: number;
  bothAccuracy: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  parseFailureCount: number;
  resolutionError?: string;
};

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx] ?? 0;
}

async function scoreCandidate(candidate: CandidateModelRef): Promise<ModelScore> {
  const cfg = loadConfig();
  const resolved = await resolveModelAsync(candidate.provider, candidate.modelId, undefined, cfg);
  if (!resolved.model) {
    return {
      candidate,
      fixtureResults: [],
      kindAccuracy: 0,
      bothAccuracy: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      parseFailureCount: 0,
      resolutionError: resolved.error ?? "model resolution returned undefined",
    };
  }
  const completionModel = prepareModelForSimpleCompletion({ model: resolved.model, cfg });
  const apiKey = requireApiKey(
    await getApiKeyForModel({ model: completionModel, cfg }),
    candidate.provider,
  );
  const fixtureResults: FixtureResult[] = [];
  for (const fixture of PLAN_CONTEXT_FIXTURES) {
    const r = await runFixtureOnModel(completionModel, apiKey, fixture);
    fixtureResults.push(r);
  }
  const kindMatches = fixtureResults.filter((r) => r.kindMatch).length;
  const bothMatches = fixtureResults.filter((r) => r.kindMatch && r.toolsMatch).length;
  const latencies = fixtureResults.map((r) => r.latencyMs);
  const parseFailureCount = fixtureResults.filter((r) => r.failureMode !== undefined).length;
  return {
    candidate,
    fixtureResults,
    kindAccuracy: kindMatches / PLAN_CONTEXT_FIXTURES.length,
    bothAccuracy: bothMatches / PLAN_CONTEXT_FIXTURES.length,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    parseFailureCount,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function renderReport(scores: ModelScore[]): string {
  const lines: string[] = [];
  lines.push("# Plan-context Classifier Bench");
  lines.push("");
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Fixtures: ${PLAN_CONTEXT_FIXTURES.length}`);
  lines.push("");
  lines.push("## Summary table");
  lines.push("");
  lines.push("| Model | Kind acc | Kind+Tools acc | p50 ms | p95 ms | Parse fails | Notes |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of scores) {
    const note = s.resolutionError ? `❌ ${s.resolutionError}` : "";
    lines.push(
      `| ${s.candidate.label} | ${pct(s.kindAccuracy)} | ${pct(s.bothAccuracy)} | ${s.p50LatencyMs} | ${s.p95LatencyMs} | ${s.parseFailureCount} | ${note} |`,
    );
  }
  lines.push("");
  lines.push("## Per-fixture breakdown");
  lines.push("");
  for (const s of scores) {
    if (s.resolutionError) continue;
    lines.push(`### ${s.candidate.label}`);
    lines.push("");
    lines.push("| Fixture | Kind | Tools | Latency | Failure | Raw (first 80c) |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of s.fixtureResults) {
      const rawSnippet = (r.rawResponse ?? "").replace(/\s+/g, " ").slice(0, 80);
      lines.push(
        `| ${r.fixtureId} | ${r.kindMatch ? "✓" : "✗"} | ${r.toolsMatch ? "✓" : "✗"} | ${r.latencyMs}ms | ${r.failureMode ?? "-"} | \`${rawSnippet}\` |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const scores: ModelScore[] = [];
  for (const candidate of CANDIDATES) {
    process.stdout.write(`Scoring ${candidate.label}...\n`);
    try {
      const score = await scoreCandidate(candidate);
      scores.push(score);
      process.stdout.write(
        `  kind ${pct(score.kindAccuracy)} | both ${pct(score.bothAccuracy)} | p95 ${score.p95LatencyMs}ms${score.resolutionError ? ` | ❌ ${score.resolutionError}` : ""}\n`,
      );
    } catch (err) {
      process.stdout.write(`  ❌ exception: ${(err as Error).message}\n`);
      scores.push({
        candidate,
        fixtureResults: [],
        kindAccuracy: 0,
        bothAccuracy: 0,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        parseFailureCount: 0,
        resolutionError: (err as Error).message,
      });
    }
  }
  const report = renderReport(scores);
  process.stdout.write("\n" + report + "\n");
}

main().catch((err) => {
  process.stderr.write(`Bench harness crashed: ${(err as Error).stack ?? (err as Error).message}\n`);
  process.exit(1);
});
