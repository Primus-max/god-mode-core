import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import { z } from "zod";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { parseModelRef } from "../../agents/model-selection.js";
import { resolveModelAsync } from "../../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../../agents/simple-completion-transport.js";
import type { OpenClawConfig } from "../../config/config.js";
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
 * @param deps - Runtime config and optional adapter registry.
 * @returns IntentContractor that never throws for classification failures.
 */
export function createIntentContractor(deps: {
  readonly cfg: OpenClawConfig;
  readonly fileNames?: readonly string[];
  readonly ledgerContext?: string;
  readonly agentDir?: string;
  readonly adapterRegistry?: IntentContractorAdapterRegistry;
  readonly onDebugEvent?: (event: IntentContractorDebugEvent) => void;
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
      try {
        return normalizeSemanticIntent(
          await adapter.classify({
            prompt,
            fileNames: deps.fileNames ?? [],
            ...(deps.ledgerContext ? { ledgerContext: deps.ledgerContext } : {}),
            config,
            cfg: deps.cfg,
            ...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
            onDebugEvent: deps.onDebugEvent,
          }),
        );
      } catch (error) {
        const reason = isAbortError(error) ? "llm_timeout" : "llm_error";
        emitDebugEvent(deps.onDebugEvent, {
          stage: "fallback",
          backend: config.backend,
          configuredModel: config.model,
          message: error instanceof Error ? error.message : String(error),
        });
        return lowConfidenceIntent(reason);
      }
    },
  };
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
    const validation = SemanticIntentResponseSchema.safeParse(parsed);
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
  return JSON.stringify({
    instruction: "Return only JSON. Do not include prose.",
    schema: {
      desiredEffectFamily: EFFECT_FAMILY_REGISTRY.map((entry) => ({
        id: entry.id,
        allowedOperationKinds: entry.allowedOperationKinds,
      })),
      targetKinds: ["session", "artifact", "workspace", "external_channel", "unspecified"],
      constraintObject: "flat JSON object; unknown keys may be ignored downstream",
    },
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
