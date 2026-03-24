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
    id: "code_build_publish",
    purpose: "Build, test, and publish code artifacts",
    summary: "Work repo-first and validate changes before publish when possible.",
    acceptedInputs: [{ type: "text", required: true }],
    producedArtifacts: [
      { type: "binary", description: "Built artifact" },
      { type: "release", description: "Published release" },
    ],
    requiredCapabilities: ["node", "git"],
    allowedProfiles: ["developer"],
    riskLevel: "high",
    publishTargets: ["github", "npm", "docker", "vercel", "netlify"],
    systemPrompt:
      "Work repository-first. Prefer reading code, validating with targeted checks, and only then publishing.",
    timeoutSeconds: 420,
  },
];

export const initialRecipeRegistry = createRecipeRegistry(INITIAL_RECIPES);

export function getInitialRecipe(id: string): ExecutionRecipe | undefined {
  return initialRecipeRegistry.get(id);
}
