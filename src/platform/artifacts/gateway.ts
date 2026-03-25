import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { ArtifactOperationSchema } from "../schemas/artifact.js";
import type { ArtifactService } from "./service.js";

export function createArtifactListGatewayMethod(service: ArtifactService): GatewayRequestHandler {
  return ({ respond }) => {
    respond(true, { artifacts: service.list() });
  };
}

export function createArtifactGetGatewayMethod(service: ArtifactService): GatewayRequestHandler {
  return ({ params, respond }) => {
    const artifactId = typeof params.artifactId === "string" ? params.artifactId.trim() : "";
    if (!artifactId) {
      respond(false, { error: "artifactId required" });
      return;
    }
    const detail = service.getDetail(artifactId);
    if (!detail) {
      respond(false, { error: "artifact not found" });
      return;
    }
    respond(true, detail);
  };
}

export function createArtifactTransitionGatewayMethod(
  service: ArtifactService,
): GatewayRequestHandler {
  return ({ params, respond }) => {
    const artifactId = typeof params.artifactId === "string" ? params.artifactId.trim() : "";
    if (!artifactId) {
      respond(false, { error: "artifactId required" });
      return;
    }
    const parsedOperation = ArtifactOperationSchema.safeParse(params.operation);
    if (!parsedOperation.success) {
      respond(false, { error: "invalid artifact operation" });
      return;
    }
    const descriptor = service.transition(artifactId, parsedOperation.data);
    if (!descriptor) {
      respond(false, { error: "artifact not found" });
      return;
    }
    respond(true, {
      descriptor,
      detail: service.getDetail(artifactId),
    });
  };
}
