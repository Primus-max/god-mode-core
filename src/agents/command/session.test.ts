import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store.js";
import { resolveSession } from "./session.js";

const tempDirs: string[] = [];

afterEach(async () => {
  clearSessionStoreCacheForTest();
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("resolveSession", () => {
  it("does not reuse a stale session entry when an explicit new session id is requested", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-command-session-"));
    tempDirs.push(tempDir);
    const storePath = path.join(tempDir, "sessions.json");
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "existing-session",
            updatedAt: Date.now(),
            channel: "telegram",
            lastChannel: "telegram",
            thinkingLevel: "high",
            verboseLevel: "full",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const resolved = resolveSession({
      cfg: {
        session: {
          scope: "per-sender",
          store: storePath,
        },
      } as OpenClawConfig,
      to: "+6533456892",
      sessionId: "fresh-session",
    });

    expect(resolved.sessionId).toBe("fresh-session");
    expect(resolved.sessionKey).toBe("agent:main:main");
    expect(resolved.sessionEntry).toBeUndefined();
    expect(resolved.persistedThinking).toBeUndefined();
    expect(resolved.persistedVerbose).toBeUndefined();
    expect(resolved.isNewSession).toBe(true);
  });
});
