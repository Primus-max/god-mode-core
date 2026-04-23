import type { DeliverableKind } from "../produce/registry.js";

/**
 * Declarative single source of truth for the TaskClassifier capability vocabulary.
 *
 * Why this module exists
 * ----------------------
 * Before this catalog the eleven `needs_*` capability ids were spelled out in
 * five different places (the JSON schema for the LLM, the Zod parser, the
 * `Capability` TS union, the system-prompt decision ladder, and the normalizer).
 * Adding or renaming one required editing all five and every divergence between
 * them was a footgun — the LLM would happily emit a capability that the parser
 * accepted but the normalizer never reasoned about.
 *
 * The catalog inverts that: every capability is described once here, and the
 * downstream artifacts (JSON schema enum, Zod enum, prompt section, normalizer
 * rules, planner-bridge tool list) are projected from this list.
 *
 * Design rule the user emphasized: capabilities are **abstract intent**.
 * They MUST NOT name a specific tool, vendor, provider, framework, or product.
 * "needs_visual_composition" describes the user's intent ("a visual composition
 * is the primary artifact"); it does not say "image_generate". The mapping from
 * intent to concrete tools lives in `tool-registry.ts`.
 */

export const TASK_CAPABILITY_IDS = [
  "needs_visual_composition",
  "needs_multimodal_authoring",
  "needs_repo_execution",
  "needs_document_extraction",
  "needs_local_runtime",
  "needs_interactive_browser",
  "needs_high_reliability_provider",
  "needs_workspace_mutation",
  "needs_external_delivery",
  "needs_tabular_reasoning",
  "needs_web_research",
] as const;

export type TaskCapabilityId = (typeof TASK_CAPABILITY_IDS)[number];

/**
 * Normalizer hooks each capability can declare. Kept declarative so the
 * normalizer can iterate the catalog instead of hard-coding 11 if-branches.
 *
 * - `requiresDeliverableKinds`: capability is dropped when a deliverable is
 *   present AND its kind is not in this set. Capabilities are left untouched
 *   when no deliverable has been resolved yet — the legacy inference fallback
 *   uses capabilities to derive a deliverable kind, so we must not strip them
 *   before that step runs.
 * - `requiresOutcomes`: capability is dropped when the dominant outcome is not
 *   in this set. Used for delivery-only flags (`needs_external_delivery`,
 *   `needs_high_reliability_provider`) so they cannot leak into a workspace
 *   change or a document package.
 * - `forbiddenWithCapabilities`: ids that are removed when this capability is
 *   present. Used today for "extraction wins over tabular/multimodal/visual".
 */
export type TaskCapabilityNormalizer = {
  readonly requiresDeliverableKinds?: readonly DeliverableKind[];
  readonly requiresOutcomes?: readonly string[];
  readonly forbiddenWithCapabilities?: readonly TaskCapabilityId[];
};

export type TaskCapabilityEntry = {
  readonly id: TaskCapabilityId;
  /** Short abstract intent (one line, no tool/vendor names). */
  readonly intent: string;
  /** One bullet for the system-prompt decision ladder. */
  readonly promptBullet: string;
  readonly normalizer?: TaskCapabilityNormalizer;
};

/**
 * The canonical catalog. Order is preserved when projected into JSON schema /
 * Zod enums / prompt section, so eyeballing diffs against the prompt stays
 * straightforward.
 */
