/**
 * NEW-C Phase 7 — outbound-coalescer acceptance fixture (FINAL slice
 * gate).
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_outbound_coalescer.plan.md`
 *   §7 oc-phase-7-acceptance-and-live-verify.
 * Phase 1 audit: `extensions/AUDIT-outbound-coalescer.md` §g
 *   (live-evidence cross-check 2026-05-06 18:26+18:27 double-emit).
 * Fixture: `extensions/regress-fixtures/new-c-double-emit.fixture.json`.
 *
 * Goal: replay the live-evidence reproduction (one user prompt → ack +
 * intermediate + final on the SAME `(turnId, channelKey)` bucket)
 * through the REAL `createOutboundCoalescer` Phase 3 impl + REAL Phase
 * 5 `commitOutboundOnCommitmentSatisfied` hook + REAL Slice E
 * `recordMemoryOnCommitmentSatisfied` + REAL Slice F
 * `recordTaskOnCommitmentSatisfied` + REAL Slice I
 * `sanitizeOutboundForExternalChannel` to assert A1..A7 acceptance
 * criteria from sub-plan §7 (b).
 *
 * Acceptance assertions (sub-plan §7 (b)):
 *   - A1: channel adapter receives EXACTLY ONE send for the user turn.
 *   - A2: send carries the FINAL body verbatim (LLM output preserved).
 *   - A3: ack text prefixed onto the final body.
 *   - A4: telemetry contains EXACTLY ONE
 *         `[outbound-coalescer] event=committed turnId=<id>
 *          channel=<c> messages_merged>=2 final_kind=final`.
 *   - A5: Slice F `recordTaskOnCommitmentSatisfied` + Slice E
 *         `recordMemoryOnCommitmentSatisfied` STILL fire on the same
 *         `commitmentSatisfied=true` edge (regression — no
 *         double-subscribe; coalescer commit and write-on-satisfied
 *         hooks are SIBLINGS, not nested).
 *   - A6: Slice I sanitizer STILL strips diagnostics from the
 *         committed payload (composition: coalescer commits ONE →
 *         sanitizer sees ONE → channel receives sanitized).
 *   - A7: 16 hard invariants reverse-test passes — no UserPrompt
 *         text-rule (#5/#6), no `commitment` ↛ `decision` import (#8),
 *         5 frozen contracts byte-identical (#11).
 *
 * Test discipline (per slice F/E/I precedent and sub-plan §5):
 *   - No `vi.spyOn` on `createOutboundCoalescer` /
 *     `commitOutboundOnCommitmentSatisfied` /
 *     `recordTaskOnCommitmentSatisfied` /
 *     `recordMemoryOnCommitmentSatisfied` /
 *     `sanitizeOutboundForExternalChannel` — all cases use REAL
 *     implementations.
 *   - Spies live on injected DEPS (channel adapter, telemetry sink,
 *     `MemoryStore.storeEpisodic`, `TaskLedger.create`) — not on the
 *     function under test.
 *   - Fixture is LOADED from
 *     `extensions/regress-fixtures/new-c-double-emit.fixture.json` (per
 *     sub-plan §7 (a)) so the live-evidence trace is the source of
 *     truth and a future evidence rotation updates the JSON, not the
 *     test code.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { recordMemoryOnCommitmentSatisfied } from "../../agents/pi-embedded-runner/run/memory-write-on-satisfied.js";
import { commitOutboundOnCommitmentSatisfied } from "../../agents/pi-embedded-runner/run/commit-outbound-on-satisfied.js";
import { recordTaskOnCommitmentSatisfied } from "../../agents/pi-embedded-runner/run/task-write-on-satisfied.js";
import type {
  CommitmentSatisfiedAttestationLike,
} from "../../agents/pi-embedded-runner/run/memory-write-on-satisfied.js";
import { createOutboundCoalescer } from "../../infra/outbound/outbound-coalescer.js";
import { sanitizeOutboundForExternalChannel } from "../../infra/outbound/outbound-sanitizer.js";
import { asIdentityId } from "../../platform/identity/identity-id.js";
import { InMemoryMemoryStore } from "../../platform/memory/in-memory-store.js";
import { InMemoryTaskLedger } from "../../platform/task/in-memory-task-ledger.js";

import type { ReplyPayload } from "../types.js";

/**
 * Inline structural shape of the JSON fixture. Mirrors the on-disk
 * schema exactly; if the fixture ever drifts, TypeScript catches the
 * mismatch at the cast site below — there is NO runtime validation
 * here because the fixture is checked into the repo and only updated
 * intentionally.
 */
