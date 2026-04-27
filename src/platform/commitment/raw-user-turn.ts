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
