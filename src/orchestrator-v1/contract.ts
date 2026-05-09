/**
 * V1-CONTRACT-ONLY — TurnContract schema + Stage-A routing schema.
 *
 * Two-stage classifier per V1-CONTRACT-ONLY plan revision 2:
 *   Stage A → StageARoutingSchema  (intent + tool names + sequencing)
 *   Stage B → TurnContractSchema   (full args populated per tool)
 *
 * The dispatcher consumes only TurnContract. Reply text is rendered from
 * a fixed catalog (reply-templates.ts), never from a classifier-emitted
 * field. This is the single biggest divergence from prior architectures
 * and the reason the bot cannot author free-form action claims.
 */

import { z } from "zod";

/** Names of every tool the orchestrator can dispatch. Stage A picks names from this list. */
export const TOOL_NAMES = [
  "write",
  "edit",
  "read",
  "image_generate",
  "web_search",
  "web_fetch",
  "sessions_send",
  "persistent_worker_push",
  "cron",
  "exec",
] as const;

export const ToolNameSchema = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolNameSchema>;

/**
 * Stage-A output: intent classification + which tools to invoke.
 * Args are NOT populated here; Stage B handles per-tool extraction.
 */
export const StageARoutingSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("tool_calls"),
    tool_names: z.array(ToolNameSchema).min(1),
    sequencing: z.enum(["sequential", "parallel"]).default("sequential"),
  }),
  z.object({
    intent: z.literal("conversation"),
  }),
  z.object({
    intent: z.literal("refuse"),
    refusal_reason: z.string().min(1),
  }),
]);
export type StageARouting = z.infer<typeof StageARoutingSchema>;

/**
 * A single dispatcher action — tool name + validated args.
 * `args` is `Record<string, unknown>` here because each tool has its
 * own arg schema; Stage B validates against the per-tool schema before
 * the args reach the dispatcher. The dispatcher trusts that validation.
 */
export const TurnActionSchema = z.object({
  tool: ToolNameSchema,
  args: z.record(z.string(), z.unknown()),
});
export type TurnAction = z.infer<typeof TurnActionSchema>;

/**
 * Full TurnContract — what Stage B emits and the dispatcher consumes.
 * The conversation and refuse variants are identical to Stage A's
 * (no per-tool args needed); the tool_calls variant has the actions array.
 */
export const TurnContractSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("tool_calls"),
    tool_calls: z.array(TurnActionSchema).min(1),
    sequencing: z.enum(["sequential", "parallel"]).default("sequential"),
  }),
  z.object({
    intent: z.literal("conversation"),
  }),
  z.object({
    intent: z.literal("refuse"),
    refusal_reason: z.string().min(1),
  }),
]);
export type TurnContract = z.infer<typeof TurnContractSchema>;

/** Helper: build a refuse contract (stable shape used by callers on validation failure). */
export function refuseContract(reason: string): TurnContract {
  return { intent: "refuse", refusal_reason: reason };
}

/** Helper: build a conversation contract. */
export function conversationContract(): TurnContract {
  return { intent: "conversation" };
}

/** Helper: build a tool_calls contract; throws if the array is empty. */
export function toolCallsContract(
  tool_calls: TurnAction[],
  sequencing: "sequential" | "parallel" = "sequential",
): TurnContract {
  if (tool_calls.length === 0) {
    throw new Error("toolCallsContract: tool_calls must be non-empty");
  }
  return { intent: "tool_calls", tool_calls, sequencing };
}
