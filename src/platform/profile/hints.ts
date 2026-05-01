/**
 * Normalize profile/recipe hint tokens for stable, deterministic merge output.
 * Trims whitespace, drops empties, dedupes, then sorts lexicographically (Unicode code point order).
 */
export function normalizeProfileHintList(values: readonly string[] | undefined): string[] {
  const trimmed = (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set(trimmed)).toSorted((a, b) => a.localeCompare(b));
}
