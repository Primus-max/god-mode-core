import { logVerbose } from "../../globals.js";
import type { ReplyPayload } from "../types.js";

/**
 * Final consolidated reply delivery used by block-streaming external deferral (PR-A.2).
 * Structural-only gate — never inspect partial text for routing decisions.
 */
export type BlockReplyDeliver = (
  payload: ReplyPayload,
  options?: { abortSignal?: AbortSignal; timeoutMs?: number },
) => void | Promise<void>;

/**
 * Sentinel marker (slice H Phase 3, H2 fix). When set on a deferred
 * entry, `mergeExternalDeferredReplyPayloads` and the `replay` branch
 * keep the entry as the FIRST send/prefix so subagent ack ordering
 * survives consolidation. The marker is internal to this module — not
 * exported, not part of the public ReplyPayload type. The `Symbol`
 * keeps the field non-enumerable for downstream payload consumers
 * (channel adapters spread `...payload` and never see the sentinel).
 */
const ACK_SENTINEL: unique symbol = Symbol("block-external-buffer.ack-sentinel");
type AckSentinelEntry = ReplyPayload & { readonly [ACK_SENTINEL]?: true };

export function mergeExternalDeferredReplyPayloads(payloads: ReplyPayload[]): ReplyPayload {
  if (payloads.length === 0) {
    return {};
  }
  // Slice H Phase 3 (H2 sentinel): if an ack entry is present, keep it
  // as the FIRST text fragment of the merged result regardless of its
  // position in the input array. Other entries preserve relative order.
  // Non-ack callers see identical behaviour to the pre-fix path.
  const ackIndex = (payloads as AckSentinelEntry[]).findIndex(
    (p) => p[ACK_SENTINEL] === true,
  );
  let ordered: ReplyPayload[];
  if (ackIndex >= 0) {
    const ackEntry = payloads[ackIndex];
    if (ackEntry !== undefined) {
      const rest = payloads.filter((_, i) => i !== ackIndex);
      ordered = [ackEntry, ...rest];
    } else {
      ordered = payloads;
    }
  } else {
    ordered = payloads;
  }
  const last = ordered[ordered.length - 1];
  const texts = ordered.map((p) => p.text ?? "").filter((t) => t.length > 0);
  const text = texts.join("\n\n");
  // Strip the internal ACK_SENTINEL symbol before returning — channel
  // adapters must not observe internal markers.
  if (last && (last as AckSentinelEntry)[ACK_SENTINEL]) {
    const { [ACK_SENTINEL]: _ignored, ...clean } = last as AckSentinelEntry;
    void _ignored;
    return { ...clean, text };
  }
  return { ...last, text };
}

/** Pure helper for idempotent broker replay tests (forward-compat). */
export function externalBufferFinalizeKind(
  structuralToolExecutionSeen: boolean,
  deferredCount: number,
): "none" | "consolidated" | "replay" {
  if (deferredCount <= 0) {
    return "none";
  }
  return structuralToolExecutionSeen ? "consolidated" : "replay";
}

export function createExternalBlockReplyDeferral(params: {
  turnId: string;
  sessionId?: string;
}) {
  const deferred: AckSentinelEntry[] = [];
  let structuralToolExecutionSeen = false;
  let finalized = false;
  // Idempotency guard for `enqueueAck` (sub-plan §6 implementation
  // note: a duplicate `emitDeferredAck` call must not insert a second
  // ack entry). A single ack per deferral instance — the parent
  // `agent-runner.ts:851` `didEmitDeferredAck` guard already enforces
  // this on the runner side; we mirror it here for defense-in-depth
  // (invariant #15) so direct callers of the deferral API stay safe.
  let didEnqueueAck = false;

  function notifyStructuralToolExecutionStarting() {
    if (finalized) {
      return;
    }
    structuralToolExecutionSeen = true;
    logVerbose(
      `[block-stream-buffer] event=structural_tool_seen turnId=${params.turnId} sessionId=${params.sessionId ?? "?"}`,
    );
  }

  function wrapDeliver(inner: BlockReplyDeliver): BlockReplyDeliver {
    return (payload, options) => {
      if (finalized) {
        return inner(payload, options);
      }
      deferred.push({ ...payload });
      return Promise.resolve();
    };
  }

  /**
   * Slice H Phase 3 (H2): enqueue a subagent ack as a sentinel entry
   * inside the deferred buffer. Replaces the `agent-runner.ts:866`
   * bypass (`effectiveOpts?.onBlockReply`) so the ack participates in
   * the same ordering pipeline as the streamed preamble + final tail.
   *
   * Behaviour:
   *   - Idempotent: a second call is a no-op (sub-plan §6 idempotency).
   *   - Post-finalize: ignored (the finalize branch already shipped).
   *   - The sentinel is a `Symbol` so spread-based payload consumers
   *     never observe it (channel adapters do `{ ...payload }`).
   */
  async function enqueueAck(payload: ReplyPayload): Promise<void> {
    if (finalized || didEnqueueAck) {
      return;
    }
    didEnqueueAck = true;
    const entry: AckSentinelEntry = { ...payload, [ACK_SENTINEL]: true };
    deferred.push(entry);
    logVerbose(
      `[block-stream-buffer] event=ack_queued turnId=${params.turnId} sessionId=${params.sessionId ?? "?"}`,
    );
  }

  async function finalizeAfterRun(inner: BlockReplyDeliver) {
    if (finalized) {
      return;
    }
    finalized = true;
    const count = deferred.length;
    if (count === 0) {
      return;
    }
    if (structuralToolExecutionSeen) {
      const merged = mergeExternalDeferredReplyPayloads(deferred);
      deferred.length = 0;
      logVerbose(
        `[block-stream-buffer] event=emit_consolidated turnId=${params.turnId} sessionId=${params.sessionId ?? "?"} chunks=${count}`,
      );
      await Promise.resolve(inner(merged, {}));
      return;
    }
    // Slice H Phase 3 (H2 replay branch): when no structural tool
    // fired, ack still rides as the FIRST replayed entry so the
    // recorded ordering is `[ack, partial-1, partial-2, ...]`. Other
    // entries preserve insertion order.
    const ackIdx = deferred.findIndex((p) => p[ACK_SENTINEL] === true);
    let replay: ReplyPayload[];
    if (ackIdx >= 0) {
      const ackEntry = deferred[ackIdx];
      if (ackEntry !== undefined) {
        const rest = deferred.filter((_, i) => i !== ackIdx);
        replay = [ackEntry, ...rest];
      } else {
        replay = deferred.slice();
      }
      deferred.length = 0;
    } else {
      replay = deferred.splice(0);
    }
    logVerbose(
      `[block-stream-buffer] event=replay_stream turnId=${params.turnId} sessionId=${params.sessionId ?? "?"} chunks=${count}`,
    );
    for (const payload of replay) {
      // Strip the sentinel symbol before handing payload to the inner
      // adapter — channel-side code must not observe internal markers.
      const { [ACK_SENTINEL]: _ignored, ...clean } = payload as AckSentinelEntry;
      void _ignored;
      await Promise.resolve(inner(clean as ReplyPayload, {}));
    }
  }

  return {
    notifyStructuralToolExecutionStarting,
    wrapDeliver,
    enqueueAck,
    finalizeAfterRun,
  };
}
