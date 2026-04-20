import type {
  PlatformRuntimeExecutionReceipt,
  PlatformRuntimeExecutionReceiptKind,
  PlatformRuntimeExecutionReceiptStatus,
  PlatformRuntimeExecutionVerification,
} from "../runtime/contracts.js";
import type { IntentLedgerEntry } from "./intent-ledger.js";

export type PromisedActionViolation = {
  ledgerEntryId: string;
  turnId: string;
  summary: string;
  expectedReceiptKinds: PlatformRuntimeExecutionReceiptKind[];
  expectedToolNames?: string[];
  observedReceiptKinds: PlatformRuntimeExecutionReceiptKind[];
  severity: "hard" | "soft";
  createdAt: number;
};

export type ReconcilePromisesParams = {
  pendingPromises: IntentLedgerEntry[];
  receipts: PlatformRuntimeExecutionReceipt[];
  verification?: PlatformRuntimeExecutionVerification;
  now?: () => number;
};

const DEFAULT_EXPECTED_RECEIPT_KINDS: PlatformRuntimeExecutionReceiptKind[] = [
  "tool",
  "platform_action",
];

const SATISFYING_STATUSES = new Set<PlatformRuntimeExecutionReceiptStatus>([
  "success",
  "partial",
]);

// Deferred wording signals a soft violation — bot promised to do it later, not now.
const SOFT_PROMISE_WORDING_RE =
  /(сейчас\s+сделаю|как\s+только|потом|после|позже|чуть\s+позже|попозже|later|i['’]?ll\s+do\s+it\s+later|will\s+do\s+later)/i;

function toLowerSafe(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function receiptToolName(receipt: PlatformRuntimeExecutionReceipt): string {
  return toLowerSafe(receipt.name);
}

function toolNameMatches(
  receipt: PlatformRuntimeExecutionReceipt,
  expected: readonly string[],
): boolean {
  if (expected.length === 0) {
    return true;
  }
  const name = receiptToolName(receipt);
  if (!name) {
    return false;
  }
  return expected.some((expectedName) => {
    const normalized = expectedName.toLowerCase();
    return name === normalized || name.includes(normalized);
  });
}

function isReceiptMatching(
  receipt: PlatformRuntimeExecutionReceipt,
  expectedKinds: readonly PlatformRuntimeExecutionReceiptKind[],
  expectedToolNames: readonly string[],
): boolean {
  if (!SATISFYING_STATUSES.has(receipt.status)) {
    return false;
  }
  if (!expectedKinds.includes(receipt.kind)) {
    return false;
  }
  return toolNameMatches(receipt, expectedToolNames);
}

function observedKindsFromReceipts(
  receipts: readonly PlatformRuntimeExecutionReceipt[],
): PlatformRuntimeExecutionReceiptKind[] {
  const seen = new Set<PlatformRuntimeExecutionReceiptKind>();
  for (const receipt of receipts) {
    if (SATISFYING_STATUSES.has(receipt.status)) {
      seen.add(receipt.kind);
    }
  }
  return [...seen];
}

function resolveSeverity(summary: string): "hard" | "soft" {
  return SOFT_PROMISE_WORDING_RE.test(summary) ? "soft" : "hard";
}

export function reconcilePromisesWithReceipts(
  params: ReconcilePromisesParams,
): PromisedActionViolation[] {
  const promises = (params.pendingPromises ?? []).filter(
    (entry) => entry.kind === "promised_action",
  );
  if (promises.length === 0) {
    return [];
  }
  const receipts = params.receipts ?? [];
  const observedReceiptKinds = observedKindsFromReceipts(receipts);
  const now = params.now ?? (() => Date.now());
  const violations: PromisedActionViolation[] = [];
  for (const promise of promises) {
    const matcherKinds = promise.receiptMatchers?.receiptKinds;
    const expectedKinds =
      matcherKinds && matcherKinds.length > 0
        ? [...matcherKinds]
        : [...DEFAULT_EXPECTED_RECEIPT_KINDS];
    const expectedToolNames = promise.receiptMatchers?.toolNames ?? [];
    const satisfied = receipts.some((receipt) =>
      isReceiptMatching(receipt, expectedKinds, expectedToolNames),
    );
    if (satisfied) {
      continue;
    }
    const severity = resolveSeverity(promise.summary);
    violations.push({
      ledgerEntryId: promise.id,
      turnId: promise.turnId,
      summary: promise.summary,
      expectedReceiptKinds: expectedKinds,
      ...(expectedToolNames.length > 0
        ? { expectedToolNames: [...expectedToolNames] }
        : {}),
      observedReceiptKinds,
      severity,
      createdAt: now(),
    });
  }
  return violations;
}
