import { describe, expect, it } from "vitest";
import { MaterializationRequestSchema, MaterializationResultSchema } from "./contracts.js";

describe("materialization contracts", () => {
  it("accepts a markdown file materialization request", () => {
    const request = {
      artifactId: "doc-1",
      label: "Document Summary",
      sourceDomain: "document",
      renderKind: "markdown",
      outputTarget: "file",
      includePdf: true,
      payload: {
        title: "Document Summary",
        markdown: "# Summary",
      },
    };
    expect(MaterializationRequestSchema.parse(request)).toEqual(request);
  });

  it("accepts a degraded materialization result", () => {
    const result = {
      primary: {
        renderKind: "html",
        outputTarget: "file",
        path: "artifact.html",
        mimeType: "text/html",
        sizeBytes: 512,
        lifecycle: "draft",
      },
      degraded: true,
      warnings: ["pdf renderer unavailable; fell back to html output"],
    };
    expect(MaterializationResultSchema.parse(result)).toEqual(result);
  });
});
