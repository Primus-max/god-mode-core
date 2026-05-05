---
name: Slice D — Channel-Agnostic Session Persistence (v1 Foundation)
overview: "Refactor session/memory keying so the same operator-identity is reachable from any channel (Telegram + Web priority; Max v1.1; Slack/Discord/iMessage/Signal/WhatsApp fixture-parity). Foundation for slice E (memory layer / mem0). Audit (2026-05-05) confirmed the existing per-channel session key format `agent:{agentId}:{channel}:{peerKind}:{peerId}` is already structured — what's missing is the second-level `IdentityId` abstraction that lets one user have one memory across channels."
todos:
  - id: d-phase-1-identity-id-type-and-registry
    content: "Phase 1 — introduce `IdentityId` branded type + static identity registry. New file `src/platform/identity/identity-id.ts` with `IdentityId = (string & { __brand: \"IdentityId\" })` + helpers `formatIdentityId`, `parseIdentityId`. New file `src/platform/identity/identity-registry.ts` with `IdentityRegistry` interface + `StaticIdentityRegistry` impl reading mappings from openclaw.json under a new `identities` section. No callers wire it yet — purely additive. Tests: registry round-trip, branded-type discipline, missing-mapping → undefined (NOT throw)."
    status: completed
  - id: d-phase-2-resolve-identity-from-session-key
    content: "Phase 2 — `resolveIdentityFromSessionKey(sessionKey, registry)` helper. Parses the session-key shape `agent:{agentId}:{channel}:{peerKind}:{peerId}`, looks up `(channel, peerId)` in the identity registry, returns `IdentityId | undefined`. New file `src/platform/identity/resolve-identity.ts`. Tests: telegram peer → identity, web peer → same identity, unknown channel → undefined, malformed key → undefined (no throw)."
    status: completed
  - id: d-phase-3-channel-registry-extend
    content: "Phase 3 — extend `ChatChannelId` registry in `src/channels/ids.ts` with `web` and `max`. Add ordering. Backward compat: existing `(string & {})` extensibility preserved; no consumer change required. Tests: enum order, includes new ids."
    status: completed
  - id: d-phase-4-extension-audit-telegram
    content: "Phase 4 — audit `extensions/telegram/**` for raw `message.chat.id` usage outside the adapter boundary. Confirm the adapter normalizes peerId (string-encoded numeric) before calling `buildAgentPeerSessionKey`. If any prod-path code reads chat.id directly past the adapter, fix it in this phase. Audit-only if no violations found; one fix-PR if found. Output: `extensions/telegram/AUDIT.md` with findings."
    status: completed
  - id: d-phase-5-config-section-and-bootstrap
    content: "Phase 5 — add `identities` section to openclaw.json schema in `src/config/zod-schema.*` + bootstrap defaults. Schema: `identities: { [identityId]: { mappings: Array<{ channel: ChannelId, externalId: string }>, displayName: string } }`. v1 default: one identity for the operator (Vladimir) statically configured. Tests: schema validation, default loading, malformed-config rejection."
    status: completed
  - id: d-phase-6-acceptance-fixture
    content: "Phase 6 — backend-fixture acceptance test: same `IdentityId` resolved from a Telegram session key AND from a Web session key when both map to the same operator. This is the test that proves slice D's contract. Memory layer (slice E) consumes this directly. Test file: `src/platform/identity/cross-channel-identity.test.ts`."
    status: completed
isProject: false
---

# Slice D — Channel-Agnostic Session Persistence

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_release_roadmap.plan.md` (slice D) |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` |
| Trigger | v1 Release Roadmap §3 group 0 — foundation for slice E (memory layer). Audit 2026-05-05 confirmed the existing session-key format already encodes channel; gap is the missing identity-level abstraction. |
| Out of scope | (a) OAuth or any runtime identity verification — v1 uses static config (one operator: Vladimir). Multi-tenant identity is v2. (b) Memory layer itself — that's slice E. (c) Channel adapter rewrites — Telegram adapter only audited; Slack/Discord untouched. |
| Maintainer signoff | REQUIRED at slice level (architectural — adds `IdentityId` concept). Roadmap-level signoff covers scope; per-phase signoff for Phase 1 (type introduction) and Phase 5 (config schema). |

## 1. Hard invariants this slice keeps

