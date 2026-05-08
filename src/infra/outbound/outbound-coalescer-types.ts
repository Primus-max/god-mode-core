import type { BlockReplyDeliver } from "../../auto-reply/reply/block-external-buffer.js";
/**
 * NEW-C Phase 2 — OutboundCoalescer types + DI seam.
 *
 * Master sub-plan: `.cursor/plans/commitment_kernel_outbound_coalescer.plan.md`.
 * Phase 1 audit: `extensions/AUDIT-outbound-coalescer.md`.
 *
 * Pure types. No implementation, no module-level state, no I/O. The
 * concrete factory `createOutboundCoalescer` lives in
 * `./outbound-coalescer.ts` (Phase 3); this file declares the contract
 * surface and a structured telemetry helper that mirrors slice I's
 * `formatOutboundSanitizerLog`.
 *
 * Соответствие 16 hard invariants (`.cursor/rules/commitment-kernel-invariants.mdc`):
 * - #5: keys `(turnId, channelKey)` структурные, body opaque (forwarded
 *   `ReplyPayload`); никаких regex / pattern matching на `UserPrompt` /
 *   `RawUserTurn`. Nothing in this module reads user text.
 * - #6: `IntentContractor` остаётся единственным reader сырого user
 *   text — этот модуль ничего из user prompt не читает.
 * - #8: лежит в `src/infra/outbound/`, вне обоих `src/platform/commitment/`
 *   и `src/platform/decision/`; не импортирует из них.
 * - #11: 5 frozen contracts byte-identical (Phase 2 не трогает их).
 * - #15: blanket signoff (2026-05-05) покрывает все code-touching
 *   фазы slice'а; Phase 2 — pure types + factory stub.
 * - #16: `EffectFamilyId` ≠ `EffectId`; coalescer — OUTPUT lane (не
 *   effect lane); `EffectId` сюда не утекает; никаких new brands не
 *   вводится — `turnId` / `channelKey` остаются обычными branded
 *   string-типами.
 *
 * Plus contractual invariant `Single_final_user_facing_message_per_user_turn`
 * (master §0.5.6 + master §3 prose). NEW-C provides its first runtime
 * gate; Phase 2 lays down the contract surface that gate will enclose
 * starting Phase 3.
 */
import type { ReplyPayload } from "../../auto-reply/types.js";

/**
 * Closed string union of outbound message kinds. Coalescer keys merge
 * strategy on this discriminator only — body remains opaque (never
 * inspected). Per Phase 1 audit §a, the 23 emit-sites map onto these
 * four kinds:
 * - `ack`        — slice H Phase 3 ACK_SENTINEL ack (or non-deferral
 *                   ack fallback at `agent-runner.ts:866-885`).
 * - `preamble`   — reserved for slice K reminder / future preamble
 *                   surfaces; Phase 4 wiring covers this when needed.
 * - `intermediate` — compaction notices (`agent-runner.ts:1432`),
 *                   PR-G holding payload (subagent aggregation),
 *                   any non-final body emitted before commit signal.
 * - `final`      — assistant-reply body of the user turn; the body
 *                   that the merge strategy ultimately commits.
 */
export type OutboundMessageKind = "ack" | "preamble" | "intermediate" | "final";

/**
 * NEW-C Phase 6 — closed `BypassReason` union (sub-plan §6 (a) + audit
 * §e). Each entry corresponds to an emit-site that lacks a
 * `(turnId, channelKey)` context OR operates outside the
 * `runReplyAgent` user-turn boundary.
 *
 * Non-additivity: per sub-plan §6 (e), this set MUST NOT widen without
 * a sub-plan amendment. Each new bypass entry is a potential
 * `Single_final_user_facing_message_per_user_turn` regression. The
 * runtime guard in `bypass()` rejects any reason outside this set —
 * see Phase 6 acceptance test
 * `outbound-coalescer-bypass.test.ts` (B1 negative coverage cases).
 *
 * Per invariant #5 (no user-prompt-derived reasons), the union is
 * closed at compile-time AND the runtime validation re-checks against
 * `BYPASS_REASONS` so a bug elsewhere in the codebase that tries to
 * pass an attacker-supplied string through the bypass surface fails
 * fast with a structured error.
 *
 * Mapping to Phase 1 audit §e candidates:
 * - `system_init`           — boot announcements (no `turnId`).
 * - `internal_canvas`       — operator-side canvas surface.
 * - `internal_stdout`       — operator-side stdout surface.
 * - `internal_log`          — operator-side log surface.
 * - `standalone_command`    — `/help` / `/status` synchronous replies.
 * - `internal_acp_lane`     — ACP dispatch path (Phase 4 wiring noted
 *                             this as a string reason; Phase 6 promotes
 *                             it to the typed enum).
 *
 * - `cron_persistent_worker`: REMOVED at Bug F slice (lit by
 *   `persistent_worker.subsequent_push` affordance); persistent-worker
 *   pushes now flow through
 *   `OutboundCoalescer.register({ turnId, channelKey, kind: 'final' })`
 *   like every per-turn user-facing path. Tuple narrowed 7→6 at slice
 *   `persistent-worker-push` Phase 6.
 *
 * Sliced into 6 entries (matches audit §e, post-Bug-F): the historical
 * 7th `cron_persistent_worker` slot has been retired through the
 * sanctioned cron-fire dispatch adapter. `internal_acp_lane` remains a
 * distinct reason — collapsing it into one of the `internal_*` channel
 * variants would lose the dispatcher-vs-channel distinction in
 * telemetry.
 */
