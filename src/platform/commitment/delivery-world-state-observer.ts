import type { DeliveryReceiptRegistry } from "./delivery-receipt-registry.js";
import type { DeliveryWorldState } from "./world-state.js";

export interface DeliveryWorldStateObserver {
  /**
   * Reads a deterministic snapshot of recorded delivery receipts.
   *
   * @returns Read-only `DeliveryWorldState` derived from the receipt registry.
   */
  observe(): DeliveryWorldState;
}

/**
 * Creates a read-only observer over an injected receipt registry.
 *
 * @param registry - Append-only registry written by the outbound pipeline.
 * @returns Observer that maps the registry into `DeliveryWorldState`.
 */
export function createDeliveryWorldStateObserver(
  registry: DeliveryReceiptRegistry,
): DeliveryWorldStateObserver {
  return Object.freeze({
    observe(): DeliveryWorldState {
      return Object.freeze({ receipts: registry.snapshot() });
    },
  });
}
