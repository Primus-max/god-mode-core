import type { DocumentTable } from "./artifacts.js";
import { canonicalizeFieldKey } from "./normalize-fields.js";

export type NormalizedDocumentTable = {
  id: string;
  title?: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  rowCount: number;
  columnCount: number;
  pageRefs?: number[];
};

function buildHeaders(table: DocumentTable): string[] {
  const sourceHeaders =
    table.headers?.length && table.headers.some((header) => header.trim().length > 0)
      ? table.headers
      : Array.from(
          { length: Math.max(...table.rows.map((row) => row.length), 1) },
          (_, index) => `Column ${index + 1}`,
        );

  const seen = new Map<string, number>();
  return sourceHeaders.map((header, index) => {
    const base = canonicalizeFieldKey(header || `column_${index + 1}`) || `column_${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

export function normalizeTables(tables: DocumentTable[] | undefined): NormalizedDocumentTable[] {
  if (!tables?.length) {
    return [];
  }

  return tables.map((table, index) => {
    const headers = buildHeaders(table);
    const rows = table.rows.map((row) => {
      const padded = Array.from({ length: headers.length }, (_, cellIndex) => row[cellIndex] ?? "");
      return Object.fromEntries(
        headers.map((header, headerIndex) => [header, padded[headerIndex].trim()]),
      );
    });

    return {
      id: table.id || `table_${index + 1}`,
      ...(table.title ? { title: table.title.trim() } : {}),
      headers,
      rows,
      rowCount: rows.length,
      columnCount: headers.length,
      ...(table.pageRefs?.length
        ? { pageRefs: Array.from(new Set(table.pageRefs)).toSorted((a, b) => a - b) }
        : {}),
    };
  });
}

export function normalizePreviewRows(
  rows: Array<Record<string, unknown>> | undefined,
): Array<Record<string, string | number | boolean | null>> {
  if (!rows?.length) {
    return [];
  }

  const allColumns = Array.from(
    new Set(
      rows.flatMap((row) =>
        Object.keys(row)
          .map((key) => canonicalizeFieldKey(key))
          .filter(Boolean),
      ),
    ),
  ).toSorted();

  return rows.map((row) => {
    const normalizedEntries = new Map<string, string | number | boolean | null>();
    for (const [key, value] of Object.entries(row)) {
      const normalizedKey = canonicalizeFieldKey(key);
      if (!normalizedKey) {
        continue;
      }
      normalizedEntries.set(
        normalizedKey,
        typeof value === "string" || typeof value === "number" || typeof value === "boolean"
          ? value
          : value === null
            ? null
            : JSON.stringify(value),
      );
    }

    return Object.fromEntries(
      allColumns.map((column) => [column, normalizedEntries.get(column) ?? null]),
    );
  });
}
