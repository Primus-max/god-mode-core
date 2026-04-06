export type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  ContextEngineMaintenanceResult,
  ContextEngineRuntimeContext,
  IngestResult,
  PromptOptimizationReport,
  PromptOptimizeForTurnResult,
  TranscriptRewriteReplacement,
  TranscriptRewriteRequest,
  TranscriptRewriteResult,
} from "./types.js";

export {
  registerContextEngine,
  getContextEngineFactory,
  listContextEngineIds,
  resolveContextEngine,
} from "./registry.js";
export type { ContextEngineFactory } from "./registry.js";

export { LegacyContextEngine, registerLegacyContextEngine } from "./legacy.js";
export { delegateCompactionToRuntime } from "./delegate.js";

export { ensureContextEnginesInitialized } from "./init.js";

export {
  deterministicPromptOptimize,
  mergePromptOptimizationReports,
} from "./prompt-optimize.js";
