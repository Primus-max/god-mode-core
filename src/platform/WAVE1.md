# Wave 1 — Files for Stage 1 (Profile & Policy)

This is the implementation file list for Stage 1, derived from the
architecture baseline established in Stage 0.

## Stage 0 deliverables (done)

| File                                           | Purpose                                              |
| ---------------------------------------------- | ---------------------------------------------------- |
| `src/platform/schemas/profile.ts`              | Profile, TaskOverlay, ActiveProfileState Zod schemas |
| `src/platform/schemas/recipe.ts`               | ExecutionRecipe, PlannerOutput Zod schemas           |
| `src/platform/schemas/capability.ts`           | CapabilityDescriptor, CatalogEntry Zod schemas       |
| `src/platform/schemas/artifact.ts`             | ArtifactDescriptor, ArtifactOperation Zod schemas    |
| `src/platform/schemas/index.ts`                | Barrel export for all schemas                        |
| `src/platform/registry/types.ts`               | Registry interface contracts                         |
| `src/platform/registry/profile-registry.ts`    | In-memory profile registry                           |
| `src/platform/registry/recipe-registry.ts`     | In-memory recipe registry                            |
| `src/platform/registry/capability-registry.ts` | In-memory capability registry                        |
| `src/platform/registry/artifact-store.ts`      | In-memory artifact store                             |
| `src/platform/registry/index.ts`               | Barrel export for registries                         |
| `src/platform/SEAMS.md`                        | Extension seam map (core vs platform)                |
| `src/platform/WAVE1.md`                        | This file                                            |

## Stage 1 implementation targets

### 1.1 Profile resolver

| File (to create)                        | Purpose                                               |
| --------------------------------------- | ----------------------------------------------------- |
| `src/platform/profile/resolver.ts`      | Score signals, resolve base + session profile         |
| `src/platform/profile/signals.ts`       | Extract profile signals from channel, files, dialogue |
| `src/platform/profile/defaults.ts`      | Default profile definitions (baseline set)            |
| `src/platform/profile/resolver.test.ts` | Unit tests for resolver logic                         |
| `src/platform/profile/signals.test.ts`  | Unit tests for signal extraction                      |

### 1.2 Task overlay engine

| File (to create)                       | Purpose                                     |
| -------------------------------------- | ------------------------------------------- |
| `src/platform/profile/overlay.ts`      | Apply task overlay on top of active profile |
| `src/platform/profile/overlay.test.ts` | Unit tests for overlay application          |

### 1.3 Policy engine (v1 — deterministic rules)

| File (to create)                     | Purpose                                |
| ------------------------------------ | -------------------------------------- |
| `src/platform/policy/engine.ts`      | Evaluate policy rules before execution |
| `src/platform/policy/rules.ts`       | Default policy rule set                |
| `src/platform/policy/types.ts`       | PolicyRule, PolicyDecision types       |
| `src/platform/policy/engine.test.ts` | Unit tests for policy evaluation       |

### 1.4 Platform plugin (wiring into OpenClaw hooks)

| File (to create)              | Purpose                                           |
| ----------------------------- | ------------------------------------------------- |
| `src/platform/plugin.ts`      | `register(api)` entry — wire profile/policy hooks |
| `src/platform/plugin.test.ts` | Integration test for hook registration            |

### 1.5 Core hooks needed (upstream-safe additions)

These hooks exist or can be added as generic, small upstream PRs:

| Hook name              | Where it fires              | Platform use                |
| ---------------------- | --------------------------- | --------------------------- |
| `before_agent_start`   | `agent-command.ts`          | Inject profile state        |
| `before_model_resolve` | `pi-embedded-runner/run.ts` | Override model from profile |
| `before_prompt_build`  | embedded runner             | Add profile system prompt   |
| `llm_output`           | embedded runner             | Extract artifact signals    |

### 1.6 Russian locale (Stage 7, but foundation here)

| File (to create)            | Purpose                     |
| --------------------------- | --------------------------- |
| `ui/src/i18n/locales/ru.ts` | Russian translation strings |

## Dependencies

- **zod** — already in the project (`zod@^4.3.6`)
- No new runtime dependencies needed for Stage 1

## Test strategy

- Schema validation: `vitest` unit tests (done in Stage 0)
- Registry contracts: `vitest` unit tests (done in Stage 0)
- Profile resolver: pure-function unit tests
- Policy engine: deterministic rule evaluation, no LLM
- Plugin wiring: mock `OpenClawPluginApi`, verify hook registration
- Snapshot: baseline descriptor identity (done in Stage 0)
