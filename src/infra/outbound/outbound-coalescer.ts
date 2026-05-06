/**
 * NEW-C Phase 3 — `createOutboundCoalescer` impl.
 *
 * Replaces the Phase 2 throw stub with the real bucket-store + watchdog
 * implementation. The coalescer enforces the contractual invariant
 * `Single_final_user_facing_message_per_user_turn` (master §0.5.6 +
 * master §3 prose) by aggregating multi-emit-site assistant replies
 * keyed on `(turnId, channelKey)` and committing exactly one merged
 * payload per bucket through the injected `deps.deliver`.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_outbound_coalescer.plan.md`.
 * Phase 1 audit: `extensions/AUDIT-outbound-coalescer.md`.
 *
 * Соответствие 16 hard invariants:
 * - #5: ключ `(turnId, channelKey)` структурный; body — opaque
 *   `ReplyPayload`; merge стратегии работают только с `body.text` как
 *   с непрозрачной строкой (никаких regex / pattern matching на
 *   `UserPrompt` / `RawUserTurn`).
 * - #6: `IntentContractor` остаётся единственным reader сырого user
 *   text; модуль не читает user prompt.
 * - #8: лежит в `src/infra/outbound/`, вне обоих
 *   `src/platform/commitment/` и `src/platform/decision/`; не
 *   импортирует из них.
 * - #11: 5 frozen contracts byte-identical; этот модуль не трогает их.
 * - #15: blanket signoff (2026-05-05); failure isolation per-bucket —
 *   `deps.deliver` бросает → лог warn, бакет очищается, watchdog
 *   снимается, остальные turn'ы продолжают обслуживаться.
 * - #16: никаких новых brand'ов; `turnId` aliased `runId`,
 *   `channelKey` — обычный structural string.
 *
 * Архитектурные ключевые точки:
 * - Two-level Map: `Map<channelKey, Map<turnId, OutboundMessage[]>>`
 *   обеспечивает O(1) lookup на register/commit. Cross-turn isolation
 *   реализована автоматически — бакеты разных runId никогда не
 *   сталкиваются на одном channelKey.
 * - Per-bucket watchdog `setTimeout(maxBufferMs)` стартует на первый
 *   register; снимается на commit / deliver-throw / явный вызов.
 * - `drop_intermediates` стратегия зеркалит slice H Phase 3
 *   ACK_SENTINEL ordering: ack-фрагменты префиксируются перед
 *   committed final body, intermediate-фрагменты дропаются.
 * - `merge_into_final` стратегия: `text` поля конкатенируются через
 *   `\n\n`, метаданные последнего entry (replyToId, threadId, audio
 *   flags) служат envelope.
 * - Idempotent commit: повторный вызов на пустой бакет = noop с
 *   `event=commit_noop`. Это нужно для случая, когда primary
 *   `commitmentSatisfied===true` edge и fallback `finalizeAfterRun`
 *   срабатывают оба (Phase 5 вернётся к этому).
 */
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { BlockReplyDeliver } from "../../auto-reply/reply/block-external-buffer.js";
import {
  BYPASS_REASONS,
  formatOutboundCoalescerLog,
  isBypassReason,
  type BypassReason,
  type OutboundCoalescer,
  type OutboundCoalescerDeps,
  type OutboundMessage,
  type OutboundMessageKind,
} from "./outbound-coalescer-types.js";

export type {
  BypassReason,
  OutboundCoalescer,
  OutboundCoalescerDeps,
  OutboundMessage,
  OutboundMessageKind,
  OutboundCoalescerLogEvent,
} from "./outbound-coalescer-types.js";

export { BYPASS_REASONS, isBypassReason } from "./outbound-coalescer-types.js";

/**
 * Phase 2 throw-stub error retained for one-import-cycle to keep the
 * `OutboundCoalescerNotImplementedError` symbol stable for any
 * pre-Phase-3 callers (Phase 2 tests still import it). Phase 3 still
 * throws this for invalid DI shapes — the only way it reaches a caller
 * now is via a misconfigured factory.
 */
export class OutboundCoalescerNotImplementedError extends Error {
  readonly code = "outbound_coalescer_not_implemented" as const;
  readonly phase = 2 as const;
  constructor(message = "outbound-coalescer impl lands in Phase 3") {
    super(message);
    this.name = "OutboundCoalescerNotImplementedError";
  }
}

