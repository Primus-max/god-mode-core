import { describe, expect, it } from "vitest";
import type {
  PlatformRuntimeExecutionReceipt,
  PlatformRuntimeExecutionReceiptKind,
  PlatformRuntimeExecutionReceiptProof,
  PlatformRuntimeExecutionReceiptStatus,
} from "../runtime/contracts.js";
import { reconcilePromisesWithReceipts } from "./execution-evidence.js";
import type { IntentLedgerEntry } from "./intent-ledger.js";

const FIXED_NOW = 1_800_000_000_000;

function buildPromise(overrides: Partial<IntentLedgerEntry> = {}): IntentLedgerEntry {
  const hasExplicitMatchers = Object.prototype.hasOwnProperty.call(
    overrides,
    "receiptMatchers",
  );
  const matchers = hasExplicitMatchers
    ? overrides.receiptMatchers
    : {
        receiptKinds: ["tool", "platform_action"] as PlatformRuntimeExecutionReceiptKind[],
        toolNames: ["exec"],
      };
  return {
    id: overrides.id ?? "turn-1:1",
    turnId: overrides.turnId ?? "turn-1",
    sessionId: overrides.sessionId ?? "session-a",
    channelId: overrides.channelId ?? "telegram",
    kind: overrides.kind ?? "promised_action",
    summary: overrides.summary ?? "Принял, запускаю node --version прямо сейчас.",
    expectsFrom: overrides.expectsFrom ?? "system",
    createdAt: overrides.createdAt ?? FIXED_NOW - 1_000,
    ttlMs: overrides.ttlMs ?? 60_000,
    ...(matchers
      ? {
          receiptMatchers: {
            ...(matchers.receiptKinds
              ? { receiptKinds: [...matchers.receiptKinds] }
              : {}),
            ...(matchers.toolNames ? { toolNames: [...matchers.toolNames] } : {}),
          },
        }
      : {}),
  };
}

function buildReceipt(overrides: {
  kind?: PlatformRuntimeExecutionReceiptKind;
  name?: string;
  status?: PlatformRuntimeExecutionReceiptStatus;
  proof?: PlatformRuntimeExecutionReceiptProof;
  summary?: string;
} = {}): PlatformRuntimeExecutionReceipt {
  return {
    kind: overrides.kind ?? "tool",
    name: overrides.name ?? "exec",
    status: overrides.status ?? "success",
    proof: overrides.proof ?? "reported",
    ...(overrides.summary ? { summary: overrides.summary } : {}),
  };
}