- **#5, #6**: New code reads no raw user text. `IdentityId` is derived from session-key shape (already structural).
- **#8**: New code lives in `src/platform/identity/`. Does NOT import from `src/platform/decision/` and is NOT imported by `src/platform/commitment/**`. Identity is consumed by the auto-reply layer + future memory layer (slice E).
- **#11**: Frozen 5 contracts untouched. `SessionId` is a separate concept from `IdentityId`; both coexist.
- **#15**: Architectural addition — needs explicit signoff before Phase 1 commits. Subsequent phases reuse the signoff.
- **#16**: `IdentityId` is a distinct branded type from `SessionId` and `EffectId`; no implicit conversion.

## 2. Audit findings (2026-05-05)

### 2.1. Session key today

Format: `agent:{agentId}:{channel}:{peerKind}:{peerId}` (or scope-specific variants).
- Channel ALREADY a segment.
- File: `src/routing/session-key.ts` — builders.
- Storage: `~/.openclaw-dev/agents/{agentId}/sessions/sessions.json` (JSON, NOT SQLite per audit).
- Branded type for `SessionId`: NOT present today (just `string`).

### 2.2. Channel registry

`src/channels/ids.ts:4–18` — `CHAT_CHANNEL_ORDER`:
```ts
const CHAT_CHANNEL_ORDER = [
  "telegram", "whatsapp", "discord", "irc", "googlechat",
  "slack", "signal", "imessage", "line",
] as const;
```
Missing for v1: `web`, `max`.

### 2.3. Reader surface

~455 files reference `sessionId` / `sessionKey`. Frozen layer (8 files) only reads, doesn't construct. Auto-reply (20+ files) heavy readers + pass-through.

### 2.4. SQLite

No SQLite schema for sessions. JSON file is the canonical store. No schema migration in this slice.

### 2.5. Telegram adapter

Audit pending in Phase 4. Risk: raw `message.chat.id` might leak past adapter boundary.

## 3. Hypothesis

The keying refactor required by v1 is **smaller than originally scoped**. The session-key string is already channel-aware. What's missing is:

1. A second-level `IdentityId` so one operator's memory works across channels.
2. A static registry mapping `(channel, externalId) → IdentityId` (v1 = one operator).
3. New channels (`web`, `max`) added to the registry.

NO sweeping refactor of 455 files. The 6-phase plan is purely additive — existing `sessionId` semantics unchanged.

## 4. Acceptance criteria

1. **`IdentityId` branded type** exists; round-trip parse/format works; distinct from `SessionId` per invariant #16.
2. **Static identity registry** loaded from openclaw.json `identities` section. Missing mapping returns `undefined` (no throw).
3. **`resolveIdentityFromSessionKey`** returns the same `IdentityId` for two different session keys belonging to the same operator (e.g. one Telegram, one Web) — proven by Phase 6 fixture.
4. **Channel registry** includes `web` and `max`.
5. **Telegram extension audit** (Phase 4) either confirms adapter discipline OR fixes any raw chat.id leak.
6. **Frozen layer untouched.** 16 invariants reverse-tested.

## 5. Per-phase tests (must catch real bugs — see AGENTS.md "Tests must catch real bugs")

Each phase's tests must:
- Reproduce the absence-of-functionality first (before the fix exists, the test must fail in a way that matches the spec).
- Use real types and real registry instances; no `vi.spyOn` on the function being tested.
- Cover the negative case explicitly (malformed input, missing mapping, unknown channel).
- For Phase 6 (cross-channel acceptance): the fixture must encode two distinct session keys for the same operator across two distinct channels and assert byte-equal `IdentityId`.

## 6. Implementation notes

- New module path: `src/platform/identity/`. Mirrors `src/platform/commitment/` layout (types + registry + impl + tests).
- `openclaw.json` schema additions go in the existing zod-schema generator pipeline. Do NOT hand-edit `schema.base.generated.ts`.
- Phase 4 (extension audit) is read-only IF clean; one separate fix-PR IF dirty. Report findings in `extensions/telegram/AUDIT.md`.

## 7. Handoff Log

### 2026-05-05 — Sub-plan kickoff

- Sub-plan written. Phase 1 starts immediately per roadmap "поехали" signoff.
- Audit (2026-05-05) confirms scope is purely additive; no frozen-layer touch; no schema migration.
- Git base: `dev` HEAD `849f214094` (post-roadmap commit).
- Branch: `feat/v1-slice-d-identity-id-foundation` (Phase 1).

### 2026-05-04 — Phase 1 merged (PR-#146)

- `IdentityId` branded type + `IdentityRegistry` interface + `StaticIdentityRegistry` impl landed under `src/platform/identity/`.
- Eager validation at construction: rejects duplicate `identityId`, conflicting `(channel,externalId)` mappings, empty `externalId`. All records frozen.
- Tests: `identity-id.test.ts` (brand discipline + parse/format round-trip), `static-identity-registry.test.ts` (resolve, list, byIdentity, validation negatives, all-records-frozen).
- No callers wired yet (purely additive). Frozen layer untouched. 16 invariants reverse-tested.

