import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const AgentsListToolSchema = Type.Object({});

type AgentListEntry = {
  id: string;
  name?: string;
  configured: boolean;
};

export function createAgentsListTool(opts?: {
  agentSessionKey?: string;
  /** Explicit agent ID override for cron/hook sessions. */
  requesterAgentIdOverride?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Agents",
    name: "agents_list",
    description:
      'List OpenClaw agent ids you can target with `sessions_spawn` when `runtime="subagent"` (based on subagent allowlists).',
    parameters: AgentsListToolSchema,
    execute: async () => {
      const cfg = opts?.config ?? loadConfig();
      const requesterAgentId =
        opts?.requesterAgentIdOverride?.trim() ||
        resolveSessionAgentId({
          config: cfg,
          sessionKey: opts?.agentSessionKey,
        });
      const configuredAgents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
      const normalizedRequesterId = normalizeAgentId(requesterAgentId);
      const requesterEntry = configuredAgents.find(
        (entry) => normalizeAgentId(entry?.id) === normalizedRequesterId,
      );
      const allowAgents = requesterEntry?.subagents?.allowAgents ?? [];
      const allowAny = allowAgents.some((value) => value.trim() === "*");
      const allowSet = new Set(
        allowAgents
          .map((value) => value.trim())
          .filter((value) => value && value !== "*"),
      );

      const configuredIds = configuredAgents
        .map((entry) => normalizeAgentId(entry?.id))
        .filter(Boolean);
      const configuredNameMap = new Map<string, string>();
      for (const entry of configuredAgents) {
        const id = normalizeAgentId(entry?.id);
        if (!id) {
          continue;
        }
        const name = entry?.name?.trim() ?? "";
        if (!name) {
          configuredNameMap.set(id, id);
          continue;
        }
        configuredNameMap.set(id, name);
      }

      const allowed = new Set<string>();
      allowed.add(requesterAgentId);
      if (allowAny) {
        for (const id of configuredIds) {
          allowed.add(id);
        }
      } else {
        for (const id of allowSet) {
          allowed.add(id);
        }
      }

      const all = Array.from(allowed);
      const rest = all
        .filter((id) => id !== requesterAgentId)
        .toSorted((a, b) => a.localeCompare(b));
      const ordered = [requesterAgentId, ...rest];
      const agents: AgentListEntry[] = ordered.map((id) => ({
        id,
        name: configuredNameMap.get(id),
        configured: configuredIds.includes(id),
      }));

      return jsonResult({
        requester: requesterAgentId,
        allowAny,
        configuredIds,
        allowAgents,
        agents,
      });
    },
  };
}
