/**
 * Slice F — runtime-adapter wrapper that injects `inboundMediaSummary`
 * image paths into the `image_generate` tool's `image:` arg before tool
 * execution, completing the second half of the Telegram-image fix
 * started by Slice E (PR #315 / commit `1cc6e85f61`).
 *
 * Symptom this closes (production trace gateway-pr315b.log turnId
 * `a0ba62ec-5343-40cd-bc11-bd753eb8131a`): user sent a hand-drawn
 * ventilation sketch on Telegram. After Slice E the inbound photo
 * surfaces structurally on `inboundMediaSummary.attachments[].path`,
 * but when the chat model called `image_generate` with `prompt:
 * "ventilation scheme"` the `image:` arg was empty, so the tool ran in
 * text-to-image mode and produced a different (and wrong) diagram.
 *
 * The wrapper is the missing seam between the (frozen) precondition
 * resolver — `resolveInboundImageReferencePrecondition` already returns
 * `{ paths: [<sketchPath>] }` when Slice E populated the summary — and
 * the actual tool dispatch performed by `pi-agent-core`. It is the
 * structural sibling of `wrapToolWithBeforeToolCallHook` (only narrower
 * in scope) — it observes a closed STRUCTURED input (`toolName +
 * inboundMediaSummary + turnId`) and mutates only the `image_generate`
 * tool's `args.image` / `args.images` slots. Per invariants #5/#6 no
 * raw user text is read.
 *
 * Boundary discipline:
 *   - Lives in `src/agents/pi-embedded-runner/run/`, NOT in
 *     `src/platform/commitment/` — invariant #8.
 *   - The frozen-layer resolver (`resolveInboundImageReferencePrecondition`)
 *     is read-only; this wrapper consumes its output.
 *   - The pure injector (`injectInboundImageReferenceIntoToolArgs`,
 *     `artifact-runtime-adapter.ts:285`) is reused unchanged for the
 *     paths→args rewrite — this wrapper adds (a) the LLM-supplied
 *     `image:` preserve guard and (b) the per-call telemetry line.
 *   - Per the Slice F spec the wrapper MUST NOT overwrite an explicit
 *     `image:` arg supplied by the model. That preserves the rare case
 *     where the LLM picks a path itself (e.g. it picked one of two
 *     inbound images explicitly) and prevents this seam from silently
 *     stomping a deliberate choice.
 */

import {
  resolveInboundImageReferencePrecondition,
  type InboundImageReferencePreconditionValue,
} from "../../../platform/commitment/inbound-image-reference-precondition-resolver.js";
import type { InboundMediaSummary } from "../../../platform/inbound-media/types.js";
import {
  injectInboundImageReferenceIntoToolArgs,
  type ImageGenerateToolArgs,
} from "./artifact-runtime-adapter.js";
import type { AnyAgentTool } from "../../tools/common.js";

/**
 * Telemetry log line prefix used by the live-verifier gateway log gate.
 * Distinct from the `[image-generate] inputImages count=N
 * referenceMode=img2img` line emitted by the pure injector helper —
 * this line carries the bound path AND turnId so production traces can
 * be JOIN-ed against the upstream Slice E `attachments[].path` log.
 */
export const RUNTIME_ADAPTER_IMG2IMG_BIND_LOG_PREFIX = "[runtime-adapter] image_generate img2img-bind";

export interface WrapImageGenerateInput {
  /**
   * The tool to wrap. When `tool.name !== "image_generate"` the wrapper
   * returns the tool unchanged (defensive — callers may pass the full
   * tool list and let the wrapper filter).
   */
  readonly tool: AnyAgentTool;
  /**
   * The structural inbound-media summary for the current turn (from
   * `buildInboundMediaSummaryForTurn` in
   * `agent-runner-execution.ts`). When `undefined` the wrapper still
   * wraps but every call is a pass-through.
   */
  readonly inboundMediaSummary: InboundMediaSummary | undefined;
  /**
   * The per-turn id (the runner's `runId`) — included in the telemetry
   * line so production traces can JOIN the bind back to the originating
   * turn.
   */
  readonly turnId: string;
  /**
   * Optional sink for the `[runtime-adapter] image_generate img2img-bind
   * path=<path> turnId=<id>` line. Defaults to `console.log` so live
   * gateway traces capture the line without any extra wiring; tests
   * inject a `vi.fn()` to capture invocations.
   */
  readonly logger?: (line: string) => void;
}

