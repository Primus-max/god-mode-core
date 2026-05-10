/**
 * V1-CONTRACT-ONLY — Inbound attachment metadata.
 *
 * Symptom this surfaces: real Telegram turn 2026-05-10 12:52 — the user
 * wrote a long task description AND attached two Word document templates.
 * The orchestrator-v1 short-circuit only forwarded `userText`; the
 * attachment refs (`msg.document`, `msg.photo`, ...) were silently
 * dropped. Stage A then classified the request as "create files from
 * scratch" (image_generate / pdf / write) instead of "use the attached
 * docs as templates / read them".
 *
 * This module is a pure types file — no runtime behaviour. It defines a
 * minimal metadata record that:
 *
 *   - the inbound channel (Telegram first; other channels later) fills in
 *     from its own raw message envelope, and
 *   - the orchestrator forwards into Stage A so the classifier can route
 *     correctly when files are already provided.
 *
 * What is intentionally NOT here (out of scope, follow-up slice):
 *
 *   - downloading the file via Telegram Bot API,
 *   - reading attachment content (e.g. extracting docx text),
 *   - any tool runner consuming the file.
 *
 * That follow-up will extend this type with a `localPath?` once a download
 * pipeline lands; everything in this slice is content-blind metadata.
 */

/**
 * Coarse-grained attachment kind. We deliberately collapse Telegram-
 * specific subtypes (sticker / video_note / animation / etc.) into a
 * narrow whitelist so Stage A's prompt menu stays small and the classifier
 * is not asked to reason about exotic types it has no tool for. Anything
 * unmapped becomes `"other"`.
 */
export type InboundAttachmentKind =
  | "document"
  | "photo"
  | "audio"
  | "video"
  | "voice"
  | "sticker"
  | "other";

/**
 * One attachment carried by an inbound user turn.
 *
 * All optional fields are filled on a best-effort basis from the channel's
 * native envelope. Stage A reads `kind`, `filename` and `mimeType` only;
 * `telegramFileId` is reserved for the future download slice.
 */
export type InboundAttachment = {
  /** Coarse kind — the only required field. */
  kind: InboundAttachmentKind;
  /**
   * User-visible filename (Telegram `document.file_name`). Photos and
   * voice notes don't carry one — leave undefined.
   */
  filename?: string;
  /** MIME type when the channel reports one (Telegram documents do). */
  mimeType?: string;
  /**
   * Channel-native handle for a future download. For Telegram this is
   * `document.file_id` / `photo[-1].file_id` / etc. The classifier MUST
   * NOT inspect it; a future tool runner will.
   */
  telegramFileId?: string;
  /**
   * Caption the user typed alongside the file. The dispatch site also
   * forwards captions as part of `userText` already, so this is only
   * useful when a future channel separates caption from message body.
   */
  captionFromUser?: string;
};