export const BYPASS_REASONS = [
  "system_init",
  "internal_canvas",
  "internal_stdout",
  "internal_log",
  "standalone_command",
  "internal_acp_lane",
] as const;

export type BypassReason = (typeof BYPASS_REASONS)[number];

/**
 * Closed-set membership check; consumed by the `bypass()` runtime
 * guard. Returns true ONLY for the 6 enumerated entries above. Any
 * other input — even a structurally-valid string — falls through. Pure
 * function; no side effects.
 */
export function isBypassReason(value: unknown): value is BypassReason {
  return typeof value === "string" && (BYPASS_REASONS as ReadonlyArray<string>).includes(value);
}

/**
 * One register'd outbound message. `channelKey` is serialised via the
 * structural `${channel}:${accountId}:${target}` идиома used at
 * `src/infra/outbound/target-resolver.ts:106` (Phase 1 audit §c
 * discrepancy: the sub-plan §2.3 sketch mentioned
 * `delivery-queue-storage.ts targetSerializer.serialize` but that
 * symbol does not exist; the structural form above is the canonical
 * channel-key shape).
 *
 * `turnId` re-uses the existing `runId` from
 * `src/auto-reply/reply/agent-runner-execution.ts` — the same value
 * that ships in `[assistant-reply]` log lines and operator UIs. No
 * new brand introduced (#16).
 *
 * `body` is forwarded `ReplyPayload` opaque-blob; the coalescer never
 * inspects `body.text` (#5 + #6).
 *
 * `ts` is wall-clock millis at register time (via injected
 * `clockNow`); used only for sort-stable ordering inside one bucket
 * before merge.
 */
export type OutboundMessage = {
  readonly turnId: string;
  readonly channelKey: string;
  readonly kind: OutboundMessageKind;
  readonly body: ReplyPayload;
  readonly ts: number;
};

/**
 * The coalescer's public contract. Implementations live in
 * `./outbound-coalescer.ts`; one instance per `runReplyAgent`
 * invocation (slice E P3 / `createExternalBlockReplyDeferral`
 * lifecycle precedent — no global singleton).
 *
 * - `register(msg)`: enqueue a message into the
 *   `(turnId, channelKey)` bucket; first register starts the
 *   per-bucket watchdog (`maxBufferMs`).
 * - `commit(turnId, channelKey)`: flush exactly one bucket through
 *   `deps.deliver`. Empty bucket = noop with `event=commit_noop`
 *   telemetry.
 * - `commitAll(turnId)`: iterate every channelKey bucket scoped to
 *   `turnId` and `commit` each. Cross-channel turns deliver one
 *   committed payload per channel.
 * - `bypass(reason, body, deliver)`: structured-reason bypass for
 *   emit-sites without a `(turnId, channel)` context (Phase 6
 *   allowlist: system-init, cron-driven persistent worker, internal
 *   `canvas`/`stdout`/`log`, standalone `/help` / `/status`). Never
 *   touches the bucket store.
 * - `stats()`: introspection for tests + telemetry; current
 *   implementation reports `buffered` (total messages held across
 *   all buckets) and `turns` (distinct turnIds with at least one
 *   open bucket).
 */
export type OutboundCoalescer = {
  register(msg: OutboundMessage): void;
  commit(turnId: string, channelKey: string): Promise<void>;
  commitAll(turnId: string): Promise<void>;
  bypass(reason: BypassReason, body: ReplyPayload, deliver: BlockReplyDeliver): Promise<void>;
  stats(): { buffered: number; turns: number };
};

/**
 * DI bag for `createOutboundCoalescer`. All dependencies are
 * injectable so tests exercise real code paths without timer/clock
 * coupling.
 *
 * - `deliver`: single committed-send sink (block-buffer's inner
 *   deliver from `agent-runner.ts:584-628` after `wrapDeliver`
 *   composition). Coalescer calls this exactly once per committed
 *   bucket.
 * - `mergeStrategy`: `"drop_intermediates"` → keep last `final`
 *   body verbatim, prepend ack as first text fragment (mirrors
 *   slice H P3 ACK_SENTINEL ordering); `"merge_into_final"` →
 *   concat `text` fields by `\n\n`, last entry's metadata serves
 *   as envelope. Phase 3 implements both; default per emit-site is
 *   `"drop_intermediates"`.
 * - `maxBufferMs`: per-bucket watchdog. Default 60_000 (matches
 *   master §0.5.6 NEW-C three-line defense).
 * - `logTelemetry`: line-emitting sink (gateway log). One line per
 *   coalescer event.
 * - `clockNow`: injectable `Date.now`; tests use a fake clock.
 */
