import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SkillSnapshot } from "../skills.js";

const hoisted = vi.hoisted(() => ({
  loadWorkspaceSkillEntries: vi.fn(
    (_workspaceDir: string, _options?: { config?: OpenClawConfig }) => [],
  ),
}));

vi.mock("../skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skills.js")>();
  return {
    ...actual,
    loadWorkspaceSkillEntries: (workspaceDir: string, options?: { config?: OpenClawConfig }) =>
      hoisted.loadWorkspaceSkillEntries(workspaceDir, options),
  };
});

// `test/setup.ts` transitively pre-loads `skills-runtime.js`'s dependency
// chain via `../skills.js` BEFORE this file's `vi.mock` factory registers.
// Without `vi.resetModules()` the SUT keeps the real `loadWorkspaceSkillEntries`
// binding and `hoisted.loadWorkspaceSkillEntries` is never invoked
// (assertion sees `Number of calls: 0`). Same root cause as PR #303 / #304 /
// #305 / #308.
let resolveEmbeddedRunSkillEntries: (typeof import("./skills-runtime.js"))[
  "resolveEmbeddedRunSkillEntries"
];

beforeAll(async () => {
  vi.resetModules();
  const skillsRuntime = await import("./skills-runtime.js");
  resolveEmbeddedRunSkillEntries = skillsRuntime.resolveEmbeddedRunSkillEntries;
});

describe("resolveEmbeddedRunSkillEntries", () => {
  beforeEach(() => {
    hoisted.loadWorkspaceSkillEntries.mockReset();
    hoisted.loadWorkspaceSkillEntries.mockReturnValue([]);
  });

  it("loads skill entries with config when no resolved snapshot skills exist", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          diffs: { enabled: true },
        },
      },
    };

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config,
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [],
      },
    });

    expect(result.shouldLoadSkillEntries).toBe(true);
    expect(hoisted.loadWorkspaceSkillEntries).toHaveBeenCalledTimes(1);
    expect(hoisted.loadWorkspaceSkillEntries).toHaveBeenCalledWith("/tmp/workspace", { config });
  });

  it("skips skill entry loading when resolved snapshot skills are present", () => {
    const snapshot: SkillSnapshot = {
      prompt: "skills prompt",
      skills: [{ name: "diffs" }],
      resolvedSkills: [],
    };

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: {},
      skillsSnapshot: snapshot,
    });

    expect(result).toEqual({
      shouldLoadSkillEntries: false,
      skillEntries: [],
    });
    expect(hoisted.loadWorkspaceSkillEntries).not.toHaveBeenCalled();
  });
});
