import { vi } from "vitest";
import { stubTool } from "./fast-tool-stubs.js";

vi.mock("../tools/browser-tool.js", () => ({
  createBrowserTool: () => stubTool("browser"),
}));

vi.mock("../tools/canvas-tool.js", () => ({
  createCanvasTool: () => stubTool("canvas"),
}));

vi.mock("../tools/message-tool.js", () => ({
  createMessageTool: () => stubTool("message"),
}));

vi.mock("../tools/tts-tool.js", () => ({
  createTtsTool: () => stubTool("tts"),
}));

vi.mock("../tools/gateway-tool.js", () => ({
  createGatewayTool: () => stubTool("gateway"),
}));

vi.mock("../tools/image-generate-tool.js", () => ({
  createImageGenerateTool: () => stubTool("image_generate"),
}));

vi.mock("../tools/pdf-tool.js", () => ({
  createPdfTool: () => stubTool("pdf"),
}));

vi.mock("../tools/csv-tool.js", () => ({
  createCsvTool: () => stubTool("csv"),
}));

vi.mock("../tools/docx-tool.js", () => ({
  createDocxTool: () => stubTool("docx"),
}));

vi.mock("../tools/xlsx-tool.js", () => ({
  createXlsxTool: () => stubTool("xlsx"),
}));

vi.mock("../tools/site-tool.js", () => ({
  createSiteTool: () => stubTool("site"),
}));

vi.mock("../tools/capability-install-tool.js", () => ({
  createCapabilityInstallTool: () => stubTool("capability_install"),
}));
