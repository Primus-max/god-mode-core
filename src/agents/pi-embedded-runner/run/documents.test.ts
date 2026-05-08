import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_PDF = path.join(__dirname, "__fixtures__", "sample-hello.pdf");
const FIXTURE_DOCX = path.join(__dirname, "__fixtures__", "sample-hello.docx");
const FIXTURE_CORRUPT_PDF = path.join(__dirname, "__fixtures__", "sample-corrupt.pdf");

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// In-memory log capture — the helper writes telemetry through the
// shared subsystem logger. We use `vi.doMock` (non-hoisted) plus
// `vi.resetModules` + dynamic import to inject a buffer-backed logger
// before the helper module loads. Live verifier still reads the real
// `[inbound-doc-extract]` line off the gateway file logger.
const logBuffer: { level: "info" | "warn"; line: string }[] = [];

type DocumentsModule = typeof import("./documents.js");
let documents: DocumentsModule;

beforeEach(async () => {
  logBuffer.length = 0;
  vi.resetModules();
  vi.doMock("../logger.js", () => ({
    log: {
      trace: () => {},
      debug: () => {},
      info: (message: string) => {
        logBuffer.push({ level: "info", line: message });
      },
      warn: (message: string) => {
        logBuffer.push({ level: "warn", line: message });
      },
      error: () => {},
      fatal: () => {},
      raw: () => {},
      isEnabled: () => false,
      subsystem: "agent/embedded",
      child: () => ({
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        fatal: () => {},
        raw: () => {},
        isEnabled: () => false,
        subsystem: "agent/embedded",
        child: () => ({}) as never,
      }),
    },
  }));
  documents = await import("./documents.js");
});

