import { TRUSTED_CAPABILITY_CATALOG } from "../bootstrap/defaults.js";
import { listProducerEntries } from "../produce/registry.js";

export const IDENTITY_FACTS_TTL_MS_DEFAULT = 30 * 60 * 1000;
export const IDENTITY_PROJECTION_DEFAULT_MAX_TOKENS = 50;
export const IDENTITY_PROJECTION_DEFAULT_MAX_TOOLS = 8;

export type IdentityFacts = {
  persona?: string;
  availableTools: string[];
  availableCapabilities: string[];
  capturedAt: number;
  ttlMs: number;
};

export type ToolRegistry = {
  listToolNames: () => string[];
};

export type CapabilityRegistry = {
  listCapabilityIds: () => string[];
};

export type BuildIdentityFactsOptions = {
  personaResolver?: () => string | undefined;
  toolRegistry: ToolRegistry;
  capabilityRegistry: CapabilityRegistry;
  now?: () => number;
  ttlMs?: number;
};

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function toStableUnique(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

export function createProducerToolRegistry(): ToolRegistry {
  return {
    listToolNames: () => toStableUnique(listProducerEntries().map((entry) => entry.toolName)),
  };
}

export function createTrustedCapabilityRegistry(): CapabilityRegistry {
  return {
    listCapabilityIds: () =>
      toStableUnique(TRUSTED_CAPABILITY_CATALOG.map((entry) => entry.capability.id)),
  };
}

export function buildIdentityFacts(options: BuildIdentityFactsOptions): IdentityFacts {
  const now = options.now ?? (() => Date.now());
  const ttlMs =
    options.ttlMs ??
    resolvePositiveInt(process.env.OPENCLAW_IDENTITY_TTL_MS, IDENTITY_FACTS_TTL_MS_DEFAULT);
  const persona = options.personaResolver?.()?.trim() || undefined;
  return {
    ...(persona ? { persona } : {}),
    availableTools: toStableUnique(options.toolRegistry.listToolNames()),
    availableCapabilities: toStableUnique(options.capabilityRegistry.listCapabilityIds()),
    capturedAt: now(),
    ttlMs,
  };
}

export type ProjectIdentityForPromptOptions = {
  maxTokens?: number;
  maxTools?: number;
};

function countApproxTokens(text: string): number {
  return text.split(/[\s,]+/).filter(Boolean).length;
}

function buildIdentityProjection(facts: IdentityFacts, tools: string[]): string {
  const lines: string[] = [];
  if (facts.persona) {
    lines.push(`persona: ${facts.persona}`);
  }
  const toolList = tools.length > 0 ? tools.join(", ") : "<none>";
  lines.push(`available_tools: ${toolList}`);
  return lines.join("\n");
}

/**
 * Renders identity facts as a compact prompt block. Returns "" when there is nothing useful
 * to say (no persona AND no tools) so the caller can skip emitting `<identity></identity>`.
 * Tools are truncated to fit the budget; persona is always preserved.
 */
export function projectIdentityForPrompt(
  facts: IdentityFacts | undefined,
  options: ProjectIdentityForPromptOptions = {},
): string {
  if (!facts) {
    return "";
  }
  const hasPersona = Boolean(facts.persona);
  if (!hasPersona && facts.availableTools.length === 0) {
    return "";
  }
  const maxTokens = options.maxTokens ?? IDENTITY_PROJECTION_DEFAULT_MAX_TOKENS;
  const maxTools = Math.max(0, options.maxTools ?? IDENTITY_PROJECTION_DEFAULT_MAX_TOOLS);
  const initialTools = facts.availableTools.slice(0, maxTools);
  let tools = initialTools.slice();
  let projection = buildIdentityProjection(facts, tools);
  while (countApproxTokens(projection) > maxTokens && tools.length > 0) {
    tools = tools.slice(0, -1);
    projection = buildIdentityProjection(facts, tools);
  }
  return projection;
}
