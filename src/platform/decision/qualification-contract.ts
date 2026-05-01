import { z } from "zod";

export const OutcomeContractSchema = z.enum([
  "text_response",
  "structured_artifact",
  "workspace_change",
  "interactive_local_result",
  "external_operation",
]);
export type OutcomeContract = z.infer<typeof OutcomeContractSchema>;

export const RequestedEvidenceKindSchema = z.enum([
  "assistant_text",
  "tool_receipt",
  "artifact_descriptor",
  "process_receipt",
  "delivery_receipt",
  "capability_receipt",
]);
export type RequestedEvidenceKind = z.infer<typeof RequestedEvidenceKindSchema>;

export const QualificationConfidenceSchema = z.enum(["high", "medium", "low"]);
export type QualificationConfidence = z.infer<typeof QualificationConfidenceSchema>;

export const QualificationLowConfidenceStrategySchema = z.enum([
  "clarify",
  "safe_broad_family_execution",
  "bounded_attempt_with_strict_verification",
]);
export type QualificationLowConfidenceStrategy = z.infer<
  typeof QualificationLowConfidenceStrategySchema
>;

export const CandidateExecutionFamilySchema = z.enum([
  "general_assistant",
  "document_render",
  "media_generation",
  "code_build",
  "analysis_transform",
  "ops_execution",
]);
export type CandidateExecutionFamily = z.infer<typeof CandidateExecutionFamilySchema>;

export const QualificationExecutionContractSchema = z
  .object({
    requiresTools: z.boolean(),
    requiresWorkspaceMutation: z.boolean(),
    requiresLocalProcess: z.boolean(),
    requiresArtifactEvidence: z.boolean(),
    requiresDeliveryEvidence: z.boolean(),
    mayNeedBootstrap: z.boolean(),
  })
  .strict();
export type QualificationExecutionContract = z.infer<typeof QualificationExecutionContractSchema>;

export const QualificationResultSchema = z
  .object({
    outcomeContract: OutcomeContractSchema,
    executionContract: QualificationExecutionContractSchema,
    requestedEvidence: z.array(RequestedEvidenceKindSchema),
    confidence: QualificationConfidenceSchema,
    ambiguityReasons: z.array(z.string().min(1)),
    candidateFamilies: z.array(CandidateExecutionFamilySchema),
    lowConfidenceStrategy: QualificationLowConfidenceStrategySchema.optional(),
  })
  .strict();
export type QualificationResult = z.infer<typeof QualificationResultSchema>;