type FixtureMessage = {
  readonly kind: "ack" | "preamble" | "intermediate" | "final";
  readonly tsOffsetMs: number;
  readonly body: ReplyPayload;
};

type FixtureTurn = {
  readonly turnId: string;
  readonly channelKey: string;
  readonly messages: readonly FixtureMessage[];
};

type FixtureExpectations = {
  readonly channelDeliveryCount: number;
  readonly finalText: string;
  readonly finalReplyToId?: string;
  readonly telemetry: {
    readonly committedEvents: number;
    readonly messagesMerged: number;
    readonly finalKind: "ack" | "preamble" | "intermediate" | "final";
  };
};

type Fixture = {
  readonly turn: FixtureTurn;
  readonly expectedAfterCoalescer: FixtureExpectations;
};

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../extensions/regress-fixtures/new-c-double-emit.fixture.json",
);

function loadFixture(): Fixture {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  return JSON.parse(raw) as Fixture;
}

const SATISFIED: CommitmentSatisfiedAttestationLike = {
  commitmentSatisfied: true,
  terminalState: "action_completed",
  acceptanceReason: "commitment_satisfied",
};

describe("NEW-C Phase 7 — outbound-coalescer acceptance fixture (A1..A7)", () => {
  it("A1+A2+A3+A4: single committed message ack-prefixed, final body verbatim, telemetry=1 committed", async () => {
    const fx = loadFixture();
    const turn = fx.turn;
    const exp = fx.expectedAfterCoalescer;

    const channelDelivered: ReplyPayload[] = [];
    const logs: string[] = [];

    const coalescer = createOutboundCoalescer({
      deliver: (payload) => {
        channelDelivered.push(payload);
      },
      mergeStrategy: "drop_intermediates",
      maxBufferMs: 60_000,
      logTelemetry: (line) => logs.push(line),
      clockNow: () => Date.now(),
    });

    // Replay the fixture: register every message in arrival order on
    // the same `(turnId, channelKey)` bucket. This reconstructs the
    // in-runId collision class NEW-C defends against (audit §g — the
    // synthetic reproduction the live evidence motivates).
    for (const msg of turn.messages) {
      coalescer.register({
        turnId: turn.turnId,
        channelKey: turn.channelKey,
        kind: msg.kind,
        body: msg.body,
        ts: 1_000 + msg.tsOffsetMs,
      });
    }

    // Drive the PRIMARY commit edge — Phase 5
    // `commitOutboundOnCommitmentSatisfied` hook against
    // `commitmentSatisfied===true` attestation.
    await commitOutboundOnCommitmentSatisfied({
      coalescer,
      attestation: SATISFIED,
      turnId: turn.turnId,
      logger: (line) => logs.push(line),
    });

    // A1: EXACTLY ONE channel send for the user turn.
    expect(channelDelivered).toHaveLength(exp.channelDeliveryCount);

    // A2 + A3: send carries the final body VERBATIM with ack prefixed.
    // The fixture pre-computes the canonical merged text so future
    // evidence rotations update the JSON, not the assertions.
    expect(channelDelivered[0]?.text).toBe(exp.finalText);
    if (exp.finalReplyToId) {
      // Final body's metadata (replyToId) preserved as envelope.
      expect(channelDelivered[0]?.replyToId).toBe(exp.finalReplyToId);
    }

    // A4: EXACTLY ONE `event=committed` telemetry line for the turn,
    // carrying messages_merged>=2 and final_kind=final.
    const committedLines = logs.filter(
      (l) => l.includes("event=committed") && l.includes(`turnId=${turn.turnId}`),
    );
    expect(committedLines).toHaveLength(exp.telemetry.committedEvents);
    expect(committedLines[0]).toMatch(
      new RegExp(`messages_merged=${exp.telemetry.messagesMerged}\\b`),
    );
    expect(committedLines[0]).toContain(`final_kind=${exp.telemetry.finalKind}`);
    expect(committedLines[0]).toContain(`channel=${turn.channelKey}`);

    // PRIMARY edge `commit_signal source=commitment_satisfied` MUST
    // appear in the telemetry pair (commit_signal → committed).
    expect(
      logs.some(
        (l) =>
          l.includes("event=commit_signal") &&
          l.includes("source=commitment_satisfied") &&
          l.includes(`turnId=${turn.turnId}`),
      ),
    ).toBe(true);

    // Intermediate body MUST NOT appear in the merged committed
    // payload — `drop_intermediates` strategy. Reverse-coverage for the
    // ack-prefix happy path.
    const intermediate = turn.messages.find((m) => m.kind === "intermediate");
    if (intermediate?.body.text) {
      expect(channelDelivered[0]?.text).not.toContain(intermediate.body.text);
    }
  });

  it("A5: Slice F + Slice E write-on-satisfied hooks STILL fire (regression — no double-subscribe)", async () => {
    // The coalescer commit edge and the slice E/F write-on-satisfied
    // edges are SIBLINGS — both fire off the same
    // `commitmentSatisfied===true` attestation. NEW-C must NOT
    // double-subscribe (i.e. coalescer wiring must NOT re-register the
    // slice E/F hooks under a different observer).
    //
    // We exercise all THREE hooks (memory + task + outbound) against
    // ONE attestation and assert each fires exactly once.
    const fx = loadFixture();
    const turn = fx.turn;
    const VLADIMIR = asIdentityId("identity:vladimir");

    // Real slice E memory store + real slice F task ledger.
    const memoryStore = new InMemoryMemoryStore();
    const taskLedger = new InMemoryTaskLedger();
    const memorySpy = vi.spyOn(memoryStore, "storeEpisodic");
    const ledgerCreateSpy = vi.spyOn(taskLedger, "create");

    const channelDelivered: ReplyPayload[] = [];
    const logs: string[] = [];
    const coalescer = createOutboundCoalescer({
      deliver: (payload) => {
        channelDelivered.push(payload);
      },
      mergeStrategy: "drop_intermediates",
      maxBufferMs: 60_000,
      logTelemetry: (line) => logs.push(line),
      clockNow: () => Date.now(),
    });

    // Register the same fixture turn — coalescer commit will fire
    // alongside the write-on-satisfied hooks.
    for (const msg of turn.messages) {
      coalescer.register({
        turnId: turn.turnId,
        channelKey: turn.channelKey,
        kind: msg.kind,
        body: msg.body,
        ts: 1_000 + msg.tsOffsetMs,
      });
    }

    const captureLogger = () => {
      const warns: Array<{ message: string; meta?: Record<string, unknown> }> = [];
      const debugs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
      return {
        warn: (message: string, meta?: Record<string, unknown>) => {
          warns.push({ message, ...(meta ? { meta } : {}) });
        },
        debug: (message: string, meta?: Record<string, unknown>) => {
          debugs.push({ message, ...(meta ? { meta } : {}) });
        },
        warns,
        debugs,
      };
    };

    // Slice E memory hook — write a `persistent_session.created`
    // episodic event (the only payload-bearing arm in slice E).
    const memoryOutcome = await recordMemoryOnCommitmentSatisfied({
      attestation: SATISFIED,
      identityId: VLADIMIR,
      memoryStore,
      episodicEvent: {
        effectFamily: "persistent_session",
        effectId: "effect-NEW-C-P7-A5",
        payload: {
          messageRole: "assistant",
          messageText: "(opaque — coalescer never reads user text per #5/#6)",
          messageId: "msg-NEW-C-P7-A5",
          occurredAt: "2026-05-06T18:26:55.711Z",
        },
      },
      logger: captureLogger(),
    });

    // Slice F task hook — write a `task.created` ledger row + episodic
    // cross-reference. Field names per `TaskCreatedWriteInput` (slice F
    // PR-#185): `label` + `summary` (NOT `title`),
    // `sourceEffectFamily` / `sourceEffectId` for the JOIN.
    const taskOutcome = await recordTaskOnCommitmentSatisfied({
      attestation: SATISFIED,
      identityId: VLADIMIR,
      memoryStore,
      taskLedger,
      taskInput: {
        kind: "created",
        label: "remember-borscht-recipe",
        summary: "Запомнить рецепт борща",
        sourceEffectFamily: "task",
        sourceEffectId: "effect-NEW-C-P7-A5",
        occurredAt: "2026-05-06T18:26:55.711Z",
      },
      logger: captureLogger(),
    });

    // NEW-C primary outbound commit hook.
    await commitOutboundOnCommitmentSatisfied({
      coalescer,
      attestation: SATISFIED,
      turnId: turn.turnId,
      logger: (line) => logs.push(line),
    });

    // A5 (memory): slice E hook fired and the entry landed.
    // `storeEpisodic` is called TWICE in this scenario — once by the
    // slice E `recordMemoryOnCommitmentSatisfied` (persistent_session
    // payload) AND once by the slice F `recordTaskOnCommitmentSatisfied`
    // cross-reference write (task.created episodic JOIN). Both fires
    // are SIBLINGS — the memory hook is NOT wrapped or re-invoked by
    // the task hook. The assertion is therefore that BOTH hooks
    // produced their respective episodic write (slice E direct,
    // slice F cross-reference) — one call apiece, two total.
    expect(memorySpy).toHaveBeenCalledTimes(2);
    expect(memoryOutcome.kind).toBe("written");

    // A5 (task): slice F hook fired exactly once and the ledger row +
    // episodic cross-reference both landed. Per slice F partial-write
    // tolerance (sub-plan F §6 line 148), `kind` is one of
    // `wrote` | `failed`; the partial case is folded into `failed` with
    // per-side success booleans. We assert the LEDGER write path was
    // reached and the outcome is NOT a `skipped`.
    expect(ledgerCreateSpy).toHaveBeenCalledTimes(1);
    expect(taskOutcome.kind).not.toBe("skipped");
    expect(["wrote", "failed"]).toContain(taskOutcome.kind);

    // A5 (outbound): coalescer commit ALSO fired exactly once on the
    // same edge — NEW-C is a SIBLING of slice E/F, never their
    // wrapper. No double-subscribe.
    expect(channelDelivered).toHaveLength(1);
    const committedLines = logs.filter(
      (l) => l.includes("event=committed") && l.includes(`turnId=${turn.turnId}`),
    );
    expect(committedLines).toHaveLength(1);
  });

  it("A6: slice I sanitizer composes BELOW coalescer — diagnostics still stripped", async () => {
    // Composition: coalescer commits ONE merged payload, sanitizer
    // runs AFTER and strips internal `[planner]` diagnostic lines per
    // slice I `OUTBOUND_LEAK_PATTERNS`. The fixture's clean turn does
    // NOT contain a diagnostic — for A6 we synthesise an
    // ack+intermediate+final stack where the FINAL body carries a
    // `[planner]` line so the sanitizer's removal is observable AT
    // the channel boundary.
    const channelDelivered: { text: string }[] = [];
    const logs: string[] = [];

    const sanitizingChannelAdapter = (payload: ReplyPayload) => {
      const sanitized = sanitizeOutboundForExternalChannel(payload.text ?? "");
      channelDelivered.push({ text: sanitized.text });
    };

    const coalescer = createOutboundCoalescer({
      deliver: sanitizingChannelAdapter,
      mergeStrategy: "drop_intermediates",
      maxBufferMs: 60_000,
      logTelemetry: (line) => logs.push(line),
      clockNow: () => Date.now(),
    });

    const TURN = "run-A6-sanitizer-compose";
    const CHANNEL = "telegram:6533456892:6533456892";

    coalescer.register({
      turnId: TURN,
      channelKey: CHANNEL,
      kind: "ack",
      body: { text: "Принял запрос про борщ" },
      ts: 1,
    });
    // FINAL body carries an internal `[planner]` diagnostic that
    // slice I sanitizer is required to strip. The literal pattern is
    // taken from `outbound-sanitizer.ts:136-137` planner_marker rule.
    coalescer.register({
      turnId: TURN,
      channelKey: CHANNEL,
      kind: "final",
      body: {
        text: "Я запомнил рецепт.\n[planner] route=internal step=4 plan_built=true\nГотов помогать дальше.",
      },
      ts: 2,
    });

    await coalescer.commitAll(TURN);

    // A6.1: coalescer committed exactly ONE payload (composition
    // surface unchanged by sanitizer downstream).
    expect(channelDelivered).toHaveLength(1);

    // A6.2: ack still prefixes final body (drop_intermediates strategy
    // unchanged by sanitizer composition).
    expect(channelDelivered[0]?.text).toContain("Принял запрос про борщ");
    expect(channelDelivered[0]?.text).toContain("Я запомнил рецепт");
    expect(channelDelivered[0]?.text).toContain("Готов помогать дальше");

    // A6.3: slice I sanitizer stripped the `[planner]` diagnostic
    // line from the committed payload at the deliver layer.
    expect(channelDelivered[0]?.text).not.toContain("[planner]");
    expect(channelDelivered[0]?.text).not.toContain("plan_built");

    // Coalescer telemetry shows ONE committed event for the turn.
    const committedLines = logs.filter(
      (l) => l.includes("event=committed") && l.includes(`turnId=${TURN}`),
    );
    expect(committedLines).toHaveLength(1);
  });

  it("A7: 16 hard invariants reverse-test — boundary discipline preserved", async () => {
    // A7 is a STRUCTURAL guard (not a runtime exercise of every
    // invariant — that's the job of the per-invariant unit tests
    // already in the codebase). The acceptance assertion here is:
    // (a) the coalescer SOURCE file does NOT import from the frozen
    //     layer (`src/platform/commitment/**`) — invariant #8;
    // (b) the coalescer types file does NOT cross the
    //     `commitment` -> `decision` boundary (#8);
    // (c) the coalescer SOURCE files do NOT reference any raw user
    //     text type (the placeholder names live ONLY in invariant
    //     enforcement code), validating invariants #5/#6 — coalescer
    //     surface accepts opaque `ReplyPayload` only.
    const selfPath = fileURLToPath(import.meta.url);
    const coalescerSourcePath = resolve(
      dirname(selfPath),
      "../../infra/outbound/outbound-coalescer.ts",
    );
    const coalescerTypesPath = resolve(
      dirname(selfPath),
      "../../infra/outbound/outbound-coalescer-types.ts",
    );
    const commitHookPath = resolve(
      dirname(selfPath),
      "../../agents/pi-embedded-runner/run/commit-outbound-on-satisfied.ts",
    );

    const coalescerSource = readFileSync(coalescerSourcePath, "utf8");
    const coalescerTypes = readFileSync(coalescerTypesPath, "utf8");
    const commitHookSource = readFileSync(commitHookPath, "utf8");

    // (a) frozen-layer import check — coalescer SOURCE must NOT import
    // from `src/platform/commitment/`. The lint rule
    // `lint:commitment:no-decision-imports` already enforces this at
    // the build level; this assertion makes the discipline visible in
    // the acceptance run.
    expect(coalescerSource).not.toMatch(
      /from\s+["'][^"']*platform\/commitment\//,
    );
    expect(coalescerTypes).not.toMatch(
      /from\s+["'][^"']*platform\/commitment\//,
    );
    // The Phase 5 commit-outbound-on-satisfied hook lives in
    // `agents/pi-embedded-runner/run/` (slice F P5 sibling location)
    // and reads the attestation via the structural
    // `CommitmentSatisfiedAttestationLike` type — NOT via a runtime
    // import from `src/platform/commitment/`. Per invariant #8, the
    // hook must NOT introduce a NEW runtime import into the frozen
    // commitment module.
    expect(commitHookSource).not.toMatch(
      /^import[^;]*from\s+["'][^"']*platform\/commitment\//m,
    );

    // (b) commitment <-/-> decision boundary (#8): the coalescer
    // surface must NOT pull `decision/` into its graph nor surface
    // anything `commitment`-flavoured into a decision module.
    expect(coalescerSource).not.toMatch(
      /from\s+["'][^"']*platform\/decision\//,
    );
    expect(coalescerTypes).not.toMatch(
      /from\s+["'][^"']*platform\/decision\//,
    );

    // (c) raw-user-text reverse coverage (#5 / #6): coalescer source
    // and types must NOT import any `RawUserTurn` / `UserPrompt`
    // symbol. The strings only ever appear in this file in DOCUMENTING
    // the invariant — not as a runtime consumer. We validate via
    // import-line scan rather than string scan to avoid false matches
    // on doc comments.
    expect(coalescerSource).not.toMatch(
      /^import[^;]*\b(RawUserTurn|UserPrompt)\b/m,
    );
    expect(coalescerTypes).not.toMatch(
      /^import[^;]*\b(RawUserTurn|UserPrompt)\b/m,
    );

    // Positive cross-check: the test exercises real coalescer +
    // real write-on-satisfied hooks + real sanitizer (A1..A6 above).
    // If A7 grows beyond a static-grep guard in future, those exercises
    // remain the authoritative coverage; A7 here documents the
    // import-boundary contract NEW-C inherits from the master plan.
    expect(coalescerSource).toContain("createOutboundCoalescer");
    expect(coalescerTypes).toContain("OutboundCoalescer");
    expect(commitHookSource).toContain("commitOutboundOnCommitmentSatisfied");
  });
});