export const TASK_CAPABILITY_CATALOG: readonly TaskCapabilityEntry[] = [
  {
    id: "needs_workspace_mutation",
    intent: "the turn must edit files in the user's workspace",
    promptBullet:
      "needs_workspace_mutation: only for editing repo/workspace contents.",
  },
  {
    id: "needs_repo_execution",
    intent: "the turn must run checks, tests, builds, scripts, or validation",
    promptBullet:
      "needs_repo_execution: run checks, tests, builds, scripts, or validation.",
  },
  {
    id: "needs_local_runtime",
    intent: "the user expects a local process/runtime to be active",
    promptBullet:
      "needs_local_runtime: local runtime/process is explicitly requested or obviously required by the wording.",
  },
  {
    id: "needs_document_extraction",
    intent: "the turn must extract structured fields from supplied documents",
    promptBullet:
      "needs_document_extraction: extract from supplied docs/images/PDFs.",
    // Note: extraction's "wins over authoring/visual/tabular" rule is
    // outcome-conditional (only when primaryOutcome === "document_extraction"),
    // not capability-conditional, so it stays in the imperative normalizer.
    // Putting it here would break `comparison_report` turns that legitimately
    // combine extraction with tabular reasoning over the extracted rows.
  },
  {
    id: "needs_interactive_browser",
    intent: "the turn must observe or interact with a live web page",
    promptBullet:
      "needs_interactive_browser: inspect/click/smoke-test/compare live pages in browser.",
  },
  {
    id: "needs_web_research",
    intent: "the turn must look up fresh public facts on the web",
    promptBullet:
      "needs_web_research: latest public facts/pricing/news/web lookup.",
  },
  {
    id: "needs_tabular_reasoning",
    intent: "the turn's reasoning is dominated by structured tables or numbers",
    promptBullet:
      "needs_tabular_reasoning: structured table/spreadsheet comparison or numeric reasoning is central.",
  },
  {
    id: "needs_visual_composition",
    intent: "the primary artifact is a visual composition (image, poster, banner, illustration)",
    promptBullet:
      'needs_visual_composition: ONLY when deliverable.kind="image" and the visual itself is the artifact. NEVER add it for documents/PDF/decks/sites/data — those are authored documents that may contain visuals; use needs_multimodal_authoring instead.',
    normalizer: {
      requiresDeliverableKinds: ["image"],
    },
  },
  {
    id: "needs_multimodal_authoring",
    intent:
      "the turn must author a structured document by composing mixed materials (text, layout, optional visuals)",
    promptBullet:
      "needs_multimodal_authoring: authored document/deck/PDF/infographic from mixed materials, notes, tables, or images.",
  },
  {
    id: "needs_external_delivery",
    intent: "the turn must hand off the result to an external system or environment",
    promptBullet: "needs_external_delivery: explicit deploy/publish/send external.",
    normalizer: {
      requiresOutcomes: ["external_delivery"],
    },
  },
  {
    id: "needs_high_reliability_provider",
    intent: "the external delivery target must be production-grade",
    promptBullet:
      "needs_high_reliability_provider: only for production/live external delivery.",
    normalizer: {
      requiresOutcomes: ["external_delivery"],
    },
  },
];

const CATALOG_BY_ID: ReadonlyMap<TaskCapabilityId, TaskCapabilityEntry> =
  new Map(TASK_CAPABILITY_CATALOG.map((entry) => [entry.id, entry]));

export function listTaskCapabilityIds(): readonly TaskCapabilityId[] {
  return TASK_CAPABILITY_IDS;
}

export function getTaskCapability(id: TaskCapabilityId): TaskCapabilityEntry | undefined {
  return CATALOG_BY_ID.get(id);
}

/**
 * Build the bullet list inserted into the classifier system prompt. Keeps the
 * prompt aligned with the runtime — no risk of a capability being silently
 * dropped from the prompt while staying in the parser enum.
 */
export function buildCapabilityPromptSection(): string {
  return TASK_CAPABILITY_CATALOG.map((entry) => `   - ${entry.promptBullet}`).join("\n");
}

/**
 * Apply the catalog-declared normalizer rules to a capability set. Returns the
 * filtered set; callers chain it into the broader normalizer.
 *
 * Order of operations:
 *   1. Drop capabilities whose `requiresOutcomes` does not include the
 *      dominant outcome.
 *   2. Drop capabilities whose `requiresDeliverableKinds` does not include the
 *      resolved deliverable kind (skipped when no deliverable is present yet,
 *      since the legacy fallback inference still depends on capabilities).
 *   3. Drop capabilities listed in any still-present capability's
 *      `forbiddenWithCapabilities`.
 */
export function applyCatalogNormalizer(params: {
  capabilities: ReadonlySet<TaskCapabilityId>;
  primaryOutcome: string;
  deliverableKind: DeliverableKind | undefined;
}): Set<TaskCapabilityId> {
  const next = new Set(params.capabilities);
  for (const entry of TASK_CAPABILITY_CATALOG) {
    if (!next.has(entry.id)) {
      continue;
    }
    const rule = entry.normalizer;
    if (!rule) {
      continue;
    }
    if (
      rule.requiresOutcomes &&
      !rule.requiresOutcomes.includes(params.primaryOutcome)
    ) {
      next.delete(entry.id);
      continue;
    }
    if (rule.requiresDeliverableKinds && params.deliverableKind !== undefined) {
      if (!rule.requiresDeliverableKinds.includes(params.deliverableKind)) {
        next.delete(entry.id);
      }
    }
  }
  for (const entry of TASK_CAPABILITY_CATALOG) {
    if (!next.has(entry.id)) {
      continue;
    }
    const forbids = entry.normalizer?.forbiddenWithCapabilities;
    if (!forbids) {
      continue;
    }
    for (const forbiddenId of forbids) {
      next.delete(forbiddenId);
    }
  }
  return next;
}
