import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { buildRuntimeOperatorDecision } from "../runtime/operator-attribution.js";
import { BootstrapRequestDecisionSchema, type BootstrapRequestService } from "./index.js";

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
      respond(false, { error: "platform.bootstrap.get requires a non-empty requestId" });
      return;
    }
    const detail = service.get(requestId);
    if (!detail) {
      respond(false, { error: "bootstrap request not found for the given requestId" });
      return;
    }
    respond(true, { detail });
  };
}

export function createBootstrapResolveGatewayMethod(
  service: BootstrapRequestService,
): GatewayRequestHandler {
  return ({ params, client, respond }) => {
    const requestId = typeof params.requestId === "string" ? params.requestId.trim() : "";
    if (!requestId) {
      respond(false, { error: "platform.bootstrap.resolve requires a non-empty requestId" });
      return;
    }
    const decision = BootstrapRequestDecisionSchema.safeParse(params.decision);
    if (!decision.success) {
      respond(false, { error: "invalid bootstrap decision (expected approve or deny)" });
      return;
    }
    const detail = service.resolve(requestId, decision.data, {
      operatorDecision: buildRuntimeOperatorDecision({
        action: decision.data,
        source: "platform.bootstrap.resolve",
        client,
      }),
    });
    if (!detail) {
      respond(false, { error: "bootstrap request not found for the given requestId" });
      return;
    }
    respond(true, { detail });
  };
}

export function createBootstrapRunGatewayMethod(
  service: BootstrapRequestService,
): GatewayRequestHandler {
  return async ({ params, client, respond }) => {
    const requestId = typeof params.requestId === "string" ? params.requestId.trim() : "";
    if (!requestId) {
      respond(false, { error: "platform.bootstrap.run requires a non-empty requestId" });
      return;
    }
    const detail = await service.run({
      id: requestId,
      operatorDecision: buildRuntimeOperatorDecision({
        action: "run",
        source: "platform.bootstrap.run",
        client,
      }),
    });
    if (!detail) {
      respond(false, { error: "bootstrap request not found for the given requestId" });
      return;
    }
    respond(true, { detail });
  };
}
