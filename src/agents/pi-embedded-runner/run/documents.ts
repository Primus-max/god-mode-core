import fs from "node:fs/promises";
import path from "node:path";

import type { InboundMediaAttachmentKind } from "../../../platform/commitment/intent-contractor-impl.js";
import { extractPdfContent } from "../../../media/pdf-extract.js";
import { log } from "../logger.js";

/**
 * Slice G — inbound DOCX/PDF text pre-extraction.
 *
 * Closes the bundle-as-contract gap (PR #290): the
 * `artifact_authoring` bundle correctly excludes the `read` tool, so
 * the model has no in-band path to open user-attached PDFs/DOCXs. The
 * `document_extraction` bundle stays empty (no production tool emits a
 * `pdf_extract`/`docx_extract` symbol) — by design extraction is run
 * BEFORE the LLM call and the text is inlined into the prompt body.
 * This mirrors the existing `detectAndLoadPromptImages` shape in
 * `images.ts`, which decodes image bytes to `ImageContent` blocks pre-
 * call.
 *
 * Production trace (2026-05-08): user attached two `.docx` templates on
 * Telegram with prompt «Прикладываю два документа, надо в таком же
 * стиле…». Bot emitted CoT-spam ending in
 * `Provider finish_reason: error` then a generic «каркас для
 * извлечения структуры документа» — meta-text proving it could not
 * read the file body. Same class of bug applies to PDFs.
 *
 * Telemetry contract: emits exactly one
 *   `[inbound-doc-extract] kind=<pdf|docx> path=<p> chars=<N> turnId=<id>`
 * info line per extracted attachment (used by the live-verifier gate).
 * Failures emit a warn line carrying `reason=extract_failed` so
 * post-mortems can JOIN on turnId without re-reading the user prompt.
 *
 * Invariants:
 *   #5/#6 — structural reads only. The helper consumes the closed-
 *   shape `kind` field from `InboundMediaAttachment`; it never inspects
 *   `RawUserTurn` text to decide what to extract.
 *   #8 — frozen layer is read-only. We import the
 *   `InboundMediaAttachmentKind` TYPE alias from
 *   `platform/commitment/intent-contractor-impl.ts` but do not mutate
 *   any contract there.
 */

/** Hard caps for PDF extraction — defensive for oversized inbound payloads. */
const MAX_PDF_PAGES = 50;
const MAX_PDF_RENDER_PIXELS = 2_000_000;

/** Single attachment input shape. Subset of `InboundMediaAttachment`. */
export type InboundDocumentAttachmentInput = {
  readonly kind: InboundMediaAttachmentKind;
  readonly path: string;
  readonly mimeType: string;
};

export type InboundDocumentExtraction = {
  readonly kind: "pdf" | "docx";
  readonly path: string;
  readonly mimeType: string;
  readonly text: string;
  readonly characterCount: number;
  /** Set when extraction failed gracefully (corrupt file, missing dep). */
  readonly reason?: "extract_failed";
};

export type InboundDocumentExtractionResult = {
  /** Prompt body with prepended `<inbound_document>` blocks (1 per extracted file). */
  readonly prompt: string;
  /** Extractions in the same order as the input attachments (skipped kinds are omitted). */
  readonly extractions: readonly InboundDocumentExtraction[];
};

// Minimal local type — `mammoth` ships no .d.ts and there is no
// `@types/mammoth` on the registry as of 2026-05-08. We only use the
// `extractRawText` entry-point so the surface stays narrow.
type MammothModule = {
  extractRawText: (input: { buffer: Buffer }) => Promise<{
    value: string;
    messages?: ReadonlyArray<{ type?: string; message?: string }>;
  }>;
};

let mammothModulePromise: Promise<MammothModule> | null = null;