export type OutboundCoalescerDeps = {
  readonly deliver: BlockReplyDeliver;
  readonly mergeStrategy: "drop_intermediates" | "merge_into_final";
  readonly maxBufferMs: number;
  readonly logTelemetry: (line: string) => void;
  readonly clockNow: () => number;
  /**
   * V1-CLOSE T4 — backoff schedule between retry attempts on a thrown
   * `deps.deliver` call. The array length determines the number of
   * retries (initial attempt is always made; each entry gates one
   * additional retry). Default in `createOutboundCoalescer` is
   * `[1000, 2000, 4000]` (≤7s wall clock, well under the 15s ceiling
   * in V1-CLOSE charter §4 T4).
   *
   * Tests pass `[0, 0]` to drive the loop without coupling to wall
   * clock. Production callers should leave this undefined.
   */
  readonly retryDelaysMs?: readonly number[];
  /**
   * V1-CLOSE T4 — injectable scheduler for retry-backoff delays.
   * Defaults to a `setTimeout`-based wait. Tests can pass an immediate
   * resolver (`() => Promise.resolve()`) when they want full control
   * over backoff timing. The fn receives the configured delay in
   * milliseconds and resolves once the delay elapses.
   */
  readonly retrySleep?: (ms: number) => Promise<void>;
};

/**
 * Closed event set for `[outbound-coalescer]` telemetry. Caller
 * (Phase 3 impl + Phase 4 emit-site wiring) emits exactly one log
 * line per event with structured key=value payload pairs.
 *
 * - `registered`        — `register(msg)` enqueued into bucket.
 * - `committed`         — bucket flushed via `commit` /
 *                          `commitAll` (success path).
 * - `commit_noop`       — `commit` called on empty bucket.
 * - `bypassed`          — `bypass(...)` delivered without buffering.
 * - `timeout_committed` — watchdog fired after `maxBufferMs` —
 *                          forced commit.
 * - `deliver_failed`    — `deps.deliver` threw; bucket cleared, no
 *                          propagation (failure isolation).
 * - `commit_signal`     — emitted by Phase 5 hook
 *                          (`commit-outbound-on-satisfied.ts`) and
 *                          `finalizeAfterRun` fallback to mark which
 *                          source triggered commit; carries
 *                          `source=<commitment_satisfied|finalize_after_run|watchdog>`.
 * - `types_loaded`      — one-shot module-init marker (sub-plan §5
 *                          Phase 2 test list). Emitted at most once per
 *                          import via `OUTBOUND_COALESCER_TYPES_LOADED_LINE`;
 *                          never emitted from runtime paths.
 */
export type OutboundCoalescerLogEvent =
  | "registered"
  | "committed"
  | "commit_noop"
  | "bypassed"
  | "timeout_committed"
  | "deliver_failed"
  | "commit_signal"
  | "types_loaded"
  // V1-CLOSE T4 (`outbound-coalescer.deliver-retry`): emitted ONCE per
  // bucket after `deps.deliver` exhausts the retry schedule. Distinct
  // from `deliver_failed` (per-attempt warn) so operators can grep a
  // single line per actually-dropped bucket and route it to admin
  // notification / mark-turn-failed flows. Carries full bucket context
  // (turnId, channelKey, attempts, attachment_count, last_error).
  | "delivery_dropped";

/**
 * Format one `[outbound-coalescer]` telemetry line. Mirrors slice I's
 * `formatOutboundSanitizerLog` — `key=value` pairs joined by spaces,
 * `null` / `undefined` filtered out, arrays bracket-wrapped, objects
 * stringified via `JSON.stringify`. Pure function; no side effects.
 *
 * Example:
 *   formatOutboundCoalescerLog("committed", {
 *     turnId: "run-abc",
 *     channel: "telegram:6533456892:chat",
 *     messages_merged: 3,
 *     final_kind: "final",
 *   })
 *   → "[outbound-coalescer] event=committed turnId=run-abc \
 *      channel=telegram:6533456892:chat messages_merged=3 final_kind=final"
 */
export function formatOutboundCoalescerLog(
  event: OutboundCoalescerLogEvent,
  payload: Readonly<Record<string, unknown>>,
): string {
  const parts: string[] = [`event=${event}`];
  for (const key of Object.keys(payload)) {
    const value = payload[key];
    if (value === undefined || value === null) {
      continue;
    }
    parts.push(`${key}=${formatLogValue(value)}`);
  }
  return `[outbound-coalescer] ${parts.join(" ")}`;
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => formatLogValue(v)).join(",")}]`;
  }
  return JSON.stringify(value);
}

/**
 * Module-init telemetry marker (per sub-plan §5 Phase 2 test list).
 * Distinct from the Phase 3 runtime events; emitted at most once per
 * import to confirm types module loaded into the runtime image.
 *
 * Test-only consumers can re-call this; it is stateless.
 */
export const OUTBOUND_COALESCER_TYPES_LOADED_LINE: string = formatOutboundCoalescerLog(
  "types_loaded",
  {},
);
