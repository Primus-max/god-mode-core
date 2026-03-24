import fs from "node:fs";
import path from "node:path";
import type { MaterializedArtifactOutput } from "./contracts.js";

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&#39;/gu, "'")
    .replace(/&quot;/gu, '"')
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function escapePdfText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function buildMinimalPdfBuffer(text: string): Buffer {
  const lines = text.split(/\r?\n/gu).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return [""];
    }
    const chunks: string[] = [];
    let remaining = trimmed;
    while (remaining.length > 90) {
      chunks.push(remaining.slice(0, 90));
      remaining = remaining.slice(90);
    }
    chunks.push(remaining);
    return chunks;
  });
  const content = [
    "BT",
    "/F1 11 Tf",
    "50 780 Td",
    "14 TL",
    ...lines.map((line, index) =>
      index === 0 ? `(${escapePdfText(line)}) Tj` : `T* (${escapePdfText(line)}) Tj`,
    ),
    "ET",
  ].join("\n");

  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    `5 0 obj << /Length ${String(Buffer.byteLength(content, "utf8"))} >> stream\n${content}\nendstream\nendobj`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${object}\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${String(objects.length + 1)}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

export function writePdfMaterialization(params: {
  outputDir: string;
  baseFileName: string;
  html: string;
}): MaterializedArtifactOutput {
  fs.mkdirSync(params.outputDir, { recursive: true });
  const filePath = path.join(params.outputDir, `${params.baseFileName}.pdf`);
  const text = stripHtml(params.html);
  const buffer = buildMinimalPdfBuffer(text || "OpenClaw materialized artifact");
  fs.writeFileSync(filePath, buffer);
  const sizeBytes = fs.statSync(filePath).size;
  return {
    renderKind: "pdf",
    outputTarget: "file",
    path: filePath,
    mimeType: "application/pdf",
    sizeBytes,
    lifecycle: "draft",
  };
}
