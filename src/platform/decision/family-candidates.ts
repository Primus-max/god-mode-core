import type { QualificationBridgePlannerInput } from "./outcome-contract.js";
import type { CandidateExecutionFamily, OutcomeContract } from "./qualification-contract.js";

export function inferCandidateExecutionFamilies(
  outcomeContract: OutcomeContract,
  input: QualificationBridgePlannerInput,
): CandidateExecutionFamily[] {
  if (input.requestedTools?.includes("sessions_spawn")) {
    return ["ops_execution"];
  }
  switch (outcomeContract) {
    case "structured_artifact":
      if (input.artifactKinds?.some((kind) => ["image", "video", "audio"].includes(kind))) {
        return ["media_generation", "document_render"];
      }
      return ["document_render", "analysis_transform"];
    case "workspace_change":
    case "interactive_local_result":
      return ["code_build"];
    case "external_operation":
      return ["ops_execution"];
    case "text_response":
    default:
      if (
        (input.artifactKinds?.length ?? 0) > 0 &&
        (input.artifactKinds ?? []).every((kind) => kind === "data" || kind === "report")
      ) {
        return ["analysis_transform"];
      }
      if ((input.artifactKinds?.length ?? 0) > 0 && input.artifactKinds?.includes("report")) {
        return ["analysis_transform"];
      }
      return ["general_assistant"];
  }
}
