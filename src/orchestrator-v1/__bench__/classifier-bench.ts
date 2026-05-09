/**
 * Hour 0-1 — Classifier-model bench harness.
 *
 * Runs the 10 fixture prompts through N candidate cheap models via
 * pi-ai's `completeSimple`, scores intent + tool_names accuracy, and
 * prints a markdown table to stdout.
 *
 * Hard-stop checkpoint per V1-CONTRACT-ONLY plan §"Implementation order":
 * if NO model achieves ≥80% intent accuracy, scope down to a 3-tool MVP
 * (conversation + write + image_generate) and report that as the bench's
 * top-level recommendation.
 *
 * Run via:
 *   pnpm tsx src/orchestrator-v1/__bench__/classifier-bench.ts
 */

import { completeSimple, type Api, type Model, type TextContent } from "@mariozechner/pi-ai";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { resolveModelAsync } from "../../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../../agents/simple-completion-transport.js";
import { loadConfig } from "../../config/config.js";
import { CLASSIFIER_FIXTURES, type ClassifierFixture, type ExpectedTurnRouting } from "./classifier-bench-fixtures.js";
import { buildStageAPrompt, parseStageAResponse } from "./classifier-stage-a-prompt.js";

type CandidateModelRef = {
  /** Display name in report */
  label: string;
  /** Provider (hydra | openai | anthropic | google | xai) */
  provider: string;
  /** Model id matching pi-ai catalog */
  modelId: string;
};

const CANDIDATES: ReadonlyArray<CandidateModelRef> = [
  { label: "gpt-5-mini", provider: "hydra", modelId: "gpt-5-mini" },
  { label: "claude-haiku-4.5", provider: "hydra", modelId: "claude-haiku-4-5" },
  { label: "gemini-2.5-flash", provider: "hydra", modelId: "gemini-2.5-flash" },
  { label: "grok-3-mini", provider: "hydra", modelId: "grok-3-mini" },
];

const TIMEOUT_MS = 20_000;
const MAX_TOKENS = 200;

