import { describe, expect, it } from "vitest";
import { appendUsageLine } from "./agent-runner-usage-line.js";

describe("appendUsageLine", () => {
  it("appends to the last text payload when it has no media", () => {
    expect(appendUsageLine([{ text: "Hello" }], "Usage: 10 in / 5 out")).toEqual([
      { text: "Hello\nUsage: 10 in / 5 out" },
    ]);
  });

  it("merges the line into a caption when the last text payload carries media", () => {
    expect(
      appendUsageLine(
        [
          {
            text: "PDF ready",
            mediaUrl: "file:///tmp/report.pdf",
            mediaUrls: ["file:///tmp/report.pdf"],
          },
        ],
        "> [debug] · used `hydra/gpt-4o`",
      ),
    ).toEqual([
      {
        text: "PDF ready\n> [debug] · used `hydra/gpt-4o`",
        mediaUrl: "file:///tmp/report.pdf",
        mediaUrls: ["file:///tmp/report.pdf"],
      },
    ]);
  });

  it("attaches the line as the caption when replies are media-only", () => {
    expect(
      appendUsageLine([{ mediaUrl: "https://example.com/report.png" }], "Usage: 10 in / 5 out"),
    ).toEqual([{ mediaUrl: "https://example.com/report.png", text: "Usage: 10 in / 5 out" }]);
  });
});
