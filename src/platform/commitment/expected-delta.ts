import type { AgentId, SessionId } from "./ids.js";

export type SessionRecordRef = {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
};

export type SessionExpectedDelta = {
  readonly followupRegistry?: {
    readonly added?: readonly SessionRecordRef[];
    readonly removed?: readonly { readonly sessionId: SessionId }[];
  };
};

export type ArtifactExpectedDelta = Record<string, never>;
export type WorkspaceExpectedDelta = Record<string, never>;
export type DeliveryExpectedDelta = Record<string, never>;

export type ExpectedDelta = {
  readonly sessions?: SessionExpectedDelta;
  readonly artifacts?: ArtifactExpectedDelta;
  readonly workspace?: WorkspaceExpectedDelta;
  readonly deliveries?: DeliveryExpectedDelta;
};
