import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import { z } from "zod";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { parseModelRef } from "../../agents/model-selection.js";
import { resolveModelAsync } from "../../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../../agents/simple-completion-transport.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { TRUSTED_CAPABILITY_CATALOG } from "../bootstrap/defaults.js";
import {
  DeliverableKindSchema,
  type DeliverableKind,
  type DeliverableSpec,
} from "../produce/registry.js";
import { collectMissingRequiredEnvForDeliverable } from "../recipe/credentials-preflight.js";
import {
  collectMissingRequiredEnvForCapabilities,
  type RecipePlannerInput,
} from "../recipe/planner.js";
import {
  TASK_CAPABILITY_IDS,
  applyCatalogNormalizer,
  buildCapabilityPromptSection,
  type TaskCapabilityId,
} from "./capability-catalog.js";
import { inferRequestedEvidence } from "./execution-contract.js";
import type { BuildExecutionDecisionInputParams } from "./input.js";
import type { CandidateExecutionFamily } from "./qualification-contract.js";
import type {
  QualificationConfidence,
  QualificationLowConfidenceStrategy,
} from "./qualification-contract.js";
import {
  resolveResolutionContract,
  toRecipeRoutingHints,
  type ResolutionBridgePlannerInput,
  type ResolutionContract,
} from "./resolution-contract.js";
import { deriveRequestedTools } from "./tool-registry.js";

const log = createSubsystemLogger("task-classifier");

export const DEFAULT_TASK_CLASSIFIER_BACKEND = "pi-simple";
export const DEFAULT_TASK_CLASSIFIER_MODEL = "hydra/gpt-5-mini";
export const DEFAULT_TASK_CLASSIFIER_TIMEOUT_MS = 20_000;
export const DEFAULT_TASK_CLASSIFIER_MAX_TOKENS = 450;
const FAIL_CLOSED_REASON = "task classifier unavailable";
const MAX_PENDING_COMMITMENTS_TOKENS = 300;

const TASK_CONTRACT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://openclaw.dev/runtime/task-contract.schema.json",
  title: "TaskContract",
  type: "object",
  additionalProperties: false,
  required: [
    "primaryOutcome",
    "requiredCapabilities",
    "interactionMode",
    "confidence",
    "ambiguities",
  ],
  properties: {
    primaryOutcome: {
      type: "string",
      enum: [
        "answer",
        "workspace_change",
        "external_delivery",
        "comparison_report",
        "calculation_result",
        "document_package",
        "document_extraction",
        "persistent_worker",
        "clarification_needed",
      ],
    },
    requiredCapabilities: {
      type: "array",
      items: {
        type: "string",
        enum: [...TASK_CAPABILITY_IDS],
      },
      uniqueItems: true,
    },
    interactionMode: {
      type: "string",
      enum: ["respond_only", "clarify_first", "tool_execution", "artifact_iteration"],
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    ambiguities: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
      },
      uniqueItems: true,
    },
    deliverable: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "acceptedFormats"],
      properties: {
        kind: {
          type: "string",
          enum: [
            "answer",
            "image",
            "document",
            "data",
            "site",
            "archive",
            "audio",
            "video",
            "code_change",
            "repo_operation",
            "external_delivery",
            "session",
            "capability_install",
          ],
        },
        acceptedFormats: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
        },
        preferredFormat: { type: "string", minLength: 1 },
        constraints: { type: "object", additionalProperties: true },
      },
    },
  },
} as const;

const TASK_CLASSIFIER_SYSTEM_PROMPT =
  "You are a deterministic TaskContract classifier. Classify only. Do not execute, refuse, explain, chat, or ask for access. Return exactly one minified JSON object and nothing else.";

