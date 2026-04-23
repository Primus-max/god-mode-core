import type { IntentLedger } from "../../session/intent-ledger.js";
import type { PlatformRuntimeExecutionReceipt } from "../contracts.js";
import type { PriorEvidenceProbe } from "../evidence-sufficiency.js";

function mapLedgerReceiptToRuntimeReceipt(
  receipt: Readonly<{
    kind: PlatformRuntimeExecutionReceipt["kind"];
    name: string;
    summary?: string;
    metadata?: Record<string, unknown>;
  }>,
): PlatformRuntimeExecutionReceipt {
  return {
    kind: receipt.kind,
    name: receipt.name,
    status: "success",
    proof: "reported",
    ...(receipt.summary ? { summary: receipt.summary } : {}),
    ...(receipt.metadata ? { metadata: receipt.metadata } : {}),
  };
}

export function buildLedgerPriorEvidence(params: {
  ledger: IntentLedger;
  sessionId: string;
  channelId: string;
  fingerprint: string;
}): PriorEvidenceProbe {
  const match = params.ledger.lookupRecentReceipt({
    sessionId: params.sessionId,
    channelId: params.channelId,
    fingerprint: params.fingerprint,
  });

  return {
    kind: "ledger",
    receipts: (match?.receipts ?? []).map(mapLedgerReceiptToRuntimeReceipt),
  };
}
