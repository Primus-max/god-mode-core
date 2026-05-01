## Summary

Describe the problem and fix in 2–5 bullets:

- Problem:
- Why it matters:
- What changed:
- What did NOT change (scope boundary):

## Change Type (select all)

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor required for the fix
- [ ] Docs
- [ ] Security hardening
- [ ] Chore/infra

## Scope (select all touched areas)

- [ ] Gateway / orchestration
- [ ] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [ ] Integrations
- [ ] API / contracts
- [ ] UI / DX
- [ ] CI/CD / infra

## Frozen layer touch (commitment kernel master plan §6.2)

If this PR changes any file under `src/platform/decision/` (TaskContract,
OutcomeContract, QualificationExecutionContract, ResolutionContract,
RecipeRoutingHints, DecisionTrace), pick exactly one category:

- [ ] telemetry-only — logs / trace / metric, no routing semantics change
- [ ] bug-fix — fixes a specific bug, does not change routing semantics
- [ ] compatibility — shim field; you MUST name the `ExecutionCommitment.<…>` source of truth below
- [ ] emergency-rollback — revert; tracking ticket: #______, retire deadline: ______
- [ ] none of the above — PR does not touch the frozen layer

Source of truth (required iff `compatibility`): ______________________

> CI label-check enforcement for this section is wired as a skeleton in PR-1
> and activated in PR-2 (commitment kernel master plan §9). Until then this
> block is reviewer-enforced.

## Linked Issue/PR

- Closes #
- Related #

## User-visible / Behavior Changes

List user-visible changes (including defaults/config).  
If none, write `None`.

## Security Impact (required)

- New permissions/capabilities? (`Yes/No`)
- Secrets/tokens handling changed? (`Yes/No`)
- New/changed network calls? (`Yes/No`)
- Command/tool execution surface changed? (`Yes/No`)
- Data access scope changed? (`Yes/No`)
- If any `Yes`, explain risk + mitigation:

## Repro + Verification

### Environment

- OS:
- Runtime/container:
- Model/provider:
- Integration/channel (if any):
- Relevant config (redacted):

### Steps

1.
2.
3.

### Expected

-

### Actual

-

## Evidence

Attach at least one:

- [ ] Failing test/log before + passing after
- [ ] Trace/log snippets
- [ ] Screenshot/recording
- [ ] Perf numbers (if relevant)

## Human Verification (required)

What you personally verified (not just CI), and how:

- Verified scenarios:
- Edge cases checked:
- What you did **not** verify:

## Review Conversations

- [ ] I replied to or resolved every bot review conversation I addressed in this PR.
- [ ] I left unresolved only the conversations that still need reviewer or maintainer judgment.

If a bot review conversation is addressed by this PR, resolve that conversation yourself. Do not leave bot review conversation cleanup for maintainers.

## Compatibility / Migration

- Backward compatible? (`Yes/No`)
- Config/env changes? (`Yes/No`)
- Migration needed? (`Yes/No`)
- If yes, exact upgrade steps:

## Failure Recovery (if this breaks)

- How to disable/revert this change quickly:
- Files/config to restore:
- Known bad symptoms reviewers should watch for:

## Risks and Mitigations

List only real risks for this PR. Add/remove entries as needed. If none, write `None`.

- Risk:
  - Mitigation:
