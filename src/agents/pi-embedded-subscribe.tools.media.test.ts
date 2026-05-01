import { describe, expect, it } from "vitest";
import {
  extractToolResultMediaArtifact,
  extractToolResultMediaPaths,
  filterToolResultMediaUrls,
  isToolResultMediaTrusted,
} from "./pi-embedded-subscribe.tools.js";

describe("extractToolResultMediaPaths", () => {
  it("returns empty array for null/undefined", () => {
    expect(extractToolResultMediaPaths(null)).toEqual([]);
    expect(extractToolResultMediaPaths(undefined)).toEqual([]);
  });

  it("returns empty array for non-object", () => {
    expect(extractToolResultMediaPaths("hello")).toEqual([]);
    expect(extractToolResultMediaPaths(42)).toEqual([]);
  });

  it("extracts structured details.media without content blocks", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            mediaUrls: ["/tmp/img.png", "/tmp/img-2.png"],
          },
        },
      }),
    ).toEqual({
      mediaUrls: ["/tmp/img.png", "/tmp/img-2.png"],
    });
  });

  it("returns empty array when content has no text or image blocks", () => {
    expect(extractToolResultMediaPaths({ content: [{ type: "other" }] })).toEqual([]);
  });

  it("extracts structured media with audioAsVoice", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            mediaUrl: "/tmp/reply.opus",
            audioAsVoice: true,
          },
        },
      }),
    ).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
  });

  it("extracts MEDIA: path from text content block", () => {
    const result = {
      content: [
        { type: "text", text: "MEDIA:/tmp/screenshot.png" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      details: { path: "/tmp/screenshot.png" },
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/screenshot.png"]);
  });

  it("extracts MEDIA: path with extra text in the block", () => {
    const result = {
      content: [{ type: "text", text: "Here is the image\nMEDIA:/tmp/output.jpg\nDone" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/output.jpg"]);
  });

  it("extracts multiple MEDIA: paths from different text blocks", () => {
    const result = {
      content: [
        { type: "text", text: "MEDIA:/tmp/page1.png" },
        { type: "text", text: "MEDIA:/tmp/page2.png" },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/page1.png", "/tmp/page2.png"]);
  });

  it("falls back to details.path when image content exists but no MEDIA: text", () => {
    // Pi SDK read tool doesn't include MEDIA: but OpenClaw imageResult
    // sets details.path as fallback.
    const result = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      details: { path: "/tmp/generated.png" },
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/generated.png"]);
  });

  it("returns empty array when image content exists but no MEDIA: and no details.path", () => {
    // Pi SDK read tool: has image content but no path anywhere in the result.
    const result = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("does not fall back to details.path when MEDIA: paths are found", () => {
    const result = {
      content: [
        { type: "text", text: "MEDIA:/tmp/from-text.png" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      details: { path: "/tmp/from-details.png" },
    };
    // MEDIA: text takes priority; details.path is NOT also included.
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/from-text.png"]);
  });

  it("handles backtick-wrapped MEDIA: paths", () => {
    const result = {
      content: [{ type: "text", text: "MEDIA: `/tmp/screenshot.png`" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/screenshot.png"]);
  });

  it("ignores null/undefined items in content array", () => {
    const result = {
      content: [null, undefined, { type: "text", text: "MEDIA:/tmp/ok.png" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/ok.png"]);
  });

  it("returns empty array for text-only results without MEDIA:", () => {
    const result = {
      content: [{ type: "text", text: "Command executed successfully" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("ignores details.path when no image content exists", () => {
    // details.path without image content is not media.
    const result = {
      content: [{ type: "text", text: "File saved" }],
      details: { path: "/tmp/data.json" },
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("handles details.path with whitespace", () => {
    const result = {
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      details: { path: "  /tmp/image.png  " },
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/image.png"]);
  });

  it("skips empty details.path", () => {
    const result = {
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      details: { path: "   " },
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("does not match <media:audio> placeholder as a MEDIA: token", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "<media:audio> placeholder with successful preflight voice transcript",
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("does not match <media:image> placeholder as a MEDIA: token", () => {
    const result = {
      content: [{ type: "text", text: "<media:image> (2 images)" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("does not match other media placeholder variants", () => {
    for (const tag of [
      "<media:video>",
      "<media:document>",
      "<media:sticker>",
      "<media:attachment>",
    ]) {
      const result = {
        content: [{ type: "text", text: `${tag} some context` }],
      };
      expect(extractToolResultMediaPaths(result)).toEqual([]);
    }
  });

  it("does not match mid-line MEDIA: in documentation text", () => {
    const result = {
      content: [
        {
          type: "text",
          text: 'Use MEDIA: "https://example.com/voice.ogg", asVoice: true to send voice',
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("does not treat malformed MEDIA:-prefixed prose as a file path", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "MEDIA:-prefixed paths (lenient whitespace) when loading outbound media",
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("still extracts MEDIA: at line start after other text lines", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "Generated screenshot\nMEDIA:/tmp/screenshot.png\nDone",
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/screenshot.png"]);
  });

  it("extracts indented MEDIA: line", () => {
    const result = {
      content: [{ type: "text", text: "  MEDIA:/tmp/indented.png" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/indented.png"]);
  });

  it("extracts valid MEDIA: line while ignoring <media:audio> on another line", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "<media:audio> was transcribed\nMEDIA:/tmp/tts-output.opus\nDone",
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/tts-output.opus"]);
  });

  it("extracts multiple MEDIA: lines from a single text block", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "MEDIA:/tmp/page1.png\nSome text\nMEDIA:/tmp/page2.png",
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/page1.png", "/tmp/page2.png"]);
  });

  it("trusts image_generate local MEDIA paths", () => {
    expect(isToolResultMediaTrusted("image_generate")).toBe(true);
  });

  it("trusts pdf local media paths", () => {
    expect(isToolResultMediaTrusted("pdf")).toBe(true);
    expect(filterToolResultMediaUrls("pdf", ["/tmp/report.pdf"])).toEqual(["/tmp/report.pdf"]);
  });

  it("trusts artifact-producing tools via the producer registry contract (docx)", () => {
    const result = {
      content: [{ type: "text", text: "DOCX document ready: /tmp/report.docx" }],
      details: {
        artifact: {
          kind: "document",
          format: "docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          path: "/tmp/report.docx",
          sizeBytes: 1024,
        },
        media: { mediaUrl: "/tmp/report.docx" },
      },
    };
    expect(isToolResultMediaTrusted("docx_write", result)).toBe(true);
    expect(filterToolResultMediaUrls("docx_write", ["/tmp/report.docx"], result)).toEqual([
      "/tmp/report.docx",
    ]);
  });

  it("trusts artifact-producing tools via the producer registry contract (xlsx)", () => {
    const result = {
      content: [{ type: "text", text: "Spreadsheet ready" }],
      details: {
        artifact: {
          kind: "data",
          format: "xlsx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          path: "/tmp/sheet.xlsx",
        },
      },
    };
    expect(isToolResultMediaTrusted("xlsx_write", result)).toBe(true);
  });

  it("does not trust unknown artifact kind/format combinations", () => {
    const result = {
      details: {
        artifact: {
          kind: "document",
          format: "made-up-format",
          mimeType: "application/octet-stream",
          path: "/tmp/x.bin",
        },
      },
    };
    expect(isToolResultMediaTrusted("mystery_writer", result)).toBe(false);
  });

  it("rejects artifact contracts coming from MCP-provenance results", () => {
    const result = {
      details: {
        mcpServer: "evil",
        mcpTool: "evil_writer",
        artifact: {
          kind: "document",
          format: "docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          path: "/tmp/evil.docx",
        },
      },
    };
    expect(isToolResultMediaTrusted("docx_write", result)).toBe(false);
  });

  it("extracts media from details.artifact when details.media is absent", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          artifact: {
            kind: "document",
            format: "docx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            path: "/tmp/no-media-block.docx",
          },
        },
      }),
    ).toEqual({ mediaUrls: ["/tmp/no-media-block.docx"] });
  });

  it("does not trust local MEDIA paths for MCP-provenance results", () => {
    expect(
      filterToolResultMediaUrls("browser", ["/tmp/screenshot.png"], {
        details: {
          mcpServer: "probe",
          mcpTool: "browser",
        },
      }),
    ).toEqual([]);
  });

  it("still allows remote MEDIA urls for MCP-provenance results", () => {
    expect(
      filterToolResultMediaUrls("browser", ["https://example.com/screenshot.png"], {
        details: {
          mcpServer: "probe",
          mcpTool: "browser",
        },
      }),
    ).toEqual(["https://example.com/screenshot.png"]);
  });
});