const TASK_CLASSIFIER_USER_TEMPLATE = `Return exactly one minified JSON object matching this JSON Schema:
{{SCHEMA_JSON}}

Rules:
- Use only schema keys.
- Return valid JSON syntax only. No markdown. No prose. No code fences.
- Keep requiredCapabilities minimal. Prefer omission over invention.
- Do not infer tools, vendors, providers, products, frameworks, hosts, or brand names as capabilities.
- Normalize Russian and English wording to the same abstract contract.

Decision ladder:
1. Pick exactly one dominant primaryOutcome:
   - answer: direct text reply, summarization, rewrite, explanation, brainstorm.
   - workspace_change: edit repository, source files, config, tests, scripts, or local project state.
   - external_delivery: deploy, publish, release, ship, send, or deliver to an external system/environment.
   - persistent_worker: create/spawn a persistent worker, named subagent, background/follow-up session, or long-running assistant session.
   - comparison_report: compare, inspect, audit, evaluate, research, review, or summarize options/findings.
   - calculation_result: arithmetic, estimation, or numeric/tabular calculation where the result is mainly the calculation.
   - document_package: create an authored artifact such as PDF, deck, report, infographic, poster, image, or other deliverable asset.
   - document_extraction: extract fields/content from supplied files.
   - clarification_needed: only when the dominant outcome is materially unclear, or when the user asks to fix/change something and then send it to production without clear approval.
2. Pick the lightest valid interactionMode:
   - respond_only: text-only answer without external inspection or tool-dependent execution.
   - tool_execution: browser, web research, extraction, repo execution, or delivery is needed.
   - artifact_iteration: the main result is an authored artifact.
   - clarify_first: use only with primaryOutcome "clarification_needed".
3. Add only capabilities that are explicitly required by the task:
{{CAPABILITY_LADDER}}

Canonical mapping rules:
- Attached files alone do not imply document_extraction, multimodal_authoring, or tool_execution.
- Browser inspection and public web research are different:
  - live page interaction/audit/smoke/compare -> needs_interactive_browser
  - latest public info/pricing/facts -> needs_web_research
- Browser observation tasks are observational: usually comparison_report, not workspace_change.
- Opening or inspecting a local app in browser does not by itself imply needs_repo_execution or needs_local_runtime.
- Pure compare/summarize/calculate without live browsing or public research should prefer respond_only.
- For comparison_report or calculation_result, prefer respond_only unless browser interaction, public web research, repo execution, local runtime, external delivery, or workspace mutation is explicitly required.
- Pure summarization/rewriting of provided text should prefer answer with no capabilities.
- Code change requests imply workspace_change and needs_workspace_mutation.
- Add needs_repo_execution only when the user also wants checks/tests/builds/scripts/validation.
- Requests to leave something running locally, passing locally, validated locally, or previewable locally imply needs_local_runtime.
- Do not infer needs_workspace_mutation for document/image creation.
- Visual or image generation requests should usually be document_package + artifact_iteration + needs_visual_composition.
- PDF/deck/report/infographic authoring from notes or mixed inputs should usually be document_package + artifact_iteration + needs_multimodal_authoring.
- Extraction from supplied files should usually be document_extraction + tool_execution + needs_document_extraction.
- Field extraction from docs/forms/invoices should not add needs_tabular_reasoning unless table/spreadsheet comparison or numeric reasoning is central.
- Spreadsheet/table attachments used only for comparison do not imply needs_document_extraction.
- Deploy/publish/release requests should usually be external_delivery + tool_execution + needs_external_delivery.
- Persistent worker/session requests should be persistent_worker + tool_execution + needs_session_orchestration, deliverable={kind:"session", acceptedFormats:["receipt"], preferredFormat:"receipt", constraints:{continuation:"followup"}}. This maps to sessions_spawn with continuation="followup". Do NOT classify these as external_delivery, workspace_change, cron, repo_run, or publish unless the user explicitly asks to deploy/publish/send to an outside provider.
- Release validation of an already-prepared build is not workspace mutation.
- Add needs_high_reliability_provider only for production/live external delivery.
- Explicit production/live publish or deploy of an already-prepared build should usually be external_delivery + tool_execution + needs_external_delivery + needs_repo_execution + needs_local_runtime + needs_high_reliability_provider, without needs_workspace_mutation unless source edits are explicitly requested.
- Do not add ambiguities for credentials, permissions, URLs, runtime access, browser matrix, page count, branding, tone, template, filenames, or delivery formatting when the dominant outcome is still clear.

Stability examples:
- "Extract fields from attached invoice PDF" -> document_extraction + tool_execution + needs_document_extraction
- "Compare attached pricing spreadsheets" -> comparison_report + respond_only + needs_tabular_reasoning
- "Fix the repo, run checks, leave local validation passing" -> workspace_change + tool_execution + needs_workspace_mutation + needs_repo_execution + needs_local_runtime
- "Open the local app in browser and report issues" -> comparison_report + tool_execution + needs_interactive_browser
- "Run release checks and publish the already-prepared build to production" -> external_delivery + tool_execution + needs_external_delivery + needs_repo_execution + needs_local_runtime + needs_high_reliability_provider
- "Сгенерировать картинку банана" / "Generate an image of a banana" -> document_package + artifact_iteration + needs_visual_composition, deliverable={kind:"image", acceptedFormats:["png","jpg"], preferredFormat:"png"}
- "Сгенерировать pdf про жизнь банана" / "Make a pdf about X" -> document_package + artifact_iteration + needs_multimodal_authoring, deliverable={kind:"document", acceptedFormats:["pdf"], preferredFormat:"pdf"}
- "То же самое в word" / "The same in Word" / "Сделай в ворде" -> document_package + artifact_iteration + needs_multimodal_authoring, deliverable={kind:"document", acceptedFormats:["docx"], preferredFormat:"docx"}. Do NOT ask for clarification about what the user wants to transfer; treat the user's current turn as authoritative for the format switch.
- "Какой-то отчёт сделать в csv" / "Any report in CSV" -> document_package + artifact_iteration + needs_tabular_reasoning, deliverable={kind:"data", acceptedFormats:["csv"], preferredFormat:"csv"}. Do NOT treat vague report requests as 'answer' when a file format is named.
- "Какой-то отчёт сделать в эксель" / "Report in Excel" -> document_package + artifact_iteration + needs_tabular_reasoning, deliverable={kind:"data", acceptedFormats:["xlsx","csv"], preferredFormat:"xlsx"}.
- "Создание сайта — простая лендинг-страница" / "Create a landing page" -> external_delivery + artifact_iteration + needs_multimodal_authoring, deliverable={kind:"site", acceptedFormats:["zip","html"], preferredFormat:"zip"}.
- "Установи стороннюю библиотеку pdfkit" / "Install pdfkit library" -> external_delivery + tool_execution + needs_external_delivery, deliverable={kind:"capability_install", acceptedFormats:["npm-package"], preferredFormat:"npm-package", constraints:{manager:"npm", name:"pdfkit"}}.
- "Создай новый файл X с содержимым Y" or "Create file X with content Y" -> workspace_change + tool_execution + needs_workspace_mutation, deliverable={kind:"code_change", acceptedFormats:["patch","workspace"], preferredFormat:"patch", constraints:{operation:"add_file"}}. Pass the exact file path and file contents through the tool arguments — never parse them in the tool itself.
- "Обнови файл X" or "Update file X, replace A with B" -> workspace_change + tool_execution + needs_workspace_mutation, deliverable={kind:"code_change", acceptedFormats:["patch","edit"], preferredFormat:"patch", constraints:{operation:"update_file"}}.
- "Инициализируй проект, добавь README и CI" or "Scaffold a new repo with README and CI" -> workspace_change + tool_execution + needs_workspace_mutation + needs_repo_execution, deliverable={kind:"code_change", acceptedFormats:["patch","workspace"], preferredFormat:"patch", constraints:{operation:"scaffold_repo"}}.
- "Найди и пофикси багу в тестовой линии" or "Find and fix the leak in the tests lane" -> workspace_change + tool_execution + needs_workspace_mutation + needs_repo_execution + needs_local_runtime, deliverable={kind:"code_change", acceptedFormats:["patch","edit"], preferredFormat:"patch", constraints:{operation:"bug_fix"}}.
- "Обнови зависимость Z и прогоняй security checks" or "Bump dependency Z and run security checks" -> workspace_change + tool_execution + needs_workspace_mutation + needs_repo_execution, deliverable={kind:"code_change", acceptedFormats:["patch","workspace"], preferredFormat:"patch", constraints:{operation:"dependency_update"}}.
- "Запусти команду node --version" or "Run node --version" -> workspace_change + tool_execution + needs_repo_execution + needs_local_runtime, deliverable={kind:"repo_operation", acceptedFormats:["exec","script"], preferredFormat:"exec", constraints:{operation:"run_command"}}.
- "Прогнать тесты в проекте" or "run the test suite" -> workspace_change + tool_execution + needs_repo_execution + needs_local_runtime, deliverable={kind:"repo_operation", acceptedFormats:["test-report","exec"], preferredFormat:"test-report", constraints:{operation:"run_tests"}}.
- "Отрефактори модуль Y, покажи diff и прогоняй тесты" or "Refactor module Y, show diff and run tests" -> workspace_change + tool_execution + needs_workspace_mutation + needs_repo_execution + needs_local_runtime, deliverable={kind:"code_change", acceptedFormats:["patch","edit"], preferredFormat:"patch", constraints:{operation:"refactor"}}.
- "Создай сабагента Валера, чтобы он каждый день слал отчёт" / "Create a persistent subagent Valera for daily reports" / "start a background worker session" -> persistent_worker + tool_execution + needs_session_orchestration, deliverable={kind:"session", acceptedFormats:["receipt"], preferredFormat:"receipt", constraints:{continuation:"followup"}}.
- Reminder requests — phrases asking the bot to say something later in the SAME chat (Russian "напомни ...", English "reminder ..." or "remind me ..."), an explicit future timestamp plus a deferred-message intent — are \`tool_execution\` with \`requestedTools=["cron"]\` (deferred message back to the CURRENT channel via the built-in cron-tool), NEVER \`external_delivery\`. \`external_delivery\` is reserved for integrations with an external provider (Bybit, OpenAI, telegram_userbot, etc.), not for a deferred message back to the current channel. Emit primaryOutcome="answer", interactionMode="tool_execution", deliverable={kind:"answer", acceptedFormats:["text"], constraints:{tool:"cron"}}. Do NOT add needs_external_delivery for these. Examples: "Напомни завтра в 12:00 пообедать", "Напомни через 30 секунд тестовое сообщение", "Remind me in 5 minutes to drink water".

Deliverable rules:
- ALWAYS include a "deliverable" object. It declares WHAT the user wants back, independent of WHICH tool produces it.
- deliverable.kind is one of: answer, image, document, data, site, archive, audio, video, code_change, repo_operation, external_delivery, session, capability_install.
- deliverable.acceptedFormats is a non-empty list of format tokens (lower-case) the user would accept. Put the preferred/most-likely format FIRST.
- If the user clearly named ONE format (pdf / docx / xlsx / csv / png / mp3 / zip / etc.) put exactly that format in acceptedFormats and set preferredFormat to it.
- If the user asked for a document but did not name a format, return primaryOutcome="clarification_needed" and an ambiguity "document format not specified". Do NOT guess pdf-vs-docx.
- If the user asked for a report/table/отчёт without naming a format, use kind="data" with acceptedFormats=["xlsx","csv"] (most universal).
- Map primaryOutcome to deliverable.kind:
  - answer -> kind: "answer", acceptedFormats: ["text"]
  - document_package (visual-only artifact like a poster, illustration, banner) -> kind: "image", acceptedFormats: ["png","jpg"]
  - document_package (authored document: pdf / docx / presentation) -> kind: "document", acceptedFormats: the named format(s)
  - document_extraction -> kind: "data", acceptedFormats: ["json"]
  - workspace_change (create/update/refactor files, bug fixes, dep bumps) -> kind: "code_change", acceptedFormats: ["patch","workspace"] (prefer "patch" when you want a diff; prefer "workspace" when the user asked for a fresh file). Constraints may include {operation: "add_file"|"update_file"|"refactor"|"bug_fix"|"dependency_update"|"scaffold_repo"}.
  - workspace_change driven by running commands/tests/scripts WITHOUT editing source files -> kind: "repo_operation", acceptedFormats: ["exec","script","test-report"]. Constraints may include {operation: "run_command"|"run_tests"|"run_script"}.
  - external_delivery -> kind: "external_delivery", acceptedFormats: ["receipt"]
  - persistent_worker -> kind: "session", acceptedFormats: ["receipt"], preferredFormat: "receipt", constraints: { continuation: "followup" }
  - comparison_report / calculation_result -> kind: "answer", acceptedFormats: ["text"]
  - install a library / package / CLI tool -> kind: "capability_install", acceptedFormats: ["npm-package"] for node, ["pip-package"] for python, ["brew-package"] for macOS system tools, constraints: { manager: "npm"|"pip"|"brew", name: "<exact package name>", version?: "<semver or tag>" }
  - build/create a website/landing page -> kind: "site", acceptedFormats: ["zip"]

Constraints guidance (deliverable.constraints):
- Optional key/value object. Use ONLY fields the user clearly implied. Never invent.
- For document (pdf/docx): constraints may include:
   - pageCount: integer 1..12 when the user specified a length ("2 pages", "две страницы", "pair of slides")
   - style: "minimal" | "rich" | "infographic" | "presentation" — set rich/infographic/presentation when the user asked for something visually formatted (charts, colorful layout, slides, инфографика); leave undefined or "minimal" when plain text is enough.
   - needsManagedRenderer: true when the user explicitly asked for tables, charts, precise layout, or "beautiful/красивый" output.
- For data (csv/xlsx): constraints may include columns:[string,...] when the user listed the columns.
- For image: constraints may include aspectRatio ("16:9","1:1","9:16") and overlayText (the literal quoted text to overlay).
- For capability_install: constraints MUST include manager, name; include version only if the user named one.
- For site: constraints may include pages:[string,...] and theme:"dark"|"light".
- For code_change / repo_operation that integrates with a specific external system, set constraints.provider to one of: "bybit" (Bybit exchange / trading bot), "openai" (OpenAI API integration), "telegram_userbot" (Telegram userbot using TELEGRAM_API_HASH). Use "integration" as a synonym if a single string is awkward. Do NOT set provider just because the user mentioned the platform in passing - only when the deliverable itself is wired to that provider's API. A poem, a picture, a plain pnpm dev run, or a generic test-suite run has NO provider.

Output contract:
- confidence must be between 0 and 1.
- ambiguities should be an empty array unless the dominant outcome is genuinely unclear.
- Return exactly one minified JSON object and nothing else.

Attachment file names:
{{ATTACHMENT_FILE_NAMES}}

User request:
{{USER_REQUEST}}`.replace("{{CAPABILITY_LADDER}}", buildCapabilityPromptSection());

