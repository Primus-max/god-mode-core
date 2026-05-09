// SUPERSEDED: brand types live at src/platform/identity/branded-ids.ts.
// Re-exported here for source-compat during the kernel-delete migration
// (S11b). Delete this file when S11 lands.
export type {
  CommitmentId,
  AffordanceId,
  EffectFamilyId,
  EffectId,
  PreconditionId,
  ChannelId,
  SessionId,
  AgentId,
  SessionKey,
  ISO8601,
  ReadonlyRecord,
} from "../identity/branded-ids.js";
