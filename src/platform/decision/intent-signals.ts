const COMPARE_INTENT_HINTS = [
  "compare",
  "comparison",
  "comparing",
  "reconcile",
  "reconciliation",
  "side by side",
  "price diff",
  "discrepanc",
  "variance",
  "match up",
  "сравн",
  "сопостав",
  "расхожден",
  "совпаден",
  "сверк",
  "выверк",
  "разница в цен",
] as const;

const CALCULATION_INTENT_HINTS = [
  "ventilation",
  "cfm",
  "airflow",
  "hvac",
  "duct",
  "btu",
  "unit conversion",
  "dimensional analysis",
  "square feet",
  "square foot",
  "cubic meter",
  "cubic metre",
  "ventilation report",
  "вентиляц",
  "кубатур",
  "площад",
  "перевод единиц",
  "единиц измерен",
  "размер помещен",
  "расчёт",
  "расчет",
  "рассчитай",
  "приток",
  "вытяжк",
] as const;

export const TABULAR_ATTACHMENT_EXTENSION = /\.(csv|xlsx|xls|ods)$/iu;

function promptIncludesAny(prompt: string, hints: readonly string[]): boolean {
  const normalized = prompt.toLowerCase();
  return hints.some((hint) => normalized.includes(hint));
}

/**
 * Detects compare-oriented language shared by planner and decision input layers.
 *
 * @param {string} prompt - User prompt to inspect.
 * @returns {boolean} Whether the prompt explicitly asks for comparison/reconciliation.
 */
export function promptSuggestsCompareIntent(prompt: string): boolean {
  return (
    promptIncludesAny(prompt, COMPARE_INTENT_HINTS) ||
    /\b(diff|deltas?|delta\b|reconcil\w*)\b/iu.test(prompt) ||
    /\b(compare|comparison|comparing|diff|reconcile|reconciliation|side[- ]by[- ]side|price\s*diff|variance|discrepanc|match\s+up|align\s+(the\s+)?(rows|sheets))\b/iu.test(
      prompt,
    ) ||
    /\b(сравн|сопостав|расхожден|совпаден|разница\s+в\s+цен|сверк|выверк)\w*\b/iu.test(prompt) ||
    /\b(два|две|три|оба|обе)\s+(csv|файл|таблиц|экспорт|xlsx)\b/iu.test(prompt)
  );
}

/**
 * Detects calculation-oriented language shared by planner and decision input layers.
 *
 * @param {string} prompt - User prompt to inspect.
 * @returns {boolean} Whether the prompt explicitly asks for a calculation/report workflow.
 */
export function promptSuggestsCalculationIntent(prompt: string): boolean {
  return (
    promptIncludesAny(prompt, CALCULATION_INTENT_HINTS) ||
    /\b(dimensions?|measurement|square\s*meter|sq\s*m\b)\b/iu.test(prompt) ||
    /\b(ventilation|vent\s|cfm|ach\b|airflow|hvac|duct|btu|cubic\s*(foot|feet|meter|metre)|square\s*(foot|feet|meter|metre)|unit\s*conversion|dimensional\s*analysis|convert\s+\d+)\b/iu.test(
      prompt,
    ) ||
    /\b(вентиляц|приток|вытяжк|кубатур|площад|перевод\s+единиц|единиц\s+измерен|размер\s+помещен|расч[её]т|рассчитай)\w*\b/iu.test(
      prompt,
    )
  );
}

/**
 * Counts tabular attachments using the shared extension policy for routing and planning.
 *
 * @param {string[]} fileNames - Candidate attachment names.
 * @returns {number} Number of tabular files among the attachments.
 */
export function countTabularFiles(fileNames: string[]): number {
  return fileNames.filter((fileName) => TABULAR_ATTACHMENT_EXTENSION.test(fileName)).length;
}
