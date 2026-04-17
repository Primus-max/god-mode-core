import path from "node:path";
import { Type } from "@sinclair/typebox";
import { saveMediaBuffer } from "../../media/store.js";
import { loadCapabilityModule } from "../../platform/bootstrap/index.js";
import { type AnyAgentTool, readStringParam } from "./common.js";

const XlsxToolSchema = Type.Object({
  fileName: Type.Optional(Type.String({ description: "Filename stem (no extension)." })),
  sheets: Type.Array(
    Type.Object({
      name: Type.Optional(Type.String({ description: "Worksheet name." })),
      columns: Type.Optional(Type.Array(Type.String())),
      rows: Type.Array(Type.Array(Type.Any())),
    }),
    {
      description:
        "One or more worksheets. Each sheet has optional column headers and rows of values.",
    },
  ),
});

type XlsxSheetInput = {
  name?: string;
  columns?: string[];
  rows: unknown[][];
};

type ExceljsModule = {
  default?: { Workbook: new () => ExceljsWorkbook };
  Workbook?: new () => ExceljsWorkbook;
};

type ExceljsWorkbook = {
  addWorksheet: (name?: string) => ExceljsWorksheet;
  xlsx: { writeBuffer: () => Promise<ArrayBuffer | Uint8Array | Buffer> };
};

type ExceljsWorksheet = {
  addRow: (values: unknown[]) => { font?: unknown; commit?: () => void } & Record<string, unknown>;
  columns: Array<{ header?: string; key?: string; width?: number }>;
};

function sanitizeFileStem(candidate: string | undefined, fallback: string): string {
  const source = (candidate ?? fallback).trim();
  const cleaned = source.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/_+/g, "_");
  return cleaned.slice(0, 48) || fallback;
}

function sanitizeSheetName(candidate: string | undefined, fallback: string): string {
  const source = (candidate ?? fallback).trim() || fallback;
  return source.replace(/[\\/?*[\]:]+/g, "_").slice(0, 31) || fallback;
}

function normalizeSheets(raw: unknown): XlsxSheetInput[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((sheet) => {
      if (!sheet || typeof sheet !== "object") {
        return null;
      }
      const s = sheet as Record<string, unknown>;
      const rowsRaw = s.rows;
      if (!Array.isArray(rowsRaw)) {
        return null;
      }
      const rows = rowsRaw.map((row) =>
        Array.isArray(row) ? (row as unknown[]) : [row],
      );
      const columnsRaw = s.columns;
      const columns = Array.isArray(columnsRaw)
        ? (columnsRaw.filter((v) => typeof v === "string") as string[])
        : undefined;
      const name = typeof s.name === "string" ? s.name : undefined;
      return {
        ...(name ? { name } : {}),
        ...(columns && columns.length > 0 ? { columns } : {}),
        rows,
      } satisfies XlsxSheetInput;
    })
    .filter((entry): entry is XlsxSheetInput => entry !== null);
}

function resolveWorkbookCtor(mod: ExceljsModule): new () => ExceljsWorkbook {
  if (mod.Workbook) {
    return mod.Workbook;
  }
  if (mod.default?.Workbook) {
    return mod.default.Workbook;
  }
  throw new Error("exceljs module did not expose Workbook constructor");
}

export function createXlsxTool(): AnyAgentTool {
  return {
    label: "XLSX Writer",
    name: "xlsx_write",
    description:
      "Generate an Excel workbook (.xlsx) from structured sheets. Backed by the managed xlsx-writer capability — installed automatically on first use.",
    parameters: XlsxToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sheets = normalizeSheets(params.sheets);
      if (sheets.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "xlsx_write requires at least one sheet with rows.",
            },
          ],
          details: { error: "missing_sheets" },
        };
      }
      let exceljs: ExceljsModule;
      try {
        exceljs = await loadCapabilityModule<ExceljsModule>({
          capabilityId: "xlsx-writer",
          packageName: "exceljs",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `xlsx_write unavailable: ${message}`,
            },
          ],
          details: { error: "capability_unavailable", message },
        };
      }
      const WorkbookCtor = resolveWorkbookCtor(exceljs);
      const workbook = new WorkbookCtor();
      sheets.forEach((sheet, index) => {
        const worksheet = workbook.addWorksheet(
          sanitizeSheetName(sheet.name, `Sheet${index + 1}`),
        );
        if (sheet.columns && sheet.columns.length > 0) {
          worksheet.columns = sheet.columns.map((header) => ({
            header,
            key: header,
            width: Math.min(Math.max(header.length + 4, 10), 32),
          }));
        }
        for (const row of sheet.rows) {
          worksheet.addRow(row);
        }
      });
      const rawBuffer = await workbook.xlsx.writeBuffer();
      const buffer = Buffer.isBuffer(rawBuffer)
        ? rawBuffer
        : Buffer.from(rawBuffer as ArrayBuffer);
      const fileStem = sanitizeFileStem(
        readStringParam(params, "fileName"),
        "report",
      );
      const saved = await saveMediaBuffer(
        buffer,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "outbound",
        10 * 1024 * 1024,
        `${fileStem}.xlsx`,
      );
      const basename = path.basename(saved.path);
      return {
        content: [
          {
            type: "text",
            text: `XLSX workbook ready: ${basename} (${(saved.size / 1024).toFixed(1)} KB).`,
          },
        ],
        details: {
          artifact: {
            kind: "data",
            format: "xlsx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            path: saved.path,
            sizeBytes: saved.size,
          },
          media: { mediaUrl: saved.path },
        },
      };
    },
  };
}