type Bucket = {
  messages: OutboundMessage[];
  watchdog: ReturnType<typeof setTimeout> | null;
  startedAt: number;
};

/**
 * Two-level bucket store: outer key channelKey, inner key turnId.
 * Choosing channel-first keeps `commitAll(turnId)` simple — iterate
 * outer map and pull `turnId` entry from each.
 */
type BucketStore = Map<string, Map<string, Bucket>>;

function getBucket(
  store: BucketStore,
  turnId: string,
  channelKey: string,
): Bucket | undefined {
  return store.get(channelKey)?.get(turnId);
}

function deleteBucket(
  store: BucketStore,
  turnId: string,
  channelKey: string,
): void {
  const inner = store.get(channelKey);
  if (!inner) {
    return;
  }
  inner.delete(turnId);
  if (inner.size === 0) {
    store.delete(channelKey);
  }
}

function ensureBucket(
  store: BucketStore,
  msg: OutboundMessage,
  startedAt: number,
): Bucket {
  let inner = store.get(msg.channelKey);
  if (!inner) {
    inner = new Map<string, Bucket>();
    store.set(msg.channelKey, inner);
  }
  let bucket = inner.get(msg.turnId);
  if (!bucket) {
    bucket = { messages: [], watchdog: null, startedAt };
    inner.set(msg.turnId, bucket);
  }
  return bucket;
}

function pickLastByKind(
  messages: OutboundMessage[],
  kind: OutboundMessageKind,
): OutboundMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.kind === kind) {
      return m;
    }
  }
  return undefined;
}

/**
 * `drop_intermediates` merge — slice H Phase 3 ACK_SENTINEL parity.
 *
 * Behaviour:
 * 1. Pick the canonical body — last `final` if any, otherwise last
 *    `intermediate`. (Per sub-plan §3 (c).)
 * 2. Concatenate every `ack` body's text as a `\n\n`-separated prefix
 *    in arrival order ahead of the canonical body.
 * 3. Other intermediates are dropped.
 * 4. Metadata (replyToId, threadId, audio flags, etc.) comes from the
 *    canonical body only — ack entries do not contribute envelope
 *    fields.
 */
function mergeDropIntermediates(messages: OutboundMessage[]): {
  payload: ReplyPayload;
  finalKind: OutboundMessageKind;
} | null {
  if (messages.length === 0) {
    return null;
  }
  const canonical = pickLastByKind(messages, "final") ?? pickLastByKind(messages, "intermediate");
  if (!canonical) {
    // Only ack/preamble entries → use the last entry as canonical so
    // we still ship something rather than dropping the whole bucket.
    const last = messages[messages.length - 1];
    if (!last) {
      return null;
    }
    const ackTexts = messages
      .slice(0, -1)
      .filter((m) => m.kind === "ack")
      .map((m) => m.body.text ?? "")
      .filter((t) => t.length > 0);
    const tail = last.body.text ?? "";
    const text = [...ackTexts, tail].filter((t) => t.length > 0).join("\n\n");
    return {
      payload: text.length > 0 ? { ...last.body, text } : { ...last.body },
      finalKind: last.kind,
    };
  }
  const ackTexts = messages
    .filter((m) => m.kind === "ack")
    .map((m) => m.body.text ?? "")
    .filter((t) => t.length > 0);
  const canonicalText = canonical.body.text ?? "";
  const merged = [...ackTexts, canonicalText].filter((t) => t.length > 0).join("\n\n");
  return {
    payload: merged.length > 0 ? { ...canonical.body, text: merged } : { ...canonical.body },
    finalKind: canonical.kind,
  };
}

/**
 * `merge_into_final` merge — concatenate all body texts in arrival
 * order joined by `\n\n`. The last entry's body acts as the canonical
 * envelope (replyToId / threadId / audio flags); its `text` is replaced
 * with the joined string.
 */
function mergeIntoFinal(messages: OutboundMessage[]): {
  payload: ReplyPayload;
  finalKind: OutboundMessageKind;
} | null {
  if (messages.length === 0) {
    return null;
  }
  const last = messages[messages.length - 1];
  if (!last) {
    return null;
  }
  const text = messages
    .map((m) => m.body.text ?? "")
    .filter((t) => t.length > 0)
    .join("\n\n");
  return {
    payload: text.length > 0 ? { ...last.body, text } : { ...last.body },
    finalKind: last.kind,
  };
}

