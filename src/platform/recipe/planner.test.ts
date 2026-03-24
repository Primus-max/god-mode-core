import { describe, expect, it } from "vitest";
import { planExecutionRecipe } from "./planner.js";

describe("planExecutionRecipe", () => {
  it("selects doc_ingest for document-first work", () => {
    const plan = planExecutionRecipe({
      prompt: "Extract tables from this PDF estimate and summarize it",
      fileNames: ["estimate.pdf"],
      artifactKinds: ["document", "report"],
      baseProfile: "general",
      intent: "document",
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("doc_ingest");
    expect(plan.plannerOutput.selectedRecipeId).toBe("doc_ingest");
  });

  it("selects code_build_publish for repository publish work", () => {
    const plan = planExecutionRecipe({
      prompt: "Fix the failing TypeScript build and publish to GitHub",
      fileNames: ["app.ts"],
      publishTargets: ["github"],
      requestedTools: ["exec"],
      baseProfile: "general",
      intent: "publish",
    });

    expect(plan.profile.selectedProfile.id).toBe("developer");
    expect(plan.recipe.id).toBe("code_build_publish");
  });

  it("selects ocr_extract for scan-heavy document work", () => {
    const plan = planExecutionRecipe({
      prompt: "Run OCR on this scanned invoice image and extract the totals",
      fileNames: ["invoice-scan.png"],
      artifactKinds: ["document"],
      baseProfile: "general",
      intent: "document",
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("ocr_extract");
  });

  it("selects table_extract for spreadsheet-heavy document work", () => {
    const plan = planExecutionRecipe({
      prompt: "Extract the table rows from this spreadsheet and export them",
      fileNames: ["estimate.xlsx"],
      artifactKinds: ["document", "data"],
      baseProfile: "general",
      intent: "document",
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("table_extract");
  });

  it("falls back to general_reasoning for lightweight chat", () => {
    const plan = planExecutionRecipe({
      prompt: "Tell me a joke about robots",
      baseProfile: "developer",
      sessionProfile: "developer",
      intent: "general",
    });

    expect(plan.profile.selectedProfile.id).toBe("general");
    expect(plan.recipe.id).toBe("general_reasoning");
  });
});
