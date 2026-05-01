import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { saveMediaBuffer } from "../../media/store.js";
import { type AnyAgentTool, readStringParam } from "./common.js";

const CsvToolSchema = Type.Object({
  fileName: Type.Optional(
    Type.String({
      description: "Optional filename (without extension) for the generated CSV.",
    }),
  ),
  columns: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Ordered list of column headers. Derived from deliverable.constraints.columns upstream.",
    }),
  ),
  rows: Type.Array(Type.Array(Type.Any()), {
    description:
      "Rows of values aligned to `columns` (or free-form rows when columns are omitted).",
  }),
  title: Type.Optional(Type.String({ description: "Optional CSV title / description." })),
});

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const raw = typeof value === "string" ? value : String(value);
  if (/["\n\r,]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function buildCsvContent(params: {
  columns?: string[];
  rows: unknown[][];
}): string {
  const lines: string[] = [];
  if (params.columns && params.columns.length > 0) {
    lines.push(params.columns.map((c) => escapeCsvCell(c)).join(","));
  }
  for (const row of params.rows) {
    lines.push(row.map((cell) => escapeCsvCell(cell)).join(","));
  }
  return lines.join("\r\n");
}

function sanitizeFileStem(candidate: string | undefined, fallback: string): string {
  const source = (candidate ?? fallback).trim();
  const cleaned = source.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/_+/g, "_");
  return cleaned.slice(0, 48) || fallback;
}

export function createCsvTool(): AnyAgentTool {
  return {
    label: "CSV Writer",
    name: "csv_write",
    description:
      "Generate a CSV file from structured rows/columns. Returns a media path that the agent can deliver as an attachment.",
    parameters: CsvToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const rowsRaw = params.rows;
      if (!Array.isArray(rowsRaw)) {
        return {
          content: [
            {
              type: "text",
              text: "csv_write requires a `rows` array.",
            },
          ],
          details: { error: "missing_rows" },
        };
      }
      const columnsRaw = params.columns;
      const columns = Array.isArray(columnsRaw)
        ? (columnsRaw.filter((v) => typeof v === "string") as string[])
        : undefined;
      const rows = (rowsRaw as unknown[]).map((row) =>
        Array.isArray(row) ? (row as unknown[]) : [row],
      );
      const title = readStringParam(params, "title");
      const fileStem = sanitizeFileStem(
        readStringParam(params, "fileName"),
        "report",
      );
      const csvBody = buildCsvContent({
        ...(columns && columns.length > 0 ? { columns } : {}),
        rows,
      });
      const csvBuffer = Buffer.from(`\uFEFF${csvBody}`, "utf8");
      const saved = await saveMediaBuffer(
        csvBuffer,
        "text/csv; charset=utf-8",
        "outbound",
        10 * 1024 * 1024,
        `${fileStem}.csv`,
      );
      const basename = path.basename(saved.path);
      const bytesLabel = `${(saved.size / 1024).toFixed(1)} KB`;
      const header = title ? `${title} — ` : "";
      return {
        content: [
          {
            type: "text",
            text: `${header}CSV file ready: ${basename} (${bytesLabel}).`,
          },
        ],
        details: {
          artifact: {
            kind: "data",
            format: "csv",
            mimeType: "text/csv",
            path: saved.path,
            sizeBytes: saved.size,
          },
          media: {
            mediaUrl: saved.path,
          },
        },
      };
    },
  };
}

// Re-export helpers for tests
export const __csvToolTestables = { buildCsvContent, escapeCsvCell };
// Touch fs import so node bundlers don't tree-shake on side-effect-free branch.
void fs;