function truncatePendingCommitmentsTokens(raw: string, maxTokens: number): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  const tokens = normalized.split(" ");
  if (tokens.length <= maxTokens) {
    return normalized;
  }
  return `${tokens.slice(0, maxTokens).join(" ")}…`;
}

function buildPendingCommitmentsInjection(ledgerContext?: string): string {
  const normalized = truncatePendingCommitmentsTokens(
    typeof ledgerContext === "string" ? ledgerContext : "",
    MAX_PENDING_COMMITMENTS_TOKENS,
  );
  if (!normalized) {
    return "";
  }
  return [
    "",
    "<pending_commitments>",
    normalized,
    "</pending_commitments>",
    "Use pending commitments only to resolve short acknowledgements (e.g., \"да\", \"подтверждаю\").",
  ].join("\n");
}

function buildClarifyBudgetInjection(clarifyBudgetNotice?: string): string {
  const normalized = (clarifyBudgetNotice ?? "").trim();
  if (!normalized) {
    return "";
  }
  return `\n${normalized}`;
}

function buildContextBlockInjection(tag: "workspace" | "identity", body?: string): string {
  const normalized = typeof body === "string" ? body.trim() : "";
  if (!normalized) {
    return "";
  }
  return `\n<${tag}>\n${normalized}\n</${tag}>`;
}

/**
 * Builds the user-message preamble in the canonical order required by P1.5 §B:
 * `<workspace>` → `<identity>` → `<pending_commitments>` → clarify-budget → user prompt.
 * Exported only for unit-test verification; production callers go through the adapter.
 */
export function composeClassifierUserRequestForTest(params: {
  prompt: string;
  workspaceContext?: string;
  identityContext?: string;
  ledgerContext?: string;
  clarifyBudgetNotice?: string;
}): string {
  const workspaceInjection = buildContextBlockInjection("workspace", params.workspaceContext);
  const identityInjection = buildContextBlockInjection("identity", params.identityContext);
  const pendingCommitmentsInjection = buildPendingCommitmentsInjection(params.ledgerContext);
  const clarifyBudgetInjection = buildClarifyBudgetInjection(params.clarifyBudgetNotice);
  const preamble = `${workspaceInjection}${identityInjection}${pendingCommitmentsInjection}${clarifyBudgetInjection}`;
  return preamble ? `${preamble.replace(/^\n/, "")}\n${params.prompt}` : params.prompt;
}

