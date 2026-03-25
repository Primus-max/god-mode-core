import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import {
  BootstrapRequestDecisionSchema,
  type BootstrapRequestService,
} from "./index.js";

export function createBootstrapListGatewayMethod(
  service: BootstrapRequestService,
): GatewayRequestHandler {
  return ({ respond }) => {
    respond(true, { requests: service.list(), pendingCount: service.pendingCount() });
  };
}

export function createBootstrapGetGatewayMethod(
  service: BootstrapRequestService,
): GatewayRequestHandler {
  return ({ params, respond }) => {
    const requestId = typeof params.requestId === "string" ? params.requestId.trim() : "";
    if (!requestId) {
      respond(false, { error: "requestId required" });
      return;
    }
    const detail = service.get(requestId);
    if (!detail) {
      respond(false, { error: "bootstrap request not found" });
      return;
    }
    respond(true, { detail });
  };
}

export function createBootstrapResolveGatewayMethod(
  service: BootstrapRequestService,
): GatewayRequestHandler {
  return ({ params, respond }) => {
    const requestId = typeof params.requestId === "string" ? params.requestId.trim() : "";
    if (!requestId) {
      respond(false, { error: "requestId required" });
      return;
    }
    const decision = BootstrapRequestDecisionSchema.safeParse(params.decision);
    if (!decision.success) {
      respond(false, { error: "invalid bootstrap decision" });
      return;
    }
    const detail = service.resolve(requestId, decision.data);
    if (!detail) {
      respond(false, { error: "bootstrap request not found" });
      return;
    }
    respond(true, { detail });
  };
}

export function createBootstrapRunGatewayMethod(
  service: BootstrapRequestService,
): GatewayRequestHandler {
  return async ({ params, respond }) => {
    const requestId = typeof params.requestId === "string" ? params.requestId.trim() : "";
    if (!requestId) {
      respond(false, { error: "requestId required" });
      return;
    }
    const detail = await service.run({ id: requestId });
    if (!detail) {
      respond(false, { error: "bootstrap request not found" });
      return;
    }
    respond(true, { detail });
  };
}
