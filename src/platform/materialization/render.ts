import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ArtifactDescriptor } from "../schemas/artifact.js";
import {
  MaterializationRequestSchema,
  MaterializationResultSchema,
  type MaterializationRequest,
  type MaterializationResult,
} from "./contracts.js";
import { resolveHtmlBody, writeHtmlMaterialization } from "./html-preview-materializer.js";
import { writePdfMaterialization } from "./pdf-materializer.js";

function sanitizeFilePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function resolveOutputDir(request: MaterializationRequest): string {
  if (request.outputDir) {
    return request.outputDir;
  }
  return path.join(
    os.tmpdir(),
    "openclaw-platform-artifacts",
    sanitizeFilePart(request.artifactId),
  );
}

function resolveBaseFileName(request: MaterializationRequest): string {
  return sanitizeFilePart(request.baseFileName ?? request.label) || "artifact";
}

function writeTextFile(params: {
  outputDir: string;
  baseFileName: string;
  extension: "md" | "txt";
  contents: string;
  mimeType: string;
}): MaterializationResult["primary"] {
  fs.mkdirSync(params.outputDir, { recursive: true });
  const filePath = path.join(params.outputDir, `${params.baseFileName}.${params.extension}`);
  fs.writeFileSync(filePath, params.contents, "utf8");
  const sizeBytes = fs.statSync(filePath).size;
  return {
    renderKind: params.extension === "md" ? "markdown" : "html",
    outputTarget: "file",
    path: filePath,
    mimeType: params.mimeType,
    sizeBytes,
    lifecycle: "draft",
  };
}

export function materializeArtifact(
  requestInput: MaterializationRequest,
  options?: { pdfRendererAvailable?: boolean },
): MaterializationResult {
  const request = MaterializationRequestSchema.parse(requestInput);
  const outputDir = resolveOutputDir(request);
  const baseFileName = resolveBaseFileName(request);
  const htmlBody = resolveHtmlBody(request.payload);
  const title = request.payload.title ?? request.label;
  const supporting: NonNullable<MaterializationResult["supporting"]> = [];

  if (request.renderKind === "markdown") {
    const primary = writeTextFile({
      outputDir,
      baseFileName,
      extension: "md",
      contents: request.payload.markdown ?? request.payload.text ?? "",
      mimeType: "text/markdown",
    });
    supporting.push(
      writeHtmlMaterialization({
        outputDir,
        baseFileName,
        title,
        bodyHtml: htmlBody,
        summary: request.payload.summary,
        outputTarget: request.outputTarget,
        renderKind: request.outputTarget === "preview" ? "site_preview" : "html",
      }),
    );
    if (request.includePdf) {
      supporting.push(writePdfMaterialization({ outputDir, baseFileName, html: htmlBody }));
    }
    return MaterializationResultSchema.parse({
      primary,
      supporting,
    });
  }

  if (request.renderKind === "pdf") {
    if (options?.pdfRendererAvailable === false) {
      const primary = writeHtmlMaterialization({
        outputDir,
        baseFileName,
        title,
        bodyHtml: htmlBody,
        summary: request.payload.summary,
        outputTarget: request.outputTarget,
        renderKind: request.outputTarget === "preview" ? "site_preview" : "html",
      });
      return MaterializationResultSchema.parse({
        primary,
        degraded: true,
        warnings: ["pdf renderer unavailable; fell back to html output"],
      });
    }
    return MaterializationResultSchema.parse({
      primary: writePdfMaterialization({
        outputDir,
        baseFileName,
        html: htmlBody,
      }),
    });
  }

  const primary = writeHtmlMaterialization({
    outputDir,
    baseFileName,
    title,
    bodyHtml: htmlBody,
    summary: request.payload.summary,
    outputTarget: request.outputTarget,
    renderKind: request.outputTarget === "preview" ? "site_preview" : "html",
  });
  if (request.includePdf) {
    supporting.push(writePdfMaterialization({ outputDir, baseFileName, html: htmlBody }));
  }
  return MaterializationResultSchema.parse({
    primary,
    ...(supporting.length > 0 ? { supporting } : {}),
  });
}

export function applyMaterializationToDescriptor(params: {
  descriptor: ArtifactDescriptor;
  materialization: MaterializationResult;
}): ArtifactDescriptor {
  const { descriptor, materialization } = params;
  return {
    ...descriptor,
    path: materialization.primary.path,
    url: descriptor.url ?? materialization.primary.url,
    mimeType: materialization.primary.mimeType,
    sizeBytes: materialization.primary.sizeBytes,
    lifecycle:
      descriptor.lifecycle === "published"
        ? descriptor.lifecycle
        : (materialization.primary.lifecycle ?? descriptor.lifecycle),
    metadata: {
      ...descriptor.metadata,
      materialization,
    },
  };
}
