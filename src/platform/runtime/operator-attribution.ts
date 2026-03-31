import type { GatewayClient } from "../../gateway/server-methods/types.js";
import type { PlatformRuntimeOperatorActor, PlatformRuntimeOperatorDecision } from "./contracts.js";

function trimOptional(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

export function buildRuntimeOperatorActor(
  client: GatewayClient | null | undefined,
): PlatformRuntimeOperatorActor | undefined {
  const actor = {
    id: trimOptional(client?.connect?.client?.id),
    displayName: trimOptional(client?.connect?.client?.displayName),
    deviceId: trimOptional(client?.connect?.device?.id),
    connId: trimOptional(client?.connId),
  } satisfies PlatformRuntimeOperatorActor;
  return actor.id || actor.displayName || actor.deviceId || actor.connId ? actor : undefined;
}

export function buildRuntimeOperatorDecision(params: {
  action: string;
  source: string;
  client: GatewayClient | null | undefined;
  atMs?: number;
}): PlatformRuntimeOperatorDecision {
  const actor = buildRuntimeOperatorActor(params.client);
  return {
    action: params.action,
    atMs: params.atMs ?? Date.now(),
    ...(actor ? { actor } : {}),
    source: params.source,
  };
}