async function loadMammothModule(): Promise<MammothModule> {
  if (!mammothModulePromise) {
    mammothModulePromise = (
      import("mammoth") as unknown as Promise<{ default?: MammothModule } & MammothModule>
    )
      .then((mod) => {
        const resolved =
          typeof (mod as { extractRawText?: unknown }).extractRawText === "function"
            ? (mod as MammothModule)
            : (mod as { default?: MammothModule }).default;
        if (!resolved || typeof resolved.extractRawText !== "function") {
          throw new Error("mammoth module did not expose extractRawText");
        }
        return resolved;
      })
      .catch((err) => {
        mammothModulePromise = null;
        throw err;
      });
  }
  return mammothModulePromise;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildDocumentBlock(args: {
  path: string;
  mimeType: string;
  text: string;
  reason?: "extract_failed";
}): string {
  const { path: filePath, mimeType, text, reason } = args;
  const attrs = [`path="${escapeAttribute(filePath)}"`, `mime="${escapeAttribute(mimeType)}"`];
  if (reason) {
    attrs.push(`reason="${reason}"`);
  }
  // Body is the raw extracted text. We do NOT escape it — the model
  // treats the block as opaque content and entity-escaping risks
  // corrupting Cyrillic / mathematical characters that mammoth/pdfjs
  // already returned as plain text. The `<inbound_document>` element
  // itself is non-collidable enough that downstream prompt scanners
  // (e.g. images.ts regexes) ignore it.
  return `<inbound_document ${attrs.join(" ")}>\n${text}\n</inbound_document>`;
}

async function extractDocxText(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const mammothMod = await loadMammothModule();
  const result = await mammothMod.extractRawText({ buffer });
  return result.value ?? "";
}

async function extractPdfText(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const result = await extractPdfContent({
    buffer,
    maxPages: MAX_PDF_PAGES,
    maxPixels: MAX_PDF_RENDER_PIXELS,
    minTextChars: 1,
  });
  return result.text;
}

function logTelemetry(args: {
  kind: "pdf" | "docx";
  filePath: string;
  characterCount: number;
  turnId: string;
  reason?: "extract_failed";
}): void {
  const reasonSuffix = args.reason ? ` reason=${args.reason}` : "";
  log.info(
    `[inbound-doc-extract] kind=${args.kind} path=${args.filePath} chars=${args.characterCount} turnId=${args.turnId}${reasonSuffix}`,
  );
}

/**
 * Pre-extracts text from inbound DOCX / PDF attachments and inlines
 * the result into the LLM-bound prompt body. Image and `other`
 * attachments are passed through untouched (images flow through
 * `detectAndLoadPromptImages` instead; `other` is ignored).
 *
 * Each extraction emits exactly one `[inbound-doc-extract]` log line.
 * On failure we still inline an empty block with `reason="extract_failed"`
 * so the model knows the upload was attempted but the body was
 * unreadable.
 */
export async function applyInboundDocumentExtractions(params: {
  prompt: string;
  attachments?: ReadonlyArray<InboundDocumentAttachmentInput>;
  turnId: string;
}): Promise<InboundDocumentExtractionResult> {
  const { prompt, attachments, turnId } = params;
  if (!attachments || attachments.length === 0) {
    return { prompt, extractions: [] };
  }

  const blocks: string[] = [];
  const extractions: InboundDocumentExtraction[] = [];

  for (const attachment of attachments) {
    if (attachment.kind !== "pdf" && attachment.kind !== "docx") {
      continue;
    }
    let text = "";
    let reason: "extract_failed" | undefined;
    try {
      if (attachment.kind === "pdf") {
        text = await extractPdfText(attachment.path);
      } else {
        text = await extractDocxText(attachment.path);
      }
    } catch (err) {
      reason = "extract_failed";
      log.warn(
        `[inbound-doc-extract] kind=${attachment.kind} path=${attachment.path} turnId=${turnId} reason=extract_failed error=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const characterCount = text.length;
    blocks.push(
      buildDocumentBlock({
        path: attachment.path,
        mimeType: attachment.mimeType,
        text,
        reason,
      }),
    );
    extractions.push({
      kind: attachment.kind,
      path: attachment.path,
      mimeType: attachment.mimeType,
      text,
      characterCount,
      ...(reason ? { reason } : {}),
    });

    // One info line per extraction (success or graceful failure).
    // Failures already emitted a warn above with the error message, so
    // the info line here just stamps the structured success/total-chars
    // record the live-verifier scrapes.
    if (!reason) {
      logTelemetry({
        kind: attachment.kind,
        filePath: attachment.path,
        characterCount,
        turnId,
      });
    }
  }

  if (blocks.length === 0) {
    return { prompt, extractions: [] };
  }

  // Prepend the document blocks before the user prompt body. Order
  // matches the input attachment array (Symptom G).
  const augmentedPrompt = `${blocks.join("\n\n")}\n\n${prompt}`;
  return { prompt: augmentedPrompt, extractions };
}

/**
 * Scan a prompt body for `[media attached: <path> (<mime>) ...]` /
 * `[media attached N/M: <path> ...]` markers and return the subset
 * whose extension / MIME identifies them as PDFs or DOCXs. Mirrors the
 * `[media attached]` parser in `images.ts`. Used by the `attempt.ts`
 * wiring site when the upstream `inboundMediaSummary` is not (yet)
 * threaded down — pi-embedded callers receive the prompt already
 * stamped with the `[media attached]` lines by the auto-reply note
 * builder, so this surface stays self-contained.
 */
export function detectDocumentAttachmentsInPrompt(
  prompt: string,
): InboundDocumentAttachmentInput[] {
  const refs: InboundDocumentAttachmentInput[] = [];
  const seen = new Set<string>();
  const mediaAttachedPattern = /\[media attached(?:\s+\d+\/\d+)?:\s*([^\]]+)\]/gi;
  let match: RegExpExecArray | null;
  while ((match = mediaAttachedPattern.exec(prompt)) !== null) {
    const content = match[1] ?? "";
    if (/^\d+\s+files?$/i.test(content.trim())) {
      continue;
    }
    // Format inside the bracket is: `<path> (<mime>) | <url>` or
    // `<path> | <url>` or `<path> (<mime>)` or just `<path>`.
    // Path may contain spaces. We pull until either ` (` or ` | ` or end.
    const trimmed = content.trim();
    let filePath = trimmed;
    let mimeType = "";
    const parenIdx = trimmed.lastIndexOf(" (");
    const pipeIdx = trimmed.indexOf(" | ");
    const splitIdx =
      parenIdx >= 0 && (pipeIdx < 0 || parenIdx < pipeIdx)
        ? parenIdx
        : pipeIdx >= 0
          ? pipeIdx
          : -1;
    if (splitIdx > 0) {
      filePath = trimmed.slice(0, splitIdx).trim();
      const tail = trimmed.slice(splitIdx).trim();
      const mimeMatch = tail.match(/\(([^)]+)\)/);
      if (mimeMatch?.[1]) {
        mimeType = mimeMatch[1].trim();
      }
    }
    if (!filePath) {
      continue;
    }
    const ext = path.extname(filePath).toLowerCase();
    let kind: "pdf" | "docx" | null = null;
    if (mimeType === "application/pdf" || ext === ".pdf") {
      kind = "pdf";
    } else if (
      mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      ext === ".docx"
    ) {
      kind = "docx";
    }
    if (!kind) {
      continue;
    }
    const dedupeKey = process.platform === "win32" ? filePath.toLowerCase() : filePath;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    refs.push({
      kind,
      path: filePath,
      mimeType:
        mimeType ||
        (kind === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    });
  }
  return refs;
}
