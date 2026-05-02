import type { OpenClawConfig } from "../../config/config.js";
import { runWebResearchSpecialist } from "../../agents/pi-embedded-runner/run/web-research-runtime-adapter.js";
import {
  WEB_EVIDENCE_COLLECTED_EFFECT,
  type ExecutionCommitment,
  type SemanticIntent,
} from "../commitment/index.js";
import type { CommitmentId, SessionId } from "../commitment/ids.js";
import {
  createWebEvidenceCollector,
  type TurnKey,
} from "../commitment/web-evidence-world-state-observer.js";
import { createWebResearchSpecialistTransport } from "./web-research-transports.js";

/**
 * Result of a `maybeFetchWebEvidence` call. The returned `enrichedPrompt`
 * prepends a structural `<web_evidence>{records}</web_evidence>` block to the
 * original user prompt so the downstream LLM sees fresh search results before
 * the user query. Per `commitment_kernel_search_composer_pipeline.plan.md` §6.2
 * (invariant #5 safe): the block is closed-shape JSON, NOT raw user text.
 *
 * On any failure (specialist transport error, no records, parse error, no
 * citations) the helper returns `undefined` so the caller falls through to the
 * legacy single-LLM flow — no regression vs. the pre-Search-Composer baseline.
 */
export type MaybeFetchWebEvidenceResult = {
  readonly enrichedPrompt: string;
  readonly recordCount: number;
};

const PREFETCH_DEFAULT_SUMMARY = "(no_summary)";

function buildEvidenceBlock(records: ReadonlyArray<unknown>, summary: string): string {
  return `<web_evidence>${JSON.stringify({
    records,
    summary,
  })}</web_evidence>`;
}

function syntheticSpecialistCommitment(turnKey: TurnKey): ExecutionCommitment {
  return {
    id: `prefetch:${turnKey.sessionId}:${turnKey.turnId}` as CommitmentId,
    effect: WEB_EVIDENCE_COLLECTED_EFFECT,
    target: { kind: "external_channel" },
    constraints: { summary: PREFETCH_DEFAULT_SUMMARY },
    budgets: { maxLatencyMs: 30_000, maxRetries: 1 },
    requiredEvidence: [{ kind: "web_evidence.collected", mandatory: true }],
    terminalPolicy: {
      onTimeout: "unsupported",
      onPolicyDenial: "rejected",
      onUnsatisfiedSuccess: "rejected",
    },
  };
}

function syntheticSpecialistIntent(prompt: string): SemanticIntent {
  return {
    desiredEffectFamily: "web_research" as SemanticIntent["desiredEffectFamily"],
    target: { kind: "external_channel" },
    operation: { kind: "create" },
    constraints: { summary: prompt.trim().slice(0, 500) || PREFETCH_DEFAULT_SUMMARY },
    uncertainty: [],
    confidence: 0.9,
  };
}

export type MaybeFetchWebEvidenceParams = {
  readonly requestedTools: readonly string[] | undefined;
  readonly userPrompt: string;
  readonly cfg: OpenClawConfig;
  readonly agentDir?: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly logger?: (line: string) => void;
};

/**
 * Phase 4b''-e4 (Option ε) prefetch helper. Invoked by the agent runner just
 * before the LLM call. When the planner indicates the turn requires
 * `web_search`, runs the sonar specialist synchronously to produce a fresh
 * `<web_evidence>` block and prepends it to the user prompt. The downstream
 * LLM call then sees structural evidence before the user query and is expected
 * to ground its answer in those records.
 *
 * The helper is purposely best-effort: any specialist failure returns
 * `undefined` so the caller can fall through to the legacy single-LLM flow
 * untouched. There is no architectural reach into the model-fallback layer or
 * the LLM-call attempt loop — the only mutation is to the user prompt string
 * (and the caller's `requestedTools` array, externally).
 */
export async function maybeFetchWebEvidence(
  params: MaybeFetchWebEvidenceParams,
): Promise<MaybeFetchWebEvidenceResult | undefined> {
  if (!params.requestedTools?.includes("web_search")) {
    return undefined;
  }

  const turnKey: TurnKey = {
    sessionId: params.sessionId as SessionId,
    turnId: params.turnId,
  };
  const collector = createWebEvidenceCollector();
  const transport = createWebResearchSpecialistTransport({
    cfg: params.cfg,
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
  });

  const result = await runWebResearchSpecialist({
    commitment: syntheticSpecialistCommitment(turnKey),
    intent: syntheticSpecialistIntent(params.userPrompt),
    turnKey,
    transport,
    collector,
    ...(params.logger ? { logger: params.logger } : {}),
  });

  if (!result.ok) {
    params.logger?.(
      `[web-evidence-prefetch] specialist_failed reason=${result.reason} sessionId=${turnKey.sessionId} turnId=${turnKey.turnId}`,
    );
    return undefined;
  }

  collector.setActiveTurn(turnKey);
  const records = collector.getActiveSlice() ?? [];
  if (records.length === 0) {
    return undefined;
  }

  const block = buildEvidenceBlock(records, PREFETCH_DEFAULT_SUMMARY);
  const enrichedPrompt = `${block}\n\n${params.userPrompt}`;
  params.logger?.(
    `[web-evidence-prefetch] ok recordCount=${records.length} sessionId=${turnKey.sessionId} turnId=${turnKey.turnId} promptDeltaChars=${enrichedPrompt.length - params.userPrompt.length}`,
  );
  return { enrichedPrompt, recordCount: records.length };
}

/**
 * Returns a copy of `requestedTools` with `web_search` filtered out. Idempotent
 * and safe to call when the array is `undefined`. Used by the caller after
 * `maybeFetchWebEvidence` returns ok so the LLM can't redundantly try the
 * (broken) DDG fallback when fresh evidence is already in the prompt.
 */
export function filterWebSearchFromTools(
  requestedTools: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!requestedTools) return requestedTools;
  return requestedTools.filter((tool) => tool !== "web_search");
}
