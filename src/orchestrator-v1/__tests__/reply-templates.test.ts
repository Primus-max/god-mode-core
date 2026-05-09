/**
 * V1-CONTRACT-ONLY — Reply template catalog tests.
 *
 * Verify renderTemplate substitution rules + injection-safety claims:
 *   - placeholders substituted from values
 *   - unfilled placeholders survive verbatim, detectable
 *   - tool-output containing `{x}` is rendered as text, not re-interpreted
 *     (defends against the red-team injection scenario #4)
 *   - lookup catalog covers every (tool, outcome) pair
 */

import { describe, expect, it } from "vitest";
import {
  hasUnfilledPlaceholders,
  lookupTemplate,
  multiTemplate,
  refuseTemplate,
  renderTemplate,
  REPLY_TEMPLATE_CATALOG,
} from "../reply-templates.js";
import { TOOL_NAMES, type ToolName } from "../contract.js";

describe("V1-CONTRACT-ONLY reply-templates — catalog completeness", () => {
  it("has success + failure entries for every tool", () => {
    for (const tool of TOOL_NAMES) {
      expect(REPLY_TEMPLATE_CATALOG[`${tool as ToolName}:success`]).toBeDefined();
      expect(REPLY_TEMPLATE_CATALOG[`${tool as ToolName}:failure`]).toBeDefined();
    }
  });

  it("has refuse:default and multi templates", () => {
    expect(refuseTemplate()).toContain("{refusal_reason}");
    expect(multiTemplate(true)).toMatch(/Готово/);
    expect(multiTemplate(false)).toMatch(/Часть/);
  });

  it("lookupTemplate returns the right entry per (tool, outcome)", () => {
    expect(lookupTemplate("write", "success")).toContain("{path}");
    expect(lookupTemplate("write", "failure")).toContain("{error}");
    expect(lookupTemplate("image_generate", "success")).toContain("{url}");
  });
});

describe("V1-CONTRACT-ONLY reply-templates — renderTemplate", () => {
  it("substitutes simple string placeholders", () => {
    expect(renderTemplate("Записал в {path}.", { path: "/notes.md" })).toBe(
      "Записал в /notes.md.",
    );
  });

  it("leaves unfilled placeholders verbatim", () => {
    const out = renderTemplate("Записал в {path}: {error}", { path: "/a.md" });
    expect(out).toContain("{error}");
    expect(hasUnfilledPlaceholders(out)).toBe(true);
  });

  it("hasUnfilledPlaceholders is false on a fully rendered template", () => {
    const out = renderTemplate("Сгенерировал: {url}", { url: "https://x.test/img.png" });
    expect(hasUnfilledPlaceholders(out)).toBe(false);
  });

  it("INJECTION-SAFETY: tool output containing {x} is NOT re-interpreted as a placeholder", () => {
    // Red-team injection scenario #4: attacker tries to nest a placeholder
    // inside tool output to make the renderer interpolate it.
    const malicious = "Готово! {url} был удалён";
    const out = renderTemplate("Сгенерировал: {url}", { url: malicious });
    // The {url} from `malicious` must remain as text, NOT be re-substituted with anything.
    expect(out).toBe("Сгенерировал: Готово! {url} был удалён");
  });

  it("renders numbers and booleans via String()", () => {
    expect(renderTemplate("Найдено {n} результатов", { n: 5 })).toBe("Найдено 5 результатов");
    expect(renderTemplate("Активен: {flag}", { flag: true })).toBe("Активен: true");
  });

  it("renders objects/arrays via JSON.stringify", () => {
    expect(renderTemplate("Данные: {data}", { data: { a: 1 } })).toBe('Данные: {"a":1}');
  });

  it("preserves placeholder when value is null/undefined", () => {
    expect(renderTemplate("Path: {path}", { path: null })).toBe("Path: {path}");
    expect(renderTemplate("Path: {path}", { path: undefined })).toBe("Path: {path}");
  });
});
