export type AmbiguityKind = "blocking" | "preference" | "missing_optional_detail";

export type AmbiguityPolicyContractSnapshot = {
  primaryOutcome?: string;
  interactionMode?: string;
  outcomeContract?: string;
  deliverable?: { kind?: string };
  requiredCapabilities?: readonly string[];
};

export type AmbiguityProfileEntry = {
  reason: string;
  kind: AmbiguityKind;
  blocksClarification: boolean;
};

const AMBIGUITY_PREFIX_RE =
  /^(?:(blocking ambiguity|blocking|preference ambiguity|preference|missing optional detail|optional)\s*:\s*)/i;
const OPTIONAL_DETAIL_RE =
  /\b(style|tone|branding|brand|template|filename|file name|delivery formatting|visual style|color|colour|audience)\b/i;
const PREFERENCE_DETAIL_RE =
  /\b(commit message|receipt format|preferred format|page count|length|format priority)\b/i;
const BLOCKING_DETAIL_RE =
  /\b(publish target|deployment target|production target|target file|target path|scope of the change|missing context|credentials?|api key|token|permission|approval|unsafe|cannot safely|not safe)\b/i;

/**
 * Normalizes free-form ambiguity text into stable tokens used for repeated-clarify detection.
 *
 * @param value - Ambiguity text or assistant clarification summary.
 * @returns Lower-case word tokens with punctuation removed.
 */
export function normalizeClarifyToken(value: string): string[] {
  return value
    .toLowerCase()
    .replace(AMBIGUITY_PREFIX_RE, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * Builds the stable topic key used to group repeated clarification turns.
 *
 * @param ambigs - Ambiguity reasons for the current clarification.
 * @returns Stable topic key, or an empty string when no reason was provided.
 */
export function clarifyTopicKey(ambigs: readonly string[]): string {
  const words = ambigs
    .flatMap((entry) => normalizeClarifyToken(entry))
    .toSorted((left, right) => left.localeCompare(right));
  const joined = words.join("|");
  if (!joined) {
    return "";
  }
  return joined.slice(0, 80);
}

function classifyPrefixedAmbiguity(reason: string): AmbiguityKind | undefined {
  const match = AMBIGUITY_PREFIX_RE.exec(reason.trim());
  const prefix = match?.[1]?.toLowerCase();
  if (!prefix) {
    return undefined;
  }
  if (prefix.startsWith("blocking")) {
    return "blocking";
  }
  if (prefix.startsWith("preference")) {
    return "preference";
  }
  return "missing_optional_detail";
}

/**
 * Classifies an ambiguity reason into the policy bucket that controls clarify behavior.
 *
 * @param reason - Free-form ambiguity reason from classifier or qualification.
 * @param contract - Optional contract snapshot that gives outcome context.
 * @returns Ambiguity bucket; only `blocking` may trigger clarify.
 */
export function classifyAmbiguityReason(
  reason: string,
  contract: AmbiguityPolicyContractSnapshot = {},
): AmbiguityKind {
  const prefixed = classifyPrefixedAmbiguity(reason);
  if (prefixed) {
    return prefixed;
  }
  if (OPTIONAL_DETAIL_RE.test(reason)) {
    return "missing_optional_detail";
  }
  if (PREFERENCE_DETAIL_RE.test(reason)) {
    return "preference";
  }
  if (
    BLOCKING_DETAIL_RE.test(reason) ||
    reason.includes("without an explicit publish target") ||
    contract.outcomeContract === "external_operation"
  ) {
    return "blocking";
  }
  if (
    contract.primaryOutcome === "clarification_needed" ||
    contract.interactionMode === "clarify_first"
  ) {
    return "blocking";
  }
  if (reason.includes("multiple candidate families") || reason.includes("span multiple execution surfaces")) {
    return "preference";
  }
  return "preference";
}

/**
 * Builds a classified ambiguity profile for decision traces and clarify policy checks.
 *
 * @param reasons - Ambiguity reasons to classify.
 * @param contract - Optional contract snapshot that gives outcome context.
 * @returns Classified ambiguity profile entries.
 */
export function buildAmbiguityProfile(
  reasons: readonly string[] | undefined,
  contract: AmbiguityPolicyContractSnapshot = {},
): AmbiguityProfileEntry[] {
  return (reasons ?? [])
    .map((reason) => reason.trim())
    .filter(Boolean)
    .map((reason) => {
      const kind = classifyAmbiguityReason(reason, contract);
      return {
        reason,
        kind,
        blocksClarification: kind === "blocking",
      };
    });
}

/**
 * Returns only ambiguity reasons that are blocking for execution.
 *
 * @param reasons - Ambiguity reasons to filter.
 * @param contract - Optional contract snapshot that gives outcome context.
 * @returns Blocking ambiguity reasons.
 */
export function blockingAmbiguityReasons(
  reasons: readonly string[] | undefined,
  contract: AmbiguityPolicyContractSnapshot = {},
): string[] {
  return buildAmbiguityProfile(reasons, contract)
    .filter((entry) => entry.blocksClarification)
    .map((entry) => entry.reason);
}
