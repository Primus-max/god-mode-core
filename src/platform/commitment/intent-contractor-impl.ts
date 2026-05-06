import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import { z } from "zod";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { parseModelRef } from "../../agents/model-selection.js";
import { resolveModelAsync } from "../../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../../agents/simple-completion-transport.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { IdentityId } from "../identity/identity-id.js";
import type { MemoryStore, SemanticMemoryEntry } from "../memory/index.js";
import { buildActiveTasksBlock } from "../task/active-tasks-block.js";
import type { TaskLedger } from "../task/task-ledger.js";
import type { TaskListQuery } from "../task/task-record.js";
import {
  EFFECT_FAMILY_REGISTRY,
  getEffectFamilyDefinition,
  resolveEffectFamilyId,
  UNKNOWN_EFFECT_FAMILY,
} from "./effect-family-registry.js";
import type { EffectFamilyId } from "./ids.js";
import type { IntentContractor } from "./intent-contractor.js";
import { makeRawUserTurn, type RawUserTurn } from "./raw-user-turn.js";
import type { OperationHint, SemanticIntent, TargetRef } from "./semantic-intent.js";

export const DEFAULT_INTENT_CONTRACTOR_BACKEND = "pi-simple";
export const DEFAULT_INTENT_CONTRACTOR_MODEL = "hydra/gpt-5-mini";
export const DEFAULT_INTENT_CONTRACTOR_TIMEOUT_MS = 15_000;
export const DEFAULT_INTENT_CONTRACTOR_MAX_TOKENS = 400;
export const DEFAULT_INTENT_CONTRACTOR_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Default top-K for the slice-E Phase-6 `<memory>` recall hook. Five
 * entries is the sub-plan §0/§5 default; mirrors the `<web_evidence>`
 * pattern at `src/platform/decision/web-evidence-prefetch.ts`.
 */
export const DEFAULT_INTENT_CONTRACTOR_MEMORY_RECALL_LIMIT = 5;

/**
 * Uncertainty tag appended to a returned `SemanticIntent` when the
 * memory-recall call rejects (e.g. sqlite locked, embedder timeout).
 * Per invariant #15 the recall failure must NEVER throw into the
 * contractor flow — it degrades to "no `<memory>` block + warning log
 * + this tag on the returned intent" (sub-plan §5 Phase 6).
 */
export const MEMORY_RECALL_FAILED_UNCERTAINTY = "memory_recall_failed";

/**
 * Slice F Phase 6 sibling of `MEMORY_RECALL_FAILED_UNCERTAINTY`.
 * Appended to a returned `SemanticIntent` when `taskLedger.list`
 * rejects (e.g. sqlite locked, ledger backend down). Per invariant
 * #15 the recall failure must NEVER throw into the contractor flow —
 * it degrades to "no `<active_tasks>` block + warning log + this tag
 * on the returned intent" (sub-plan §6 + slice E precedent).
 */
export const TASK_RECALL_FAILED_UNCERTAINTY = "task_recall_failed";

/**
 * Cutover-3 Phase 6 — closed-shape attachment kind enumeration. The
 * resolver-supplied attachment surface stays narrow; widening this
 * union requires explicit master-plan amendment so the contractor
 * never grows a textual classification surface (invariant #5).
 */
export type InboundMediaAttachmentKind = "image" | "pdf" | "docx" | "other";

/**
 * Cutover-3 Phase 6 — single inbound attachment descriptor surfaced to
 * the IntentContractor through the optional `inboundMediaResolver`
 * seam. STRUCTURAL metadata only (path + MIME type + closed `kind`
 * enumeration). Per invariants #5/#6 the resolver MUST NOT route raw
 * user text through this surface — the contractor stays the ONLY
 * sanctioned reader of `RawUserTurn` text.
 *
 * `sourceTurnId` is optional and propagates the upstream turn id when
 * the producer (gateway / agent-command) tracks it; predicates and
 * downstream observers can JOIN on this id without re-reading the
 * raw text.
 */
export type InboundMediaAttachment = {
  readonly path: string;
  readonly mimeType: string;
  readonly kind: InboundMediaAttachmentKind;
  readonly sourceTurnId?: string;
};

/**
 * Cutover-3 Phase 6 — closed-shape summary of inbound media for the
 * current turn. Returned by the optional `inboundMediaResolver`
 * supplied to `createIntentContractor(...)`. When the resolver is
 * absent OR returns `undefined` OR returns an empty `attachments`
 * array, the `<inbound_attachments>` block is elided (zero whitespace
 * pollution). Mirrors the `<memory>` recall pattern from slice E P6.
 */
export type InboundMediaSummary = {
  readonly attachments: readonly InboundMediaAttachment[];
};

