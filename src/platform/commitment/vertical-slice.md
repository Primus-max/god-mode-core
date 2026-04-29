# Commitment Runtime Vertical Slice

This note documents the first production integration slice for the commitment
runtime so future audits can follow one narrow path instead of reverse-
engineering the entire folder.

## Goal

Connect the existing commitment policies to a real agent turn before model
generation so the runtime can:

- detect when the current turn is underspecified and should ask a clarification
- detect when the current turn should cut over into agent execution
- keep the integration small enough to validate behavior without introducing a
  second orchestrator stack

## Scope

The first slice intentionally avoids full persistence, global replay, and
multi-turn planning. It only adds a preflight decision point for one live turn.

## Path

1. Build a minimal commitment input from the current session and user message.
2. Run world-state observation plus clarification and cutover policies.
3. Return a structured decision that the caller can log, test, and honor.
4. Integrate that decision at the runtime entrypoint before model work starts.

## Audit Pointers

- `src/platform/commitment/preflight.ts`
- `src/platform/commitment/command-preflight-runtime.ts`
- `src/platform/commitment/production-runtime-defaults.ts`
- `src/commands/agent-via-gateway.ts`

## Out Of Scope

- durable session shadow persistence
- planner DAGs or explicit task graphs
- broad prompt rewrites across agent surfaces
- replacing existing agent execution infrastructure
