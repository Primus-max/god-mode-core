import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterializationResult } from "../materialization/index.js";
import {
  captureDocumentArtifactsFromLlmOutput,
  extractDocumentArtifactPayloads,
  listCapturedDocumentArtifacts,
  projectDocumentArtifacts,
  resetCapturedDocumentArtifacts,
} from "./artifact-projection.js";

function readFixture(name: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, "__fixtures__", name), "utf-8");
}

describe("document artifact projection", () => {
  afterEach(() => {
    resetCapturedDocumentArtifacts();
  });

  it("extracts structured payloads from JSON code blocks", () => {
    const payloads = extractDocumentArtifactPayloads([
      'Result:\n```json\n{"type":"report","format":"markdown","content":"# Summary"}\n```',
    ]);

    expect(payloads).toEqual([{ type: "report", format: "markdown", content: "# Summary" }]);
  });

  it("extracts route-aware artifacts from fixture envelopes", () => {
    const payloads = extractDocumentArtifactPayloads(
      [readFixture("table-extract.json")],
      "table_extract",
    );

    expect(payloads.map((payload) => payload.type)).toEqual(["extraction", "export"]);
  });

  it("filters payload types that do not belong to the selected route", () => {
    const payloads = extractDocumentArtifactPayloads(
      [
        JSON.stringify({
          route: "doc_ingest",
          artifacts: [
            { type: "extraction", fields: [{ key: "id", valueType: "string", value: "1" }] },
            { type: "export", format: "json", fileName: "bad.json" },
          ],
        }),
      ],
      "doc_ingest",
    );

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.type).toBe("extraction");
  });

  it("projects structured document payloads into typed artifact descriptors", () => {
    const payloads = extractDocumentArtifactPayloads(
      [readFixture("doc-ingest-report.md")],
      "doc_ingest",
    );
    const projected = projectDocumentArtifacts({
      sessionId: "session-1",
      runId: "run-1",
      route: "doc_ingest",
      payloads,
    });

    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({
      kind: "data",
      label: "Document Ingest extraction 1",
      sourceRecipeId: "doc_ingest",
    });
    expect(projected[0]?.metadata).toMatchObject({
      route: "doc_ingest",
      normalizedDocumentPayload: expect.objectContaining({
        type: "extraction",
        fieldCount: 2,
      }),
    });
    expect(projected[1]).toMatchObject({
      kind: "report",
      mimeType: "text/markdown",
      label: "Document Ingest report 2",
    });
    expect(projected[1]?.path?.endsWith(".md")).toBe(true);
    expect(projected[1]?.metadata).toMatchObject({
      materialization: {
        primary: expect.objectContaining({
          renderKind: "markdown",
        }),
      },
    });
    const materialization = projected[1]?.metadata?.materialization as
      | MaterializationResult
      | undefined;
    expect(materialization?.supporting?.some((output) => output.renderKind === "pdf")).toBe(true);
  });

  it("preserves pre-materialization descriptor shape when materialization is disabled", () => {
    const payloads = extractDocumentArtifactPayloads(
      [readFixture("doc-ingest-report.md")],
      "doc_ingest",
    );
    const projected = projectDocumentArtifacts({
      sessionId: "session-legacy",
      runId: "run-legacy",
      route: "doc_ingest",
      payloads,
      materialize: false,
    });

    expect(projected[1]).toMatchObject({
      kind: "report",
      mimeType: "text/markdown",
    });
    expect(projected[1]).not.toHaveProperty("path");
    expect(projected[1]?.metadata).not.toHaveProperty("materialization");
  });

  it("captures document artifacts only for document recipes", () => {
    const captured = captureDocumentArtifactsFromLlmOutput({
      sessionId: "session-1",
      runId: "run-1",
      recipeId: "table_extract",
      assistantTexts: [
        '{"type":"export","format":"json","fileName":"tables.json","previewRows":[{"item":"A"}]}',
      ],
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      kind: "data",
      sourceRecipeId: "table_extract",
    });
    expect(captured[0]?.path).toBeTruthy();
    expect(listCapturedDocumentArtifacts()).toHaveLength(1);
  });

  it("ignores non-document recipes", () => {
    const captured = captureDocumentArtifactsFromLlmOutput({
      sessionId: "session-1",
      runId: "run-1",
      recipeId: "code_build_publish",
      assistantTexts: ['{"type":"report","format":"markdown","content":"# Summary"}'],
    });

    expect(captured).toEqual([]);
    expect(listCapturedDocumentArtifacts()).toEqual([]);
  });

  it("captures fixture-based OCR outputs into the artifact store", () => {
    const captured = captureDocumentArtifactsFromLlmOutput({
      sessionId: "session-ocr",
      runId: "run-ocr",
      recipeId: "ocr_extract",
      assistantTexts: [readFixture("ocr-extract.json")],
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.metadata).toMatchObject({
      route: "ocr_extract",
      fieldCount: 2,
      hasPlainText: true,
    });
  });
});
