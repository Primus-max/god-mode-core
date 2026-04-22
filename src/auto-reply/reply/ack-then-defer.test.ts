import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACK_LOCALE_ENV,
  DEFAULT_ACK_LOCALE,
  hasExplicitAckThenDeferHint,
  resolveAckLocale,
  resolveAckMessage,
} from "./ack-then-defer.js";

describe("ack-then-defer locale + message resolution", () => {
  const saved = process.env[ACK_LOCALE_ENV];
  beforeEach(() => {
    delete process.env[ACK_LOCALE_ENV];
  });
  afterEach(() => {
    if (saved === undefined) {
      delete process.env[ACK_LOCALE_ENV];
    } else {
      process.env[ACK_LOCALE_ENV] = saved;
    }
  });

  it("defaults to Russian", () => {
    expect(resolveAckLocale()).toBe(DEFAULT_ACK_LOCALE);
  });

  it("respects OPENCLAW_ACK_LOCALE env variable", () => {
    expect(resolveAckLocale({ env: { [ACK_LOCALE_ENV]: "en" } })).toBe("en");
  });

  it("falls back to session locale when env is absent", () => {
    expect(resolveAckLocale({ sessionLocale: "en-US", env: {} })).toBe("en");
  });

  it("returns the Russian ack copy for ru", () => {
    const text = resolveAckMessage("ru");
    expect(text.length).toBeGreaterThan(0);
    expect(text.toLowerCase()).toContain("прин");
  });

  it("returns an English ack copy for en", () => {
    const text = resolveAckMessage("en");
    expect(text.toLowerCase()).toContain("on it");
  });

  it("ignores unknown locales and returns the default", () => {
    expect(resolveAckLocale({ env: { [ACK_LOCALE_ENV]: "zz" } })).toBe(DEFAULT_ACK_LOCALE);
  });

  it("detects explicit capability_install hint in prompt text", () => {
    expect(
      hasExplicitAckThenDeferHint({
        prompt: "Установи pdfkit через capability_install",
      }),
    ).toBe(true);
  });

  it("detects explicit capability_install hint in command body", () => {
    expect(
      hasExplicitAckThenDeferHint({
        commandBody:
          "Capability install contract: you must call capability_install with a packageRef.",
      }),
    ).toBe(true);
  });

  it("does not flag plain reasoning text without the structural token", () => {
    expect(
      hasExplicitAckThenDeferHint({
        prompt: "Что такое pdfkit и как он работает?",
      }),
    ).toBe(false);
  });
});
