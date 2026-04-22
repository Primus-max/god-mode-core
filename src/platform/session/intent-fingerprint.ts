import crypto from "node:crypto";
import type { DeliverableSpec } from "../produce/registry.js";

export const INTENT_IDEMPOTENCY_WINDOW_MS_DEFAULT = 60_000;
export const INTENT_IDEMPOTENCY_WINDOW_MS_ENV = "OPENCLAW_INTENT_IDEMPOTENCY_WINDOW_MS";

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizePathLike(value: string): string {
  return normalizeWhitespace(value).replace(/\\/g, "/");
}

function normalizeCapabilities(requiredCapabilities?: readonly string[]): string[] {
  return Array.from(
    new Set(
      (requiredCapabilities ?? [])
        .filter((value): value is string => typeof value === "string")
        .map((value) => normalizeWhitespace(value))
        .filter(Boolean),
    ),
  ).toSorted();
}

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
  normalizer: (value: string) => string,
): string | undefined {
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw !== "string") {
      continue;
    }
    const normalized = normalizer(raw);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableNormalize(entry));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, stableNormalize(entryValue)]);
    return Object.fromEntries(entries);
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isExecDeliverable(deliverable: DeliverableSpec): boolean {
  if (deliverable.kind !== "repo_operation") {
    return false;
  }
  const acceptedFormats = deliverable.acceptedFormats.map((value) => normalizeWhitespace(value));
  return acceptedFormats.some((value) => value === "exec" || value === "script" || value === "test-report");
}

function isApplyPatchDeliverable(deliverable: DeliverableSpec): boolean {
  if (deliverable.kind !== "code_change") {
    return false;
  }
  const acceptedFormats = deliverable.acceptedFormats.map((value) => normalizeWhitespace(value));
  return acceptedFormats.some((value) => value === "patch" || value === "edit");
}

function buildApplyPatchContentHash(constraints: Record<string, unknown>): string | undefined {
  const explicitHash = firstString(
    constraints,
    ["content_hash", "contentHash"],
    normalizeWhitespace,
  );
  if (explicitHash) {
    return explicitHash;
  }
  for (const key of ["content", "patch", "newContent", "replacement", "diff"]) {
    if (!(key in constraints)) {
      continue;
    }
    return sha256Hex(stableStringify(constraints[key]));
  }
  return undefined;
}

function fingerprintPayload(params: {
  deliverable: DeliverableSpec;
  requiredCapabilities?: readonly string[];
}): unknown {
  const { deliverable } = params;
  const constraints = deliverable.constraints ?? {};
  const capabilities = normalizeCapabilities(params.requiredCapabilities);

  if (isExecDeliverable(deliverable)) {
    const targetRepo = firstString(
      constraints,
      [
        "target_repo",
        "targetRepo",
        "repo_root",
        "repoRoot",
        "repo",
        "cwd",
        "working_directory",
        "workingDirectory",
      ],
      normalizePathLike,
    );
    const commandSignature = firstString(
      constraints,
      [
        "command_signature",
        "commandSignature",
        "command",
        "script",
        "test_command",
        "testCommand",
        "entry_command",
        "entryCommand",
        "package_script",
        "packageScript",
      ],
      normalizeWhitespace,
    );
    if (targetRepo || commandSignature) {
      return {
        algorithm: "exec",
        targetRepo: targetRepo ?? "",
        commandSignature: commandSignature ?? "",
        capabilities,
      };
    }
  }

  if (isApplyPatchDeliverable(deliverable)) {
    const targetPath = firstString(
      constraints,
      ["path", "filePath", "file", "targetPath"],
      normalizePathLike,
    );
    const contentHash = buildApplyPatchContentHash(constraints);
    if (targetPath || contentHash) {
      return {
        algorithm: "apply_patch",
        path: targetPath ?? "",
        contentHash: contentHash ?? "",
        capabilities,
      };
    }
  }

  if (deliverable.kind === "image") {
    const promptNormalized = firstString(
      constraints,
      ["prompt_normalized", "promptNormalized", "prompt", "description"],
      normalizeWhitespace,
    );
    const size = firstString(
      constraints,
      ["size", "dimensions", "aspectRatio"],
      normalizeWhitespace,
    );
    if (promptNormalized || size) {
      return {
        algorithm: "image_generate",
        promptNormalized: promptNormalized ?? "",
        size: size ?? "",
        capabilities,
      };
    }
  }

  return {
    algorithm: "fallback",
    kind: deliverable.kind,
    constraints: stableNormalize(constraints),
    capabilities,
  };
}

export function computeIntentFingerprint(
  deliverable?: DeliverableSpec,
  requiredCapabilities?: readonly string[],
): string | undefined {
  if (!deliverable) {
    return undefined;
  }
  return `intent:${sha256Hex(
    stableStringify(
      fingerprintPayload({
        deliverable,
        requiredCapabilities,
      }),
    ),
  )}`;
}

export function resolveIntentIdempotencyWindowMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[INTENT_IDEMPOTENCY_WINDOW_MS_ENV];
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return INTENT_IDEMPOTENCY_WINDOW_MS_DEFAULT;
}
