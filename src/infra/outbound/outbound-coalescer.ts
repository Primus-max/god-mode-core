/**
 * NEW-C Phase 2 — `createOutboundCoalescer` factory STUB.
 *
 * Phase 2 lays down the DI seam (signature, types, telemetry helper).
 * Phase 3 will implement the bucket store, watchdog, merge strategy
 * (`drop_intermediates` + `merge_into_final`), and failure-isolated
 * `deliver` invocation. Until then, calling this factory throws a
 * structured error so any premature wiring surfaces immediately at
 * runtime — silent fall-through would defeat the slice's first runtime
 * gate for `Single_final_user_facing_message_per_user_turn`.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_outbound_coalescer.plan.md`.
 * Phase 1 audit: `extensions/AUDIT-outbound-coalescer.md`.
 */
import type {
  OutboundCoalescer,
  OutboundCoalescerDeps,
} from "./outbound-coalescer-types.js";

export type {
  OutboundCoalescer,
  OutboundCoalescerDeps,
  OutboundMessage,
  OutboundMessageKind,
  OutboundCoalescerLogEvent,
} from "./outbound-coalescer-types.js";

/**
 * Structured error thrown by the Phase 2 factory stub. Caller code
 * (Phase 4 emit-site wiring + Phase 5 finalize hook) must not depend
 * on this type — it exists only so the absence of an implementation
 * is explicit and grep-able. Phase 3 deletes this class along with
 * the throw.
 */
export class OutboundCoalescerNotImplementedError extends Error {
  readonly code = "outbound_coalescer_not_implemented" as const;
  readonly phase = 2 as const;
  constructor(message = "outbound-coalescer impl lands in Phase 3") {
    super(message);
    this.name = "OutboundCoalescerNotImplementedError";
  }
}

/**
 * Phase 2 stub. Validates the DI shape (so tests can verify the seam
 * end-to-end) then throws — Phase 3 replaces the throw with the real
 * bucket-store implementation.
 *
 * The validation pass is intentionally narrow: each `deps` field is
 * referenced exactly once so TypeScript catches structural drift in
 * the DI contract without running into "value never read" lint
 * warnings on the unused-binding axis.
 */
export function createOutboundCoalescer(deps: OutboundCoalescerDeps): OutboundCoalescer {
  // Reference each DI field once for structural validation. These
  // checks are placeholders — Phase 3's real impl will USE these
  // values; for now we only confirm the shape is wired through.
  if (typeof deps.deliver !== "function") {
    throw new OutboundCoalescerNotImplementedError(
      "outbound-coalescer: deps.deliver must be a function",
    );
  }
  if (deps.mergeStrategy !== "drop_intermediates" && deps.mergeStrategy !== "merge_into_final") {
    throw new OutboundCoalescerNotImplementedError(
      `outbound-coalescer: unknown mergeStrategy=${String(deps.mergeStrategy)}`,
    );
  }
  if (typeof deps.maxBufferMs !== "number" || deps.maxBufferMs <= 0) {
    throw new OutboundCoalescerNotImplementedError(
      "outbound-coalescer: deps.maxBufferMs must be a positive number",
    );
  }
  if (typeof deps.logTelemetry !== "function") {
    throw new OutboundCoalescerNotImplementedError(
      "outbound-coalescer: deps.logTelemetry must be a function",
    );
  }
  if (typeof deps.clockNow !== "function") {
    throw new OutboundCoalescerNotImplementedError(
      "outbound-coalescer: deps.clockNow must be a function",
    );
  }

  // Phase 3 lands the real implementation here.
  throw new OutboundCoalescerNotImplementedError();
}
