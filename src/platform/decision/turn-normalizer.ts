import { stripInboundMetadata } from "../../auto-reply/reply/strip-inbound-meta.js";

const ROUTING_CONTEXT_PREFIXES = [
  "Profile:",
  "Language continuity:",
  "Task overlay:",
  "Planner reasoning:",
  "Bootstrap required:",
  "Active specialist profile:",
  "Planned tools:",
] as const;

export type NormalizedExecutionTurn = {
  prompt: string;
  fileNames: string[];
  inferencePrompt: string;
};

export function collectPromptHints(prompt: string, candidates: readonly string[]): string[] {
  const normalized = prompt.toLowerCase();
  return candidates.filter((candidate) =>
    new RegExp(
      `(^|[^\\p{L}\\p{N}_])${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[^\\p{L}\\p{N}_]|$)`,
      "iu",
    ).test(normalized),
  );
}

export function toUniqueLowercase(values: Array<string | undefined> | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim().toLowerCase()),
    ),
  );
}

export function promptIncludesAny(prompt: string, hints: readonly string[]): boolean {
  const normalized = prompt.toLowerCase();
  return hints.some((hint) => normalized.includes(hint));
}

export function resolveKeywordInferencePrompt(prompt: string): string {
  const withoutInboundMetadata = stripInboundMetadata(prompt);
  const lines = withoutInboundMetadata.split("\n");
  let index = 0;
  let strippedContextPrefix = false;
  while (index < lines.length) {
    const trimmed = lines[index]?.trim() ?? "";
    if (!trimmed) {
      if (strippedContextPrefix) {
        index += 1;
        continue;
      }
      break;
    }
    if (ROUTING_CONTEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
      strippedContextPrefix = true;
      index += 1;
      continue;
    }
    break;
  }
  const normalizedPrompt = lines.slice(index).join("\n").trim();
  const segments = normalizedPrompt
    .split(/\n\s*\n/iu)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return (segments.at(-1) ?? normalizedPrompt) || prompt;
}

export function normalizeExecutionTurn(params: {
  prompt: string;
  inferencePrompt?: string;
  fileNames?: string[];
}): NormalizedExecutionTurn {
  const fileNames = Array.from(
    new Set(
      (params.fileNames ?? [])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim()),
    ),
  );
  const explicitInferencePrompt =
    typeof params.inferencePrompt === "string" && params.inferencePrompt.trim().length > 0
      ? params.inferencePrompt.trim()
      : undefined;
  return {
    prompt: params.prompt,
    fileNames,
    inferencePrompt: explicitInferencePrompt ?? resolveKeywordInferencePrompt(params.prompt),
  };
}
