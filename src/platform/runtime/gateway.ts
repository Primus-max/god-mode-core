import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import type { PlatformRuntimeCheckpointService } from "./service.js";

export function createRuntimeCheckpointListGatewayMethod(
  service: PlatformRuntimeCheckpointService,
): GatewayRequestHandler {
  return ({ params, respond }) => {
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : undefined;
    const status = typeof params.status === "string" ? params.status.trim() : undefined;
    respond(true, {
      checkpoints: service.list({
        ...(sessionKey ? { sessionKey } : {}),
        ...(status ? { status: status as never } : {}),
      }),
    });
  };
}

export function createRuntimeCheckpointGetGatewayMethod(
  service: PlatformRuntimeCheckpointService,
): GatewayRequestHandler {
  return ({ params, respond }) => {
    const checkpointId = typeof params.checkpointId === "string" ? params.checkpointId.trim() : "";
    if (!checkpointId) {
      respond(false, { error: "checkpointId required" });
      return;
    }
    const checkpoint = service.get(checkpointId);
    if (!checkpoint) {
      respond(false, { error: "checkpoint not found" });
      return;
    }
    respond(true, { checkpoint });
  };
}
