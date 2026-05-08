// Lazy-load barrel for `memory-store-bootstrap.js`. Created so callers
// (notably `auto-reply/reply/agent-runner.ts:973` per the remediation
// slice "Fix 1+2 — thread kernel deps") can dynamically import the
// process-scoped memory runtime WITHOUT pulling the heavy transitive
// dep graph (notably `agents/agent-scope.js`) into their static module
// chain. Statically importing `getMemoryRuntime` from agent-runner.ts
// turned `agent-scope.js` into an eager dependency, which caused
// `vi.mock("../../agents/agent-scope.js")` registrations in sibling
// `*.test.ts` files (e.g. `agent-runner-utils.test.ts`) to lose the
// race against `test/setup.ts`'s eager pre-loads — same root cause as
// PR #303 / #304 / #305 / #308 / #309.
//
// Boundary discipline (per AGENTS.md "Dynamic import guardrail"):
//   - production code MUST go through this `*.runtime.ts` re-export
//     when lazy-loading; do not mix `await import("../server/memory-store-bootstrap.js")`
//     with `import ... from "../server/memory-store-bootstrap.js"` in
//     production paths.
//   - tests may import the underlying module directly (test code is
//     not part of the production import graph for this rule).
export { getMemoryRuntime } from "./memory-store-bootstrap.js";
export type { MemoryRuntime } from "./memory-store-bootstrap.js";
