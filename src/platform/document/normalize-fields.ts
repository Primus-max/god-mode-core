import type { DocumentExtractedField, DocumentFieldValueType } from "./artifacts.js";

export type NormalizedDocumentField = {
  key: string;
  label: string;
  sourceKeys: string[];
  valueType: DocumentFieldValueType;
  valueText: string;
  numberValue?: number;
  booleanValue?: boolean;
  isoDate?: string;
  confidence?: number;
  pageRefs?: number[];
  alternates?: string[];
};

function humanizeKey(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function canonicalizeFieldKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\bno[.]?\b/g, " number ")
    .replace(/[%]/g, " percent ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function coerceBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "y", "approved", "ok"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "n", "rejected", "denied"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function coerceNumber(value: string): number | undefined {
  const cleaned = value.replace(/[$,%\s,]/g, "");
  if (!/^[-+]?\d+(\.\d+)?$/u.test(cleaned)) {
    return undefined;
  }
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function coerceIsoDate(value: string): string | undefined {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function normalizeFieldValue(
  field: DocumentExtractedField,
): Omit<NormalizedDocumentField, "key" | "label" | "sourceKeys"> {
  const valueText =
    typeof field.value === "string" ? field.value.trim() : JSON.stringify(field.value, null, 2);
  const base = {
    valueType: field.valueType,
    valueText,
    ...(field.confidence !== undefined ? { confidence: field.confidence } : {}),
    ...(field.pageRefs?.length
      ? { pageRefs: Array.from(new Set(field.pageRefs)).toSorted((a, b) => a - b) }
      : {}),
  } satisfies Omit<NormalizedDocumentField, "key" | "label" | "sourceKeys">;

  if (field.valueType === "boolean") {
    const booleanValue = coerceBoolean(valueText);
    return booleanValue === undefined ? base : { ...base, booleanValue };
  }
  if (field.valueType === "number" || field.valueType === "currency") {
    const numberValue = coerceNumber(valueText);
    return numberValue === undefined ? base : { ...base, numberValue };
  }
  if (field.valueType === "date") {
    const isoDate = coerceIsoDate(valueText);
    return isoDate === undefined ? base : { ...base, isoDate };
  }
  return base;
}

function pickPreferredField(
  current: NormalizedDocumentField | undefined,
  next: NormalizedDocumentField,
): NormalizedDocumentField {
  if (!current) {
    return next;
  }
  const currentConfidence = current.confidence ?? -1;
  const nextConfidence = next.confidence ?? -1;
  if (nextConfidence > currentConfidence) {
    return next;
  }
  if (current.valueText.trim().length === 0 && next.valueText.trim().length > 0) {
    return next;
  }
  return current;
}

export function normalizeExtractedFields(
  fields: DocumentExtractedField[] | undefined,
): NormalizedDocumentField[] {
  if (!fields?.length) {
    return [];
  }

  const grouped = new Map<string, NormalizedDocumentField>();

  for (const field of fields) {
    const key = canonicalizeFieldKey(field.key || field.label || "field");
    const normalized: NormalizedDocumentField = {
      key,
      label: field.label?.trim() || humanizeKey(key),
      sourceKeys: [field.key],
      ...normalizeFieldValue(field),
    };

    const existing = grouped.get(key);
    const preferred = pickPreferredField(existing, normalized);
    const merged: NormalizedDocumentField = {
      ...preferred,
      sourceKeys: Array.from(
        new Set([...(existing?.sourceKeys ?? []), ...normalized.sourceKeys].filter(Boolean)),
      ),
      pageRefs:
        existing?.pageRefs || normalized.pageRefs
          ? Array.from(
              new Set([...(existing?.pageRefs ?? []), ...(normalized.pageRefs ?? [])]),
            ).toSorted((a, b) => a - b)
          : undefined,
      alternates: Array.from(
        new Set(
          [existing?.valueText, normalized.valueText, ...(existing?.alternates ?? [])].filter(
            (value): value is string => Boolean(value && value !== preferred.valueText),
          ),
        ),
      ),
    };
    if (!merged.alternates?.length) {
      delete merged.alternates;
    }
    grouped.set(key, merged);
  }

  return Array.from(grouped.values()).toSorted((left, right) => left.key.localeCompare(right.key));
}
