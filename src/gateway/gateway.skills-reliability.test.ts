import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAllBootstrapSnapshots } from "../agents/bootstrap-cache.js";
import { writeSkill } from "../agents/skills.e2e-test-helpers.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import { resetAgentRunContextForTest } from "../infra/agent-events.js";
import { resetPlatformArtifactService } from "../platform/artifacts/index.js";
import { clearGatewaySubagentRuntime } from "../plugins/runtime/index.js";
import {
  runSkillEval,
  runSkillEvalTurns,
  skillEvalAssistantText,
} from "./skill-reliability-eval.harness.js";
import { createOpenAiScenarioResolver } from "./test-helpers.openai-mock.js";

/** Multi-step skill scenarios can exceed the default gateway e2e budget on cold CI workers. */
const GATEWAY_SKILL_EVAL_TIMEOUT_MS = 180_000;

describe.sequential("gateway skill reliability evals", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
    resetAgentRunContextForTest();
    clearAllBootstrapSnapshots();
    clearGatewaySubagentRuntime();
    resetPlatformArtifactService();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
    resetAgentRunContextForTest();
    clearAllBootstrapSnapshots();
    clearGatewaySubagentRuntime();
    resetPlatformArtifactService();
  });

  it(
    "uses the relevant skill and avoids the irrelevant one",
    { timeout: GATEWAY_SKILL_EVAL_TIMEOUT_MS },
    async () => {
      const result = await runSkillEval({
        timeoutMs: GATEWAY_SKILL_EVAL_TIMEOUT_MS,
        message: "Use the right skill to summarize the release checklist.",
        setupWorkspace: async (workspaceDir) => {
          const releaseSkillDir = path.join(workspaceDir, "skills", "release-checklist");
          const releaseChecklistPath = path.join(workspaceDir, "notes", "release-checklist.txt");
          const irrelevantSkillDir = path.join(workspaceDir, "skills", "garden-journal");
          await fs.mkdir(path.dirname(releaseChecklistPath), { recursive: true });
          await fs.writeFile(
            releaseChecklistPath,
            "RELEASE_MARKER=alpha\n- run checks\n- publish notes\n",
            "utf8",
          );
          await writeSkill({
            dir: releaseSkillDir,
            name: "release-checklist",
            description: "Summarize release checklists and release-readiness notes.",
            body: `# Release Checklist\nRead "${releaseChecklistPath}" and summarize it.\n`,
          });
          await writeSkill({
            dir: irrelevantSkillDir,
            name: "garden-journal",
            description: "Track plants, watering, and seasonal garden notes.",
            body: "# Garden Journal\n",
          });
          const releaseSkillPath = path.join(releaseSkillDir, "SKILL.md");
          return { releaseSkillPath, releaseChecklistPath };
        },
        resolveResponse: (req, ctx) => {
          const i = req.requestIndex;
          if (i === 0) {
            expect(req.instructions).toContain("<available_skills>");
            expect(req.instructions).toContain("release-checklist");
            expect(req.instructions).toContain("garden-journal");
            return {
              type: "tool_call",
              name: "read",
              args: { path: ctx.releaseSkillPath },
            };
          }
          if (i === 1) {
            expect(req.toolOutput).toContain(ctx.releaseChecklistPath);
            expect(req.toolOutput).not.toContain("Garden Journal");
            return {
              type: "tool_call",
              name: "read",
              args: { path: ctx.releaseChecklistPath },
            };
          }
          if (i === 2) {
            expect(req.toolOutput).toContain("RELEASE_MARKER=alpha");
            return { type: "message", text: "release skill ok" };
          }
          return { type: "message", text: "release skill ok" };
        },
      });

      expect(result.finalPayload.status).toBe("ok");
      expect(skillEvalAssistantText(result.finalPayload)).toContain("release skill ok");
      expect(result.requests.length).toBeGreaterThanOrEqual(3);
    },
  );

  it(
    "avoids skill use when the request is unrelated",
    { timeout: GATEWAY_SKILL_EVAL_TIMEOUT_MS },
    async () => {
      const result = await runSkillEval({
        timeoutMs: GATEWAY_SKILL_EVAL_TIMEOUT_MS,
        message: "What is 2 + 2?",
        setupWorkspace: async (workspaceDir) => {
          const skillDir = path.join(workspaceDir, "skills", "garden-journal");
          await writeSkill({
            dir: skillDir,
            name: "garden-journal",
            description: "Track plants, watering, and seasonal garden notes.",
            body: "# Garden Journal\n",
          });
          return {};
        },
        resolveResponse: (req) => {
          if (req.requestIndex === 0) {
            expect(req.instructions).toContain("garden-journal");
            expect(req.lastUserText).toContain("2 + 2");
            expect(req.toolOutputs).toHaveLength(0);
          }
          return { type: "message", text: "4" };
        },
      });

      expect(result.finalPayload.status).toBe("ok");
      expect(skillEvalAssistantText(result.finalPayload)).toBe("4");
      expect(result.requests.length).toBeGreaterThanOrEqual(1);
    },
  );

  it(
    "reads SKILL.md before following the required workflow steps",
    { timeout: GATEWAY_SKILL_EVAL_TIMEOUT_MS },
    async () => {
      const result = await runSkillEval({
        timeoutMs: GATEWAY_SKILL_EVAL_TIMEOUT_MS,
        message: "Follow the compliance skill exactly.",
        setupWorkspace: async (workspaceDir) => {
          const skillDir = path.join(workspaceDir, "skills", "compliance-workflow");
          const firstPath = path.join(workspaceDir, "notes", "step-1.txt");
          const secondPath = path.join(workspaceDir, "notes", "step-2.txt");
          await fs.mkdir(path.dirname(firstPath), { recursive: true });
          await fs.writeFile(firstPath, `STEP_ONE_OK next="${secondPath}"\n`, "utf8");
          await fs.writeFile(secondPath, "STEP_TWO_OK final=workflow-pass\n", "utf8");
          await writeSkill({
            dir: skillDir,
            name: "compliance-workflow",
            description: "Follow the compliance notes in order.",
            body: `# Compliance Workflow\nFirst read "${firstPath}". Then read the path written there and report the final marker.\n`,
          });
          const skillPath = path.join(skillDir, "SKILL.md");
          const resolveScenario = createOpenAiScenarioResolver([
            () => ({
              type: "tool_call",
              name: "read",
              args: { path: skillPath },
            }),
            (req) => {
              expect(req.toolOutput).toContain(firstPath);
              return {
                type: "tool_call",
                name: "read",
                args: { path: firstPath },
              };
            },
            (req) => {
              expect(req.toolOutput).toContain(`next="${secondPath}"`);
              return {
                type: "tool_call",
                name: "read",
                args: { path: secondPath },
              };
            },
            (req) => {
              expect(req.toolOutput).toContain("final=workflow-pass");
              return { type: "message", text: "workflow-pass" };
            },
          ]);
          return { resolveScenario };
        },
        resolveResponse: (request, context) => context.resolveScenario(request),
      });

      expect(result.finalPayload.status).toBe("ok");
      expect(skillEvalAssistantText(result.finalPayload)).toContain("workflow-pass");
      expect(result.requests).toHaveLength(4);
      expect(result.requests[1]?.toolOutput).toContain("Compliance Workflow");
      expect(result.requests[2]?.toolOutput).toContain("STEP_ONE_OK");
    },
  );

  it(
    "enforces a mandatory read path argument after the skill body is loaded",
    { timeout: GATEWAY_SKILL_EVAL_TIMEOUT_MS },
    async () => {
      const result = await runSkillEval({
        timeoutMs: GATEWAY_SKILL_EVAL_TIMEOUT_MS,
        message: "Run the seal-file skill.",
        setupWorkspace: async (workspaceDir) => {
          const skillDir = path.join(workspaceDir, "skills", "seal-file");
          const mandatoryPath = path.join(workspaceDir, "notes", "seal.txt");
          await fs.mkdir(path.dirname(mandatoryPath), { recursive: true });
          await fs.writeFile(mandatoryPath, "SEAL_OK=signed\n", "utf8");
          await writeSkill({
            dir: skillDir,
            name: "seal-file",
            description: "Read the sealed release marker file.",
            body: `# Seal File\nYou MUST read exactly this path (no substitutes): ${mandatoryPath}\n`,
          });
          const skillPath = path.join(skillDir, "SKILL.md");
          const resolveScenario = createOpenAiScenarioResolver([
            () => ({
              type: "tool_call",
              name: "read",
              args: { path: skillPath },
            }),
            (req) => {
              expect(req.toolOutput).toContain(mandatoryPath);
              expect((req.toolOutputs.at(-1) ?? "").length).toBeGreaterThan(0);
              return {
                type: "tool_call",
                name: "read",
                args: { path: mandatoryPath },
              };
            },
            (req) => {
              expect(req.toolOutput).toContain("SEAL_OK=signed");
              return { type: "message", text: "seal verified" };
            },
          ]);
          return { resolveScenario };
        },
        resolveResponse: (request, context) => context.resolveScenario(request),
      });

      expect(skillEvalAssistantText(result.finalPayload)).toContain("seal verified");
      expect(result.requests).toHaveLength(3);
    },
  );

  it(
    "carries session user text into later provider requests (multi-turn)",
    { timeout: GATEWAY_SKILL_EVAL_TIMEOUT_MS },
    async () => {
      const result = await runSkillEvalTurns({
        timeoutMs: GATEWAY_SKILL_EVAL_TIMEOUT_MS,
        turns: [
          "Session setup: the codeword is WALRUS-77. Reply OK.",
          "What codeword did I give you? Reply with the codeword only.",
        ],
        setupWorkspace: async () => ({}),
        resolveResponse: (request) => {
          if (request.lastUserText.includes("Session setup")) {
            expect(request.toolOutputs).toHaveLength(0);
            return { type: "message", text: "OK" };
          }
          if (request.lastUserText.includes("What codeword")) {
            expect(request.allInputText).toContain("WALRUS-77");
            return { type: "message", text: "WALRUS-77" };
          }
          throw new Error(`unexpected skill-eval request: ${request.lastUserText}`);
        },
      });

      expect(result.finalPayloads).toHaveLength(2);
      expect(skillEvalAssistantText(result.finalPayloads[0]!)).toContain("OK");
      expect(skillEvalAssistantText(result.finalPayloads[1]!)).toContain("WALRUS-77");
      expect(result.requests).toHaveLength(2);
    },
  );
});
