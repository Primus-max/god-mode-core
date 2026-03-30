import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fetchGuard from "../../infra/net/fetch-guard.js";
import { fetchBootstrapDownloadArtifact } from "./download-fetch.js";

const fetchWithSsrFGuardSpy = vi.spyOn(fetchGuard, "fetchWithSsrFGuard");
const withTrustedEnvProxyGuardedFetchModeSpy = vi.spyOn(
  fetchGuard,
  "withTrustedEnvProxyGuardedFetchMode",
);

withTrustedEnvProxyGuardedFetchModeSpy.mockImplementation((params) => params);

afterAll(() => {
  fetchWithSsrFGuardSpy.mockRestore();
  withTrustedEnvProxyGuardedFetchModeSpy.mockRestore();
});

describe("bootstrap download fetch", () => {
  let tempRoot = "";

  afterEach(async () => {
    vi.clearAllMocks();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = "";
    }
  });

  it("downloads a trusted artifact into the bounded target directory and verifies sha256", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bootstrap-download-fetch-"));
    const body = Buffer.from("bootstrap-archive");
    const sha256 = createHash("sha256").update(body).digest("hex");
    fetchWithSsrFGuardSpy.mockResolvedValue({
      response: new Response(body, {
        status: 200,
        headers: { "content-length": String(body.length) },
      }),
      finalUrl: "https://openclaw.ai/bootstrap/playwright-pdf-renderer-1.2.3.tgz",
      release: vi.fn(async () => {}),
    });

    const result = await fetchBootstrapDownloadArtifact({
      url: "https://openclaw.ai/bootstrap/playwright-pdf-renderer-1.2.3.tgz",
      integrity: `sha256:${sha256}`,
      archiveKind: "tar",
      targetDir: tempRoot,
    });

    expect(result).toMatchObject({
      ok: true,
      bytes: body.length,
      sha256,
    });
    if (!result.ok) {
      throw new Error("expected successful download");
    }
    await expect(fs.readFile(result.archivePath)).resolves.toEqual(body);
  });

  it("fails closed on integrity mismatch", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bootstrap-download-fetch-"));
    fetchWithSsrFGuardSpy.mockResolvedValue({
      response: new Response(Buffer.from("bootstrap-archive"), { status: 200 }),
      finalUrl: "https://openclaw.ai/bootstrap/playwright-pdf-renderer-1.2.3.tgz",
      release: vi.fn(async () => {}),
    });

    const result = await fetchBootstrapDownloadArtifact({
      url: "https://openclaw.ai/bootstrap/playwright-pdf-renderer-1.2.3.tgz",
      integrity: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      archiveKind: "tar",
      targetDir: tempRoot,
    });

    expect(result).toEqual({
      ok: false,
      error:
        "bootstrap download integrity mismatch for https://openclaw.ai/bootstrap/playwright-pdf-renderer-1.2.3.tgz",
    });
    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
  });
});
