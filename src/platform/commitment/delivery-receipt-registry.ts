import type { DeliveryReceipt } from "./world-state.js";

const DEFAULT_PER_CONTEXT_LIMIT = 64;

export interface DeliveryReceiptRegistry {
  /**
   * Records a delivery receipt for the given delivery context key.
   *
   * Idempotency: receipts with the same `messageId` for the same context are
   * deduplicated; the registry keeps the most recent at the tail.
   *
   * @param receipt - Receipt produced by the outbound delivery pipeline.
   */
  record(receipt: DeliveryReceipt): void;

  /**
   * Reads the receipts recorded for a single delivery context key.
   *
   * @param deliveryContextKey - Normalized delivery context key.
   * @returns Read-only list, oldest first.
   */
  list(deliveryContextKey: string): readonly DeliveryReceipt[];

  /**
   * Reads a frozen snapshot of every recorded receipt grouped by context key.
   *
   * @returns Frozen `Record<deliveryContextKey, readonly DeliveryReceipt[]>`.
   */
  snapshot(): Readonly<Record<string, readonly DeliveryReceipt[]>>;

  /**
   * Removes every recorded receipt; intended for tests and graceful shutdown.
   */
  clear(): void;
}

export type CreateDeliveryReceiptRegistryOptions = {
  /**
   * Soft cap on the number of receipts retained per context key. Older
   * receipts are dropped from the head when exceeded. Defaults to 64.
   */
  readonly perContextLimit?: number;
};

class InMemoryDeliveryReceiptRegistry implements DeliveryReceiptRegistry {
  readonly #buckets = new Map<string, DeliveryReceipt[]>();
  readonly #perContextLimit: number;

  constructor(options: CreateDeliveryReceiptRegistryOptions) {
    this.#perContextLimit = Math.max(1, options.perContextLimit ?? DEFAULT_PER_CONTEXT_LIMIT);
  }

  record(receipt: DeliveryReceipt): void {
    const bucket = this.#buckets.get(receipt.deliveryContextKey) ?? [];
    const filtered = bucket.filter((entry) => entry.messageId !== receipt.messageId);
    filtered.push(Object.freeze({ ...receipt }));
    while (filtered.length > this.#perContextLimit) {
      filtered.shift();
    }
    this.#buckets.set(receipt.deliveryContextKey, filtered);
  }

  list(deliveryContextKey: string): readonly DeliveryReceipt[] {
    const bucket = this.#buckets.get(deliveryContextKey);
    return bucket ? Object.freeze([...bucket]) : EMPTY_RECEIPTS;
  }

  snapshot(): Readonly<Record<string, readonly DeliveryReceipt[]>> {
    const out: Record<string, readonly DeliveryReceipt[]> = {};
    for (const [key, bucket] of this.#buckets.entries()) {
      out[key] = Object.freeze([...bucket]);
    }
    return Object.freeze(out);
  }

  clear(): void {
    this.#buckets.clear();
  }
}

const EMPTY_RECEIPTS: readonly DeliveryReceipt[] = Object.freeze([]);

/**
 * Creates an in-memory delivery receipt registry used by the deliveries
 * `WorldStateObserver`.
 *
 * @param options - Optional capacity tuning.
 * @returns Frozen registry handle.
 */
export function createDeliveryReceiptRegistry(
  options: CreateDeliveryReceiptRegistryOptions = {},
): DeliveryReceiptRegistry {
  const registry = new InMemoryDeliveryReceiptRegistry(options);
  return registry;
}

let processRegistry: DeliveryReceiptRegistry | undefined;

/**
 * Returns the lazily-initialized process-scoped delivery receipt registry.
 *
 * The outbound pipeline writes to this registry; the kernel's deliveries
 * observer reads from it. Tests can inject a fixture by clearing the registry
 * via `clear()` between cases.
 *
 * @returns Singleton registry shared across the running process.
 */
export function getProcessDeliveryReceiptRegistry(): DeliveryReceiptRegistry {
  if (!processRegistry) {
    processRegistry = createDeliveryReceiptRegistry();
  }
  return processRegistry;
}

/**
 * Replaces the process registry; used by integration tests that need a
 * deterministic instance distinct from the singleton lifecycle.
 *
 * @param registry - Replacement registry, or `undefined` to reset.
 */
export function setProcessDeliveryReceiptRegistryForTests(
  registry: DeliveryReceiptRegistry | undefined,
): void {
  processRegistry = registry;
}
