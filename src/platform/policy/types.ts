import type { EffectiveProfilePreference } from "../profile/overlay.js";
import type { ArtifactKind, Profile, ProfileId, RiskLevel } from "../schemas/index.js";

export type PolicyIntent = "general" | "document" | "code" | "publish";
export type PolicyAutonomy = "chat" | "assist" | "guarded";

export type PolicyContext = {
  activeProfileId: ProfileId;
  activeProfile: Profile;
  activeStateTaskOverlay?: string;
  effective: EffectiveProfilePreference;
  intent?: PolicyIntent;
  artifactKinds?: ArtifactKind[];
  publishTargets?: string[];
  requestedCapabilities?: string[];
  requestedToolNames?: string[];
  integrations?: string[];
  touchesSensitiveData?: boolean;
  explicitApproval?: boolean;
  requestedRiskLevel?: RiskLevel;
  requestedMachineControl?: boolean;
  machineControlDeviceId?: string;
  machineControlLinked?: boolean;
  machineControlKillSwitchEnabled?: boolean;
};

export type PolicyDecision = {
  profileId: ProfileId;
  taskOverlay?: string;
  allowExternalModel: boolean;
  allowArtifactPersistence: boolean;
  allowPublish: boolean;
  allowCapabilityBootstrap: boolean;
  allowPrivilegedTools: boolean;
  allowMachineControl: boolean;
  requireExplicitApproval: boolean;
  autonomy: PolicyAutonomy;
  reasons: string[];
  deniedReasons: string[];
};

export type PolicyRule = {
  id: string;
  evaluate: (context: PolicyContext, decision: PolicyDecision) => PolicyDecision;
};