describe("applyInboundDocumentExtractions", () => {
  // SYMPTOM A — PDF text injected.
  // Pre-Slice-G the bot saw only `[media attached: <p> (application/pdf)]`
  // and could not read the file body, producing «каркас для извлечения
  // структуры документа» meta-text. Helper now extracts text and inlines
  // it as a delimited block before the LLM call.
  it("injects PDF text into the prompt body via <inbound_document> block", async () => {
    const result = await documents.applyInboundDocumentExtractions({
      prompt: "Прикладываю документ",
      attachments: [{ kind: "pdf", path: FIXTURE_PDF, mimeType: PDF_MIME }],
      turnId: "turn-A",
    });

    expect(result.prompt).toContain("<inbound_document");
    expect(result.prompt).toContain('mime="application/pdf"');
    expect(result.prompt).toContain("Hello World");
    expect(result.prompt).toContain("Прикладываю документ");
    expect(result.extractions).toHaveLength(1);
    expect(result.extractions[0]).toMatchObject({ kind: "pdf" });
    expect(result.extractions[0].reason).toBeUndefined();
    expect(result.extractions[0].text).toContain("Hello World");
  });

  // SYMPTOM B — DOCX text injected via mammoth.
  // The motivating production turn attached two .docx templates; the bot
  // had no way to see their text. Helper must run mammoth.extractRawText
  // and inline the result.
  it("injects DOCX text into the prompt body via <inbound_document> block", async () => {
    const result = await documents.applyInboundDocumentExtractions({
      prompt: "Use these as templates",
      attachments: [{ kind: "docx", path: FIXTURE_DOCX, mimeType: DOCX_MIME }],
      turnId: "turn-B",
    });

    expect(result.prompt).toContain("<inbound_document");
    expect(result.prompt).toContain('mime="' + DOCX_MIME + '"');
    expect(result.prompt).toContain("Mammoth Roundtrip Probe Beta");
    expect(result.extractions).toHaveLength(1);
    expect(result.extractions[0].kind).toBe("docx");
    expect(result.extractions[0].text).toContain("Mammoth Roundtrip Probe Beta");
  });

  // SYMPTOM C — image attachments untouched.
  // Image kind is owned by detectAndLoadPromptImages; this helper must
  // pass through with no side-effects (no log, no prompt mutation).
  it("leaves image attachments untouched (handled by image pipeline)", async () => {
    const before = "What is in this picture?";
    const result = await documents.applyInboundDocumentExtractions({
      prompt: before,
      attachments: [{ kind: "image", path: "/tmp/whatever.png", mimeType: "image/png" }],
      turnId: "turn-C",
    });

    expect(result.prompt).toBe(before);
    expect(result.extractions).toHaveLength(0);
    expect(logBuffer.some((l) => l.line.includes("[inbound-doc-extract]"))).toBe(false);
  });

  // SYMPTOM D — telemetry log fires on extraction.
  // Live-verify gate: each extracted document MUST emit exactly one
  // `[inbound-doc-extract] kind=<...> path=<...> chars=<N> turnId=<id>`
  // line so the gateway log can prove pre-extract ran.
  it("emits [inbound-doc-extract] telemetry line per extracted attachment", async () => {
    await documents.applyInboundDocumentExtractions({
      prompt: "x",
      attachments: [{ kind: "pdf", path: FIXTURE_PDF, mimeType: PDF_MIME }],
      turnId: "telemetry-turn",
    });

    const teleLines = logBuffer.filter((l) => l.line.includes("[inbound-doc-extract]"));
    expect(teleLines).toHaveLength(1);
    expect(teleLines[0].line).toContain("kind=pdf");
    expect(teleLines[0].line).toContain("turnId=telemetry-turn");
    expect(teleLines[0].line).toMatch(/chars=\d+/);
  });

  // SYMPTOM E — corrupt PDF must NOT throw.
  // A malformed PDF must produce a warning + an empty <inbound_document>
  // block with reason="extract_failed", so the model still sees the
  // user's request and can ask for a re-upload.
  it("handles a corrupt PDF gracefully with reason=extract_failed", async () => {
    const result = await documents.applyInboundDocumentExtractions({
      prompt: "Read this",
      attachments: [{ kind: "pdf", path: FIXTURE_CORRUPT_PDF, mimeType: PDF_MIME }],
      turnId: "corrupt-turn",
    });

    expect(result.prompt).toContain("<inbound_document");
    expect(result.prompt).toContain('reason="extract_failed"');
    expect(result.extractions).toHaveLength(1);
    expect(result.extractions[0].reason).toBe("extract_failed");

    const warns = logBuffer.filter((l) => l.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
  });

  // SYMPTOM F — empty / heartbeat pass-through.
  // No attachments must mean no log line and the prompt is byte-identical.
  it("is a no-op when attachments is empty or undefined", async () => {
    const empty = await documents.applyInboundDocumentExtractions({
      prompt: "hello",
      attachments: [],
      turnId: "heartbeat-1",
    });
    expect(empty.prompt).toBe("hello");
    expect(empty.extractions).toHaveLength(0);

    const undef = await documents.applyInboundDocumentExtractions({
      prompt: "hello",
      attachments: undefined,
      turnId: "heartbeat-2",
    });
    expect(undef.prompt).toBe("hello");
    expect(undef.extractions).toHaveLength(0);

    expect(logBuffer.some((l) => l.line.includes("[inbound-doc-extract]"))).toBe(false);
  });

  // SYMPTOM G — DOCX + PDF in same turn.
  // Production case: user attached two docs at once. Both blocks must be
  // present, ordered by attachment index.
  it("handles multiple attachments (DOCX + PDF) in attachment order", async () => {
    const result = await documents.applyInboundDocumentExtractions({
      prompt: "Use these",
      attachments: [
        { kind: "docx", path: FIXTURE_DOCX, mimeType: DOCX_MIME },
        { kind: "pdf", path: FIXTURE_PDF, mimeType: PDF_MIME },
      ],
      turnId: "multi-turn",
    });

    expect(result.extractions).toHaveLength(2);
    expect(result.extractions[0].kind).toBe("docx");
    expect(result.extractions[1].kind).toBe("pdf");

    const docxIdx = result.prompt.indexOf("Mammoth Roundtrip Probe Beta");
    const pdfIdx = result.prompt.indexOf("Hello World");
    expect(docxIdx).toBeGreaterThan(-1);
    expect(pdfIdx).toBeGreaterThan(-1);
    expect(docxIdx).toBeLessThan(pdfIdx);
  });

  // NEGATIVE — `kind: "other"` is silently skipped.
  it("skips kind=other silently with no log and no block", async () => {
    const result = await documents.applyInboundDocumentExtractions({
      prompt: "Got this",
      attachments: [{ kind: "other", path: "/tmp/audio.ogg", mimeType: "audio/ogg" }],
      turnId: "other-turn",
    });

    expect(result.prompt).toBe("Got this");
    expect(result.extractions).toHaveLength(0);
    expect(logBuffer.some((l) => l.line.includes("[inbound-doc-extract]"))).toBe(false);
  });
});

describe("detectDocumentAttachmentsInPrompt", () => {
  // Wiring helper used by attempt.ts — detect [media attached: ...] lines
  // and classify them as PDF/DOCX/skip. Mirrors images.ts pattern.
  it("detects a PDF [media attached] line by extension", async () => {
    const refs = documents.detectDocumentAttachmentsInPrompt(
      "Hello [media attached: /tmp/Report.pdf (application/pdf) | https://x/Report.pdf]",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("pdf");
    expect(refs[0].path).toBe("/tmp/Report.pdf");
    expect(refs[0].mimeType).toBe("application/pdf");
  });

  it("detects a DOCX [media attached] line by extension", async () => {
    const refs = documents.detectDocumentAttachmentsInPrompt(
      "[media attached: /tmp/Template.docx (application/vnd.openxmlformats-officedocument.wordprocessingml.document)]",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("docx");
    expect(refs[0].path).toBe("/tmp/Template.docx");
  });

  it("skips images and audio markers", async () => {
    const refs = documents.detectDocumentAttachmentsInPrompt(
      "[media attached: /tmp/a.png (image/png)] [media attached: /tmp/v.ogg (audio/ogg)]",
    );
    expect(refs).toHaveLength(0);
  });

  it("returns multiple PDF+DOCX in attachment order without duplicates", async () => {
    const refs = documents.detectDocumentAttachmentsInPrompt(
      "[media attached 1/3: /tmp/A.docx (application/vnd.openxmlformats-officedocument.wordprocessingml.document)]\n" +
        "[media attached 2/3: /tmp/B.pdf (application/pdf)]\n" +
        "[media attached 3/3: /tmp/A.docx (application/vnd.openxmlformats-officedocument.wordprocessingml.document)]",
    );
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ kind: "docx", path: "/tmp/A.docx" });
    expect(refs[1]).toMatchObject({ kind: "pdf", path: "/tmp/B.pdf" });
  });
});
