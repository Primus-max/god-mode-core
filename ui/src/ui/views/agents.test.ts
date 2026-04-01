/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { buildCanonicalAgentsHref } from "../app-settings.ts";
import { renderAgents, type AgentsProps } from "./agents.ts";

function createSkill() {
  return {
    name: "Repo Skill",
    description: "Skill description",
    source: "workspace",
    filePath: "/tmp/skill",
    baseDir: "/tmp",
    skillKey: "repo-skill",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: {
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    missing: {
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    configChecks: [],
    install: [],
  };
}

function createProps(overrides: Partial<AgentsProps> = {}): AgentsProps {
  return {
    basePath: "",
    loading: false,
    error: null,
    agentsList: {
      defaultId: "alpha",
      mainKey: "main",
      scope: "workspace",
      agents: [{ id: "alpha", name: "Alpha" } as never, { id: "beta", name: "Beta" } as never],
    },
    selectedAgentId: "beta",
    activePanel: "overview",
    buildPanelHref: (panel) =>
      buildCanonicalAgentsHref(
        {
          basePath: "/ui",
          sessionKey: "main",
          agentsSelectedId: "beta",
          agentsPanel: "overview",
          agentFileActive: null,
          skillsFilter: "",
        } as Parameters<typeof buildCanonicalAgentsHref>[0],
        { panel },
      ),
    buildFileHref: (file) =>
      buildCanonicalAgentsHref(
        {
          basePath: "/ui",
          sessionKey: "main",
          agentsSelectedId: "beta",
          agentsPanel: "files",
          agentFileActive: null,
          skillsFilter: "",
        } as Parameters<typeof buildCanonicalAgentsHref>[0],
        { panel: "files", file },
      ),
    config: {
      form: null,
      loading: false,
      saving: false,
      dirty: false,
    },
    channels: {
      snapshot: null,
      loading: false,
      error: null,
      lastSuccess: null,
    },
    cron: {
      status: null,
      jobs: [],
      loading: false,
      error: null,
    },
    agentFiles: {
      list: null,
      loading: false,
      error: null,
      active: null,
      contents: {},
      drafts: {},
      saving: false,
    },
    agentIdentityLoading: false,
    agentIdentityError: null,
    agentIdentityById: {},
    agentSkills: {
      report: null,
      loading: false,
      error: null,
      agentId: null,
      filter: "",
    },
    toolsCatalog: {
      loading: false,
      error: null,
      result: null,
    },
    onRefresh: () => undefined,
    onSelectAgent: () => undefined,
    onSelectPanel: () => undefined,
    onLoadFiles: () => undefined,
    onSelectFile: () => undefined,
    onFileDraftChange: () => undefined,
    onFileReset: () => undefined,
    onFileSave: () => undefined,
    onToolsProfileChange: () => undefined,
    onToolsOverridesChange: () => undefined,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    onModelChange: () => undefined,
    onModelFallbacksChange: () => undefined,
    onChannelsRefresh: () => undefined,
    onCronRefresh: () => undefined,
    onCronRunNow: () => undefined,
    onSkillsFilterChange: () => undefined,
    onSkillsRefresh: () => undefined,
    onAgentSkillToggle: () => undefined,
    onAgentSkillsClear: () => undefined,
    onAgentSkillsDisableAll: () => undefined,
    onSetDefault: () => undefined,
    ...overrides,
  };
}

describe("renderAgents", () => {
  it("shows the skills count only for the selected agent's report", async () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        createProps({
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [createSkill()],
            },
            loading: false,
            error: null,
            agentId: "alpha",
            filter: "",
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const skillsTab = Array.from(container.querySelectorAll<HTMLAnchorElement>(".agent-tab")).find(
      (link) => link.textContent?.includes("Skills"),
    );

    expect(skillsTab?.textContent?.trim()).toBe("Skills");
  });

  it("shows the selected agent's skills count when the report matches", async () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        createProps({
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [createSkill()],
            },
            loading: false,
            error: null,
            agentId: "beta",
            filter: "",
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const skillsTab = Array.from(container.querySelectorAll<HTMLAnchorElement>(".agent-tab")).find(
      (link) => link.textContent?.includes("Skills"),
    );

    expect(skillsTab?.textContent?.trim()).toContain("1");
  });

  it("renders localized Skills tab label in Russian", async () => {
    const container = document.createElement("div");
    await i18n.setLocale("ru");

    render(
      renderAgents(
        createProps({
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [createSkill()],
            },
            loading: false,
            error: null,
            agentId: "beta",
            filter: "",
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const skillsTab = Array.from(container.querySelectorAll<HTMLAnchorElement>(".agent-tab")).find(
      (link) => link.textContent?.includes("Навыки"),
    );
    expect(skillsTab).toBeTruthy();

    await i18n.setLocale("en");
  });

  it("renders canonical hrefs for representative panel tabs and file rows", async () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        createProps({
          activePanel: "files",
          buildPanelHref: (panel) =>
            buildCanonicalAgentsHref(
              {
                basePath: "/ui",
                sessionKey: "main",
                agentsSelectedId: "beta",
                agentsPanel: "files",
                agentFileActive: "README.md",
                skillsFilter: "missing",
              } as Parameters<typeof buildCanonicalAgentsHref>[0],
              { panel },
            ),
          buildFileHref: (file) =>
            buildCanonicalAgentsHref(
              {
                basePath: "/ui",
                sessionKey: "main",
                agentsSelectedId: "beta",
                agentsPanel: "files",
                agentFileActive: "README.md",
                skillsFilter: "missing",
              } as Parameters<typeof buildCanonicalAgentsHref>[0],
              { panel: "files", file },
            ),
          agentFiles: {
            list: {
              agentId: "beta",
              workspace: "/tmp/agents/beta",
              files: [
                {
                  name: "AGENTS.md",
                  path: "/tmp/agents/beta/AGENTS.md",
                  size: 128,
                  updatedAtMs: Date.now(),
                  missing: false,
                } as never,
              ],
            },
            loading: false,
            error: null,
            active: "README.md",
            contents: {},
            drafts: {},
            saving: false,
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const skillsTab = Array.from(container.querySelectorAll<HTMLAnchorElement>(".agent-tab")).find(
      (link) => link.textContent?.includes("Skills"),
    );
    const fileRow = container.querySelector<HTMLAnchorElement>(".agent-file-row");

    expect(skillsTab?.getAttribute("href")).toBe(
      "/ui/agents?session=main&agent=beta&agentsPanel=skills&skillFilter=missing",
    );
    expect(fileRow?.getAttribute("href")).toBe(
      "/ui/agents?session=main&agent=beta&agentsPanel=files&agentFile=AGENTS.md",
    );
  });

  it("uses JS handoff for primary clicks on agent panel tabs", async () => {
    const container = document.createElement("div");
    const onSelectPanel = vi.fn();
    render(
      renderAgents(
        createProps({
          activePanel: "overview",
          onSelectPanel,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const filesTab = Array.from(container.querySelectorAll<HTMLAnchorElement>(".agent-tab")).find(
      (link) => link.textContent?.includes("Files"),
    );
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    filesTab?.dispatchEvent(click);

    expect(onSelectPanel).toHaveBeenCalledWith("files");
    expect(click.defaultPrevented).toBe(true);
  });

  it("uses JS handoff for primary clicks on agent file rows", async () => {
    const container = document.createElement("div");
    const onSelectFile = vi.fn();
    render(
      renderAgents(
        createProps({
          activePanel: "files",
          onSelectFile,
          agentFiles: {
            list: {
              agentId: "beta",
              workspace: "/tmp/agents/beta",
              files: [
                {
                  name: "AGENTS.md",
                  path: "/tmp/agents/beta/AGENTS.md",
                  size: 128,
                  updatedAtMs: Date.now(),
                  missing: false,
                } as never,
              ],
            },
            loading: false,
            error: null,
            active: null,
            contents: {},
            drafts: {},
            saving: false,
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const fileRow = container.querySelector<HTMLAnchorElement>(".agent-file-row");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    fileRow?.dispatchEvent(click);

    expect(onSelectFile).toHaveBeenCalledWith("AGENTS.md");
    expect(click.defaultPrevented).toBe(true);
  });

  it("lets modified clicks fall through to the browser href for agent links", async () => {
    const container = document.createElement("div");
    const onSelectPanel = vi.fn();
    const onSelectFile = vi.fn();
    render(
      renderAgents(
        createProps({
          activePanel: "files",
          onSelectPanel,
          onSelectFile,
          agentFiles: {
            list: {
              agentId: "beta",
              workspace: "/tmp/agents/beta",
              files: [
                {
                  name: "AGENTS.md",
                  path: "/tmp/agents/beta/AGENTS.md",
                  size: 128,
                  updatedAtMs: Date.now(),
                  missing: false,
                } as never,
              ],
            },
            loading: false,
            error: null,
            active: null,
            contents: {},
            drafts: {},
            saving: false,
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const skillsTab = Array.from(container.querySelectorAll<HTMLAnchorElement>(".agent-tab")).find(
      (link) => link.textContent?.includes("Skills"),
    );
    const fileRow = container.querySelector<HTMLAnchorElement>(".agent-file-row");
    const tabClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    const fileClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    skillsTab?.dispatchEvent(tabClick);
    fileRow?.dispatchEvent(fileClick);

    expect(onSelectPanel).not.toHaveBeenCalled();
    expect(onSelectFile).not.toHaveBeenCalled();
    expect(tabClick.defaultPrevented).toBe(false);
    expect(fileClick.defaultPrevented).toBe(false);
  });

  it("renders the restored active file in the files panel", async () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        createProps({
          activePanel: "files",
          agentFiles: {
            list: {
              agentId: "beta",
              workspace: "/tmp/agents/beta",
              files: [
                {
                  name: "AGENTS.md",
                  path: "/tmp/agents/beta/AGENTS.md",
                  size: 128,
                  updatedAtMs: Date.now(),
                  missing: false,
                } as never,
              ],
            },
            loading: false,
            error: null,
            active: "AGENTS.md",
            contents: { "AGENTS.md": "# Agent" },
            drafts: { "AGENTS.md": "# Agent" },
            saving: false,
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const activeRow = container.querySelector(".agent-file-row.active");
    const title = container.querySelector(".agent-file-title");

    expect(activeRow?.textContent).toContain("AGENTS.md");
    expect(title?.textContent).toContain("AGENTS.md");
  });
});
