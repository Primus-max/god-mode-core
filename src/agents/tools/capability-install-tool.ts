import { Type } from "@sinclair/typebox";
import {
  ensureCapability,
  getApprovedCapabilityCatalogEntry,
} from "../../platform/bootstrap/index.js";
import { type AnyAgentTool, readStringParam } from "./common.js";

const CapabilityInstallSchema = Type.Object({
  capabilityId: Type.Optional(
    Type.String({
      description:
        "Approved capability id (e.g. pdf-renderer, docx-writer, xlsx-writer, site-packager).",
    }),
  ),
  manager: Type.Optional(
    Type.String({
      description: "Package manager: npm | pip | brew. From deliverable.constraints.manager.",
    }),
  ),
  name: Type.Optional(
    Type.String({ description: "Package name when installing user-requested dependencies." }),
  ),
  version: Type.Optional(
    Type.String({ description: "Optional version / tag from deliverable.constraints.version." }),
  ),
  reason: Type.Optional(
    Type.String({ description: "Free-form explanation surfaced to the user." }),
  ),
});

export function createCapabilityInstallTool(): AnyAgentTool {
  return {
    label: "Capability Install",
    name: "capability_install",
    description:
      "Install or verify a platform capability (pdf-renderer, docx-writer, xlsx-writer, site-packager, …). Use when the deliverable is `capability_install` or when a producer tool explicitly asks for a capability.",
    parameters: CapabilityInstallSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const capabilityId = readStringParam(params, "capabilityId");
      const manager = readStringParam(params, "manager");
      const name = readStringParam(params, "name");
      const reason = readStringParam(params, "reason");
      if (!capabilityId && (!manager || !name)) {
        return {
          content: [
            {
              type: "text",
              text: "capability_install requires either `capabilityId` or both `manager` and `name`.",
            },
          ],
          details: { error: "missing_target" },
        };
      }
      if (!capabilityId) {
        return {
          content: [
            {
              type: "text",
              text: `Ad-hoc ${manager} package install ("${name}") is not yet approved by the platform catalog. Please add a catalog entry first.`,
            },
          ],
          details: {
            error: "ad_hoc_install_not_supported",
            manager,
            name,
            reason: reason ?? null,
          },
        };
      }
      const entry = getApprovedCapabilityCatalogEntry(capabilityId);
      if (!entry) {
        return {
          content: [
            {
              type: "text",
              text: `Capability "${capabilityId}" is not in the approved catalog. Allowed: pdf-renderer, pdf-parser, ocr-engine, table-parser, docx-writer, xlsx-writer, site-packager.`,
            },
          ],
          details: { error: "unknown_capability", capabilityId },
        };
      }
      const ensured = await ensureCapability({ capabilityId });
      if (!ensured.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to install capability "${capabilityId}": ${ensured.reason}`,
            },
          ],
          details: { error: "install_failed", capabilityId, reason: ensured.reason },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: ensured.alreadyInstalled
              ? `Capability "${capabilityId}" was already installed (${entry.capability.label}).`
              : `Capability "${capabilityId}" installed (${entry.capability.label}).`,
          },
        ],
        details: {
          artifact: {
            kind: "capability_install",
            format: entry.install?.method === "node" ? "npm-package" : "platform-capability",
            mimeType: "application/x-capability-install",
            metadata: {
              capabilityId,
              alreadyInstalled: ensured.alreadyInstalled,
            },
          },
        },
      };
    },
  };
}
