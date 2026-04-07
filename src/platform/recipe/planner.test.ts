import { describe, expect, it } from "vitest";
import { planExecutionRecipe } from "./planner.js";

describe("planExecutionRecipe", () => {
  it("selects doc_ingest for document-first work", () => {
    const plan = planExecutionRecipe({
      prompt: "Extract tables from this PDF estimate and summarize it",
      fileNames: ["estimate.pdf"],
      artifactKinds: ["document", "report"],
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
      intent: "document",
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("table_extract");
  });

  it("keeps explicit specialist overrides active for lightweight chat", () => {
    const plan = planExecutionRecipe({
      prompt: "Tell me a joke about robots",
      sessionProfile: "developer",
      intent: "general",
    });

    expect(plan.profile.selectedProfile.id).toBe("developer");
    expect(plan.profile.activeProfile.sessionProfile).toBe("developer");
  });

  it("keeps builder-profile greetings on general_reasoning", () => {
    const plan = planExecutionRecipe({
      prompt: "Привет! Как дела? Просто поздоровайся.",
      sessionProfile: "builder",
      intent: "general",
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("general_reasoning");
  });

  it("selects integration_delivery for integration-heavy work", () => {
    const plan = planExecutionRecipe({
      prompt: "Validate the webhook integration, sync OAuth config, and roll out the connector",
      integrations: ["slack", "webhook"],
      requestedTools: ["exec"],
      intent: "publish",
    });

    expect(plan.profile.selectedProfile.id).toBe("integrator");
    expect(plan.recipe.id).toBe("integration_delivery");
  });

  it("selects ops_orchestration for guarded operator work", () => {
    const plan = planExecutionRecipe({
      prompt: "Check the linked machine, inspect logs, and bootstrap the missing capability",
      requestedTools: ["exec", "process"],
    });

    expect(plan.profile.selectedProfile.id).toBe("operator");
    expect(plan.recipe.id).toBe("ops_orchestration");
  });

  it("selects media_production for multimodal media work", () => {
    const plan = planExecutionRecipe({
      prompt: "Generate a thumbnail image, caption the audio track, and package the media output",
      artifactKinds: ["image", "audio"],
      publishTargets: ["site"],
    });

    expect(plan.profile.selectedProfile.id).toBe("media_creator");
    expect(plan.recipe.id).toBe("media_production");
  });

  it("avoids code_build_publish for PDF-only artifact requests", () => {
    const plan = planExecutionRecipe({
      prompt: "Create a one-page PDF report with Stage 86 test results.",
      artifactKinds: ["document"],
      intent: "document",
    });

    expect(plan.recipe.id).not.toBe("code_build_publish");
  });

  it("selects table_compare for two spreadsheet price comparison prompts", () => {
    const plan = planExecutionRecipe({
      prompt:
        "Compare these two Excel exports for SKU and price differences, then summarize mismatches.",
      fileNames: ["vendor_prices.xlsx", "internal_prices.xlsx"],
      artifactKinds: ["data", "report"],
      intent: "compare",
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("table_compare");
    expect(plan.plannerOutput.selectedRecipeId).toBe("table_compare");
  });

  it("selects table_compare for Russian CSV comparison prompts", () => {
    const plan = planExecutionRecipe({
      prompt: "Сравни два CSV с ценами и покажи расхождения по артикулам.",
      fileNames: ["jan.csv", "feb.csv"],
      intent: "compare",
    });

    expect(plan.recipe.id).toBe("table_compare");
  });

  it("selects calculation_report for ventilation and dimensions prompts", () => {
    const plan = planExecutionRecipe({
      prompt:
        "Compute required ventilation CFM for a 420 sq ft room with 8 ft ceilings and give a short written report with assumptions.",
      artifactKinds: ["report"],
      intent: "calculation",
    });

    expect(plan.recipe.id).toBe("calculation_report");
  });

  it("selects calculation_report for Russian unit and sizing language", () => {
    const plan = planExecutionRecipe({
      prompt:
        "Рассчитай кубатуру помещения 4x5 м при высоте 2.7 м и переведи в кубические футы в отчёте.",
      intent: "calculation",
    });

    expect(plan.recipe.id).toBe("calculation_report");
  });
});
