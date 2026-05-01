import type { AgentId, EffectId, ISO8601, SessionId, SessionKey } from "./ids.js";

export type SessionRecord = {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly parentSessionKey: SessionKey | null;
  readonly status: "active" | "paused" | "closed";
  readonly createdAt: ISO8601;
};

export type SessionWorldState = {
  readonly followupRegistry: readonly SessionRecord[];
};

export type DeliveryReceiptKind = "answer" | "clarification" | "external_effect";

export type DeliveryReceipt = {
  readonly deliveryContextKey: string;
  readonly messageId: string;
  readonly sentAt: number;
  readonly effect: EffectId;
  readonly kind: DeliveryReceiptKind;
};

export type DeliveryWorldState = {
  readonly receipts: Readonly<Record<string, readonly DeliveryReceipt[]>>;
};

export type ArtifactWorldState = Record<string, never>;
export type WorkspaceWorldState = Record<string, never>;

export type WorldStateSnapshot = {
  readonly sessions?: SessionWorldState;
  readonly artifacts?: ArtifactWorldState;
  readonly workspace?: WorkspaceWorldState;
  readonly deliveries?: DeliveryWorldState;
};
