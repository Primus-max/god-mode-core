import { truncateUtf16Safe } from "../utils.js";

const TOOL_ERROR_MAX_CHARS = 400;

/** Stable tokens for receipts, logs (structured), and policy surfaces — never raw provider strings. */
export const TOOL_POLICY_ERROR_RECEIPT_REASONS = [
  "tool_not_allowed_in_channel",
  "approval_required",
  "tool_input_invalid",
  "tool_temporarily_unavailable",
  "execution_contract_unsatisfied",
] as const;
export type ToolPolicyErrorReceiptReason = (typeof TOOL_POLICY_ERROR_RECEIPT_REASONS)[number];

export type ToolPolicyClassifiedError = {
  receiptReason: ToolPolicyErrorReceiptReason;
  userMessage: string;
};

const USER_TOOL_NOT_ALLOWED =
  "This action is not allowed from this chat or tool context.";
const USER_APPROVAL_REQUIRED =
  "This action needs explicit approval before it can run.";
const USER_TOOL_INPUT_INVALID = "The tool could not use the provided arguments.";
const USER_TOOL_TEMPORARILY_UNAVAILABLE =
  "The tool is temporarily unavailable. Try again in a moment.";
const USER_EXECUTION_CONTRACT_UNSATISFIED =
  "This request cannot be fulfilled with the available execution path.";

const EXECUTION_CONTRACT_UNSATISFIED_PATTERNS = [
  /\bcontract_unsatisfiable\b/iu,
  /\bexecution_contract_unsatisfied\b/iu,
  /\bexecution contract\b.*\bunsatisf/iu,
] as const;

const CHANNEL_POLICY_PATTERNS = [
  /only reminder scheduling is allowed from this chat/iu,
  /not allowed from this chat/iu,
  /not permitted from this chat/iu,
  /tool is not (?:enabled|allowed) for this channel/iu,
  /disallowed for this (?:channel|surface)/iu,
] as const;

const TOOL_POLICY_DENIAL_PATTERNS = [
  ...CHANNEL_POLICY_PATTERNS,
  /blocked by (?:tool )?policy/iu,
  /denied by (?:tool )?policy/iu,
  /policy denial/iu,
  /forbidden by (?:tool )?policy/iu,
  /execution (?:is )?blocked by policy/iu,
] as const;

const APPROVAL_PATTERNS = [
  /approval[-_\s]?required/iu,
  /pending approval/iu,
  /awaiting approval/iu,
  /must be approved/iu,
  /requires explicit approval/iu,
  /operator approval/iu,
] as const;

const INPUT_INVALID_PATTERNS = [
  /\binvalid (?:json|arguments?|input|parameter)/iu,
  /\bvalidation failed\b/iu,
  /\bschema validation\b/iu,
  /\bzoderror\b/iu,
  /\bmissing required (?:field|property|argument)/iu,
  /\bunexpected token\b/iu,
  /\bparse error\b/iu,
  /\bmalformed\b.*\b(json|input)\b/iu,
  /must be (?:a |an )?(?:string|number|boolean|object|array)/iu,
  /\bis required\b/iu,
] as const;

const TRANSIENT_PATTERNS = [
  /\btimed?\s*out\b/iu,
  /\btimeout\b/iu,
  /\beconnrefused\b/iu,
  /\beconnreset\b/iu,
  /\bsocket hang up\b/iu,
  /\b503\b/iu,
  /\b502\b/iu,
  /\b504\b/iu,
  /\b529\b/iu,
  /\boverloaded\b/iu,
  /\brate limit\b/iu,
  /\b429\b/iu,
  /\btemporarily unavailable\b/iu,
  /\bservice unavailable\b/iu,
] as const;

function normalizeFirstLine(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) {
    return undefined;
  }
  return firstLine.length > TOOL_ERROR_MAX_CHARS
    ? `${truncateUtf16Safe(firstLine, TOOL_ERROR_MAX_CHARS)}…`
    : firstLine;
}

export function classifyToolPolicyError(text: string): ToolPolicyClassifiedError | null {
  const normalized = normalizeFirstLine(text);
  if (!normalized) {
    return null;
  }

  // Short tool status tokens (not full provider messages) — leave to callers as opaque labels.
  if (/^(?:timeout|failed|error|denied|cancel(?:led|ed)|invalid|forbidden)$/iu.test(normalized)) {
    return null;
  }

  if (EXECUTION_CONTRACT_UNSATISFIED_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      receiptReason: "execution_contract_unsatisfied",
      userMessage: USER_EXECUTION_CONTRACT_UNSATISFIED,
    };
  }

  if (TOOL_POLICY_DENIAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      receiptReason: "tool_not_allowed_in_channel",
      userMessage: USER_TOOL_NOT_ALLOWED,
    };
  }

  if (APPROVAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { receiptReason: "approval_required", userMessage: USER_APPROVAL_REQUIRED };
  }

  if (INPUT_INVALID_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { receiptReason: "tool_input_invalid", userMessage: USER_TOOL_INPUT_INVALID };
  }

  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      receiptReason: "tool_temporarily_unavailable",
      userMessage: USER_TOOL_TEMPORARILY_UNAVAILABLE,
    };
  }

  return null;
}

/**
 * Maps a raw tool/policy error string to a stable receipt reason (never user-facing prose in receipts).
 * Returns `undefined` when the error is not a known policy/transient pattern — callers should rely on
 * receipt `status` and structured metadata instead of inventing a misleading bucket.
 */
export function sanitizeToolErrorReasonForReceipt(raw: string | undefined): string | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const classified = classifyToolPolicyError(raw);
  if (classified) {
    return classified.receiptReason;
  }
  return undefined;
}

export function sanitizeToolErrorForUser(text: string): string | undefined {
  const normalized = normalizeFirstLine(text);
  if (!normalized) {
    return undefined;
  }
  const classified = classifyToolPolicyError(normalized);
  if (classified) {
    return classified.userMessage;
  }
  return normalized;
}

export function userFacingToolPolicyOrTransientMessage(text: string): string | undefined {
  return classifyToolPolicyError(text)?.userMessage;
}
