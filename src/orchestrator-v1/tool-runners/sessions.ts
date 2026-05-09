/**
 * V1-CUTOVER S6 — sessions_send tool runner.
 *
 * Thin wrapper around the production session/channel send transport. The
 * runner returns the dispatcher's `ToolRunResult` shape; reply text is
 * rendered by `reply-templates.ts` from the returned `output.channel`
 * (template `sessions_send:success` = "Отправил в {channel}.").
 *
 * Architecture notes (see `.cursor/plans/V1-CUTOVER-2026-05-09-execution.md`):
 *   - The runner does NOT loop back into the orchestrator. A
 *     `sessions_send` action is a fire-and-forget dispatch to whatever
 *     channel/chat the user named (Telegram chat id, Slack channel, etc.).
 *   - Real transport wiring is the cutover-phase job (S8/S9) — the
 *     registry slice plumbs a real `SendFn` here. Until that lands the
 *     default `SendFn` fails-closed with a clear error so the orchestrator
 *     reply renders a truthful failure rather than silently no-op-ing.
 *   - Tests mock `SendFn` at the module boundary by passing the override
 *     into `runSessionsSend(args, { send })`. The test asserts the mock
 *     received the EXACT `args.channel` so the runner can never
 *     accidentally route to the wrong session.
 */

import type { ToolRunResult } from "../dispatcher.js";

/** Underlying send transport. Production wires this in the registry slice. */
export type SessionsSendFn = (channel: string, text: string) => Promise<void>;

/** Optional dependency injection for tests + future production wiring. */
export type SessionsSendDeps = {
  send?: SessionsSendFn;
};

/**
 * Default send implementation — fails-closed until production wires the
 * real transport in the cutover phase. The dispatcher renders this as a
 * `sessions_send:failure` reply, never as a silent success.
 */
const defaultSend: SessionsSendFn = async () => {
  throw new Error("sessions_send transport not configured");
};

export async function runSessionsSend(
  args: { channel: string; text: string },
  deps?: SessionsSendDeps,
): Promise<ToolRunResult> {
  const send = deps?.send ?? defaultSend;
  try {
    await send(args.channel, args.text);
    return { ok: true, output: { channel: args.channel } };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error: error.length > 0 ? error : "sessions_send failed" };
  }
}