/**
 * Active-task statuses surfaced to the contractor recall (sub-plan §6).
 * Terminal states (`completed`, `cancelled`, `failed`) are not part of
 * the in-flight set, so the ledger query narrows on these two values.
 * The formatter (`buildActiveTasksBlock`) ALSO filters defensively so
 * that a backend that ignores the status filter still produces a
 * well-shaped block.
 */
const ACTIVE_TASK_RECALL_STATUSES: TaskListQuery["statuses"] = ["open", "in_progress"];

/**
 * Minimal logger seam used by the IntentContractor for memory-recall
 * observability. The production `run-turn-decision.ts` call site logs
 * via `console.warn` / structured loggers; tests inject a `vi.fn()`
 * spy. Kept structural (no class) so callers don't need a wrapper.
 */
export type IntentContractorLogger = {
  warn(message: string, payload?: Record<string, unknown>): void;
};

export type ResolvedIntentContractorConfig = {
  readonly enabled: boolean;
  readonly backend: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly confidenceThreshold: number;
};

export type IntentContractorDebugEvent = {
  readonly stage:
    | "disabled"
    | "unknown_backend"
    | "model_unresolved"
    | "raw_response"
    | "fallback";
  readonly backend: string;
  readonly configuredModel: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly rawText?: string;
  readonly normalizedCandidate?: string;
  readonly parseResult?: "ok" | "empty" | "json_parse_failed" | "schema_invalid";
  readonly parseErrorMessage?: string;
  readonly message?: string;
};

export type IntentContractorAdapter = {
  /**
   * Classifies raw user input into a semantic intent.
   *
   * @param params - Adapter input and resolved runtime configuration.
   * @returns Semantic intent produced by the adapter.
   */
  classify(params: {
    readonly prompt: string;
    readonly fileNames: readonly string[];
    readonly ledgerContext?: string;
    readonly config: ResolvedIntentContractorConfig;
    readonly cfg: OpenClawConfig;
    readonly agentDir?: string;
    readonly onDebugEvent?: (event: IntentContractorDebugEvent) => void;
  }): Promise<SemanticIntent>;
};

export type IntentContractorAdapterRegistry = Readonly<Record<string, IntentContractorAdapter>>;

const TargetRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), sessionId: z.string().optional() }).strict(),
  z.object({ kind: z.literal("artifact"), artifactId: z.string().optional() }).strict(),
  z.object({ kind: z.literal("workspace") }).strict(),
  z.object({ kind: z.literal("external_channel"), channelId: z.string().optional() }).strict(),
  z.object({ kind: z.literal("unspecified") }).strict(),
]);

const OperationHintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create") }).strict(),
  z.object({ kind: z.literal("update"), updateOf: TargetRefSchema.optional() }).strict(),
  z.object({ kind: z.literal("cancel"), cancelOf: TargetRefSchema.optional() }).strict(),
  z.object({ kind: z.literal("observe") }).strict(),
  z.object({ kind: z.literal("custom"), verb: z.string().min(1) }).strict(),
]);

