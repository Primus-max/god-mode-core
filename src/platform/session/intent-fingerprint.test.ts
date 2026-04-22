import { describe, expect, it, vi } from "vitest";
import {
  computeIntentFingerprint,
  INTENT_IDEMPOTENCY_WINDOW_MS_DEFAULT,
  resolveIntentIdempotencyWindowMs,
} from "./intent-fingerprint.js";

describe("computeIntentFingerprint", () => {
  it("is stable for equivalent exec deliverables", () => {
    const first = computeIntentFingerprint(
      {
        kind: "repo_operation",
        acceptedFormats: ["exec", "script"],
        preferredFormat: "exec",
        constraints: {
          target_repo: "C:\\Repo\\App",
          command_signature: " pnpm   dev ",
        },
      },
      ["needs_repo_execution", "needs_local_runtime"],
    );
    const second = computeIntentFingerprint(
      {
        kind: "repo_operation",
        acceptedFormats: ["script", "exec"],
        preferredFormat: "exec",
        constraints: {
          targetRepo: "c:/repo/app",
          commandSignature: "pnpm dev",
        },
      },
      ["needs_local_runtime", "needs_repo_execution"],
    );

    expect(first).toBe(second);
  });

  it("changes for different exec commands or repos", () => {
    const base = computeIntentFingerprint({
      kind: "repo_operation",
      acceptedFormats: ["exec"],
      preferredFormat: "exec",
      constraints: {
        target_repo: "/repo/a",
        command_signature: "pnpm dev",
      },
    });
    const differentCommand = computeIntentFingerprint({
      kind: "repo_operation",
      acceptedFormats: ["exec"],
      preferredFormat: "exec",
      constraints: {
        target_repo: "/repo/a",
        command_signature: "pnpm test",
      },
    });
    const differentRepo = computeIntentFingerprint({
      kind: "repo_operation",
      acceptedFormats: ["exec"],
      preferredFormat: "exec",
      constraints: {
        target_repo: "/repo/b",
        command_signature: "pnpm dev",
      },
    });

    expect(base).not.toBe(differentCommand);
    expect(base).not.toBe(differentRepo);
  });

  it("uses path and content hash for apply_patch deliverables", () => {
    const first = computeIntentFingerprint({
      kind: "code_change",
      acceptedFormats: ["patch"],
      preferredFormat: "patch",
      constraints: {
        path: "src/app.ts",
        content: "export const answer = 42;\n",
      },
    });
    const second = computeIntentFingerprint({
      kind: "code_change",
      acceptedFormats: ["edit"],
      preferredFormat: "patch",
      constraints: {
        filePath: "src\\app.ts",
        newContent: "export const answer = 42;\n",
      },
    });
    const differentPath = computeIntentFingerprint({
      kind: "code_change",
      acceptedFormats: ["patch"],
      preferredFormat: "patch",
      constraints: {
        path: "src/other.ts",
        content: "export const answer = 42;\n",
      },
    });
    const differentContent = computeIntentFingerprint({
      kind: "code_change",
      acceptedFormats: ["patch"],
      preferredFormat: "patch",
      constraints: {
        path: "src/app.ts",
        content: "export const answer = 43;\n",
      },
    });

    expect(first).toBe(second);
    expect(first).not.toBe(differentPath);
    expect(first).not.toBe(differentContent);
  });

  it("uses normalized prompt and size for images", () => {
    const first = computeIntentFingerprint({
      kind: "image",
      acceptedFormats: ["png"],
      preferredFormat: "png",
      constraints: {
        prompt: " Cute   banana cat ",
        size: "1024x1024",
      },
    });
    const second = computeIntentFingerprint({
      kind: "image",
      acceptedFormats: ["jpg", "png"],
      preferredFormat: "png",
      constraints: {
        promptNormalized: "cute banana cat",
        dimensions: "1024x1024",
      },
    });
    const differentPrompt = computeIntentFingerprint({
      kind: "image",
      acceptedFormats: ["png"],
      preferredFormat: "png",
      constraints: {
        prompt: "banana dog",
        size: "1024x1024",
      },
    });

    expect(first).toBe(second);
    expect(first).not.toBe(differentPrompt);
  });

  it("falls back to kind plus stable constraints JSON", () => {
    const first = computeIntentFingerprint({
      kind: "external_delivery",
      acceptedFormats: ["receipt"],
      preferredFormat: "receipt",
      constraints: {
        provider: "telegram_userbot",
        payload: {
          chatId: 1,
          text: "hello",
        },
      },
    });
    const second = computeIntentFingerprint({
      kind: "external_delivery",
      acceptedFormats: ["receipt"],
      preferredFormat: "receipt",
      constraints: {
        payload: {
          text: "hello",
          chatId: 1,
        },
        provider: "telegram_userbot",
      },
    });

    expect(first).toBe(second);
  });
});

describe("resolveIntentIdempotencyWindowMs", () => {
  it("uses default window when env is missing", () => {
    expect(resolveIntentIdempotencyWindowMs({})).toBe(INTENT_IDEMPOTENCY_WINDOW_MS_DEFAULT);
  });

  it("supports kill-switch zero", () => {
    expect(
      resolveIntentIdempotencyWindowMs({
        OPENCLAW_INTENT_IDEMPOTENCY_WINDOW_MS: "0",
      }),
    ).toBe(0);
  });

  it("ignores invalid env values", () => {
    expect(
      resolveIntentIdempotencyWindowMs({
        OPENCLAW_INTENT_IDEMPOTENCY_WINDOW_MS: "banana",
      }),
    ).toBe(INTENT_IDEMPOTENCY_WINDOW_MS_DEFAULT);
  });
});