/**
 * Snapshot of merge `kind` distribution for telemetry. Exposed via
 * `[outbound-coalescer] event=committed drop_kinds=[...]` so operators
 * can correlate merged buckets with the emit-sites they came from.
 */
function summariseKinds(messages: OutboundMessage[]): string[] {
  return messages.map((m) => m.kind);
}

/**
 * Flatten an unknown error into a single-line string for the
 * `event=deliver_failed err=<msg>` telemetry. Mirrors the pattern in
 * slice E `memory-write-on-satisfied.ts`.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Phase 3 impl. Validates the DI shape (preserves Phase 2 stub
 * behaviour for malformed deps) and constructs the bucket store +
 * watchdog management. One instance per `runReplyAgent` invocation
 * (slice E P3 `createExternalBlockReplyDeferral` lifecycle precedent).
 */
export function createOutboundCoalescer(deps: OutboundCoalescerDeps): OutboundCoalescer {
  if (typeof deps.deliver !== "function") {
    throw new OutboundCoalescerNotImplementedError(
      "outbound-coalescer: deps.deliver must be a function",
    );
  }
  if (
    deps.mergeStrategy !== "drop_intermediates" &&
    deps.mergeStrategy !== "merge_into_final"
  ) {
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

  const store: BucketStore = new Map();

  function clearWatchdog(bucket: Bucket): void {
    if (bucket.watchdog !== null) {
      clearTimeout(bucket.watchdog);
      bucket.watchdog = null;
    }
  }

  /**
   * Internal commit primitive. Caller decides the commit `source` —
   * `manual` (explicit `commit` / `commitAll`) or `watchdog`
   * (timeout). Returns `true` if a delivery was attempted (success or
   * isolated failure), `false` if bucket was empty.
   */
  async function commitBucket(
    turnId: string,
    channelKey: string,
    source: "manual" | "watchdog",
    waitedMs: number | null,
  ): Promise<boolean> {
    const bucket = getBucket(store, turnId, channelKey);
    if (!bucket || bucket.messages.length === 0) {
      // Empty / missing bucket — noop. Caller already checked for the
      // `manual` case; this handles the race where two commits collide.
      if (source === "manual") {
        deps.logTelemetry(
          formatOutboundCoalescerLog("commit_noop", {
            turnId,
            channel: channelKey,
          }),
        );
      }
      // Defensive cleanup if bucket existed but was emptied.
      if (bucket) {
        clearWatchdog(bucket);
        deleteBucket(store, turnId, channelKey);
      }
      return false;
    }

    // Stable sort by ts (arrival order). Array#sort in V8 is stable
    // for objects; we rely on that here.
    const messages = [...bucket.messages].sort((a, b) => a.ts - b.ts);
    const merged =
      deps.mergeStrategy === "merge_into_final"
        ? mergeIntoFinal(messages)
        : mergeDropIntermediates(messages);

    // Drop bucket BEFORE deliver so a deliver-throw cannot leave
    // dangling state and a retry from the SAME (turnId, channelKey)
    // becomes a fresh bucket.
    clearWatchdog(bucket);
    deleteBucket(store, turnId, channelKey);

    if (merged === null) {
      // messages.length > 0 but merge returned null — defensive
      // branch; should be unreachable.
      return false;
    }

    if (source === "watchdog") {
      // NEW-C Phase 5 — distinguish commit source via the
      // `commit_signal` event for telemetry parity with the primary
      // (`commit-outbound-on-satisfied` hook) and fallback
      // (`agent-runner.ts` finalizeAfterRun finally block) edges. The
      // pre-existing `timeout_committed` event is kept so operators
      // already grepping for it stay green.
      deps.logTelemetry(
        formatOutboundCoalescerLog("commit_signal", {
          turnId,
          source: "watchdog",
        }),
      );
      deps.logTelemetry(
        formatOutboundCoalescerLog("timeout_committed", {
          turnId,
          channel: channelKey,
          waited_ms: waitedMs ?? deps.maxBufferMs,
        }),
      );
    }

    deps.logTelemetry(
      formatOutboundCoalescerLog("committed", {
        turnId,
        channel: channelKey,
        messages_merged: messages.length,
        final_kind: merged.finalKind,
        drop_kinds: summariseKinds(messages),
      }),
    );

    try {
      await Promise.resolve(deps.deliver(merged.payload));
    } catch (err) {
      // Failure isolation per invariant #15 — bucket already cleared,
      // watchdog already cleared. Log warn, do NOT propagate. Coalescer
      // continues serving other turns.
      deps.logTelemetry(
        formatOutboundCoalescerLog("deliver_failed", {
          turnId,
          channel: channelKey,
          err: describeError(err),
        }),
      );
    }
    return true;
  }

  function startWatchdog(turnId: string, channelKey: string, bucket: Bucket): void {
    if (bucket.watchdog !== null) {
      return;
    }
    const startedAt = bucket.startedAt;
    bucket.watchdog = setTimeout(() => {
      // Re-fetch the bucket — it may have been committed already (the
      // explicit-commit path clears watchdog before delete, but a
      // late-firing timer on a torn-down bucket is still possible if
      // `clearTimeout` raced with the callback queue).
      const live = getBucket(store, turnId, channelKey);
      if (!live) {
        return;
      }
      const waited = deps.clockNow() - startedAt;
      void commitBucket(turnId, channelKey, "watchdog", waited);
    }, deps.maxBufferMs);
    // `setTimeout` returns `Timeout` on Node; in some host environments
    // the returned object has an `unref` method we can call to avoid
    // pinning the event loop in tests. We do NOT call `.unref()` here
    // because vitest fake timers wrap the returned handle without it.
  }

  function register(msg: OutboundMessage): void {
    const startedAt = deps.clockNow();
    const bucket = ensureBucket(store, msg, startedAt);
    bucket.messages.push(msg);
    const isFirst = bucket.messages.length === 1;
    if (isFirst) {
      // First register on this bucket → arm the watchdog.
      startWatchdog(msg.turnId, msg.channelKey, bucket);
    }
    deps.logTelemetry(
      formatOutboundCoalescerLog("registered", {
        turnId: msg.turnId,
        channel: msg.channelKey,
        kind: msg.kind,
        bufferDepth: bucket.messages.length,
      }),
    );
  }

  async function commit(turnId: string, channelKey: string): Promise<void> {
    await commitBucket(turnId, channelKey, "manual", null);
  }

  async function commitAll(turnId: string): Promise<void> {
    // Snapshot channel keys first — `commitBucket` mutates the store.
    const channelKeys: string[] = [];
    for (const [channelKey, inner] of store.entries()) {
      if (inner.has(turnId)) {
        channelKeys.push(channelKey);
      }
    }
    if (channelKeys.length === 0) {
      // No bucket for this turnId on any channel → noop. Per Phase 5
      // idempotency: primary + fallback both firing must produce
      // exactly one deliver per channel, so the second call MUST be a
      // silent noop (no telemetry line — distinct from `commit_noop`
      // which is per-bucket).
      return;
    }
    for (const channelKey of channelKeys) {
      await commitBucket(turnId, channelKey, "manual", null);
    }
  }

  async function bypass(
    reason: BypassReason,
    body: ReplyPayload,
    deliver: BlockReplyDeliver,
  ): Promise<void> {
    // Phase 6 runtime guard — the closed `BypassReason` union is
    // re-checked at runtime so a downstream caller that ignores the
    // type-level closed-set discipline still fails fast. Per invariant
    // #5, bypass reasons MUST come from the audit-curated allowlist
    // and NEVER from user-prompt content.
    if (!isBypassReason(reason)) {
      throw new Error(
        `outbound-coalescer: unknown bypass reason=${typeof reason === "string" ? reason : String(reason)}; allowed=${BYPASS_REASONS.join(",")}`,
      );
    }
    deps.logTelemetry(
      formatOutboundCoalescerLog("bypassed", {
        reason,
      }),
    );
    try {
      await Promise.resolve(deliver(body));
    } catch (err) {
      deps.logTelemetry(
        formatOutboundCoalescerLog("deliver_failed", {
          reason,
          err: describeError(err),
        }),
      );
    }
  }

  function stats(): { buffered: number; turns: number } {
    let buffered = 0;
    const turns = new Set<string>();
    for (const inner of store.values()) {
      for (const [turnId, bucket] of inner.entries()) {
        buffered += bucket.messages.length;
        if (bucket.messages.length > 0) {
          turns.add(turnId);
        }
      }
    }
    return { buffered, turns: turns.size };
  }

  return {
    register,
    commit,
    commitAll,
    bypass,
    stats,
  };
}