const SemanticIntentResponseSchema = z
  .object({
    desiredEffectFamily: z.string().min(1),
    target: TargetRefSchema,
    operation: OperationHintSchema.optional(),
    constraints: z.record(z.string(), z.unknown()).default({}),
    uncertainty: z.array(z.string().min(1)).default([]),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const INTENT_CONTRACTOR_SYSTEM_PROMPT =
  "Classify the user's turn into a tool-free semantic intent. Return exactly one JSON object matching the provided schema.";

/**
 * Resolves IntentContractor config from agent defaults.
 *
 * @param params - OpenClaw runtime config.
 * @returns IntentContractor config with PR-2 defaults applied.
 */
export function resolveIntentContractorConfig(params: {
  readonly cfg: OpenClawConfig;
}): ResolvedIntentContractorConfig {
  const config = params.cfg.agents?.defaults?.embeddedPi?.intentContractor;
  return {
    enabled: config?.enabled !== false,
    backend: config?.backend?.trim() || DEFAULT_INTENT_CONTRACTOR_BACKEND,
    model: config?.model?.trim() || DEFAULT_INTENT_CONTRACTOR_MODEL,
    timeoutMs: config?.timeoutMs ?? DEFAULT_INTENT_CONTRACTOR_TIMEOUT_MS,
    maxTokens: config?.maxTokens ?? DEFAULT_INTENT_CONTRACTOR_MAX_TOKENS,
    confidenceThreshold:
      config?.confidenceThreshold ?? DEFAULT_INTENT_CONTRACTOR_CONFIDENCE_THRESHOLD,
  };
}

/**
 * Resolves the adapter for an IntentContractor backend.
 *
 * @param backend - Backend adapter id.
 * @param registry - Optional adapter overrides used by tests and eval.
 * @returns Matching adapter, if registered.
 */
export function resolveIntentContractorAdapter(
  backend: string,
  registry: IntentContractorAdapterRegistry = {},
): IntentContractorAdapter | undefined {
  if (registry[backend]) {
    return registry[backend];
  }
  if (backend === DEFAULT_INTENT_CONTRACTOR_BACKEND) {
    return new PiIntentContractorAdapter();
  }
  return undefined;
}

/**
 * Creates the real PR-2 IntentContractor wrapper.
 *
 * Slice-E Phase-6 additive: when both `memoryStore` and `identityId`
 * are provided, `classify` performs a top-K memory recall keyed on the
 * identity and the raw prompt before calling the adapter; non-empty
 * results are formatted into a `<memory>{JSON}</memory>` block and
 * prepended to the prompt the adapter sees (mirrors the
 * `<web_evidence>` pattern from
 * `src/platform/decision/web-evidence-prefetch.ts`). Recall failures
 * are observability-only — they NEVER throw into the contractor flow
 * (invariant #15) and are surfaced via `logger.warn` plus a
 * `memory_recall_failed` tag on the returned intent's uncertainty.
 *
 * Slice-F Phase-6 additive: when both `taskLedger` and `identityId`
 * are provided, `classify` ALSO performs a per-`IdentityId` active-
 * tasks list keyed on the identity (status filter narrows to
 * `open` + `in_progress` — terminal states are dropped) before calling
 * the adapter; non-empty results are formatted into an
 * `<active_tasks>{JSON}</active_tasks>` block. Block ordering when both
 * recall paths fire: `<active_tasks><memory>{prompt}` — the
 * `<active_tasks>` block precedes `<memory>` so the LLM sees the
 * "what's still in flight" surface before the "what was previously
 * said" surface. Recall failure mirrors the memory path: warn log +
 * `task_recall_failed` uncertainty tag + NEVER throws (invariant #15).
 *
 * @param deps - Runtime config, optional adapter registry, and the
 *   slice-E Phase-6 optional `memoryStore` / `identityId` / `logger`
 *   recall seam (all three default to undefined for byte-identical
 *   regression behaviour with pre-Phase-6 callers). Slice-F Phase-6
 *   adds the optional `taskLedger` seam alongside `memoryStore`.
 * @returns IntentContractor that never throws for classification failures.
 */
export function createIntentContractor(deps: {
  readonly cfg: OpenClawConfig;
  readonly fileNames?: readonly string[];
  readonly ledgerContext?: string;
  readonly agentDir?: string;
  readonly adapterRegistry?: IntentContractorAdapterRegistry;
  readonly onDebugEvent?: (event: IntentContractorDebugEvent) => void;
  /**
   * Slice-E Phase-6 additive: optional memory store used to recall
   * top-K semantic memories keyed on `identityId` and the raw prompt.
   * Omitting this seam (or omitting `identityId`) disables the recall
   * hook entirely — behaviour is byte-identical to pre-Phase-6.
   */
  readonly memoryStore?: MemoryStore;
  /**
   * Slice-F Phase-6 additive: optional task ledger used to list
   * active tasks (status `open` / `in_progress`) keyed on
   * `identityId`. Omitting this seam (or omitting `identityId`)
   * disables the `<active_tasks>` recall path entirely — behaviour is
   * byte-identical to slice-E Phase-6 callers. The ledger NEVER
   * receives raw user text on the query path (invariant #5/#6 — the
   * recall query carries `ownerIdentityId` + structured `statuses`
   * filter only).
   */
  readonly taskLedger?: TaskLedger;
  /**
   * Slice-E Phase-6 additive: resolved operator identity for the
   * current turn. When undefined, the recall hook is a no-op (per
   * sub-plan §5 — anonymous sessions do NOT leak memory across
   * operators). Resolved upstream via
   * `src/platform/identity/resolve-identity.ts`. Slice-F Phase-6
   * shares the same field — both recall paths gate on `identityId`.
   */
  readonly identityId?: IdentityId;
  /**
   * Slice-E Phase-6 additive: structural logger used to surface
   * `memory_recall_failed` warnings without coupling to a specific
   * production logger (invariant #15 — recall failure is observability,
   * not a hard fault).
   */
  readonly logger?: IntentContractorLogger;
  /**
   * Slice-E Phase-6 additive: override the default top-K cap for
   * memory recall. Defaults to
   * `DEFAULT_INTENT_CONTRACTOR_MEMORY_RECALL_LIMIT` (5) per sub-plan
   * §0/§5.
   */
  readonly memoryRecallLimit?: number;
  /**
   * Cutover-3 Phase 6 additive: optional resolver that surfaces the
   * structural inbound-media metadata for the current turn. When
   * provided AND the resolver returns a non-empty `attachments`
   * array, `classify` injects an `<inbound_attachments>` block
   * (XML-like, mirrors `<memory>` / `<active_tasks>` precedents) AFTER
   * the `<memory>` block and BEFORE the raw user prompt. Omitting the
   * dep (or returning `undefined` / empty) disables the injection
   * cleanly — behaviour is byte-identical to pre-Phase-6 callers
   * (frozen-layer ADDITIVE constraint, cutover-2 PR-#104 / slice E P6
   * / slice F P6 precedent). Per invariants #5/#6 the resolver MUST
   * route STRUCTURED metadata only (path + MIME type + closed `kind`
   * enumeration), never raw user text.
   */
  readonly inboundMediaResolver?: () => InboundMediaSummary | undefined;
}): IntentContractor {
  return {
    async classify(prompt: string): Promise<SemanticIntent> {
      const config = resolveIntentContractorConfig({ cfg: deps.cfg });
      if (!config.enabled) {
        emitDebugEvent(deps.onDebugEvent, {
          stage: "disabled",
          backend: config.backend,
          configuredModel: config.model,
          message: "intent contractor disabled",
        });
        return lowConfidenceIntent("disabled");
      }
      const adapter = resolveIntentContractorAdapter(config.backend, deps.adapterRegistry);
      if (!adapter) {
        emitDebugEvent(deps.onDebugEvent, {
          stage: "unknown_backend",
          backend: config.backend,
          configuredModel: config.model,
          message: `unknown intent contractor backend "${config.backend}"`,
        });
        return lowConfidenceIntent("unknown_backend");
      }

      // Slice-E Phase-6: top-K memory recall before adapter dispatch.
      // The recall query uses raw user text — this is exactly what
      // invariant #6 sanctions at this site (the contractor is the
      // only sanctioned reader of `RawUserTurn` / `UserPrompt`).
      // Recall failure NEVER throws into the contractor flow per
      // invariant #15 — it degrades to no block + warn + uncertainty tag.
      const memoryRecall = await maybeRecallMemory({
        memoryStore: deps.memoryStore,
        identityId: deps.identityId,
        prompt,
        limit: deps.memoryRecallLimit ?? DEFAULT_INTENT_CONTRACTOR_MEMORY_RECALL_LIMIT,
        logger: deps.logger,
      });
      // Slice-F Phase-6: parallel active-tasks recall. The query carries
      // ONLY `ownerIdentityId` + structured `statuses` filter — no raw
      // user text on the ledger path (invariant #5/#6: text routing
      // stays inside the contractor, not the ledger seam).
      const taskRecall = await maybeRecallActiveTasks({
        taskLedger: deps.taskLedger,
        identityId: deps.identityId,
        logger: deps.logger,
      });
      // Cutover-3 Phase 6: structural inbound-media block. Surfaced AFTER
      // the `<memory>` block and BEFORE the raw user prompt so the
      // classifier can pre-bind `desiredEffectFamily=artifact` /
      // `referenceMode=img2img` when an inbound image is present
      // (invariant #2 — structural precondition, not phrase matching).
      // Resolver throws are absorbed (invariant #15) — observability,
      // not gating.
      const inboundMediaBlock = buildInboundAttachmentsBlock({
        resolver: deps.inboundMediaResolver,
        logger: deps.logger,
      });
      // Block order: <active_tasks> precedes <memory> precedes
      // <inbound_attachments> precedes the raw prompt. The contractor
      // surfaces "what's still in flight" → "what was previously said" →
      // "what files arrived this turn" → "the user's text". All blocks
      // self-elide when their recall returns nothing (zero whitespace
      // pollution).
      const blockPrefix = `${taskRecall.block ?? ""}${memoryRecall.block ?? ""}${inboundMediaBlock ?? ""}`;
      const promptForAdapter = blockPrefix.length > 0 ? `${blockPrefix}${prompt}` : prompt;

      try {
        const raw = await adapter.classify({
          prompt: promptForAdapter,
          fileNames: deps.fileNames ?? [],
          ...(deps.ledgerContext ? { ledgerContext: deps.ledgerContext } : {}),
          config,
          cfg: deps.cfg,
          ...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
          onDebugEvent: deps.onDebugEvent,
        });
        const normalized = normalizeSemanticIntent(raw);
        if (normalized.confidence < raw.confidence) {
          const introduced = normalized.uncertainty.find(
            (reason) =>
              reason === "family_not_in_registry" || reason === "operation_not_allowed_for_family",
          );
          emitDebugEvent(deps.onDebugEvent, {
            stage: "fallback",
            backend: config.backend,
            configuredModel: config.model,
            message: `normalize_forced_low_confidence reason=${introduced ?? "unknown"} rawConfidence=${raw.confidence.toFixed(2)} rawFamily=${String(raw.desiredEffectFamily)}`,
          });
        }
        const withMemoryTag = appendRecallFailureTag(normalized, memoryRecall.failed);
        return appendTaskRecallFailureTag(withMemoryTag, taskRecall.failed);
      } catch (error) {
        const reason = isAbortError(error) ? "llm_timeout" : "llm_error";
        emitDebugEvent(deps.onDebugEvent, {
          stage: "fallback",
          backend: config.backend,
          configuredModel: config.model,
          message: error instanceof Error ? error.message : String(error),
        });
        const fallback = appendRecallFailureTag(lowConfidenceIntent(reason), memoryRecall.failed);
        return appendTaskRecallFailureTag(fallback, taskRecall.failed);
      }
    },
  };
}

type MemoryRecallOutcome = {
  readonly block: string | null;
  readonly failed: boolean;
};

/**
 * Slice-E Phase-6 helper. Performs the optional memory recall and
 * returns either a `<memory>{JSON}</memory>` block (non-empty result)
 * or `null` (no store, no identity, empty result, or recall failure).
 * Recall errors are caught and surfaced via the injected logger plus
 * the `failed` flag — they do NOT throw into the contractor.
 *
 * Block shape mirrors `<web_evidence>` (closed-shape JSON, never raw
 * user text — invariant #5 safe):
 *   `<memory>{"entries":[{ id, content, score, metadata }, ...]}</memory>`
 */
async function maybeRecallMemory(params: {
  readonly memoryStore?: MemoryStore;
  readonly identityId?: IdentityId;
  readonly prompt: string;
  readonly limit: number;
  readonly logger?: IntentContractorLogger;
}): Promise<MemoryRecallOutcome> {
  if (!params.memoryStore || !params.identityId) {
    // Anonymous session OR no memoryStore wired — recall is a clean no-op.
    return { block: null, failed: false };
  }
  try {
    const result = await params.memoryStore.recall({
      identityId: params.identityId,
      query: params.prompt,
      limit: params.limit,
    });
    if (result.entries.length === 0) {
      // Empty result must NOT inject a block — zero whitespace pollution.
      return { block: null, failed: false };
    }
    return { block: buildMemoryBlock(result.entries), failed: false };
  } catch (error) {
    params.logger?.warn(MEMORY_RECALL_FAILED_UNCERTAINTY, {
      identityId: String(params.identityId),
      error: error instanceof Error ? error.message : String(error),
    });
    return { block: null, failed: true };
  }
}

/**
 * Closed-shape JSON encoding of recalled entries. Mirrors the
 * `<web_evidence>` pattern; the wrapper tags are static literals so
 * the downstream LLM can parse them cheaply. Per invariant #5 the
 * inner payload is structured JSON, NOT raw user text.
 */
function buildMemoryBlock(entries: readonly SemanticMemoryEntry[]): string {
  const payload = {
    entries: entries.map((entry) => ({
      id: String(entry.id),
      content: entry.content,
      score: entry.score,
      metadata: entry.metadata,
    })),
  };
  return `<memory>${JSON.stringify(payload)}</memory>`;
}

/**
 * Appends the `memory_recall_failed` uncertainty tag to a normalised
 * intent if the recall step rejected. The tag is observability-only
 * (the intent itself stays valid and confidence is unchanged), per
 * sub-plan §5 Phase 6 + invariant #15.
 */
function appendRecallFailureTag(intent: SemanticIntent, failed: boolean): SemanticIntent {
  if (!failed) return intent;
  if (intent.uncertainty.includes(MEMORY_RECALL_FAILED_UNCERTAINTY)) return intent;
  return {
    ...intent,
    uncertainty: [...intent.uncertainty, MEMORY_RECALL_FAILED_UNCERTAINTY],
  };
}

/**
 * Slice-F Phase-6 sibling of `maybeRecallMemory`. Performs the optional
 * active-tasks list and returns either an
 * `<active_tasks>{JSON}</active_tasks>` block (non-empty result) or
 * `null` (no ledger, no identity, empty/all-terminal result, or recall
 * failure). Recall errors are caught and surfaced via the injected
 * logger plus the `failed` flag — they do NOT throw into the contractor.
 *
 * The query passes ONLY structured filters (`ownerIdentityId` +
 * `statuses`) — raw user text is never routed onto the ledger path
 * (invariant #5/#6). Block formatting + status filter live in
 * `buildActiveTasksBlock`.
 */
async function maybeRecallActiveTasks(params: {
  readonly taskLedger?: TaskLedger;
  readonly identityId?: IdentityId;
  readonly logger?: IntentContractorLogger;
}): Promise<TaskRecallOutcome> {
  if (!params.taskLedger || !params.identityId) {
    // Anonymous session OR no taskLedger wired — recall is a clean no-op.
    return { block: null, failed: false };
  }
  try {
    const result = await params.taskLedger.list({
      ownerIdentityId: params.identityId,
      statuses: ACTIVE_TASK_RECALL_STATUSES,
    });
    if (result.tasks.length === 0) {
      return { block: null, failed: false };
    }
    const block = buildActiveTasksBlock(result.tasks);
    // `buildActiveTasksBlock` filters defensively to active statuses and
    // returns "" when nothing survives — collapse that branch onto the
    // empty-result no-op so callers see one shape.
    if (block.length === 0) {
      return { block: null, failed: false };
    }
    return { block, failed: false };
  } catch (error) {
    params.logger?.warn(TASK_RECALL_FAILED_UNCERTAINTY, {
      identityId: String(params.identityId),
      error: error instanceof Error ? error.message : String(error),
    });
    return { block: null, failed: true };
  }
}

type TaskRecallOutcome = {
  readonly block: string | null;
  readonly failed: boolean;
};

/**
 * Slice-F Phase-6 sibling of `appendRecallFailureTag`. Appends the
 * `task_recall_failed` uncertainty tag to a normalised intent if the
 * task recall step rejected. Same observability-only discipline as
 * the memory recall path — the intent stays valid and confidence is
 * unchanged.
 */
function appendTaskRecallFailureTag(intent: SemanticIntent, failed: boolean): SemanticIntent {
  if (!failed) return intent;
  if (intent.uncertainty.includes(TASK_RECALL_FAILED_UNCERTAINTY)) return intent;
  return {
    ...intent,
    uncertainty: [...intent.uncertainty, TASK_RECALL_FAILED_UNCERTAINTY],
  };
}

/**
 * Cutover-3 Phase 6 — `<inbound_attachments>` block builder. Mirrors
 * the slice-E `<memory>` block + slice-F `<active_tasks>` block
 * pattern. Returns a closed-shape XML-like block when the resolver
 * surfaces a non-empty list, `null` otherwise (no attachments
 * → block elided, zero whitespace pollution).
 *
 * Block shape (intentionally XML-like, mirrors `<web_evidence>` and
 * `<memory>` precedents in the same file):
 *   `<inbound_attachments>
 *     <attachment path="..." mime="..." kind="..." sourceTurnId="..." />
 *   </inbound_attachments>\n`
 *
 * The trailing newline keeps the prompt readable when concatenated
 * with the user text. The block content is STRUCTURAL only — no raw
 * user text routed through this surface (invariants #5/#6). Resolver
 * throws are absorbed (invariant #15) — observability, not gating.
 */
function buildInboundAttachmentsBlock(params: {
  readonly resolver?: () => InboundMediaSummary | undefined;
  readonly logger?: IntentContractorLogger;
}): string | null {
  if (!params.resolver) {
    return null;
  }
  let summary: InboundMediaSummary | undefined;
  try {
    summary = params.resolver();
  } catch (error) {
    params.logger?.warn("inbound_media_resolver_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!summary || summary.attachments.length === 0) {
    return null;
  }
  const entries = summary.attachments.map((attachment) => {
    const sourceTurnAttribute =
      attachment.sourceTurnId !== undefined && attachment.sourceTurnId.length > 0
        ? ` sourceTurnId="${escapeXmlAttribute(attachment.sourceTurnId)}"`
        : "";
    return (
      `  <attachment path="${escapeXmlAttribute(attachment.path)}"` +
      ` mime="${escapeXmlAttribute(attachment.mimeType)}"` +
      ` kind="${escapeXmlAttribute(attachment.kind)}"` +
      `${sourceTurnAttribute} />`
    );
  });
  const block = `<inbound_attachments>\n${entries.join("\n")}\n</inbound_attachments>\n`;
  // Telemetry on the structural-logger seam — info-level (warn channel
  // is the only structural log surface in this file; we ride that
  // without changing the logger contract). Message format mirrors
  // slice-E `[intent-contractor] memory_block_injected entries=N`.
  params.logger?.warn(
    `[intent-contractor] inbound_attachments_block injected paths=${String(summary.attachments.length)}`,
    { paths: summary.attachments.length },
  );
  return block;
}

/**
 * Minimal XML-attribute escape. Inbound attachment fields are
 * structural metadata produced upstream (path, MIME, closed `kind`
 * enumeration) but defensive escaping keeps malformed paths from
 * corrupting the block. Mirrors the level of escaping the existing
 * `<web_evidence>` / `<memory>` blocks use (none — they JSON-encode
 * inside the block; this block is XML-like so we attribute-escape).
 */
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

class PiIntentContractorAdapter implements IntentContractorAdapter {
  async classify(params: {
    readonly prompt: string;
    readonly fileNames: readonly string[];
    readonly ledgerContext?: string;
    readonly config: ResolvedIntentContractorConfig;
    readonly cfg: OpenClawConfig;
    readonly agentDir?: string;
    readonly onDebugEvent?: (event: IntentContractorDebugEvent) => void;
  }): Promise<SemanticIntent> {
    const rawTurn = makeRawUserTurn(params.prompt);
    const parsedRef = parseModelRef(params.config.model, "openai");
    if (!parsedRef) {
      throw new Error(`invalid model ref "${params.config.model}"`);
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
      throw new Error(resolved.error ?? "model could not be resolved");
    }

    const model = prepareModelForSimpleCompletion({ model: resolved.model, cfg: params.cfg });
    const auth = await getApiKeyForModel({
      model,
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
    const apiKey = requireApiKey(auth, model.provider);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.config.timeoutMs);
    try {
      const result = await completeSimple(
        model,
        {
          systemPrompt: INTENT_CONTRACTOR_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildIntentContractorPrompt({ ...params, rawTurn }),
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
      const parsed = parseSemanticIntentResponse(text);
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
      return parsed.intent ?? lowConfidenceIntent("schema_validation_failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Parses and validates a JSON response from an IntentContractor adapter.
 *
 * @param raw - Raw adapter text response.
 * @returns Parsed intent or a typed parse failure.
 */
export function parseSemanticIntentResponse(raw: string): {
  readonly intent: SemanticIntent | null;
  readonly parseResult: "ok" | "empty" | "json_parse_failed" | "schema_invalid";
  readonly normalizedCandidate?: string;
  readonly parseErrorMessage?: string;
} {
  const candidate = extractJsonObjectCandidate(raw);
  if (!candidate) {
    return { intent: null, parseResult: "empty" };
  }
  try {
    const parsed = JSON.parse(candidate) as unknown;
    const reshaped = reshapeFlattenedSemanticIntent(parsed);
    const validation = SemanticIntentResponseSchema.safeParse(reshaped);
    if (!validation.success) {
      return { intent: null, parseResult: "schema_invalid", normalizedCandidate: candidate };
    }
    return {
      intent: normalizeParsedIntent(validation.data),
      parseResult: "ok",
      normalizedCandidate: candidate,
    };
  } catch (error) {
    return {
      intent: null,
      parseResult: "json_parse_failed",
      normalizedCandidate: candidate,
      parseErrorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Defensive pre-normalizer for the strict Zod schema. Some LLMs (notably
 * gpt-5-mini in production) flatten the schema and emit keys like
 * `targetKind`, `operationKind`, or `allowedOperationKind` instead of the
 * required nested `target: { kind }` / `operation: { kind }`. Reshape so the
 * strict schema accepts the response when the intent is unambiguous; leave
 * the value untouched otherwise.
 */
function reshapeFlattenedSemanticIntent(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const obj = { ...(value as Record<string, unknown>) };
  if (obj.target === undefined && typeof obj.targetKind === "string") {
    obj.target = { kind: obj.targetKind };
  }
  delete obj.targetKind;
  if (obj.operation === undefined) {
    const flatOpKind =
      typeof obj.operationKind === "string"
        ? obj.operationKind
        : typeof obj.allowedOperationKind === "string"
          ? obj.allowedOperationKind
          : undefined;
    if (flatOpKind) {
      obj.operation = { kind: flatOpKind };
    }
  }
  delete obj.operationKind;
  delete obj.allowedOperationKind;
  if (obj.constraints === undefined) {
    obj.constraints = {};
  }
  if (obj.uncertainty === undefined) {
    obj.uncertainty = [];
  }
  // Strip null'd optional fields and unwrap "double-quoted" string-literal kinds.
  // Live evidence: gpt-5-mini emits sessionId/channelId/artifactId as null and
  // sometimes kind as `"\"session\""` — both fail strict zod.
  obj.target = sanitizeNestedKindObject(obj.target);
  obj.operation = sanitizeNestedKindObject(obj.operation);
  return obj;
}

function sanitizeNestedKindObject(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === "") continue;
    if (typeof raw === "string") {
      const unwrapped = raw.replace(/^"+|"+$/g, "");
      cleaned[key] = unwrapped;
    } else {
      cleaned[key] = raw;
    }
  }
  return cleaned;
}

/**
 * Converts parsed JSON into branded SemanticIntent fields.
 *
 * @param parsed - Validated adapter payload.
 * @returns Branded semantic intent.
 */
function normalizeParsedIntent(parsed: z.infer<typeof SemanticIntentResponseSchema>): SemanticIntent {
  return normalizeSemanticIntent({
    desiredEffectFamily: parsed.desiredEffectFamily as EffectFamilyId,
    target: parsed.target as TargetRef,
    ...(parsed.operation ? { operation: parsed.operation as OperationHint } : {}),
    constraints: parsed.constraints,
    uncertainty: parsed.uncertainty,
    confidence: parsed.confidence,
  });
}

/**
 * Enforces registry membership and operation constraints for semantic intents.
 *
 * @param intent - Candidate semantic intent.
 * @returns Normalized intent using only registered effect families.
 */
function normalizeSemanticIntent(intent: SemanticIntent): SemanticIntent {
  const rawFamily = String(intent.desiredEffectFamily);
  const family = resolveEffectFamilyId(rawFamily);
  if (family === UNKNOWN_EFFECT_FAMILY && rawFamily !== UNKNOWN_EFFECT_FAMILY) {
    return {
      ...intent,
      desiredEffectFamily: UNKNOWN_EFFECT_FAMILY,
      uncertainty: [...intent.uncertainty, "family_not_in_registry"],
      confidence: 0,
    };
  }
  const definition = getEffectFamilyDefinition(family);
  const operationAllowed =
    !intent.operation || definition?.allowedOperationKinds.includes(intent.operation.kind) === true;
  if (!operationAllowed) {
    return {
      ...intent,
      desiredEffectFamily: UNKNOWN_EFFECT_FAMILY,
      uncertainty: [...intent.uncertainty, "operation_not_allowed_for_family"],
      confidence: 0,
    };
  }
  return { ...intent, desiredEffectFamily: family };
}

/**
 * Builds the structured-output prompt for the LLM adapter.
 *
 * @param params - Adapter params containing the raw turn and context.
 * @returns Prompt with the closed PR-2 schema context.
 */
function buildIntentContractorPrompt(params: {
  readonly rawTurn: RawUserTurn;
  readonly fileNames: readonly string[];
  readonly ledgerContext?: string;
}): string {
  const familyDirectory = EFFECT_FAMILY_REGISTRY.map((entry) => ({
    id: entry.id,
    allowedOperationKinds: entry.allowedOperationKinds,
  }));
  return JSON.stringify({
    instruction:
      'Return ONLY one JSON object matching responseShape exactly. No prose, no code fences. ' +
      'Use the nested object form `target: { "kind": "<X>" }` and `operation: { "kind": "<Y>" }` — ' +
      "DO NOT flatten to `targetKind`/`operationKind`. `constraints` and `uncertainty` are required " +
      "(use `{}` and `[]` if empty). Pick `desiredEffectFamily` from `familyDirectory[].id` only.",
    responseShape: {
      desiredEffectFamily: '"persistent_session" | "communication" | "artifact" | "unknown"',
      target: {
        kind: '"session" | "artifact" | "workspace" | "external_channel" | "unspecified"',
        sessionId: "(optional, when kind=session)",
        artifactId: "(optional, when kind=artifact)",
        channelId: "(optional, when kind=external_channel)",
      },
      operation: {
        kind: '"create" | "update" | "cancel" | "observe" | "custom"',
        verb: "(required string when kind=custom)",
      },
      constraints: "object (use {} if none)",
      uncertainty: "string[] (use [] if none)",
      confidence: "number in [0,1]",
    },
    examples: [
      {
        when: "user greets or chats casually",
        response: {
          desiredEffectFamily: "communication",
          target: { kind: "external_channel" },
          operation: { kind: "create" },
          constraints: {},
          uncertainty: [],
          confidence: 0.8,
        },
      },
      {
        when: "intent unclear or off-topic",
        response: {
          desiredEffectFamily: "unknown",
          target: { kind: "unspecified" },
          constraints: {},
          uncertainty: ["intent_unclear"],
          confidence: 0.3,
        },
      },
    ],
    familyDirectory,
    context: {
      text: params.rawTurn.text,
      channel: params.rawTurn.channel,
      receivedAt: params.rawTurn.receivedAt,
      attachments: params.rawTurn.attachments,
      fileNames: params.fileNames,
      ...(params.ledgerContext ? { ledgerContext: params.ledgerContext } : {}),
    },
  });
}

/**
 * Returns a low-confidence sentinel intent for adapter failures.
 *
 * @param reason - Machine-readable uncertainty reason.
 * @returns Semantic intent that ShadowBuilder will treat as unsupported.
 */
function lowConfidenceIntent(reason: string): SemanticIntent {
  return {
    desiredEffectFamily: UNKNOWN_EFFECT_FAMILY,
    target: { kind: "unspecified" },
    constraints: {},
    uncertainty: [reason],
    confidence: 0,
  };
}

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

function extractJsonObjectCandidate(raw: string): string | null {
  const normalized = normalizeJsonCandidateText(raw);
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

function normalizeJsonCandidateText(raw: string): string {
  let start = 0;
  if (raw.charCodeAt(0) === 0xfeff) {
    start = 1;
  }
  let out = "";
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "\u201C" || char === "\u201D") {
      out += '"';
      continue;
    }
    if (char === "\u2018" || char === "\u2019") {
      out += "'";
      continue;
    }
    out += char;
  }
  return out.trim();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function emitDebugEvent(
  callback: ((event: IntentContractorDebugEvent) => void) | undefined,
  event: IntentContractorDebugEvent,
): void {
  try {
    callback?.(event);
  } catch {
    // Debug hooks must not affect shadow-mode classification.
  }
}
