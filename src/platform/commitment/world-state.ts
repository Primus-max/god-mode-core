import { z } from "zod";
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

export type WebEvidenceRecord = {
  readonly url: string;
  readonly snippet: string;
  readonly title?: string;
  readonly capturedAt: ISO8601;
};

export type WebEvidenceWorldState = {
  readonly records: readonly WebEvidenceRecord[];
};

const ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * Closed-shape schema for a single `WebEvidenceRecord` parsed from the search
 * specialist's structured-JSON reply (Phase 4a). Validation rejects empty URLs
 * and malformed ISO-8601 timestamps so the runtime adapter can fall through
 * to the legacy single-model path on parse failure (no regression).
 *
 * The schema does not validate the URL beyond non-emptiness: the search
 * specialist (sonar/sonar-pro) is the only writer, and it cites real URLs by
 * design; URL semantic validation is an out-of-scope adversarial concern.
 */
export const webEvidenceRecordSchema = z
  .object({
    url: z.string().min(1),
    snippet: z.string(),
    title: z.string().optional(),
    capturedAt: z.string().regex(ISO8601_PATTERN),
  })
  .strict();

export type WorldStateSnapshot = {
  readonly sessions?: SessionWorldState;
  readonly artifacts?: ArtifactWorldState;
  readonly workspace?: WorkspaceWorldState;
  readonly deliveries?: DeliveryWorldState;
  readonly webEvidence?: WebEvidenceWorldState;
};
