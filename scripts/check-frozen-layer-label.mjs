#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const FROZEN_LAYER_PATTERNS = [
  "src/platform/decision/task-classifier.ts",
  "src/platform/decision/input.ts",
  "src/platform/decision/trace.ts",
  "src/platform/recipe/",
  "src/platform/plugin.ts",
];

export const FROZEN_LAYER_LABELS = [
  "telemetry-only",
  "bug-fix",
  "compatibility",
  "emergency-rollback",
  "none of the above",
];

function toPosix(value) {
  return value.replaceAll("\\", "/");
}

/**
 * Filters changed paths down to the PR-2 frozen legacy layers.
 *
 * @param {readonly string[]} paths - Changed repo-relative paths.
 * @returns {string[]} Frozen-layer paths touched by the change.
 */
export function findFrozenLayerTouches(paths) {
  return paths.map(toPosix).filter((filePath) =>
    FROZEN_LAYER_PATTERNS.some((pattern) =>
      pattern.endsWith("/") ? filePath.startsWith(pattern) : filePath === pattern,
    ),
  );
}

/**
 * Extracts checked frozen-layer labels from a PR body.
 *
 * @param {string} body - Pull request body text.
 * @returns {string[]} Checked label ids.
 */
export function parseFrozenLayerLabels(body) {
  const checked = [];
  const lines = body.split(/\r?\n/u);
  for (const line of lines) {
    const normalized = line.trim().toLowerCase();
    for (const label of FROZEN_LAYER_LABELS) {
      if (
        (normalized.startsWith(`- [x] ${label}`) ||
          normalized.startsWith(`- [X] ${label}`.toLowerCase())) &&
        !checked.includes(label)
      ) {
        checked.push(label);
      }
    }
  }
  return checked;
}

/**
 * Validates emergency rollback metadata required by hard invariant #12.
 *
 * @param {string} body - Pull request body text.
 * @returns {boolean} True when tracking URL and retire deadline are present.
 */
export function hasValidEmergencyRollbackMetadata(body) {
  return /https?:\/\/\S+/u.test(body) && /\bRetire-By:\s*\d{4}-\d{2}-\d{2}\b/u.test(body);
}

/**
 * Evaluates whether a PR body satisfies frozen-layer labeling.
 *
 * @param {object} params - Validation input.
 * @param {readonly string[]} params.changedPaths - Changed paths.
 * @param {string} params.prBody - Pull request body text.
 * @returns {{ ok: true } | { ok: false; message: string }}
 */
export function validateFrozenLayerLabel({ changedPaths, prBody }) {
  const touched = findFrozenLayerTouches(changedPaths);
  if (touched.length === 0) {
    return { ok: true };
  }
  const labels = parseFrozenLayerLabels(prBody);
  if (labels.length === 0) {
    return {
      ok: false,
      message: `Frozen legacy layer touched (${touched.join(", ")}); check one frozen-layer label in the PR body.`,
    };
  }
  if (
    labels.includes("emergency-rollback") &&
    !hasValidEmergencyRollbackMetadata(prBody)
  ) {
    return {
      ok: false,
      message:
        "emergency-rollback requires a tracking URL and Retire-By: YYYY-MM-DD in the PR body.",
    };
  }
  return { ok: true };
}

async function readChangedPaths() {
  const baseRef = process.env.BASE_REF?.trim() || "origin/main";
  const { stdout } = await execFileAsync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
    maxBuffer: 1024 * 1024,
  });
  return stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

async function main() {
  const changedPaths = await readChangedPaths();
  const result = validateFrozenLayerLabel({
    changedPaths,
    prBody: process.env.PR_BODY ?? "",
  });
  if (result.ok) {
    return;
  }
  console.error(result.message);
  process.exit(1);
}

if (process.argv[1]?.endsWith("check-frozen-layer-label.mjs")) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
