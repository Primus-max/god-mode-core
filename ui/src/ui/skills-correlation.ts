import type { SkillStatusEntry } from "./types.ts";

export const SKILL_FILTER_MISSING = "missing";
export const SKILL_FILTER_BLOCKED = "blocked by allowlist";

function collectSkillMissingTokens(skill: SkillStatusEntry): string[] {
  return [
    ...skill.missing.bins.map((value) => `bin:${value}`),
    ...skill.missing.env.map((value) => `env:${value}`),
    ...skill.missing.config.map((value) => `config:${value}`),
    ...skill.missing.os.map((value) => `os:${value}`),
  ];
}

export function buildSkillSearchText(skill: SkillStatusEntry): string {
  const missing = collectSkillMissingTokens(skill);
  const tokens = [
    skill.name,
    skill.description,
    skill.source,
    skill.skillKey,
    ...missing,
    ...(missing.length > 0 ? [SKILL_FILTER_MISSING] : []),
    ...(skill.disabled ? ["disabled"] : []),
    ...(skill.blockedByAllowlist ? [SKILL_FILTER_BLOCKED, "blocked"] : []),
  ];
  return tokens.join(" ").toLowerCase();
}
