import type { DeliverableKind, DeliverableSpec } from "../produce/registry.js";
import { resolveProducer } from "../produce/registry.js";
import type { TaskCapabilityId } from "./capability-catalog.js";

/**
 * Declarative mapping from abstract task capabilities to concrete tool names
 * and from a deliverable to its producing tools.
 *
 * The capability catalog stays free of tool names on purpose ("capability =
 * intent"); this registry is where intent collides with the actual tool surface
 * the runtime exposes. Two readers consume it:
 *
 *   1. `mapTaskContractToBridge` — derives `requestedTools` for the planner
 *      from a TaskContract without the long if-chain it used to carry.
 *   2. (Future) Tool-availability gating — when a capability's only tools are
 *      missing we can route to a clarification or install flow.
 *
 * Add a tool by creating one entry here. Do NOT scatter `requestedTools.push`
 * back into the classifier; route everything through `deriveRequestedTools`.
 */

export type TaskToolEntry = {
  /** Stable runtime name surfaced to the planner / executor. */
  readonly name: string;
  /** Human-readable abstract description (no vendor names). */
  readonly intent: string;
  /** Capability ids this tool can satisfy. */
  readonly satisfiesCapabilities: readonly TaskCapabilityId[];
  /**
   * If set, the tool is suppressed when the deliverable.kind matches one of
   * these. Used to avoid requesting `apply_patch` when the deliverable is a
   * `repo_operation` (commit / run tests), which `exec` already covers.
   */
  readonly suppressForDeliverableKinds?: readonly DeliverableKind[];
};

export const TASK_TOOL_REGISTRY: readonly TaskToolEntry[] = [
  {
    name: "exec",
    intent: "execute a shell command or run a build/test in the user's workspace",
    satisfiesCapabilities: ["needs_repo_execution"],
  },
  {
    name: "apply_patch",
    intent: "apply a structured patch to workspace files",
    satisfiesCapabilities: ["needs_workspace_mutation"],
    // repo_operation deliverables (commit, run tests, run script) never want
    // a patch — they want exec. Keeping this guard out of the classifier means
    // the bridge stays tiny.
    suppressForDeliverableKinds: ["repo_operation"],
  },
  {
    name: "process",
    intent: "spawn or supervise a long-lived local process",
    satisfiesCapabilities: ["needs_local_runtime"],
  },
  {
    name: "browser",
    intent: "drive a real browser to inspect or interact with a live page",
    satisfiesCapabilities: ["needs_interactive_browser"],
  },
  {
    name: "web_search",
    intent: "look up fresh public information on the open web",
    satisfiesCapabilities: ["needs_web_research"],
  },
  {
    name: "image_generate",
    intent: "compose a raster visual artifact",
    // Both authoring intents (a pure visual artifact and an authored document
    // that may embed visuals) end up needing image generation today. Keeping
    // both in this list mirrors the prior bridge logic.
    satisfiesCapabilities: ["needs_visual_composition", "needs_multimodal_authoring"],
  },
];

const TOOLS_BY_CAPABILITY = (() => {
  const map = new Map<TaskCapabilityId, TaskToolEntry[]>();
  for (const entry of TASK_TOOL_REGISTRY) {
    for (const capabilityId of entry.satisfiesCapabilities) {
      const list = map.get(capabilityId) ?? [];
      list.push(entry);
      map.set(capabilityId, list);
    }
  }
  return map;
})();

export function listToolsForCapability(
  capabilityId: TaskCapabilityId,
): readonly TaskToolEntry[] {
  return TOOLS_BY_CAPABILITY.get(capabilityId) ?? [];
}

/**
 * Project a (capabilities, deliverable) pair into the deduplicated, ordered
 * list of runtime tool names the planner should request.
 *
 * Rules baked in:
 *   - Each capability contributes the tools registered to it.
 *   - A tool's `suppressForDeliverableKinds` guard wins over a capability that
 *     would otherwise request it.
 *   - The deliverable's own producer chain (resolved via produce/registry) is
 *     appended last so format-driven tools (`pdf`, `docx_write`, `csv_write`,
 *     `apply_patch` for code_change/edit, …) come along automatically.
 *   - `deliverable.constraints.tool` is appended verbatim. This is the freeform
 *     escape hatch the classifier uses for built-in tools that have no
 *     producer entry (today: the cron / reminder tool routed via
 *     `kind="answer"` constraints).
 */
export function deriveRequestedTools(params: {
  capabilities: ReadonlySet<TaskCapabilityId>;
  deliverable?: DeliverableSpec | undefined;
}): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (name: string | undefined): void => {
    if (typeof name !== "string") {
      return;
    }
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  };

  for (const entry of TASK_TOOL_REGISTRY) {
    const capable = entry.satisfiesCapabilities.some((capabilityId) =>
      params.capabilities.has(capabilityId),
    );
    if (!capable) {
      continue;
    }
    if (
      entry.suppressForDeliverableKinds &&
      params.deliverable !== undefined &&
      entry.suppressForDeliverableKinds.includes(params.deliverable.kind)
    ) {
      continue;
    }
    add(entry.name);
  }

  const producerResolution = resolveProducer(params.deliverable);
  for (const toolName of producerResolution.toolNames) {
    add(toolName);
  }

  const constraintsTool = params.deliverable?.constraints?.tool;
  if (typeof constraintsTool === "string") {
    add(constraintsTool);
  }
  return ordered;
}
