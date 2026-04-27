import type {
  ChannelId,
  EffectFamilyId,
  ReadonlyRecord,
  SessionId,
} from "./ids.js";

export type TargetRef =
  | { readonly kind: "session"; readonly sessionId?: SessionId }
  | { readonly kind: "artifact"; readonly artifactId?: string }
  | { readonly kind: "workspace" }
  | { readonly kind: "external_channel"; readonly channelId?: ChannelId }
  | { readonly kind: "unspecified" };

export type OperationHint =
  | { readonly kind: "create" }
  | { readonly kind: "update"; readonly updateOf?: TargetRef }
  | { readonly kind: "cancel"; readonly cancelOf?: TargetRef }
  | { readonly kind: "observe" }
  | { readonly kind: "custom"; readonly verb: string };

export type SemanticIntent = {
  readonly desiredEffectFamily: EffectFamilyId;
  readonly target: TargetRef;
  readonly operation?: OperationHint;
  readonly constraints: ReadonlyRecord<string, unknown>;
  readonly uncertainty: readonly string[];
  readonly confidence: number;
};
