import type { RecipePlannerInput } from "../recipe/planner.js";
import type { OutcomeContract } from "./qualification-contract.js";

export type QualificationBridgePlannerInput = Pick<
  RecipePlannerInput,
  "intent" | "artifactKinds" | "requestedTools" | "publishTargets"
>;

export function inferOutcomeContract(
  input: QualificationBridgePlannerInput,
): OutcomeContract {
  const artifactKinds = input.artifactKinds ?? [];
  if (artifactKinds.includes("site")) {
    return "interactive_local_result";
  }
  if (
    artifactKinds.some((kind) =>
      ["document", "estimate", "image", "video", "audio", "archive", "release", "binary"].includes(
        kind,
      ),
    )
  ) {
    return "structured_artifact";
  }
  if (input.intent === "publish" || (input.publishTargets?.length ?? 0) > 0) {
    return "external_operation";
  }
  if (input.intent === "code") {
    return "workspace_change";
  }
  return "text_response";
}
