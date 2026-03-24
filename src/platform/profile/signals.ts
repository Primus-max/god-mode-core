import type { ArtifactKind, ProfileId, ProfileScoringSignal } from "../schemas/index.js";

export type ProfileSignalInput = {
  prompt?: string;
  channelId?: string;
  fileNames?: string[];
  artifactKinds?: ArtifactKind[];
  publishTargets?: string[];
  integrations?: string[];
  requestedTools?: string[];
};

const BUILDER_KEYWORDS = [
  "pdf",
  "document",
  "docx",
  "estimate",
  "smeta",
  "invoice",
  "contract",
  "table",
  "spreadsheet",
  "extract",
  "ocr",
  "report",
  "summary",
];

const DEVELOPER_KEYWORDS = [
  "code",
  "repo",
  "repository",
  "build",
  "deploy",
  "release",
  "bug",
  "test",
  "typescript",
  "javascript",
  "python",
  "api",
  "refactor",
  "commit",
  "pull request",
  "docker",
];

const GENERAL_KEYWORDS = [
  "hello",
  "hi",
  "joke",
  "fun",
  "story",
  "poem",
  "chat",
  "translate",
  "explain",
  "brainstorm",
];

const BUILDER_EXTENSIONS = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv"];
const DEVELOPER_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
];
const BUILDER_ARTIFACTS = new Set<ArtifactKind>(["document", "estimate", "report", "data"]);
const DEVELOPER_ARTIFACTS = new Set<ArtifactKind>(["site", "release", "binary", "archive"]);
const BUILDER_PUBLISH_TARGETS = new Set(["pdf", "email", "docs"]);
const DEVELOPER_PUBLISH_TARGETS = new Set(["github", "npm", "docker", "vercel", "netlify"]);
const DEVELOPER_INTEGRATIONS = new Set(["github", "gitlab", "vercel", "docker", "jira", "linear"]);
const BUILDER_INTEGRATIONS = new Set(["notion", "confluence", "drive", "sheets"]);
const DEVELOPER_TOOLS = new Set(["exec", "process", "apply_patch"]);

function normalizedText(input: ProfileSignalInput): string {
  return [
    input.prompt,
    ...(input.fileNames ?? []),
    ...(input.publishTargets ?? []),
    ...(input.integrations ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function includesAny(text: string, values: string[]): boolean {
  return values.some((value) => text.includes(value));
}

function pushSignal(
  signals: ProfileScoringSignal[],
  source: ProfileScoringSignal["source"],
  profileId: ProfileId,
  weight: number,
  reason: string,
) {
  signals.push({ source, profileId, weight, reason });
}

export function extractProfileSignals(input: ProfileSignalInput): ProfileScoringSignal[] {
  const signals: ProfileScoringSignal[] = [];
  const text = normalizedText(input);
  const files = input.fileNames ?? [];
  const artifacts = input.artifactKinds ?? [];
  const publishTargets = (input.publishTargets ?? []).map((value) => value.toLowerCase());
  const integrations = (input.integrations ?? []).map((value) => value.toLowerCase());
  const tools = (input.requestedTools ?? []).map((value) => value.toLowerCase());

  if (text && includesAny(text, BUILDER_KEYWORDS)) {
    pushSignal(signals, "dialogue", "builder", 0.65, "document/estimate language detected");
  }
  if (text && includesAny(text, DEVELOPER_KEYWORDS)) {
    pushSignal(signals, "dialogue", "developer", 0.7, "code/build language detected");
  }
  if (text && includesAny(text, GENERAL_KEYWORDS)) {
    pushSignal(signals, "dialogue", "general", 0.35, "general/fun language detected");
  }

  if (files.some((file) => BUILDER_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext)))) {
    pushSignal(signals, "file", "builder", 0.8, "document-heavy file types attached");
  }
  if (files.some((file) => DEVELOPER_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext)))) {
    pushSignal(signals, "file", "developer", 0.85, "code file types attached");
  }

  if (artifacts.some((kind) => BUILDER_ARTIFACTS.has(kind))) {
    pushSignal(signals, "artifact", "builder", 0.75, "document/report artifact requested");
  }
  if (artifacts.some((kind) => DEVELOPER_ARTIFACTS.has(kind))) {
    pushSignal(signals, "artifact", "developer", 0.75, "release/binary artifact requested");
  }

  if (publishTargets.some((target) => BUILDER_PUBLISH_TARGETS.has(target))) {
    pushSignal(signals, "config", "builder", 0.7, "builder-oriented publish target requested");
  }
  if (publishTargets.some((target) => DEVELOPER_PUBLISH_TARGETS.has(target))) {
    pushSignal(signals, "config", "developer", 0.8, "developer-oriented publish target requested");
  }

  if (integrations.some((integration) => DEVELOPER_INTEGRATIONS.has(integration))) {
    pushSignal(signals, "config", "developer", 0.75, "developer-oriented integration detected");
  }
  if (integrations.some((integration) => BUILDER_INTEGRATIONS.has(integration))) {
    pushSignal(signals, "config", "builder", 0.6, "builder-oriented integration detected");
  }

  if (tools.some((tool) => DEVELOPER_TOOLS.has(tool))) {
    pushSignal(signals, "tool_usage", "developer", 0.9, "privileged developer tool requested");
  }

  if (signals.length === 0) {
    pushSignal(signals, "config", "general", 0.2, "fallback general profile");
  }

  return signals;
}