### 2026-05-04 — Phase 2 merged (PR-#147)

- `resolveIdentityFromSessionKey(sessionKey, registry)` helper + `extractChannelAndPeerFromSessionKey` parser landed in `src/platform/identity/resolve-identity.ts`.
- Handles all session-key shapes from `src/routing/session-key.ts`: per-channel-peer, per-account-channel-peer, group/channel variants. Fail-closed for main keys, no-channel DMs, wrapped scopes (`subagent`/`cron`/`acp`), unknown channels, malformed/empty peer ids.
- Tests: `resolve-identity.test.ts` covers all shapes + each negative case (no throw). Reverse-tests confirm wrapped scopes do NOT leak parent operator's identity.

### 2026-05-04 — Phase 3 merged (PR-#148)

- Added `max` to `CHAT_CHANNEL_ORDER` in `src/channels/ids.ts`.
- Added `Max` ChannelMeta entry in `src/channels/registry.ts` (selectionLabel "Max (RU messenger)") to satisfy exhaustiveness check.
- Introduced `IdentityChannelId = ChatChannelId | typeof INTERNAL_MESSAGE_CHANNEL` so the registry can map both chat channels AND the internal `webchat` surface.
- Web is the existing `INTERNAL_MESSAGE_CHANNEL = "webchat"` (kept distinct from chat channels per existing convention; identity layer accepts both).
- Tests: `static-identity-registry.test.ts` extended to cover webchat + max channel ids.

### 2026-05-04 — Phase 4 merged (PR-#149)

- Audit-and-fix on `extensions/telegram/**`. Two behaviour-neutral changes for explicit type discipline at the peer-id boundary: `bot-message-context.ts:239` and `bot-handlers.runtime.ts:325` now use `${String(chatId)}:${dmThreadId}` instead of relying on implicit number→string coercion.
- Adapter audit confirms `message.chat.id` is normalized to `String(chatId)` before any `buildAgentPeerSessionKey` call.
- Pre-existing 188 telegram-extension test failures verified as unrelated to slice D (baseline reproduces them on `dev` HEAD before changes via `git stash`).

### 2026-05-04 — Phase 5 merged (PR-#150)

- New `src/config/zod-schema.identities.ts` with `IdentityMappingSchema`, `IdentityRecordSchema`, `IdentitiesSchema`. Channel enum sourced from `[...CHAT_CHANNEL_ORDER, INTERNAL_MESSAGE_CHANNEL]`. Strict object validation; empty `externalId` rejected.
- Wired into `src/config/zod-schema.ts` `OpenClawSchema` as `identities: IdentitiesSchema.optional()`.
- New `src/platform/identity/load-identities-from-config.ts`: `buildIdentityRecordsFromConfig` validates each map key via `asIdentityId` (clear error message on malformed key); `loadIdentityRegistryFromConfig` is the one-call helper.
- Tests: `load-identities-from-config.test.ts` (round-trip, empty input, malformed key surfaces, registry-level validation propagation).

### 2026-05-04 — Phase 6 merged (PR-#151)

- Acceptance fixture `src/platform/identity/cross-channel-identity.acceptance.test.ts` (8 cases) proves slice D's contract end-to-end: cross-channel parity (Telegram + Web + Max + Slack share one IdentityId), per-account variant key shape, group/channel session keys, anonymous → undefined (no cross-tenant bleed), wrapped scope (subagent/cron/acp) → undefined.
- This is the test slice E (memory layer) consumes as the foundation guarantee. If it passes, "one operator, one memory across channels" is keyable on `IdentityId`.
- 16 invariants reverse-tested; frozen layer untouched throughout the slice.

## 8. Adjacent / deferred (out of scope)

| Item | Why deferred |
| --- | --- |
| OAuth-based identity verification | v2 — needs IdP integration |
| Multi-tenant identity (multiple operators) | v2 — single-operator v1 |
| Slack/Discord/iMessage adapter audit | v1.1 — Telegram + Web priority; others fixture-parity |
| Sessions.json → SQLite migration | v2 — JSON is fine for v1 scale |

## 9. References

- Roadmap: `.cursor/plans/commitment_kernel_v1_release_roadmap.plan.md` (slice D row in §3).
- Existing keying: `src/routing/session-key.ts`, `src/channels/ids.ts`.
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc`.
- Audit findings: this document §2.
