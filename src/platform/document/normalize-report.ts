import type { DocumentReportArtifact } from "./artifacts.js";

export type NormalizedDocumentReport = {
  format: DocumentReportArtifact["format"];
  content: string;
  summary: string;
  sections: string[];
};

function deriveSummary(content: string): string {
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"));
  return lines[0] ?? content.trim();
}

export function normalizeReport(report: DocumentReportArtifact): NormalizedDocumentReport {
  const content = report.content.trim();
  return {
    format: report.format,
    content,
    summary: report.summary?.trim() || deriveSummary(content),
    sections: (report.sections ?? []).map((section) => section.trim()).filter(Boolean),
  };
}