function defaultLogger(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

/**
 * Wraps an `image_generate` tool's `execute` so that, when the current
 * turn has an inbound image attachment AND the model did NOT supply an
 * explicit `image:` arg, the wrapper injects `args.image = paths[0]`
 * (single-ref) or `args.images = paths` (multi-ref) BEFORE delegating
 * to the original execute.
 *
 * Pass-through cases (no mutation, no log line):
 *   - `tool.name !== "image_generate"` → tool returned verbatim.
 *   - `tool.execute` is missing.
 *   - `inboundMediaSummary` is `undefined` / empty.
 *   - The resolver returns `null` (e.g. only `kind: "pdf"` attachments).
 *   - The model already supplied `args.image` — explicit-LLM-choice
 *     guard.
 *
 * Telemetry: on injection, emits a line of the form
 *   `[runtime-adapter] image_generate img2img-bind path=<bound-path>
 *    turnId=<turn-id> count=<N>`
 * via the supplied `logger` (defaults to `console.log`).
 *
 * @param input - The tool, the structural inbound-media summary, the
 *   per-turn id, and optional logger.
 * @returns A new tool wrapper (or the original tool when the wrap is a
 *   no-op for the given inputs).
 */
export function wrapImageGenerateWithImg2ImgInjection(
  input: WrapImageGenerateInput,
): AnyAgentTool {
  if (input.tool.name !== "image_generate") {
    return input.tool;
  }
  const originalExecute = input.tool.execute;
  if (!originalExecute) {
    return input.tool;
  }
  const log = input.logger ?? defaultLogger;
  const wrapped: AnyAgentTool = {
    ...input.tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const incoming = (args ?? {}) as ImageGenerateToolArgs;
      const explicitImage = typeof incoming.image === "string" && incoming.image.length > 0;
      // The slice F preserve-existing rule — never stomp an explicit
      // model-supplied path. We MUST NOT defer this to the pure
      // injector in `artifact-runtime-adapter.ts` because that helper
      // is intentionally unconditional (Slice E shipped it that way for
      // affordance-resolver reuse). The guard belongs at the wrapper
      // because only the wrapper knows the args came from the LLM.
      if (explicitImage) {
        return originalExecute(toolCallId, args, signal, onUpdate);
      }
      // Compute the precondition from the structural summary at call
      // time (not at wrap time) — this way each tool call sees the
      // freshest summary even if the runner ever decides to refresh it
      // mid-turn (no current callsite does, but the wrapper stays
      // future-safe).
      const preconditionValue: InboundImageReferencePreconditionValue | null =
        resolveInboundImageReferencePrecondition(input.inboundMediaSummary);
      if (!preconditionValue || preconditionValue.paths.length === 0) {
        return originalExecute(toolCallId, args, signal, onUpdate);
      }
      const injection = injectInboundImageReferenceIntoToolArgs({
        toolName: "image_generate",
        toolArgs: incoming,
        preconditionValue,
      });
      if (!injection.injected) {
        return originalExecute(toolCallId, args, signal, onUpdate);
      }
      const boundPath = preconditionValue.paths[0] ?? "";
      log(
        `${RUNTIME_ADAPTER_IMG2IMG_BIND_LOG_PREFIX} path=${boundPath} turnId=${input.turnId} count=${String(preconditionValue.paths.length)}`,
      );
      return originalExecute(toolCallId, injection.toolArgs, signal, onUpdate);
    },
  };
  return wrapped;
}

/**
 * Convenience helper — walks a tool list and returns a NEW list with
 * the `image_generate` entry replaced by its img2img-injecting wrap.
 * Other entries pass through by reference. Used by the runner-side
 * wiring (`attempt.ts`) so the call site stays a one-liner.
 *
 * @param input - Tool list + `inboundMediaSummary` + `turnId` + optional
 *   logger.
 * @returns A NEW list with `image_generate` (if present) wrapped.
 */
export function applyImg2ImgInjectionToToolList(input: {
  readonly tools: readonly AnyAgentTool[];
  readonly inboundMediaSummary: InboundMediaSummary | undefined;
  readonly turnId: string;
  readonly logger?: (line: string) => void;
}): AnyAgentTool[] {
  return input.tools.map((tool) =>
    tool.name === "image_generate"
      ? wrapImageGenerateWithImg2ImgInjection({
          tool,
          inboundMediaSummary: input.inboundMediaSummary,
          turnId: input.turnId,
          ...(input.logger ? { logger: input.logger } : {}),
        })
      : tool,
  );
}