type PrimaryOutcome =
  | "answer"
  | "workspace_change"
  | "external_delivery"
  | "comparison_report"
  | "calculation_result"
  | "document_package"
  | "document_extraction"
  | "persistent_worker"
  | "clarification_needed";

type Capability = TaskCapabilityId;

type InteractionMode = "respond_only" | "clarify_first" | "tool_execution" | "artifact_iteration";

const TaskContractZodSchema = z
  .object({
    primaryOutcome: z.enum([
      "answer",
      "workspace_change",
      "external_delivery",
      "comparison_report",
      "calculation_result",
      "document_package",
      "document_extraction",
      "persistent_worker",
      "clarification_needed",
    ]),
    requiredCapabilities: z
      .array(z.enum(TASK_CAPABILITY_IDS))
      .superRefine((values, ctx) => {
        if (new Set(values).size !== values.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "requiredCapabilities must contain unique items",
          });
        }
      }),
    interactionMode: z.enum([
      "respond_only",
      "clarify_first",
      "tool_execution",
      "artifact_iteration",
    ]),
    confidence: z.number().min(0).max(1),
    ambiguities: z.array(z.string().min(1)).superRefine((values, ctx) => {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "ambiguities must contain unique items",
        });
      }
    }),
    deliverable: z
      .object({
        kind: DeliverableKindSchema,
        acceptedFormats: z.array(z.string().min(1)).min(1),
        preferredFormat: z.string().min(1).optional(),
        constraints: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type TaskContract = {
  primaryOutcome: PrimaryOutcome;
  requiredCapabilities: Capability[];
  interactionMode: InteractionMode;
  confidence: number;
  ambiguities: string[];
  deliverable?: DeliverableSpec;
};

export type TaskClassifierDebugEvent = {
  stage: "model_unresolved" | "raw_response" | "fallback" | "disabled" | "unknown_backend";
  backend: string;
  configuredModel: string;
  provider?: string;
  modelId?: string;
  rawText?: string;
  normalizedCandidate?: string;
  parseResult?: "ok" | "empty" | "json_parse_failed" | "schema_invalid";
  parseErrorMessage?: string;
  message?: string;
};

export type ClassifiedTaskResolution = {
  source: "llm" | "fail_closed";
  taskContract: TaskContract;
  plannerInput: RecipePlannerInput;
  resolutionContract: ResolutionContract;
  candidateFamilies: CandidateExecutionFamily[];
};

export type TaskClassifierAdapter = {
  classify(params: {
    prompt: string;
    fileNames: string[];
    ledgerContext?: string;
    clarifyBudgetNotice?: string;
    workspaceContext?: string;
    identityContext?: string;
    config: ResolvedTaskClassifierConfig;
    cfg: OpenClawConfig;
    agentDir?: string;
    onDebugEvent?: (event: TaskClassifierDebugEvent) => void;
  }): Promise<TaskContract | null>;
};

export type ResolvedTaskClassifierConfig = {
  enabled: boolean;
  backend: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
};

function normalizeUnique<T extends string>(values: readonly T[]): T[] {
  return Array.from(new Set(values)).toSorted();
}

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

function emitDebugEvent(
  callback: ((event: TaskClassifierDebugEvent) => void) | undefined,
  event: TaskClassifierDebugEvent,
): void {
  try {
    callback?.(event);
  } catch {
    // Debug hooks must never interfere with classifier execution.
  }
}

function normalizeTaskContractJsonCandidate(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
}

function extractJsonObjectCandidate(raw: string): string | null {
  const normalized = normalizeTaskContractJsonCandidate(raw);
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("{") && normalized.endsWith("}")) {
    return normalized;
  }
  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  return normalized.slice(firstBrace, lastBrace + 1).trim();
}

function safeParseTaskContract(raw: string): {
  taskContract: TaskContract | null;
  parseResult: "ok" | "empty" | "json_parse_failed" | "schema_invalid";
  normalizedCandidate?: string;
  parseErrorMessage?: string;
} {
  const candidate = extractJsonObjectCandidate(raw);
  if (!candidate) {
    return { taskContract: null, parseResult: "empty" };
  }
  try {
    const parsed = JSON.parse(candidate) as TaskContract;
    const validation = TaskContractZodSchema.safeParse(parsed);
    return validation.success
      ? { taskContract: validation.data, parseResult: "ok", normalizedCandidate: candidate }
      : { taskContract: null, parseResult: "schema_invalid", normalizedCandidate: candidate };
  } catch (error) {
    return {
      taskContract: null,
      parseResult: "json_parse_failed",
      normalizedCandidate: candidate,
      parseErrorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function clampConfidence(confidence: number): number {
  return Math.min(1, Math.max(0, confidence));
}

function normalizeTaskContract(contract: TaskContract): TaskContract {
  const capabilities = new Set(contract.requiredCapabilities);
  let primaryOutcome = contract.primaryOutcome;
  let interactionMode = contract.interactionMode;
  if (primaryOutcome === "clarification_needed") {
    interactionMode = "clarify_first";
  } else if (interactionMode === "clarify_first") {
    primaryOutcome = "clarification_needed";
  }

  if (primaryOutcome === "document_package") {
    interactionMode = "artifact_iteration";
    capabilities.delete("needs_document_extraction");
  }

  if (primaryOutcome === "document_extraction") {
    interactionMode = "tool_execution";
    capabilities.add("needs_document_extraction");
    capabilities.delete("needs_tabular_reasoning");
    capabilities.delete("needs_multimodal_authoring");
    capabilities.delete("needs_visual_composition");
  }

  if (primaryOutcome === "persistent_worker") {
    interactionMode = "tool_execution";
    capabilities.add("needs_session_orchestration");
    capabilities.delete("needs_external_delivery");
    capabilities.delete("needs_high_reliability_provider");
    capabilities.delete("needs_workspace_mutation");
    capabilities.delete("needs_repo_execution");
    capabilities.delete("needs_local_runtime");
  }

  if (capabilities.has("needs_workspace_mutation") && primaryOutcome !== "external_delivery") {
    primaryOutcome = "workspace_change";
    interactionMode = "tool_execution";
  }

  if (primaryOutcome === "workspace_change") {
    if (contract.deliverable?.kind === "repo_operation") {
      // P1.3 invariant: repo_operation (git commit, run tests, run build) must not
      // be treated as a workspace mutation. `apply_patch` and the P0.2 low-confidence
      // safety rule both key off `needs_workspace_mutation`; leaving this flag in when
      // the LLM mis-tagged a git operation would force `apply_patch` and spurious
      // clarify on low-confidence "just commit" turns.
      capabilities.delete("needs_workspace_mutation");
    } else {
      capabilities.add("needs_workspace_mutation");
    }
    interactionMode = "tool_execution";
  }

  if (capabilities.has("needs_interactive_browser")) {
    interactionMode = "tool_execution";
    if (primaryOutcome === "comparison_report") {
      capabilities.delete("needs_local_runtime");
      capabilities.delete("needs_repo_execution");
    }
    if (primaryOutcome === "answer") {
      primaryOutcome = "comparison_report";
    }
  }
  if (capabilities.has("needs_web_research")) {
    interactionMode = "tool_execution";
    capabilities.delete("needs_tabular_reasoning");
    if (primaryOutcome === "answer") {
      primaryOutcome = "comparison_report";
    }
  }

  // Delivery-only flags (`needs_external_delivery`, `needs_high_reliability_provider`)
  // are pruned by the catalog's `requiresOutcomes` rule once the final pass runs.
  if (primaryOutcome === "external_delivery") {
    capabilities.delete("needs_workspace_mutation");
    capabilities.add("needs_external_delivery");
    if (capabilities.has("needs_local_runtime")) {
      capabilities.add("needs_high_reliability_provider");
    }
    interactionMode = "tool_execution";
  }

  if (
    (primaryOutcome === "comparison_report" || primaryOutcome === "calculation_result") &&
    !capabilities.has("needs_interactive_browser") &&
    !capabilities.has("needs_web_research") &&
    !capabilities.has("needs_repo_execution") &&
    !capabilities.has("needs_local_runtime") &&
    !capabilities.has("needs_external_delivery") &&
    !capabilities.has("needs_workspace_mutation")
  ) {
    interactionMode = "respond_only";
  }

  const deliverable =
    contract.deliverable ?? inferDeliverableFallback(primaryOutcome, capabilities);

  // Final pass: enforce catalog-declared invariants (e.g. needs_visual_composition
  // can only ride on a kind=image deliverable). Runs LAST so that the legacy
  // outcome/capability mutations and deliverable inference above have already
  // settled — catalog rules are pure filtering, never re-derivation.
  const catalogFiltered = applyCatalogNormalizer({
    capabilities,
    primaryOutcome,
    deliverableKind: deliverable?.kind,
  });

  return {
    ...contract,
    primaryOutcome,
    interactionMode,
    requiredCapabilities: normalizeUnique(Array.from(catalogFiltered)),
    confidence: clampConfidence(contract.confidence),
    ambiguities: normalizeUnique(contract.ambiguities),
    ...(deliverable ? { deliverable } : {}),
  };
}

function inferDeliverableFallback(
  primaryOutcome: PrimaryOutcome,
  capabilities: Set<Capability>,
): DeliverableSpec | undefined {
  switch (primaryOutcome) {
    case "answer":
    case "comparison_report":
    case "calculation_result":
      return { kind: "answer", acceptedFormats: ["text"] };
    case "clarification_needed":
      return { kind: "answer", acceptedFormats: ["text"] };
    case "workspace_change":
      if (
        capabilities.has("needs_repo_execution") &&
        !capabilities.has("needs_workspace_mutation")
      ) {
        return { kind: "repo_operation", acceptedFormats: ["exec", "script"] };
      }
      return { kind: "code_change", acceptedFormats: ["patch", "workspace"] };
    case "external_delivery":
      return { kind: "external_delivery", acceptedFormats: ["receipt"] };
    case "persistent_worker":
      return {
        kind: "session",
        acceptedFormats: ["receipt"],
        preferredFormat: "receipt",
        constraints: { continuation: "followup" },
      };
    case "document_extraction":
      return { kind: "data", acceptedFormats: ["json"] };
    case "document_package":
      if (
        capabilities.has("needs_visual_composition") &&
        !capabilities.has("needs_multimodal_authoring")
      ) {
        return { kind: "image", acceptedFormats: ["png", "jpg"] };
      }
      return undefined;
    default:
      return undefined;
  }
}

function buildFailClosedTaskContract(reason: string): TaskContract {
  return {
    primaryOutcome: "clarification_needed",
    requiredCapabilities: [],
    interactionMode: "clarify_first",
    confidence: 0,
    ambiguities: [reason],
  };
}

function isScaffoldContract(contract: TaskContract): boolean {
  if (contract.primaryOutcome !== "workspace_change") {
    return false;
  }
  if (contract.deliverable?.kind !== "code_change") {
    return false;
  }
  const operation = contract.deliverable.constraints?.operation;
  return typeof operation === "string" && operation === "scaffold_repo";
}

function rewriteTaskContractAsCredentialClarification(params: {
  contract: TaskContract;
  missingCredentials: string[];
}): TaskContract {
  return {
    primaryOutcome: "clarification_needed",
    interactionMode: "clarify_first",
    requiredCapabilities: [],
    confidence: Math.min(params.contract.confidence, 0.5),
    ambiguities: normalizeUnique([
      ...params.contract.ambiguities,
      ...params.missingCredentials.map((envName) => `missing_credentials: ${envName}`),
    ]),
  };
}

function applyCredentialsPreflight(params: {
  contract: TaskContract;
}): TaskContract {
  if (!isScaffoldContract(params.contract)) {
    return params.contract;
  }
  // P1.6.1: union of capability-declared env (legacy path; the bundled
  // `needs_repo_execution` no longer carries `requiredEnv`) and the
  // deliverable's provider/integration tag resolved through the
  // provider→envKeys table. Without an explicit provider signal in the
  // structured deliverable we no longer raise a credentials clarification.
  const capabilityMissing = collectMissingRequiredEnvForCapabilities({
    capabilityIds: params.contract.requiredCapabilities,
    capabilityCatalog: TRUSTED_CAPABILITY_CATALOG,
    envSnapshot: process.env,
  });
  const deliverableMissing = collectMissingRequiredEnvForDeliverable({
    deliverable: params.contract.deliverable,
    envSnapshot: process.env,
  });
  const missingCredentials = Array.from(
    new Set([...capabilityMissing, ...deliverableMissing]),
  ).toSorted();
  if (missingCredentials.length === 0) {
    return params.contract;
  }
  return rewriteTaskContractAsCredentialClarification({
    contract: params.contract,
    missingCredentials,
  });
}

function taskContractConfidenceToQualification(confidence: number): QualificationConfidence {
  if (confidence >= 0.8) {
    return "high";
  }
  if (confidence >= 0.55) {
    return "medium";
  }
  return "low";
}

function taskContractLowConfidenceStrategy(
  contract: TaskContract,
): QualificationLowConfidenceStrategy | undefined {
  if (
    contract.primaryOutcome === "clarification_needed" ||
    contract.interactionMode === "clarify_first"
  ) {
    return "clarify";
  }
  // P0.2 safety rule: low classifier confidence combined with a workspace-
  // mutating request AND unresolved ambiguities must route through clarify,
  // not proceed optimistically. Rationale: `workspace_change` is irreversible
  // enough that we would rather ask one question than damage the workspace on
  // a guess. Threshold 0.5 matches `qualificationConfidence=low` upper bound.
  const capabilities = new Set(contract.requiredCapabilities);
  const rawConfidence = typeof contract.confidence === "number" ? contract.confidence : 1;
  const ambiguityCount = contract.ambiguities?.length ?? 0;
  if (
    rawConfidence < 0.5 &&
    capabilities.has("needs_workspace_mutation") &&
    ambiguityCount > 0
  ) {
    return "clarify";
  }
  return undefined;
}

const CLARIFY_RESPOND_ONLY_BRIDGE: ResolutionBridgePlannerInput = {
  intent: "general",
  artifactKinds: [],
  requestedTools: [],
  publishTargets: [],
  outcomeContract: "text_response",
  executionContract: {
    requiresTools: false,
    requiresWorkspaceMutation: false,
    requiresLocalProcess: false,
    requiresArtifactEvidence: false,
    requiresDeliveryEvidence: false,
    mayNeedBootstrap: false,
  },
};

function mapTaskContractToBridge(contract: TaskContract): ResolutionBridgePlannerInput {
  const capabilities = new Set(contract.requiredCapabilities);
  const hasVisualComposition = capabilities.has("needs_visual_composition");
  const hasMultimodalAuthoring = capabilities.has("needs_multimodal_authoring");
  const isPureVisualArtifact =
    contract.primaryOutcome === "document_package" &&
    hasVisualComposition &&
    !hasMultimodalAuthoring;
  const artifactKinds: (
    | "document"
    | "estimate"
    | "site"
    | "release"
    | "binary"
    | "report"
    | "video"
    | "image"
    | "audio"
    | "archive"
    | "data"
    | "other"
  )[] = [];
  const requestedTools: string[] = [];
  let intent: ResolutionBridgePlannerInput["intent"];

  switch (contract.primaryOutcome) {
    case "workspace_change":
      intent = "code";
      artifactKinds.push("binary");
      break;
    case "external_delivery":
      intent = "publish";
      artifactKinds.push("release");
      break;
    case "comparison_report":
      intent = "compare";
      artifactKinds.push("data", "report");
      break;
    case "calculation_result":
      intent = "calculation";
      artifactKinds.push("data", "report");
      break;
    case "document_package":
      if (!isPureVisualArtifact) {
        intent = "document";
        artifactKinds.push("document");
      }
      // For pure visual artifacts, intent remains undefined (no document intent needed)
      break;
    case "document_extraction":
      intent = "document";
      artifactKinds.push("document", "report");
      break;
    case "persistent_worker":
      intent = "general";
      break;
    default:
      intent = "general";
      break;
  }

  if (hasVisualComposition) {
    artifactKinds.push("image");
  }
  if (hasMultimodalAuthoring) {
    artifactKinds.push("document", "image");
  }
  // ToolRegistry-driven derivation. The capability→tool mapping, the
  // suppression of `apply_patch` for repo_operation deliverables, the
  // producer-chain inclusion, and the `deliverable.constraints.tool` escape
  // hatch (used today by the reminder/cron flow) all live inside the registry.
  // Anything we used to push manually here now belongs in `tool-registry.ts`.
  for (const toolName of deriveRequestedTools({
    capabilities,
    deliverable: contract.deliverable,
  })) {
    requestedTools.push(toolName);
  }
  if (contract.deliverable) {
    const deliverableKind = contract.deliverable.kind;
    if (deliverableKind === "image" && !artifactKinds.includes("image")) {
      artifactKinds.push("image");
    }
    if (deliverableKind === "document" && !artifactKinds.includes("document")) {
      artifactKinds.push("document");
    }
    if (deliverableKind === "data" && !artifactKinds.includes("data")) {
      artifactKinds.push("data");
    }
    if (deliverableKind === "site" && !artifactKinds.includes("site")) {
      artifactKinds.push("site");
    }
    if (deliverableKind === "archive" && !artifactKinds.includes("archive")) {
      artifactKinds.push("archive");
    }
    if (deliverableKind === "audio" && !artifactKinds.includes("audio")) {
      artifactKinds.push("audio");
    }
    if (deliverableKind === "video" && !artifactKinds.includes("video")) {
      artifactKinds.push("video");
    }
  }

  const normalizedArtifactKinds = normalizeUnique(artifactKinds);
  const normalizedRequestedTools = normalizeUnique(requestedTools);
  const hasStructuredArtifact =
    normalizedArtifactKinds.includes("document") ||
    normalizedArtifactKinds.includes("estimate") ||
    normalizedArtifactKinds.includes("image") ||
    normalizedArtifactKinds.includes("video") ||
    normalizedArtifactKinds.includes("audio") ||
    normalizedArtifactKinds.includes("archive");
  const requiresTools =
    normalizedRequestedTools.length > 0 ||
    contract.interactionMode === "tool_execution" ||
    contract.interactionMode === "artifact_iteration";

  return {
    intent,
    artifactKinds: normalizedArtifactKinds,
    requestedTools: normalizedRequestedTools,
    publishTargets: capabilities.has("needs_external_delivery") ? ["external"] : [],
    ...(contract.deliverable ? { deliverable: contract.deliverable } : {}),
    outcomeContract:
      contract.primaryOutcome === "workspace_change"
        ? "workspace_change"
        : contract.primaryOutcome === "external_delivery"
          ? "external_operation"
          : contract.primaryOutcome === "persistent_worker"
            ? "text_response"
            : normalizedArtifactKinds.includes("site")
              ? "interactive_local_result"
              : hasStructuredArtifact
                ? "structured_artifact"
                : contract.primaryOutcome === "comparison_report" ||
                    contract.primaryOutcome === "calculation_result" ||
                    contract.primaryOutcome === "answer" ||
                    contract.primaryOutcome === "clarification_needed"
                  ? "text_response"
                  : "structured_artifact",
    executionContract: {
      requiresTools,
      requiresWorkspaceMutation: capabilities.has("needs_workspace_mutation"),
      requiresLocalProcess: capabilities.has("needs_local_runtime"),
      requiresArtifactEvidence:
        contract.primaryOutcome === "document_package" ||
        contract.primaryOutcome === "document_extraction",
      requiresDeliveryEvidence: capabilities.has("needs_external_delivery"),
      mayNeedBootstrap:
        capabilities.has("needs_repo_execution") ||
        capabilities.has("needs_document_extraction") ||
        capabilities.has("needs_local_runtime"),
    },
  };
}

export function buildPlannerInputFromTaskContract(params: {
  prompt: string;
  fileNames?: string[];
  taskContract: TaskContract;
  classifierTelemetry?: import("../recipe/planner.js").ClassifierTelemetry;
}): RecipePlannerInput {
  const fileNames = Array.from(
    new Set(
      (params.fileNames ?? [])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim()),
    ),
  );
  const ambiguityReasons = normalizeUnique(params.taskContract.ambiguities);
  const confidence = taskContractConfidenceToQualification(params.taskContract.confidence);
  const lowConfidenceStrategy = taskContractLowConfidenceStrategy(params.taskContract);
  // P0.3 consistency invariant: when the classifier decides to clarify we must
  // not leak tool requests or artifact expectations into the planner. Feeding
  // `requestedTools` / `requiresTools=true` on a clarify turn produces the
  // exact contradiction the user sees in logs (plan says clarify, runtime
  // still proposes `apply_patch`/`exec`). Force a respond-only bridge.
  const bridge =
    lowConfidenceStrategy === "clarify"
      ? CLARIFY_RESPOND_ONLY_BRIDGE
      : mapTaskContractToBridge(params.taskContract);
  const deliverableForPlanner =
    lowConfidenceStrategy === "clarify" ? undefined : params.taskContract.deliverable;
  const resolutionContract = resolveResolutionContract({
    contractFirst: true,
    ...(fileNames.length > 0 ? { fileNames } : {}),
    ...bridge,
  });
  return {
    prompt: params.prompt,
    contractFirst: true,
    ...(fileNames.length > 0 ? { fileNames } : {}),
    ...(bridge.intent ? { intent: bridge.intent } : {}),
    ...(bridge.artifactKinds?.length ? { artifactKinds: bridge.artifactKinds } : {}),
    ...(bridge.requestedTools?.length ? { requestedTools: bridge.requestedTools } : {}),
    ...(bridge.publishTargets?.length ? { publishTargets: bridge.publishTargets } : {}),
    ...(deliverableForPlanner ? { deliverable: deliverableForPlanner } : {}),
    outcomeContract: bridge.outcomeContract,
    executionContract: bridge.executionContract,
    requestedEvidence: inferRequestedEvidence(bridge.outcomeContract, bridge.executionContract),
    confidence,
    taskRequiredCapabilities: [...params.taskContract.requiredCapabilities],
    ...(ambiguityReasons.length > 0 ? { ambiguityReasons } : {}),
    ...(lowConfidenceStrategy ? { lowConfidenceStrategy } : {}),
    candidateFamilies: [...resolutionContract.candidateFamilies],
    resolutionContract,
    routing: toRecipeRoutingHints(resolutionContract),
    ...(params.classifierTelemetry ? { classifierTelemetry: params.classifierTelemetry } : {}),
  };
}

export function resolveTaskClassifierConfig(params: {
  cfg: OpenClawConfig;
}): ResolvedTaskClassifierConfig {
  const classifierConfig = params.cfg.agents?.defaults?.embeddedPi?.taskClassifier;
  return {
    enabled: classifierConfig?.enabled !== false,
    backend: classifierConfig?.backend?.trim() || DEFAULT_TASK_CLASSIFIER_BACKEND,
    model: classifierConfig?.model?.trim() || DEFAULT_TASK_CLASSIFIER_MODEL,
    timeoutMs: classifierConfig?.timeoutMs ?? DEFAULT_TASK_CLASSIFIER_TIMEOUT_MS,
    maxTokens: classifierConfig?.maxTokens ?? DEFAULT_TASK_CLASSIFIER_MAX_TOKENS,
  };
}

class PiTaskClassifierAdapter implements TaskClassifierAdapter {
  async classify(params: {
    prompt: string;
    fileNames: string[];
    ledgerContext?: string;
    clarifyBudgetNotice?: string;
    workspaceContext?: string;
    identityContext?: string;
    config: ResolvedTaskClassifierConfig;
    cfg: OpenClawConfig;
    agentDir?: string;
    onDebugEvent?: (event: TaskClassifierDebugEvent) => void;
  }): Promise<TaskContract | null> {
    const modelRefRaw = params.config.model;
    const parsedRef = parseModelRef(modelRefRaw, "openai");
    if (!parsedRef) {
      return null;
    }
    const resolved = await resolveModelAsync(
      parsedRef.provider,
      parsedRef.model,
      params.agentDir,
      params.cfg,
    );
    if (!resolved.model) {
      emitDebugEvent(params.onDebugEvent, {
        stage: "model_unresolved",
        backend: params.config.backend,
        configuredModel: params.config.model,
        provider: parsedRef.provider,
        modelId: parsedRef.model,
        message: resolved.error ?? "model could not be resolved",
      });
      return null;
    }
    const model = prepareModelForSimpleCompletion({ model: resolved.model, cfg: params.cfg });
    const auth = await getApiKeyForModel({ model, cfg: params.cfg, agentDir: params.agentDir });
    const apiKey = requireApiKey(auth, model.provider);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.config.timeoutMs);
    try {
      const userRequest = composeClassifierUserRequestForTest({
        prompt: params.prompt,
        ...(params.workspaceContext ? { workspaceContext: params.workspaceContext } : {}),
        ...(params.identityContext ? { identityContext: params.identityContext } : {}),
        ...(params.ledgerContext ? { ledgerContext: params.ledgerContext } : {}),
        ...(params.clarifyBudgetNotice ? { clarifyBudgetNotice: params.clarifyBudgetNotice } : {}),
      });
      const prompt = TASK_CLASSIFIER_USER_TEMPLATE.replace(
        "{{SCHEMA_JSON}}",
        JSON.stringify(TASK_CONTRACT_SCHEMA),
      )
        .replace("{{ATTACHMENT_FILE_NAMES}}", JSON.stringify(params.fileNames))
        .replace("{{USER_REQUEST}}", userRequest);
      const result = await completeSimple(
        model,
        {
          systemPrompt: TASK_CLASSIFIER_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: prompt,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens: params.config.maxTokens,
          temperature: 0,
          signal: controller.signal,
        },
      );
      const text = result.content
        .filter(isTextContentBlock)
        .map((block) => block.text)
        .join("")
        .trim();
      const parsed = safeParseTaskContract(text);
      emitDebugEvent(params.onDebugEvent, {
        stage: "raw_response",
        backend: params.config.backend,
        configuredModel: params.config.model,
        provider: model.provider,
        modelId: model.id,
        rawText: text,
        normalizedCandidate: parsed.normalizedCandidate,
        parseResult: parsed.parseResult,
        parseErrorMessage: parsed.parseErrorMessage,
      });
      if (parsed.taskContract) {
        return normalizeTaskContract(parsed.taskContract);
      }
      const retryableParseFailure = parsed.parseResult !== "ok";
      if (retryableParseFailure) {
        const retryResult = await completeSimple(
          model,
          {
            systemPrompt: TASK_CLASSIFIER_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: `${prompt}\n\nReminder: return exactly one minified JSON object only.`,
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey,
            maxTokens: params.config.maxTokens,
            temperature: 0,
            signal: controller.signal,
          },
        );
        const retryText = retryResult.content
          .filter(isTextContentBlock)
          .map((block) => block.text)
          .join("")
          .trim();
        const retryParsed = safeParseTaskContract(retryText);
        emitDebugEvent(params.onDebugEvent, {
          stage: "raw_response",
          backend: params.config.backend,
          configuredModel: params.config.model,
          provider: model.provider,
          modelId: model.id,
          rawText: retryText,
          normalizedCandidate: retryParsed.normalizedCandidate,
          parseResult: retryParsed.parseResult,
          parseErrorMessage: retryParsed.parseErrorMessage,
        });
        return retryParsed.taskContract ? normalizeTaskContract(retryParsed.taskContract) : null;
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildFailClosedResolution(params: {
  prompt: string;
  fileNames?: string[];
  reason: string;
  classifierConfig?: ResolvedTaskClassifierConfig;
}): ClassifiedTaskResolution {
  const taskContract = buildFailClosedTaskContract(params.reason);
  const plannerInput = buildPlannerInputFromTaskContract({
    prompt: params.prompt,
    fileNames: params.fileNames,
    taskContract,
    classifierTelemetry: {
      source: "fail_closed",
      ...(params.classifierConfig?.backend ? { backend: params.classifierConfig.backend } : {}),
      ...(params.classifierConfig?.model ? { model: params.classifierConfig.model } : {}),
    },
  });
  return {
    source: "fail_closed",
    taskContract,
    plannerInput,
    resolutionContract: plannerInput.resolutionContract!,
    candidateFamilies: plannerInput.candidateFamilies ?? [],
  };
}

export function resolveTaskClassifierAdapter(
  backend: string,
  registry: Readonly<Record<string, TaskClassifierAdapter>> = {},
): TaskClassifierAdapter | undefined {
  if (registry[backend]) {
    return registry[backend];
  }
  if (backend === DEFAULT_TASK_CLASSIFIER_BACKEND) {
    return new PiTaskClassifierAdapter();
  }
  return undefined;
}

export async function classifyTaskForDecision(params: {
  prompt: string;
  fileNames?: string[];
  ledgerContext?: string;
  clarifyBudgetNotice?: string;
  workspaceContext?: string;
  identityContext?: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  input?: BuildExecutionDecisionInputParams;
  adapterRegistry?: Readonly<Record<string, TaskClassifierAdapter>>;
  onDebugEvent?: (event: TaskClassifierDebugEvent) => void;
}): Promise<ClassifiedTaskResolution> {
  const classifierConfig = resolveTaskClassifierConfig({ cfg: params.cfg });
  if (!classifierConfig.enabled) {
    emitDebugEvent(params.onDebugEvent, {
      stage: "disabled",
      backend: classifierConfig.backend,
      configuredModel: classifierConfig.model,
      message: "classifier disabled; returning fail-closed clarification contract",
    });
    return buildFailClosedResolution({
      prompt: params.prompt,
      fileNames: params.fileNames,
      reason: FAIL_CLOSED_REASON,
      classifierConfig,
    });
  }
  const adapter = resolveTaskClassifierAdapter(classifierConfig.backend, params.adapterRegistry);
  if (!adapter) {
    const error = new Error(`task-classifier: unknown backend "${classifierConfig.backend}"`);
    emitDebugEvent(params.onDebugEvent, {
      stage: "unknown_backend",
      backend: classifierConfig.backend,
      configuredModel: classifierConfig.model,
      message: error.message,
    });
    log.warn(error.message);
    return buildFailClosedResolution({
      prompt: params.prompt,
      fileNames: params.fileNames,
      reason: FAIL_CLOSED_REASON,
      classifierConfig,
    });
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const classified = await adapter.classify({
        prompt: params.prompt,
        fileNames: params.fileNames ?? [],
        ledgerContext: params.ledgerContext,
        clarifyBudgetNotice: params.clarifyBudgetNotice,
        ...(params.workspaceContext ? { workspaceContext: params.workspaceContext } : {}),
        ...(params.identityContext ? { identityContext: params.identityContext } : {}),
        config: classifierConfig,
        cfg: params.cfg,
        agentDir: params.agentDir,
        onDebugEvent: params.onDebugEvent,
      });
      if (classified) {
        const normalizedContract = normalizeTaskContract(classified);
        const preflightAdjustedContract = applyCredentialsPreflight({
          contract: normalizedContract,
        });
        const classifierTelemetry: import("../recipe/planner.js").ClassifierTelemetry = {
          source: "llm",
          backend: classifierConfig.backend,
          model: classifierConfig.model,
          primaryOutcome: preflightAdjustedContract.primaryOutcome,
          interactionMode: preflightAdjustedContract.interactionMode,
          confidence: preflightAdjustedContract.confidence,
          ...(preflightAdjustedContract.deliverable?.kind
            ? { deliverableKind: preflightAdjustedContract.deliverable.kind }
            : {}),
          ...(preflightAdjustedContract.deliverable?.acceptedFormats?.length
            ? { deliverableFormats: [...preflightAdjustedContract.deliverable.acceptedFormats] }
            : {}),
        };
        const plannerInput = buildPlannerInputFromTaskContract({
          prompt: params.prompt,
          fileNames: params.fileNames,
          taskContract: preflightAdjustedContract,
          classifierTelemetry,
        });
        log.info(
          `classified: backend=${classifierConfig.backend} model=${classifierConfig.model} outcome=${preflightAdjustedContract.primaryOutcome} mode=${preflightAdjustedContract.interactionMode} conf=${preflightAdjustedContract.confidence} deliverable=${preflightAdjustedContract.deliverable?.kind ?? "n/a"}/${(preflightAdjustedContract.deliverable?.acceptedFormats ?? []).join(",")} caps=[${preflightAdjustedContract.requiredCapabilities.join(",")}] ambig=[${preflightAdjustedContract.ambiguities.join(" | ")}]`,
        );
        return {
          source: "llm",
          taskContract: preflightAdjustedContract,
          plannerInput,
          resolutionContract: plannerInput.resolutionContract!,
          candidateFamilies: plannerInput.candidateFamilies ?? [],
        };
      }
      emitDebugEvent(params.onDebugEvent, {
        stage: "fallback",
        backend: classifierConfig.backend,
        configuredModel: classifierConfig.model,
        message:
          "classifier returned no valid contract; returning fail-closed clarification contract",
      });
      return buildFailClosedResolution({
        prompt: params.prompt,
        fileNames: params.fileNames,
        reason: FAIL_CLOSED_REASON,
        classifierConfig,
      });
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        emitDebugEvent(params.onDebugEvent, {
          stage: "fallback",
          backend: classifierConfig.backend,
          configuredModel: classifierConfig.model,
          message: `classifier attempt ${attempt} failed; retrying once (${error instanceof Error ? error.message : String(error)})`,
        });
        continue;
      }
    }
  }
  emitDebugEvent(params.onDebugEvent, {
    stage: "fallback",
    backend: classifierConfig.backend,
    configuredModel: classifierConfig.model,
    message: `classifier failed after retry; returning fail-closed clarification contract (${lastError instanceof Error ? lastError.message : String(lastError)})`,
  });
  log.warn(
    `task-classifier: fail-closed after retry (${lastError instanceof Error ? lastError.message : String(lastError)})`,
  );
  return buildFailClosedResolution({
    prompt: params.prompt,
    fileNames: params.fileNames,
    reason: FAIL_CLOSED_REASON,
    classifierConfig,
  });
}
