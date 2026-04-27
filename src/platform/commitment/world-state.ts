import type { ISO8601, SessionId } from "./ids.js";

export type SessionRecord = {
  readonly sessionId: SessionId;
  readonly agentId: string;
  readonly parentSessionKey: string | null;
  readonly status: "active" | "paused" | "closed";
  readonly createdAt: ISO8601;
};

export type SessionWorldState = {
  readonly followupRegistry: readonly SessionRecord[];
};

export type ArtifactWorldState = Record<string, never>;
export type WorkspaceWorldState = Record<string, never>;
export type DeliveryWorldState = Record<string, never>;

export type WorldStateSnapshot = {
  readonly sessions?: SessionWorldState;
  readonly artifacts?: ArtifactWorldState;
  readonly workspace?: WorkspaceWorldState;
  readonly deliveries?: DeliveryWorldState;
};
