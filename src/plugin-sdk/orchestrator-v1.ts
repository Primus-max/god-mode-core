/**
 * Plugin-sdk surface for the V1-CONTRACT-ONLY orchestrator.
 *
 * Re-exports both the diagnostic entry point (`diagnoseTurn`) AND the
 * production orchestrator (`runOrchestratorTurn` + tool-runner registry +
 * deps types) so channel extensions can either:
 *
 *   - keep the env-gated dry-run path (`diagnoseTurn`), or
 *   - run the full Stage-A/B + dispatcher + tool-runner pipeline
 *     (`runOrchestratorTurn` + `buildRunToolFromRegistry`).
 *
 * The S9 cutover (extensions/telegram) consumes the production exports
 * behind the same `OPENCLAW_USE_V1_ORCHESTRATOR=1` env flag for safety.
 */

export {
  callConversationLLM,
  diagnoseTurn,
  type DiagnoseTurnDeps,
  type DiagnoseTurnResult,
} from "../orchestrator-v1/diagnostic.js";

export { DEFAULT_STAGE_A_MODEL, type StageAModelRef } from "../orchestrator-v1/classifier-stage-a.js";

export {
  CONVERSATION_SYSTEM_PROMPT_GUARD,
  runOrchestratorTurn,
  type RunOrchestratorTurnInputs,
  type RunOrchestratorTurnResult,
} from "../orchestrator-v1/orchestrator.js";

export {
  buildRunToolFromRegistry,
  type RegistryDeps,
  type ToolRunnerLogger,
} from "../orchestrator-v1/tool-runner-registry.js";

export type {
  RunConversationLLMFn,
  RunToolFn,
  ToolRunResult,
} from "../orchestrator-v1/dispatcher.js";

export type { SessionsSendFn } from "../orchestrator-v1/tool-runners/sessions.js";

export type {
  CreatePersistentWorkerFn,
  ScheduleCronFn,
  SchedulingRunnerDeps,
} from "../orchestrator-v1/tool-runners/scheduling.js";
