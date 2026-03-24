# Extension Seams: Core vs Platform

This document maps where the platform layer hooks into OpenClaw core
without modifying upstream code.

## Seam 1 — Agent Command Entry

**Core file:** `src/commands/agent.ts` → `src/agents/agent-command.ts`

**What core does:** Loads config, resolves session/agent scope, calls
`runAgentAttempt` which dispatches to CLI or embedded runner.

**Platform hook:** Wrap `prepareAgentCommandExecution` to inject:
- Active profile state (`ActiveProfileState`) from profile resolver
- Task overlay resolution before model selection
- Recipe selection via planner output

**How:** Plugin hook `before_agent_start` already exists in
`src/plugins/types.ts`. Platform registers a hook that enriches params
with profile + recipe context. No core patch needed.

## Seam 2 — Embedded Runner Loop

**Core file:** `src/agents/pi-embedded-runner/run.ts`

**What core does:** Queue → hooks → model resolve → auth → retry loop
around `runEmbeddedAttempt`.

**Platform hooks (existing):**
- `before_model_resolve` — inject model override based on profile/recipe
- `before_prompt_build` — inject profile-specific system prompt sections
- `llm_input` / `llm_output` — audit, policy enforcement, artifact extraction

**Platform hooks (new, via plugin API):**
- `before_recipe_execute` — validate recipe prerequisites
- `after_recipe_execute` — artifact capture, publish triggers

**How:** Register via `api.on("before_model_resolve", ...)` etc. in a
platform plugin. The runner already calls these hooks; no fork needed.

## Seam 3 — Model Selection

**Core file:** `src/agents/model-selection.ts`, `src/agents/model-fallback.ts`

**What core does:** Parse `provider/model` refs, build catalog, fallback chain.

**Platform hook:** Profile resolver sets `model` in agent defaults before
the selection pipeline runs. RouterAI provider is registered as a custom
provider in config (`models.providers`), not a code change.

## Seam 4 — Plugin Registration

**Core file:** `src/plugins/types.ts`, `src/plugins/loader.ts`

**What core does:** Discover plugins, call `register(api)`, wire hooks.

**Platform hook:** The platform layer IS a plugin (or set of plugins).
It registers:
- Profile resolver hook
- Recipe planner hook
- Capability bootstrap service
- Artifact store service
- Policy engine hook

All via `OpenClawPluginApi` methods: `registerTool`, `registerService`,
`on(hookName, ...)`, etc.

## Seam 5 — Gateway / OpenAI Facade

**Core file:** `src/gateway/openai-http.ts`, `src/gateway/server-methods/agent.ts`

**What core does:** Serve OpenAI-compatible HTTP API, WS control protocol.

**Platform hook:** `registerHttpRoute` and `registerGatewayMethod` for:
- `/platform/profiles` — list/switch profiles
- `/platform/artifacts` — artifact CRUD
- `/platform/capabilities` — capability status
- `/platform/recipes` — recipe catalog

## Seam 6 — Security Audit

**Core file:** `src/security/audit.ts`

**What core does:** Audit config, file permissions, dangerous patterns.

**Platform hook:** Add platform-specific audit checks via hook or by
extending the audit runner. Policy engine checks run BEFORE model calls
and are deterministic (no LLM dependency).

## Seam 7 — UI i18n

**Core file:** `ui/src/i18n/lib/registry.ts`, `ui/src/i18n/lib/translate.ts`

**What core does:** Locale registry, translation lookup.

**Platform hook:** Register `ru` locale with Russian translations.
The registry already supports dynamic locale registration.

---

## Summary: What stays in core vs platform

| Layer | In Core (upstream-safe) | In Platform (extensions) |
|-------|------------------------|--------------------------|
| Agent dispatch | `agent-command.ts` | Profile/recipe pre-processing hook |
| Model selection | `model-selection.ts` | Profile-based model hints |
| Runner loop | `pi-embedded-runner/run.ts` | Hooks for recipe/artifact/policy |
| Plugin system | `plugins/types.ts` + loader | Platform plugin registration |
| Gateway API | `openai-http.ts` | Platform HTTP routes |
| Security | `audit.ts` | Policy engine rules |
| UI | i18n registry | Russian locale + platform UI pages |
| Config | Zod schemas | Platform schemas in `src/platform/` |

## Key principle

The platform layer **never patches core files**. It uses the existing
hook/plugin/provider APIs. If a hook point is missing, we contribute
it upstream (small, generic) rather than forking the runner.
