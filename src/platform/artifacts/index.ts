export {
  ArtifactRecordDetailSchema,
  ArtifactRecordSummarySchema,
  ArtifactServiceAccessSchema,
  PersistedArtifactRecordSchema,
  type ArtifactRecordDetail,
  type ArtifactRecordSummary,
  type ArtifactServiceAccess,
  type PersistedArtifactRecord,
} from "./contracts.js";

export {
  ARTIFACT_METADATA_FILENAME,
  ARTIFACTS_DIRNAME,
  PLATFORM_ARTIFACTS_DIRNAME,
  buildArtifactDirectoryName,
  resolveArtifactDirectory,
  resolveArtifactMetadataPath,
  resolvePlatformArtifactsRoot,
} from "./paths.js";

export {
  createArtifactService,
  getPlatformArtifactService,
  resetPlatformArtifactService,
  type ArtifactService,
} from "./service.js";

export {
  PLATFORM_ARTIFACTS_CONTENT_PREFIX,
  PLATFORM_ARTIFACTS_PREVIEW_PREFIX,
  PLATFORM_ARTIFACTS_ROUTE_PREFIX,
  createArtifactHttpHandler,
} from "./http.js";

export {
  createArtifactGetGatewayMethod,
  createArtifactListGatewayMethod,
  createArtifactTransitionGatewayMethod,
} from "./gateway.js";
