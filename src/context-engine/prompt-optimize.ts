import type { PromptOptimizationReport, PromptOptimizeForTurnResult } from "./types.js";

const DETERMINISTIC_STRATEGY_ID = "deterministic-v2";

function collapseInlineSpacingOutsideCode(line: string): string {
  if (!line || !/[ \t]{2,}/u.test(line)) {
    return line;
  }
  const segments = line.split(/(`[^`]*`)/gu);
  return segments
    .map((segment, index) =>
      index % 2 === 1 ? segment : segment.replace(/(?<=\S)[ \t]{2,}(?=\S)/gu, " "),
    )
    .join("");
}

/**
 * Merge optimization reports from hooks and runtime passes (ordered reasoning).
 */
export function mergePromptOptimizationReports(
  ...parts: Array<PromptOptimizationReport | undefined>
): PromptOptimizationReport | undefined {
  const reasoning: string[] = [];
  let charsRemoved = 0;
  let applied = false;
  let strategyId: string | undefined;
  let charsIn: number | undefined;
  let charsOut: number | undefined;
  let normalized = false;
  let trimmedWhitespace = 0;
  let collapsedLines = 0;

  for (const p of parts) {
    if (!p) {
      continue;
    }
    if (p.reasoning?.length) {
      reasoning.push(...p.reasoning);
    }
    if (typeof p.charsRemoved === "number") {
      charsRemoved += p.charsRemoved;
    }
    if (p.applied) {
      applied = true;
    }
    if (p.strategyId) {
      strategyId = p.strategyId;
    }
    if (typeof p.charsIn === "number") {
      charsIn = p.charsIn;
    }
    if (typeof p.charsOut === "number") {
      charsOut = p.charsOut;
    }
    if (p.normalized) {
      normalized = true;
    }
    if (typeof p.trimmedWhitespace === "number") {
      trimmedWhitespace += p.trimmedWhitespace;
    }
    if (typeof p.collapsedLines === "number") {
      collapsedLines += p.collapsedLines;
    }
  }

  if (
    reasoning.length === 0 &&
    !applied &&
    charsRemoved === 0 &&
    !strategyId &&
    charsIn === undefined &&
    charsOut === undefined &&
    !normalized &&
    trimmedWhitespace === 0 &&
    collapsedLines === 0
  ) {
    return undefined;
  }

  const out: PromptOptimizationReport = {};
  if (reasoning.length > 0) {
    out.reasoning = reasoning;
  }
  if (applied) {
    out.applied = true;
  }
  if (charsRemoved > 0) {
    out.charsRemoved = charsRemoved;
  }
  if (strategyId) {
    out.strategyId = strategyId;
  }
  if (charsIn !== undefined) {
    out.charsIn = charsIn;
  }
  if (charsOut !== undefined) {
    out.charsOut = charsOut;
  }
  if (normalized) {
    out.normalized = true;
  }
  if (trimmedWhitespace > 0) {
    out.trimmedWhitespace = trimmedWhitespace;
  }
  if (collapsedLines > 0) {
    out.collapsedLines = collapsedLines;
  }
  return out;
}

/**
 * Deterministic prompt cleanup: trims line noise and excessive blank lines
 * without removing non-empty lines (preserves paths, tasks, and constraints).
 */
export function deterministicPromptOptimize(prompt: string): PromptOptimizeForTurnResult {
  const charsIn = prompt.length;
  const reasoning: string[] = [];
  let text = prompt;
  let normalized = false;
  let trimmedWhitespace = 0;
  let collapsedLines = 0;

  if (text.includes("\r\n")) {
    text = text.replaceAll("\r\n", "\n");
    normalized = true;
    reasoning.push("normalized CRLF line endings to LF");
  }
  if (text.includes("\r")) {
    text = text.replaceAll("\r", "\n");
    normalized = true;
    reasoning.push("normalized lone CR characters to LF");
  }

  const lines = text.split("\n");
  for (const line of lines) {
    trimmedWhitespace += line.length - line.replace(/[ \t]+$/u, "").length;
  }
  const trimmedLines = lines.map((line) => line.replace(/[ \t]+$/u, ""));
  if (trimmedLines.join("\n") !== lines.join("\n")) {
    reasoning.push("stripped trailing spaces and tabs on lines");
    text = trimmedLines.join("\n");
  }

  const spacingLines = text.split("\n");
  let insideFence = false;
  const normalizedSpacingLines = spacingLines.map((line) => {
    const trimmedLine = line.trimStart();
    if (trimmedLine.startsWith("```")) {
      insideFence = !insideFence;
      return line;
    }
    if (insideFence) {
      return line;
    }
    return collapseInlineSpacingOutsideCode(line);
  });
  if (normalizedSpacingLines.join("\n") !== spacingLines.join("\n")) {
    reasoning.push("collapsed repeated inline spacing in plain-text lines");
    text = normalizedSpacingLines.join("\n");
  }

  const collapsed = text.replace(/\n{3,}/gu, (run) => {
    collapsedLines += run.length - 2;
    return "\n\n";
  });
  if (collapsed !== text) {
    reasoning.push("collapsed runs of 3+ blank lines to a single paragraph break");
    text = collapsed;
  }

  const beforeOuterTrim = text;
  const trimmed = text.trim();
  trimmedWhitespace += beforeOuterTrim.length - trimmed.length;
  if (trimmed !== text) {
    reasoning.push("trimmed leading/trailing blank lines");
    text = trimmed;
  }

  const charsOut = text.length;
  const applied = text !== prompt;
  return {
    prompt: text,
    meta: {
      applied,
      reasoning: reasoning.length > 0 ? reasoning : undefined,
      strategyId: DETERMINISTIC_STRATEGY_ID,
      charsIn,
      charsOut,
      charsRemoved: Math.max(0, charsIn - charsOut),
      normalized,
      trimmedWhitespace,
      collapsedLines,
    },
  };
}
