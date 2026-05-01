import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GoldenSetSchema, type GoldenSet } from "./types.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_GOLDEN_SET_PATH = path.join(moduleDir, "golden-set.json");

export async function loadGoldenSet(filePath = DEFAULT_GOLDEN_SET_PATH): Promise<GoldenSet> {
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  return GoldenSetSchema.parse(parsed);
}

export function assertUniqueIds(cases: GoldenSet): void {
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) {
      throw new Error(`golden-set: duplicate case id "${c.id}"`);
    }
    seen.add(c.id);
  }
}
