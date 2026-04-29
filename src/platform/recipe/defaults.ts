import { createRecipeRegistry } from "../registry/index.js";
import type { ExecutionRecipe } from "../schemas/recipe.js";

export const INITIAL_RECIPES: ExecutionRecipe[] = [
  {
    id: "general_reasoning",
    purpose: "General-purpose chat and reasoning",
    summary: "Keep the run lightweight and reasoning-first.",
    acceptedInputs: [{ type: "text" }],
    riskLevel: "none",
    systemPrompt:
      "Prefer direct reasoning and lightweight tool use unless the task clearly needs more.",
    timeoutSeconds: 90,
  },
  {
    id: "doc_ingest",
    purpose: "Ingest, parse, and extract structured data from documents",
    summary: "Work document-first: extract structure before broad synthesis.",
    acceptedInputs: [
      { type: "file", required: true, description: "Document to process" },
      { type: "text", description: "Extraction instructions" },
    ],
    producedArtifacts: [{ type: "data", description: "Extracted structured data" }],
    requiredCapabilities: ["pdf-parser"],
    allowedProfiles: ["builder", "general"],
    riskLevel: "low",
    systemPrompt:
      "Work document-first. Extract structure, tables, and fields before writing broad conclusions.",
    timeoutSeconds: 180,
  },
  {
    id: "doc_authoring",
    purpose: "Author and package a new document or PDF deliverable from prompt instructions",
    summary: "Work author-first: create the requested document artifact instead of treating the turn as file ingestion.",
    acceptedInputs: [
      { type: "text", required: true, description: "Document brief, structure, and requested output format" },
      { type: "file", description: "Optional reference assets or source images to include" },
    ],
    producedArtifacts: [
      { type: "document", description: "Generated PDF or document deliverable" },
      { type: "report", description: "Supporting written structure or summary when helpful" },
    ],
    allowedProfiles: ["builder", "general"],
    riskLevel: "low",
    systemPrompt:
      "Work author-first. When the user asks for a new PDF, report, presentation, or slide-style document from prompt text, create the deliverable with the pdf tool instead of treating the task like document parsing. If supporting images are requested, generate or gather them first, then assemble the final PDF in the same turn. Do not stop after image generation, do not ask for style confirmation unless the user explicitly asked for a choice, and do not claim completion until the final document artifact exists.",
    timeoutSeconds: 240,
  },
  {
    id: "ocr_extract",
    purpose: "Extract structured text and fields from scans and image-heavy documents",
    summary: "Use OCR-first flow when the source is a scan, screenshot, or image-dominant page.",
    acceptedInputs: [
      { type: "file", required: true, description: "Scan or image-heavy document to process" },
      { type: "text", description: "OCR extraction instructions" },
    ],
    producedArtifacts: [{ type: "data", description: "OCR extraction output" }],
    requiredCapabilities: ["ocr-engine"],
    allowedProfiles: ["builder", "general"],
    riskLevel: "low",
    systemPrompt:
      "Use OCR-first reasoning. Recover text faithfully, then normalize it into structured fields.",
    timeoutSeconds: 240,
  },
  {
    id: "table_extract",
    purpose: "Extract tables and spreadsheet-like structures into structured rows",
    summary:
      "Use table-first flow when the task is dominated by rows, columns, or tabular exports.",
    acceptedInputs: [
      {
        type: "file",
        required: true,
        description: "Spreadsheet, table image, or table-heavy document",
      },
      { type: "text", description: "Table extraction instructions" },
    ],
    producedArtifacts: [
      { type: "data", description: "Structured table rows" },
      { type: "report", description: "Table extraction summary" },
    ],
    requiredCapabilities: ["table-parser"],
    allowedProfiles: ["builder", "general"],
    riskLevel: "low",
    systemPrompt:
      "Use table-first reasoning. Preserve row and column structure before summarizing totals or trends.",
    timeoutSeconds: 210,
  },
  {
    id: "table_compare",
    purpose: "Compare, diff, and reconcile two or more tabular exports (CSV/Excel) or price sheets",
    summary:
      "Use compare-first flow when the task centers on aligning rows, spotting price or quantity deltas, or reconciling spreadsheets.",
    acceptedInputs: [
      {
        type: "file",
        required: true,
        description: "Two or more spreadsheets or CSV exports to compare",
      },
      { type: "text", required: true, description: "Compare rules, keys, or columns to align on" },
    ],
    producedArtifacts: [
      { type: "data", description: "Aligned or diffed row-level comparison output" },
      { type: "report", description: "Comparison summary and reconciliation notes" },
    ],
    requiredCapabilities: ["table-parser"],
    allowedProfiles: ["builder", "general"],
    riskLevel: "low",
    systemPrompt:
      "Use compare-first reasoning. Normalize schemas, choose stable join keys, surface row-level deltas, and call out ambiguous or missing matches before narrating conclusions.",
    timeoutSeconds: 240,
  },
  {
    id: "calculation_report",
    purpose:
      "Engineering-style calculations, unit conversions, and dimensional summaries with a clear written report",
    summary:
      "Use calculation-first flow for ventilation loads, dimensions, unit math, and other numeric report-style answers without code shipping.",
    acceptedInputs: [
      { type: "text", required: true, description: "Calculation goal, inputs, and required units" },
      { type: "file", description: "Optional reference tables, drawings, or notes" },
    ],
    producedArtifacts: [
      { type: "report", description: "Stepwise calculation and assumptions" },
      { type: "data", description: "Intermediate numeric results when helpful" },
    ],
    allowedProfiles: ["builder", "general"],
    riskLevel: "low",
    systemPrompt:
      "Use calculation-first reasoning. State assumptions, keep unit tracking explicit, show intermediate steps for auditability, and finish with a concise results section.",
    timeoutSeconds: 180,
  },
  {
    id: "code_build_publish",
    purpose: "Build, test, and publish code artifacts",
    summary: "Work repo-first and validate changes before publish when possible.",
    acceptedInputs: [{ type: "text", required: true }],
    producedArtifacts: [
      { type: "report", description: "Build/test execution summary" },
      { type: "site", description: "Preview deployment or preview URL" },
      { type: "binary", description: "Built artifact" },
      { type: "release", description: "Published release" },
    ],
    requiredCapabilities: ["node", "git"],
    allowedProfiles: ["developer", "media_creator"],
    riskLevel: "high",
    publishTargets: ["github", "npm", "docker", "vercel", "netlify"],
    systemPrompt:
      "Work repository-first. Prefer reading code, validating with targeted checks, and only then publishing.",
    timeoutSeconds: 420,
  },
  {
    id: "integration_delivery",
    purpose: "Wire integrations, webhooks, and connected rollout workflows",
    summary:
      "Work integration-first: validate contracts, endpoints, and rollout handoffs before release.",
    acceptedInputs: [{ type: "text", required: true }],
    producedArtifacts: [
      { type: "report", description: "Integration rollout summary" },
      { type: "site", description: "Connected preview or delivery endpoint" },
      { type: "release", description: "Integration release handoff" },
    ],
    requiredCapabilities: ["node", "git"],
    allowedProfiles: ["integrator", "developer"],
    riskLevel: "high",
    publishTargets: ["github", "docker", "vercel", "netlify", "webhook"],
    systemPrompt:
      "Work integration-first. Validate API contracts, environment assumptions, and rollout handoffs before activation.",
    timeoutSeconds: 360,
  },
  {
    id: "ops_orchestration",
    purpose: "Operate infrastructure, guarded machine control, and capability lifecycle tasks",
    summary: "Work approval-first: inspect runtime state, then sequence guarded operational steps.",
    acceptedInputs: [{ type: "text", required: true }],
    producedArtifacts: [
      { type: "report", description: "Operational runbook and execution summary" },
    ],
    // Bug C: integrator profile тоже допустим как кандидат — профайл-резолвер
    // выбирает integrator по умолчанию для любого external_operation, что
    // структурно исключало ops_orchestration из пула до scoring'а. Сам
    // scoring (см. planner.ts buildRecipeScore) теперь решает tie-break.
    allowedProfiles: ["operator", "integrator"],
    riskLevel: "high",
    systemPrompt:
      "Work operations-first. Prefer inspection, explain planned impact, and keep approvals explicit for machine, bootstrap, or session-orchestration actions. For persistent worker requests, use sessions_spawn with continuation=\"followup\".",
    timeoutSeconds: 360,
  },
  {
    id: "media_production",
    purpose: "Create, refine, and package multimodal media outputs",
    summary:
      "Work media-first: structure assets, prompts, and deliverables before final packaging.",
    acceptedInputs: [{ type: "text", required: true }],
    producedArtifacts: [
      { type: "image", description: "Generated or edited image asset" },
      { type: "video", description: "Generated or edited video asset" },
      { type: "audio", description: "Generated or edited audio asset" },
      { type: "report", description: "Media production summary" },
    ],
    allowedProfiles: ["media_creator"],
    riskLevel: "medium",
    publishTargets: ["site"],
    systemPrompt:
      "Work media-first. Preserve creative intent, asset structure, and delivery format before broad packaging.",
    timeoutSeconds: 240,
  },
];

export const initialRecipeRegistry = createRecipeRegistry(INITIAL_RECIPES);

export function getInitialRecipe(id: string): ExecutionRecipe | undefined {
  return initialRecipeRegistry.get(id);
}
