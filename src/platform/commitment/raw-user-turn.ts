import type { ChannelId, ISO8601 } from "./ids.js";

declare const UserPromptBrand: unique symbol;
export type UserPrompt = string & { readonly [UserPromptBrand]: true };

declare const RawUserTextBrand: unique symbol;
export type RawUserText = string & { readonly [RawUserTextBrand]: true };

export type AttachmentRef = {
  readonly kind: "file" | "image" | "audio" | "other";
  readonly url: string;
  readonly mimeType: string;
};

export type RawUserTurn = {
  readonly text: RawUserText;
  readonly channel: ChannelId;
  readonly receivedAt: ISO8601;
  readonly attachments: readonly AttachmentRef[];
};

/**
 * Brands an inbound prompt as a `RawUserTurn` inside the IntentContractor boundary.
 *
 * @param prompt - User-visible prompt text passed by legacy decision callers.
 * @param options - Optional channel, timestamp, and attachments metadata.
 * @returns Branded raw user turn for internal IntentContractor processing.
 */
export function makeRawUserTurn(
  prompt: string,
  options: {
    readonly channel?: ChannelId;
    readonly receivedAt?: ISO8601;
    readonly attachments?: readonly AttachmentRef[];
  } = {},
): RawUserTurn {
  return {
    text: prompt as RawUserText,
    channel: options.channel ?? ("unknown" as ChannelId),
    receivedAt: options.receivedAt ?? (new Date().toISOString() as ISO8601),
    attachments: options.attachments ?? [],
  };
}
