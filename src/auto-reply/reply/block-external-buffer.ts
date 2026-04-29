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

export function mergeExternalDeferredReplyPayloads(payloads: ReplyPayload[]): ReplyPayload {
  if (payloads.length === 0) {
    return {};
  }
  const last = payloads[payloads.length - 1];
  const texts = payloads.map((p) => p.text ?? "").filter((t) => t.length > 0);
  const text = texts.join("\n\n");
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
  const deferred: ReplyPayload[] = [];
  let structuralToolExecutionSeen = false;
  let finalized = false;

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
    const replay = deferred.splice(0);
    logVerbose(
      `[block-stream-buffer] event=replay_stream turnId=${params.turnId} sessionId=${params.sessionId ?? "?"} chunks=${count}`,
    );
    for (const payload of replay) {
      await Promise.resolve(inner(payload, {}));
    }
  }

  return {
    notifyStructuralToolExecutionStarting,
    wrapDeliver,
    finalizeAfterRun,
  };
}
