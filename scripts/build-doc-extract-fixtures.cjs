/* eslint-disable */
/**
 * One-off helper that builds reproducible inbound DOCX/PDF fixtures for
 * the Slice G `inbound-doc-extract` test suite.
 *
 * Run from repo root:
 *   node scripts/build-doc-extract-fixtures.cjs
 *
 * Output:
 *   src/agents/pi-embedded-runner/run/__fixtures__/sample-hello.pdf
 *   src/agents/pi-embedded-runner/run/__fixtures__/sample-hello.docx
 *   src/agents/pi-embedded-runner/run/__fixtures__/sample-corrupt.pdf
 */
const path = require("node:path");
const fs = require("node:fs");
const JSZip = require("jszip");
const mammoth = require("mammoth");

const fixturesDir = path.resolve(
  __dirname,
  "..",
  "src",
  "agents",
  "pi-embedded-runner",
  "run",
  "__fixtures__",
);
fs.mkdirSync(fixturesDir, { recursive: true });

// --- Minimal valid PDF with literal "Hello World" text. -----------------
// Hand-rolled PDF/1.4 with single page using the built-in Helvetica font.
// pdfjs-dist parses it via getTextContent() and returns "Hello World".
function buildHelloWorldPdf() {
  const objects = [];
  const offsets = [];
  let buf = "";

  function addObj(content) {
    offsets.push(Buffer.byteLength(buf, "binary") + Buffer.byteLength("%PDF-1.4\n", "binary"));
    objects.push(content);
    buf += `${objects.length} 0 obj\n${content}\nendobj\n`;
  }

  // 1: Catalog
  addObj("<< /Type /Catalog /Pages 2 0 R >>");
  // 2: Pages
  addObj("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  // 3: Page
  addObj(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  );
  // 4: Content stream
  const stream = "BT\n/F1 24 Tf\n72 720 Td\n(Hello World) Tj\nET";
  addObj(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  // 5: Font
  addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let pdf = "%PDF-1.4\n" + buf;
  const xrefOffset = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

// --- Minimal valid DOCX (Open XML zip) with predictable text. ------------
async function buildHelloDocx(text) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
  );
  zip.folder("_rels").file(
    ".rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
  );
  zip.folder("word").file(
    "document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body>" +
      "<w:p><w:r><w:t>" +
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
      "</w:t></w:r></w:p>" +
      "</w:body>" +
      "</w:document>",
  );
  return await zip.generateAsync({ type: "nodebuffer" });
}

(async () => {
  const helloPdf = buildHelloWorldPdf();
  fs.writeFileSync(path.join(fixturesDir, "sample-hello.pdf"), helloPdf);

  const helloDocx = await buildHelloDocx("Mammoth Roundtrip Probe Beta");
  fs.writeFileSync(path.join(fixturesDir, "sample-hello.docx"), helloDocx);

  const corruptPdf = Buffer.from("%PDF-1.4\nthis is not a valid pdf at all\n%%EOF\n", "binary");
  fs.writeFileSync(path.join(fixturesDir, "sample-corrupt.pdf"), corruptPdf);

  // Verify the round-trip so the fixtures are guaranteed extractable.
  const docxResult = await mammoth.extractRawText({
    path: path.join(fixturesDir, "sample-hello.docx"),
  });
  if (!docxResult.value.includes("Mammoth Roundtrip Probe Beta")) {
    throw new Error(
      "DOCX fixture did not round-trip through mammoth: " + JSON.stringify(docxResult.value),
    );
  }

  console.log("Wrote fixtures:");
  console.log(" ", path.join(fixturesDir, "sample-hello.pdf"));
  console.log(" ", path.join(fixturesDir, "sample-hello.docx"));
  console.log(" ", path.join(fixturesDir, "sample-corrupt.pdf"));
})();
