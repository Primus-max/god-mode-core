import type { PlatformRuntimeExecutionReceipt } from "../runtime/contracts.js";
import { defaultRuntime } from "../../runtime.js";
import { intentLedger as defaultIntentLedger } from "./intent-ledger.js";

const APPLY_PATCH_TOOL_NAME = "apply_patch";
const SHORT_SESSION_LENGTH = 8;

export type WorkspaceInvalidationLogger = {
  log: (message: string) => void;
};

export type WorkspaceInvalidationLedger = {
  invalidateWorkspace: (sessionId: string, channelId: string) => boolean;
};

export type WorkspaceInvalidationDefer = (callback: () => void) => unknown;

export type MaybeInvalidateWorkspaceForReceiptsOptions = {
  receipts: ReadonlyArray<PlatformRuntimeExecutionReceipt> | undefined;
  sessionId: string | undefined | null;
  channelId: string | undefined | null;
  ledger?: WorkspaceInvalidationLedger;
  logger?: WorkspaceInvalidationLogger;
  defer?: WorkspaceInvalidationDefer;
};

export type MaybeInvalidateWorkspaceForReceiptsResult = {
  scheduled: boolean;
  reason?: "no_session" | "no_channel" | "no_receipts" | "no_apply_patch";
};

export function shouldInvalidateWorkspaceForReceipt(
  receipt: PlatformRuntimeExecutionReceipt,
): boolean {
  if (receipt.kind !== "tool") return false;
  if (typeof receipt.name !== "string") return false;
  if (receipt.name.trim().toLowerCase() !== APPLY_PATCH_TOOL_NAME) return false;
  return receipt.status === "success";
}

export function maybeInvalidateWorkspaceForReceipts(
  options: MaybeInvalidateWorkspaceForReceiptsOptions,
): MaybeInvalidateWorkspaceForReceiptsResult {
  const sessionId = typeof options.sessionId === "string" ? options.sessionId.trim() : "";
  const channelId = typeof options.channelId === "string" ? options.channelId.trim() : "";
  if (!sessionId) return { scheduled: false, reason: "no_session" };
  if (!channelId) return { scheduled: false, reason: "no_channel" };
  const receipts = options.receipts ?? [];
  if (receipts.length === 0) return { scheduled: false, reason: "no_receipts" };
  const matched = receipts.some((receipt) => shouldInvalidateWorkspaceForReceipt(receipt));
  if (!matched) return { scheduled: false, reason: "no_apply_patch" };

  const ledger = options.ledger ?? defaultIntentLedger;
  const logger = options.logger ?? defaultRuntime;
  const defer = options.defer ?? setImmediate;

  defer(() => {
    let invalidated = false;
    try {
      invalidated = ledger.invalidateWorkspace(sessionId, channelId);
    } catch (err) {
      logger.log(
        `[workspace-probe] invalidate-failed reason=apply_patch session=${shortSessionId(sessionId)} error=${String(
          (err as Error)?.message ?? err,
        )}`,
      );
      return;
    }
    logger.log(
      `[workspace-probe] invalidated reason=apply_patch session=${shortSessionId(sessionId)} hit=${invalidated ? "1" : "0"}`,
    );
  });

  return { scheduled: true };
}

function shortSessionId(sessionId: string): string {
  const compact = sessionId.trim();
  return compact.length <= SHORT_SESSION_LENGTH
    ? compact
    : compact.slice(0, SHORT_SESSION_LENGTH);
}
