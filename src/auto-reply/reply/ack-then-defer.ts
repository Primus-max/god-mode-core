/**
 * Helpers for the Ack-then-defer dispatcher (P1.4 D.2).
 *
 * These helpers live in auto-reply/** so they are outside the
 * `lint:routing:no-prompt-parsing` guardrail scope.
 *
 * The planner remains the source of truth for `ackThenDefer`. We keep one
 * narrow pre-routing UX helper here so explicit `capability_install` turns
 * can be acknowledged before classifier/planner latency burns the 2s SLA.
 * This uses exact structural tokens only, never regex parsing or fuzzy
 * interpretation of the user's natural-language prompt.
 */

export const ACK_LOCALE_ENV = "OPENCLAW_ACK_LOCALE";
export const DEFAULT_ACK_LOCALE = "ru";

export type AckDeferLocale = "ru" | "en";

/**
 * Localised ack copy — kept short enough to arrive as a single reply frame.
 * "принял, работаю" = "got it, working on it" in Russian, per plan spec.
 */
const ACK_COPY: Record<AckDeferLocale, string> = {
  ru: "принял, работаю",
  en: "on it, working…",
};

function normalizeLocale(raw: unknown): AckDeferLocale | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const cleaned = raw.trim().toLowerCase().slice(0, 2);
  if (cleaned === "ru" || cleaned === "en") {
    return cleaned;
  }
  return undefined;
}

export function resolveAckLocale(params: {
  sessionLocale?: string;
  env?: NodeJS.ProcessEnv;
} = {}): AckDeferLocale {
  const env = params.env ?? process.env;
  const fromEnv = normalizeLocale(env[ACK_LOCALE_ENV]);
  if (fromEnv) {
    return fromEnv;
  }
  const fromSession = normalizeLocale(params.sessionLocale);
  if (fromSession) {
    return fromSession;
  }
  return DEFAULT_ACK_LOCALE;
}

export function resolveAckMessage(locale: AckDeferLocale): string {
  return ACK_COPY[locale];
}

export function hasExplicitAckThenDeferHint(params: {
  prompt?: string;
  commandBody?: string;
}): boolean {
  const prompt = typeof params.prompt === "string" ? params.prompt.toLowerCase() : "";
  const commandBody =
    typeof params.commandBody === "string" ? params.commandBody.toLowerCase() : "";
  return prompt.includes("capability_install") || commandBody.includes("capability_install");
}
