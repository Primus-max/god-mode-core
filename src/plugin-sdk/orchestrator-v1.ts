/**
 * Plugin-sdk surface for the V1-CONTRACT-ONLY orchestrator.
 *
 * Re-exports the diagnostic entry point (`diagnoseTurn`) so channel
 * extensions can env-gate a dry-run path without violating the
 * extension boundary. Exposing the diagnostic path only — not the full
 * tool-execution dispatcher — until the orchestrator is integrated
 * into the production reply pipeline (separate workstream).
 */

export {
  diagnoseTurn,
  type DiagnoseTurnDeps,
  type DiagnoseTurnResult,
} from "../orchestrator-v1/diagnostic.js";

export { CONVERSATION_SYSTEM_PROMPT_GUARD } from "../orchestrator-v1/orchestrator.js";
