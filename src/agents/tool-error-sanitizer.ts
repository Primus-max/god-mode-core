import { truncateUtf16Safe } from "../utils.js";

const TOOL_ERROR_MAX_CHARS = 400;
const GENERIC_POLICY_DENIAL =
  "This action is not allowed from this chat or tool context.";

const INTERNAL_DENIAL_PATTERNS = [
  /only reminder scheduling is allowed from this chat/iu,
  /not allowed from this chat/iu,
  /not permitted from this chat/iu,
  /blocked by (?:tool )?policy/iu,
  /denied by (?:tool )?policy/iu,
  /policy denial/iu,
  /forbidden by (?:tool )?policy/iu,
];

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

export function sanitizeToolErrorForUser(text: string): string | undefined {
  const normalized = normalizeFirstLine(text);
  if (!normalized) {
    return undefined;
  }
  if (INTERNAL_DENIAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return GENERIC_POLICY_DENIAL;
  }
  return normalized;
}

