import type { QualificationBridgePlannerInput } from "./outcome-contract.js";
import type {
  OutcomeContract,
  QualificationExecutionContract,
  RequestedEvidenceKind,
} from "./qualification-contract.js";

export function inferExecutionContract(
  outcomeContract: OutcomeContract,
  input: QualificationBridgePlannerInput,
): QualificationExecutionContract {
  const requestedTools = input.requestedTools ?? [];
  const requiresTools = requestedTools.length > 0 || outcomeContract !== "text_response";
  const requiresLocalProcess =
    requestedTools.some((tool) => ["exec", "process"].includes(tool)) ||
    outcomeContract === "interactive_local_result";

  switch (outcomeContract) {
    case "structured_artifact":
      return {
        requiresTools,
        requiresWorkspaceMutation: false,
        requiresLocalProcess,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: requestedTools.some((tool) => tool === "pdf" || tool === "image_generate"),
      };
    case "workspace_change":
      return {
        requiresTools,
        requiresWorkspaceMutation: true,
        requiresLocalProcess,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: requiresLocalProcess,
      };
    case "interactive_local_result":
      return {
        requiresTools: true,
        requiresWorkspaceMutation: true,
        requiresLocalProcess: true,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      };
    case "external_operation":
      return {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      };
    case "text_response":
    default:
      return {
        requiresTools,
        requiresWorkspaceMutation: false,
        requiresLocalProcess,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      };
  }
}

export function inferRequestedEvidence(
  outcomeContract: OutcomeContract,
  executionContract: QualificationExecutionContract,
): RequestedEvidenceKind[] {
  const requestedEvidence = new Set<RequestedEvidenceKind>();
  switch (outcomeContract) {
    case "structured_artifact":
      requestedEvidence.add("tool_receipt");
      requestedEvidence.add("artifact_descriptor");
      break;
    case "interactive_local_result":
      requestedEvidence.add("tool_receipt");
      requestedEvidence.add("process_receipt");
      break;
    case "workspace_change":
    case "external_operation":
      requestedEvidence.add("tool_receipt");
      break;
    case "text_response":
    default:
      requestedEvidence.add("assistant_text");
      break;
  }
  if (executionContract.requiresDeliveryEvidence) {
    requestedEvidence.add("delivery_receipt");
  }
  if (executionContract.mayNeedBootstrap) {
    requestedEvidence.add("capability_receipt");
  }
  return Array.from(requestedEvidence);
}
