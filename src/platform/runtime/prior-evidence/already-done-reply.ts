import type { ReplyPayload } from "../../../auto-reply/types.js";

function buildAlreadyDoneTextFromMetadata(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata) {
    return undefined;
  }
  const url =
    typeof metadata.url === "string" && metadata.url.trim()
      ? metadata.url.trim()
      : undefined;
  const path =
    typeof metadata.path === "string" && metadata.path.trim()
      ? metadata.path.trim()
      : typeof metadata.filePath === "string" && metadata.filePath.trim()
        ? metadata.filePath.trim()
        : undefined;
  const pid =
    typeof metadata.pid === "number"
      ? `PID ${String(metadata.pid)}`
      : typeof metadata.pid === "string" && metadata.pid.trim()
        ? `PID ${metadata.pid.trim()}`
        : undefined;
  if (url && pid) {
    return `${url} (${pid})`;
  }
  return url ?? path ?? pid;
}

export function buildAlreadyDoneReply(params: {
  receipts: Array<{
    summary?: string;
    metadata?: Record<string, unknown>;
  }>;
}): ReplyPayload {
  for (const receipt of params.receipts) {
    const detail = buildAlreadyDoneTextFromMetadata(receipt.metadata);
    if (detail) {
      return { text: `Уже сделано: ${detail}` };
    }
  }
  for (const receipt of params.receipts) {
    const summary = receipt.summary?.trim();
    if (summary) {
      return { text: `Уже сделано: ${summary}` };
    }
  }
  return { text: "Уже сделано: использую receipt предыдущего успешного запуска." };
}
