import { z } from "zod";

/**
 * Universal Deliverable abstraction.
 *
 * A DeliverableSpec declares WHAT the user wants back, independent of WHICH tool
 * will produce it. The ProducerRegistry maps (kind, format) -> tool + capability.
 *
 * This module is the single source of truth for:
 *   1. Classifier -> requestedTools derivation (no more hardcoded "pdf" push).
 *   2. Evidence acceptance — artifact kinds/formats instead of tool names.
 *   3. Bootstrap — which capability backs which format.
 *
 * Never hardcode `pdf` / `docx` / `xlsx` tool names elsewhere in platform code.
 * Add a ProducerEntry here and let callers ask the registry.
 */

export const DeliverableKindSchema = z.enum([
  "answer",
  "image",
  "document",
  "data",
  "site",
  "archive",
  "audio",
  "video",
  "code_change",
  "external_delivery",
  "capability_install",
]);
export type DeliverableKind = z.infer<typeof DeliverableKindSchema>;

export const DeliverableSpecSchema = z
  .object({
    kind: DeliverableKindSchema,
    acceptedFormats: z.array(z.string().min(1)).min(1),
    preferredFormat: z.string().min(1).optional(),
    constraints: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type DeliverableSpec = z.infer<typeof DeliverableSpecSchema>;

export const ProducedArtifactSchema = z
  .object({
    kind: DeliverableKindSchema,
    format: z.string().min(1),
    mimeType: z.string().min(1),
    path: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    bootstrapRequestId: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ProducedArtifact = z.infer<typeof ProducedArtifactSchema>;

export type ProducerEntry = {
  kind: DeliverableKind;
  format: string;
  toolName: string;
  capabilityId?: string;
  mimeType: string;
};

const REGISTRY: ProducerEntry[] = [
  {
    kind: "image",
    format: "png",
    toolName: "image_generate",
    mimeType: "image/png",
  },
  {
    kind: "image",
    format: "jpg",
    toolName: "image_generate",
    mimeType: "image/jpeg",
  },
  {
    kind: "document",
    format: "pdf",
    toolName: "pdf",
    capabilityId: "pdf-renderer",
    mimeType: "application/pdf",
  },
  {
    kind: "document",
    format: "docx",
    toolName: "docx_write",
    capabilityId: "docx-writer",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  {
    kind: "document",
    format: "html",
    toolName: "write",
    mimeType: "text/html",
  },
  {
    kind: "document",
    format: "md",
    toolName: "write",
    mimeType: "text/markdown",
  },
  {
    kind: "data",
    format: "csv",
    toolName: "csv_write",
    mimeType: "text/csv",
  },
  {
    kind: "data",
    format: "xlsx",
    toolName: "xlsx_write",
    capabilityId: "xlsx-writer",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  {
    kind: "data",
    format: "json",
    toolName: "write",
    mimeType: "application/json",
  },
  {
    kind: "site",
    format: "zip",
    toolName: "site_pack",
    capabilityId: "site-packager",
    mimeType: "application/zip",
  },
  {
    kind: "archive",
    format: "zip",
    toolName: "site_pack",
    capabilityId: "site-packager",
    mimeType: "application/zip",
  },
  {
    kind: "capability_install",
    format: "npm-package",
    toolName: "capability_install",
    mimeType: "application/x-capability-install",
  },
  {
    kind: "capability_install",
    format: "pip-package",
    toolName: "capability_install",
    mimeType: "application/x-capability-install",
  },
];

export function listProducerEntries(): readonly ProducerEntry[] {
  return REGISTRY;
}

export function findProducer(
  kind: DeliverableKind,
  format: string,
): ProducerEntry | undefined {
  const normalizedFormat = format.trim().toLowerCase();
  return REGISTRY.find(
    (entry) =>
      entry.kind === kind && entry.format.toLowerCase() === normalizedFormat,
  );
}

export type ResolveProducerResult = {
  primary: ProducerEntry | undefined;
  candidates: ProducerEntry[];
  toolNames: string[];
  capabilityIds: string[];
  mimeTypes: string[];
};

/**
 * Resolve which tool(s) can satisfy a DeliverableSpec.
 *
 * Rules:
 *   - `preferredFormat` wins when it maps to a registered producer.
 *   - Otherwise: walk `acceptedFormats` in order and return the first match as `primary`.
 *   - `candidates` includes every registered producer that matches any accepted format.
 */
export function resolveProducer(
  deliverable: DeliverableSpec | undefined,
): ResolveProducerResult {
  if (!deliverable) {
    return {
      primary: undefined,
      candidates: [],
      toolNames: [],
      capabilityIds: [],
      mimeTypes: [],
    };
  }
  const preferred = deliverable.preferredFormat
    ? findProducer(deliverable.kind, deliverable.preferredFormat)
    : undefined;
  const ordered: ProducerEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: ProducerEntry | undefined) => {
    if (!entry) {
      return;
    }
    const key = `${entry.kind}:${entry.format}:${entry.toolName}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    ordered.push(entry);
  };
  push(preferred);
  for (const format of deliverable.acceptedFormats) {
    push(findProducer(deliverable.kind, format));
  }
  const primary = ordered[0];
  const toolNames = Array.from(new Set(ordered.map((entry) => entry.toolName)));
  const capabilityIds = Array.from(
    new Set(
      ordered
        .map((entry) => entry.capabilityId)
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const mimeTypes = Array.from(new Set(ordered.map((entry) => entry.mimeType)));
  return {
    primary,
    candidates: ordered,
    toolNames,
    capabilityIds,
    mimeTypes,
  };
}

/**
 * Check whether a ProducedArtifact satisfies a DeliverableSpec.
 *
 * Match rules:
 *   - Kind must be equal.
 *   - Format must be in `acceptedFormats` (case-insensitive).
 */
export function artifactSatisfiesDeliverable(
  deliverable: DeliverableSpec,
  artifact: ProducedArtifact,
): boolean {
  if (artifact.kind !== deliverable.kind) {
    return false;
  }
  const accepted = new Set(
    deliverable.acceptedFormats.map((value) => value.trim().toLowerCase()),
  );
  return accepted.has(artifact.format.trim().toLowerCase());
}
