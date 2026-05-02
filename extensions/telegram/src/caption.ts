export const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

export function splitTelegramCaption(text?: string): {
  caption?: string;
  followUpText?: string;
} {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) {
    return { caption: undefined, followUpText: undefined };
  }
  if (trimmed.length <= TELEGRAM_MAX_CAPTION_LENGTH) {
    return { caption: trimmed, followUpText: undefined };
  }
  const head = trimmed.slice(0, TELEGRAM_MAX_CAPTION_LENGTH);
  const wsMatch = /\s+\S*$/.exec(head);
  const minCaptionLength = Math.floor(TELEGRAM_MAX_CAPTION_LENGTH / 2);
  const splitAt =
    wsMatch && wsMatch.index >= minCaptionLength
      ? wsMatch.index
      : TELEGRAM_MAX_CAPTION_LENGTH;
  const caption = trimmed.slice(0, splitAt).trimEnd();
  const followUpText = trimmed.slice(splitAt).trimStart();
  return {
    caption: caption.length > 0 ? caption : undefined,
    followUpText: followUpText.length > 0 ? followUpText : undefined,
  };
}
