/**
 * V1-CONTRACT-ONLY — TOOL_FIELD_LABELS coverage + describeToolField helper.
 *
 * Pins the (tool, field) → Russian-label table so that every REQUIRED
 * field across every TOOL_ARG_SCHEMA has a label entry. If a future
 * schema change adds a required field, this test catches the missing
 * label entry before users see "поле <field>" leaking out of refuse
 * rendering.
 *
 * Also locks the safe fallbacks in `describeToolField` so the
 * orchestrator can render a coherent refuse line even on unmapped
 * fields without crashing.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  TOOL_ARG_SCHEMAS,
  TOOL_FIELD_LABELS,
  describeToolField,
} from "../tool-arg-schemas.js";
import { TOOL_NAMES } from "../contract.js";

/**
 * Walk a Zod object schema and return the names of fields that are
 * REQUIRED (not `.optional()` and not `.default(...)`).
 *
 * We rely on Zod 4's `.def.shape` / `.isOptional()` rather than parsing
 * the schema. Fields with default values or `.optional()` are skipped
 * because Stage B never emits `missing_field` for those (extractor
 * just omits the field).
 */
function requiredFieldsOf(schema: z.ZodType): string[] {
  const def = (schema as unknown as { def?: { shape?: Record<string, z.ZodType> } }).def;
  const shape = def?.shape;
  if (!shape) return [];
  const out: string[] = [];
  for (const [name, fieldSchema] of Object.entries(shape)) {
    const isOptional =
      typeof (fieldSchema as { isOptional?: () => boolean }).isOptional === "function"
        ? (fieldSchema as { isOptional: () => boolean }).isOptional()
        : false;
    if (!isOptional) out.push(name);
  }
  return out;
}

describe("TOOL_FIELD_LABELS — coverage of every required field", () => {
  it("every required field of every TOOL_ARG_SCHEMA has a label entry", () => {
    const missing: string[] = [];
    for (const tool of TOOL_NAMES) {
      const schema = TOOL_ARG_SCHEMAS[tool];
      const required = requiredFieldsOf(schema);
      const labels = TOOL_FIELD_LABELS[tool] ?? {};
      for (const field of required) {
        if (!labels[field]) missing.push(`${tool}.${field}`);
      }
    }
    expect(missing, `unmapped required fields: ${missing.join(", ")}`).toEqual([]);
  });

  it("every TOOL_NAME has a labels table (even if empty for tools with only optional fields)", () => {
    for (const tool of TOOL_NAMES) {
      expect(TOOL_FIELD_LABELS[tool], `${tool} missing labels table`).toBeDefined();
    }
  });
});

describe("describeToolField — refuse-text helper", () => {
  it("returns the mapped Russian label for a known (tool, field)", () => {
    expect(describeToolField("write", "path")).toBe("путь к файлу");
    expect(describeToolField("web_search", "query")).toBe("запрос для поиска");
    expect(describeToolField("pdf", "title")).toBe("заголовок документа");
  });

  it("falls back to a safe generic label for an unmapped field name", () => {
    // Defensive — covers schema-drift where Stage B emits a new field
    // that hasn't been added to TOOL_FIELD_LABELS yet.
    expect(describeToolField("write", "future_unknown_field")).toBe('поле "future_unknown_field"');
  });

  it('returns "обязательное поле" for the Stage-B sentinel "(unknown field)"', () => {
    // classifier-stage-b sets detail to "(unknown field)" when the
    // model returns _error:"missing" without a _field. Refuse-text
    // must still read naturally.
    expect(describeToolField("write", "(unknown field)")).toBe("обязательное поле");
  });

  it('returns "обязательное поле" for an empty field name', () => {
    expect(describeToolField("write", "")).toBe("обязательное поле");
  });

  it("never returns a string containing 'undefined' for any input", () => {
    for (const tool of TOOL_NAMES) {
      const out = describeToolField(tool, "totally_made_up");
      expect(out).not.toContain("undefined");
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