function isTextBlock(b: { type: string }): b is TextContent {
  return b.type === "text";
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

type FixtureResult = {
  fixtureId: string;
  intentMatch: boolean;
  toolsMatch: boolean;
  sequencingMatch: boolean;
  failureMode?: "non_json" | "wrong_shape" | "wrong_enum" | "exception" | "timeout";
  rawResponse?: string;
  latencyMs: number;
};

async function runFixtureOnModel(
  candidate: CandidateModelRef,
  resolvedModel: Model<Api>,
  apiKey: string,
  fixture: ClassifierFixture,
  systemPrompt: string,
): Promise<FixtureResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let raw = "";
  let failureMode: FixtureResult["failureMode"];
  try {
    const result = await completeSimple(
      resolvedModel,
      {
        messages: [
          {
            role: "user",
            content: `${systemPrompt}\n\n${fixture.prompt}`,
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
      intentMatch: false,
      toolsMatch: false,
      sequencingMatch: false,
      failureMode,
      rawResponse: raw,
      latencyMs,
    };
  }
  const { parsed, failureMode: parseFailure } = parseStageAResponse(raw);
  if (!parsed) {
    return {
      fixtureId: fixture.id,
      intentMatch: false,
      toolsMatch: false,
      sequencingMatch: false,
      failureMode: parseFailure,
      rawResponse: raw,
      latencyMs,
    };
  }
  const expected = fixture.expected;
  const intentMatch = parsed.intent === expected.intent;
  // For sequencing="sequential" we require order match; "parallel" only set match.
  const toolsMatch =
    expected.sequencing === "parallel"
      ? arraysEqualAsSet(parsed.tool_names, expected.tool_names)
      : arraysEqualAsSequence(parsed.tool_names, expected.tool_names);
  const sequencingMatch =
    expected.sequencing === undefined ? true : (parsed.sequencing ?? "sequential") === expected.sequencing;
  return {
    fixtureId: fixture.id,
    intentMatch,
    toolsMatch,
    sequencingMatch,
    rawResponse: raw,
    latencyMs,
  };
}

type ModelScore = {
  candidate: CandidateModelRef;
  fixtureResults: FixtureResult[];
  intentAccuracy: number;
  bothAccuracy: number; // intent AND tools both match
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

async function scoreCandidate(candidate: CandidateModelRef, systemPrompt: string): Promise<ModelScore> {
  const cfg = loadConfig();
  const resolved = await resolveModelAsync(candidate.provider, candidate.modelId, undefined, cfg);
  if (!resolved.model) {
    return {
      candidate,
      fixtureResults: [],
      intentAccuracy: 0,
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
  for (const fixture of CLASSIFIER_FIXTURES) {
    const r = await runFixtureOnModel(candidate, completionModel, apiKey, fixture, systemPrompt);
    fixtureResults.push(r);
  }
  const intentMatches = fixtureResults.filter((r) => r.intentMatch).length;
  const bothMatches = fixtureResults.filter((r) => r.intentMatch && r.toolsMatch).length;
  const latencies = fixtureResults.map((r) => r.latencyMs);
  const parseFailureCount = fixtureResults.filter((r) => r.failureMode !== undefined).length;
  return {
    candidate,
    fixtureResults,
    intentAccuracy: intentMatches / CLASSIFIER_FIXTURES.length,
    bothAccuracy: bothMatches / CLASSIFIER_FIXTURES.length,
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
  lines.push("# Classifier-Model Bench — V1-CONTRACT-ONLY Hour 0-1");
  lines.push("");
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Fixtures: ${CLASSIFIER_FIXTURES.length}`);
  lines.push("");
  lines.push("## Summary table");
  lines.push("");
  lines.push("| Model | Intent acc | Intent+Tools acc | p50 ms | p95 ms | Parse fails | Notes |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of scores) {
    const note = s.resolutionError ? `❌ ${s.resolutionError}` : "";
    lines.push(
      `| ${s.candidate.label} | ${pct(s.intentAccuracy)} | ${pct(s.bothAccuracy)} | ${s.p50LatencyMs} | ${s.p95LatencyMs} | ${s.parseFailureCount} | ${note} |`,
    );
  }
  lines.push("");
  // Pick winner
  const ranked = [...scores]
    .filter((s) => !s.resolutionError)
    .sort((a, b) => {
      if (b.bothAccuracy !== a.bothAccuracy) return b.bothAccuracy - a.bothAccuracy;
      if (b.intentAccuracy !== a.intentAccuracy) return b.intentAccuracy - a.intentAccuracy;
      return a.p95LatencyMs - b.p95LatencyMs;
    });
  const winner = ranked[0];
  lines.push("## Verdict");
  lines.push("");
  if (!winner) {
    lines.push("❌ No candidate resolved successfully. Check provider auth / pi-ai catalog availability.");
  } else if (winner.intentAccuracy < 0.8) {
    lines.push(`⚠️ Hard-stop: top model **${winner.candidate.label}** scored ${pct(winner.intentAccuracy)} on intent (< 80% threshold).`);
    lines.push("");
    lines.push("**Recommendation:** scope down to 3-tool MVP (conversation + write + image_generate). Re-run bench with reduced fixture set.");
  } else {
    lines.push(`✅ Winner: **${winner.candidate.label}** — intent ${pct(winner.intentAccuracy)}, intent+tools ${pct(winner.bothAccuracy)}, p95 ${winner.p95LatencyMs}ms.`);
  }
  lines.push("");
  lines.push("## Per-fixture breakdown");
  lines.push("");
  for (const s of scores) {
    if (s.resolutionError) continue;
    lines.push(`### ${s.candidate.label}`);
    lines.push("");
    lines.push("| Fixture | Intent | Tools | Seq | Latency | Failure | Raw (first 80c) |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const r of s.fixtureResults) {
      const rawSnippet = (r.rawResponse ?? "").replace(/\s+/g, " ").slice(0, 80);
      lines.push(
        `| ${r.fixtureId} | ${r.intentMatch ? "✓" : "✗"} | ${r.toolsMatch ? "✓" : "✗"} | ${r.sequencingMatch ? "✓" : "✗"} | ${r.latencyMs}ms | ${r.failureMode ?? "-"} | \`${rawSnippet}\` |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const systemPrompt = buildStageAPrompt();
  const scores: ModelScore[] = [];
  for (const candidate of CANDIDATES) {
    process.stdout.write(`Scoring ${candidate.label}...\n`);
    try {
      const score = await scoreCandidate(candidate, systemPrompt);
      scores.push(score);
      process.stdout.write(
        `  intent ${pct(score.intentAccuracy)} | both ${pct(score.bothAccuracy)} | p95 ${score.p95LatencyMs}ms${score.resolutionError ? ` | ❌ ${score.resolutionError}` : ""}\n`,
      );
    } catch (err) {
      process.stdout.write(`  ❌ exception: ${(err as Error).message}\n`);
      scores.push({
        candidate,
        fixtureResults: [],
        intentAccuracy: 0,
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
  process.stderr.write(`bench failed: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