describe("reconcilePromisesWithReceipts", () => {
  it("returns empty when there are no pending promises", () => {
    const violations = reconcilePromisesWithReceipts({
      pendingPromises: [],
      receipts: [buildReceipt()],
      now: () => FIXED_NOW,
    });
    expect(violations).toEqual([]);
  });

  it("ignores ledger entries that are not promised_action", () => {
    const violations = reconcilePromisesWithReceipts({
      pendingPromises: [
        buildPromise({ kind: "awaiting_confirmation", summary: "Подтверди, да/нет?" }),
        buildPromise({ kind: "clarifying", summary: "Расскажи подробнее." }),
      ],
      receipts: [],
      now: () => FIXED_NOW,
    });
    expect(violations).toEqual([]);
  });

  it("flags a hard violation when promise exists but no receipts arrive", () => {
    const promise = buildPromise();
    const violations = reconcilePromisesWithReceipts({
      pendingPromises: [promise],
      receipts: [],
      now: () => FIXED_NOW,
    });
    expect(violations).toHaveLength(1);
    const violation = violations[0]!;
    expect(violation.ledgerEntryId).toBe(promise.id);
    expect(violation.turnId).toBe(promise.turnId);
    expect(violation.severity).toBe("hard");
    expect(violation.expectedReceiptKinds).toEqual(["tool", "platform_action"]);
    expect(violation.expectedToolNames).toEqual(["exec"]);
    expect(violation.observedReceiptKinds).toEqual([]);
    expect(violation.createdAt).toBe(FIXED_NOW);
  });

  it("returns no violation when a matching tool receipt with success is present", () => {
    const violations = reconcilePromisesWithReceipts({
      pendingPromises: [buildPromise()],
      receipts: [buildReceipt({ kind: "tool", name: "exec", status: "success" })],
      now: () => FIXED_NOW,
    });
    expect(violations).toEqual([]);
  });

  it("accepts partial status as satisfying the promise", () => {
    const violations = reconcilePromisesWithReceipts({
      pendingPromises: [buildPromise()],
      receipts: [buildReceipt({ kind: "tool", name: "exec", status: "partial" })],
      now: () => FIXED_NOW,
    });
    expect(violations).toEqual([]);
  });

  it("does not accept failed receipts as satisfying the promise", () => {
    const violations = reconcilePromisesWithReceipts({
      pendingPromises: [buildPromise()],
      receipts: [buildReceipt({ kind: "tool", name: "exec", status: "failed" })],
      now: () => FIXED_NOW,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe("hard");
    expect(violations[0]?.observedReceiptKinds).toEqual([]);
  });

  it("filters by expected receipt kind — capability receipt does not satisfy default tool expectation", () => {
    const violations = reconcilePromisesWithReceipts({
      pendingPromises: [buildPromise()],
      receipts: [buildReceipt({ kind: "capability", name: "exec", status: "success" })],
      now: () => FIXED_NOW,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe("hard");
    expect(violations[0]?.observedReceiptKinds).toEqual(["capability"]);
  });

  it("filters by toolName when matcher specifies it — other tool receipts do not match", () => {
    const violations = reconcilePromisesWithReceipts({
      pendingPromises: [buildPromise()],
      receipts: [buildReceipt({ kind: "tool", name: "apply_patch", status: "success" })],
      now: () => FIXED_NOW,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe("hard");
  });

  it("matches platform_action receipt when matcher kinds include it", () => {
    const promise = buildPromise({
      summary: "Применяю патч к файлу прямо сейчас.",
      receiptMatchers: {
        receiptKinds: ["tool", "platform_action"],
        toolNames: ["apply_patch"],
      },
    });
    const violations = reconcilePromisesWithReceipts({
      pendingPromises: [promise],
      receipts: [
        buildReceipt({ kind: "platform_action", name: "apply_patch", status: "success" }),
      ],
      now: () => FIXED_NOW,
    });
    expect(violations).toEqual([]);
  });

  it("uses default expected kinds [tool, platform_action] when receiptMatchers is absent", () => {
    const promise = buildPromise({ receiptMatchers: undefined });
    const violations = reconcilePromisesWithReceipts({
      pendingPromises: [promise],
      receipts: [
        buildReceipt({ kind: "platform_action", name: "session.persist", status: "success" }),
      ],
      now: () => FIXED_NOW,
    });
    expect(violations).toEqual([]);
  });

  it("marks soft severity when promise wording is deferred — сейчас сделаю", () => {
    const promise = buildPromise({
      id: "turn-2:1",
      turnId: "turn-2",
      summary: "Ок, сейчас сделаю, подожди немного.",
    });
    const violations = reconcilePromisesWithReceipts({
      pendingPromises: [promise],
      receipts: [],
      now: () => FIXED_NOW,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe("soft");
  });

  it("marks soft severity when promise wording is deferred — потом/после", () => {
    const promise = buildPromise({
      id: "turn-3:1",
      turnId: "turn-3",
      summary: "Запущу node --version после того как освобожусь.",
    });
    const violations = reconcilePromisesWithReceipts({
      pendingPromises: [promise],
      receipts: [],
      now: () => FIXED_NOW,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe("soft");
  });

  it("reports observedReceiptKinds from eligible receipts when violation is produced", () => {
    const promise = buildPromise();
    const violations = reconcilePromisesWithReceipts({
      pendingPromises: [promise],
      receipts: [
        buildReceipt({ kind: "provider_model", name: "openai/gpt", status: "success" }),
        buildReceipt({ kind: "messaging_delivery", name: "delivery.telegram", status: "success" }),
      ],
      now: () => FIXED_NOW,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.observedReceiptKinds.sort()).toEqual(
      ["messaging_delivery", "provider_model"].sort(),
    );
  });

  it("emits one violation per unmatched promise when multiple promises are pending", () => {
    const promiseA = buildPromise({ id: "turn-4:a", turnId: "turn-4" });
    const promiseB = buildPromise({
      id: "turn-4:b",
      turnId: "turn-4",
      summary: "Применяю патч прямо сейчас.",
      receiptMatchers: {
        receiptKinds: ["tool", "platform_action"],
        toolNames: ["apply_patch"],
      },
    });
    const violations = reconcilePromisesWithReceipts({
      pendingPromises: [promiseA, promiseB],
      receipts: [buildReceipt({ kind: "tool", name: "exec", status: "success" })],
      now: () => FIXED_NOW,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.ledgerEntryId).toBe(promiseB.id);
  });

  it("does not flag a promise when any one matching receipt is present (multi-receipt run)", () => {
    const violations = reconcilePromisesWithReceipts({
      pendingPromises: [buildPromise()],
      receipts: [
        buildReceipt({ kind: "provider_model", name: "openai/gpt", status: "success" }),
        buildReceipt({ kind: "tool", name: "exec", status: "success" }),
        buildReceipt({ kind: "messaging_delivery", name: "delivery.telegram", status: "success" }),
      ],
      now: () => FIXED_NOW,
    });
    expect(violations).toEqual([]);
  });
});
