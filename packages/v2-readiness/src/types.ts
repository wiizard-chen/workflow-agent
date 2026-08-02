import type {
  ActorRef,
  BundleRef,
  DecisionRef,
  EpicId,
  EvidenceRef,
  InitiativeId,
  LaunchPermitId,
  PositiveOrdinal,
  ReasonRef,
  RepositoryId,
  Revision,
  RoleRunId,
} from "@pi-workflow/v2-domain";

export type Sha256Digest = string;
export type SourceRevision = string;

export type ReadinessSubject =
  | Readonly<{ kind: "initiative"; id: InitiativeId; revision: Revision }>
  | Readonly<{ kind: "epic"; id: EpicId; revision: Revision }>;

export type ReadinessApplicability = "applicable" | "not_applicable";

export type CreateReadinessCandidateBindingInput = Readonly<{
  subject: ReadinessSubject;
  bundle: Readonly<{ ref: BundleRef; manifestSha256: Sha256Digest }>;
  repository: Readonly<{ id: RepositoryId; baseRevision: SourceRevision }>;
  policy: Readonly<{ ref: EvidenceRef; profileRevision: SourceRevision }>;
  requirementSet: Readonly<{ ref: EvidenceRef; revision: SourceRevision }>;
  applicability: ReadinessApplicability;
}>;

export type ReadinessCandidateBinding =
  CreateReadinessCandidateBindingInput &
  Readonly<{ canonicalSha256: Sha256Digest }>;

export type EvidenceKind =
  | "semantic"
  | "quantitative"
  | "repository_feasibility"
  | "applicability_policy"
  | "quantitative_exception"
  | "authority";

export type EvidenceProducerKind =
  | "product_ai"
  | "engineering_lead"
  | "human_governor"
  | "deterministic_evaluator";

export type EvidenceProducer = Readonly<{
  kind: EvidenceProducerKind;
  actorRef: ActorRef;
  authorityEvidenceRef: EvidenceRef | null;
  selfReportedTrust: "untrusted" | "trusted" | "verified" | "human" | null;
}>;

export type SemanticEvidencePayload = Readonly<{
  kind: "semantic";
  finding: "pass" | "needs_refinement" | "must_decompose";
  requirementRefs: readonly EvidenceRef[];
}>;

export type QuantitativeEvidencePayload = Readonly<{
  kind: "quantitative";
  estimatedActiveMinutes: number;
  finding: "within_budget" | "minor_overrun" | "severe_overrun";
}>;

export type RepositoryFeasibilityEvidencePayload = Readonly<{
  kind: "repository_feasibility";
  finding: "feasible" | "blocked";
  repositoryId: RepositoryId;
  baseRevision: SourceRevision;
  roleRunId: RoleRunId;
  launchPermitId: LaunchPermitId;
}>;

export type ApplicabilityPolicyEvidencePayload = Readonly<{
  kind: "applicability_policy";
  subjectKind: "initiative";
  applicability: ReadinessApplicability;
  policyRef: EvidenceRef;
  profileRevision: SourceRevision;
}>;

export type QuantitativeExceptionEvidencePayload = Readonly<{
  kind: "quantitative_exception";
  quantitativeEvidenceRef: EvidenceRef;
  decisionRef: DecisionRef;
  authorityEvidenceRef: EvidenceRef;
  rationaleRef: ReasonRef;
}>;

export type AuthorityEvidencePayload = Readonly<{
  kind: "authority";
  authority: "human_portfolio_governor";
  decisionRef: DecisionRef;
  scope: "readiness_quantitative_exception";
}>;

export type GovernanceEvidencePayload =
  | SemanticEvidencePayload
  | QuantitativeEvidencePayload
  | RepositoryFeasibilityEvidencePayload
  | ApplicabilityPolicyEvidencePayload
  | QuantitativeExceptionEvidencePayload
  | AuthorityEvidencePayload;

export type CreateGovernanceEvidenceInput = Readonly<{
  evidenceRef: EvidenceRef;
  kind: EvidenceKind;
  candidateSha256: Sha256Digest;
  sourceRef: EvidenceRef;
  sourceRevision: SourceRevision;
  producer: EvidenceProducer;
  payload: GovernanceEvidencePayload;
}>;

export type GovernanceEvidence =
  CreateGovernanceEvidenceInput &
  Readonly<{ canonicalSha256: Sha256Digest }>;

export type ReadinessDisposition =
  | "ready"
  | "needs_refinement"
  | "must_decompose"
  | "blocked";

export type ReadinessReasonCode =
  | "not_applicable_by_policy"
  | "missing_applicability_policy"
  | "ambiguous_applicability_policy"
  | "applicability_policy_mismatch"
  | "missing_semantic_evidence"
  | "ambiguous_semantic_evidence"
  | "semantic_needs_refinement"
  | "semantic_must_decompose"
  | "missing_quantitative_evidence"
  | "ambiguous_quantitative_evidence"
  | "quantitative_minor_overrun"
  | "quantitative_severe_overrun"
  | "quantitative_finding_mismatch"
  | "missing_repository_feasibility"
  | "ambiguous_repository_feasibility"
  | "repository_feasibility_blocked"
  | "wrong_candidate_evidence"
  | "evidence_integrity_failure"
  | "evidence_provenance_failure"
  | "invalid_quantitative_exception"
  | "quantitative_exception_applied";

export type ReadinessEvidenceBinding = Readonly<{
  evidenceRef: EvidenceRef;
  kind: EvidenceKind;
  canonicalSha256: Sha256Digest;
}>;

export type ReadinessAssessment = Readonly<{
  assessmentRef: EvidenceRef;
  candidate: ReadinessCandidateBinding;
  applicability: ReadinessApplicability;
  disposition: ReadinessDisposition;
  evidence: readonly ReadinessEvidenceBinding[];
  evidenceSetSha256: Sha256Digest;
  reasonCodes: readonly ReadinessReasonCode[];
  sequence: PositiveOrdinal;
  previousAssessmentRef: EvidenceRef | null;
  previousAssessmentSha256: Sha256Digest | null;
  canonicalSha256: Sha256Digest;
}>;

export type AssessReadinessInput = Readonly<{
  assessmentRef: EvidenceRef;
  candidate: ReadinessCandidateBinding;
  evidence: readonly GovernanceEvidence[];
  history: readonly ReadinessAssessment[];
}>;

export type ReadinessFreshness = "current" | "stale";

export type ReadinessStaleReason =
  | "subject_revision_changed"
  | "bundle_changed"
  | "repository_base_changed"
  | "policy_changed"
  | "requirement_set_changed"
  | "evidence_invalidated"
  | "exception_invalidated"
  | "source_missing"
  | "assessment_head_changed";

export type ReadinessEvidenceCurrentState = Readonly<{
  evidenceRef: EvidenceRef;
  kind: EvidenceKind;
  state: "current" | "invalidated" | "missing";
  canonicalSha256: Sha256Digest | null;
}>;

export type ReadinessAssessmentHead = Readonly<{
  assessmentRef: EvidenceRef;
  canonicalSha256: Sha256Digest;
}>;

export type ReadinessCurrentContext = Readonly<{
  subject: ReadinessSubject;
  bundle: Readonly<{ ref: BundleRef; manifestSha256: Sha256Digest }>;
  repository: Readonly<{ id: RepositoryId; baseRevision: SourceRevision }>;
  policy: Readonly<{ ref: EvidenceRef; profileRevision: SourceRevision }>;
  requirementSet: Readonly<{ ref: EvidenceRef; revision: SourceRevision }>;
  evidence: readonly ReadinessEvidenceCurrentState[];
  assessmentHead: ReadinessAssessmentHead;
}>;

export type ReadinessFreshnessProjection = Readonly<{
  freshness: ReadinessFreshness;
  reasons: readonly ReadinessStaleReason[];
  assessmentRef: EvidenceRef;
  assessmentSha256: Sha256Digest;
}>;

export type ProjectReadinessFreshnessInput = Readonly<{
  assessment: ReadinessAssessment;
  current: ReadinessCurrentContext;
}>;

export type ReadinessConsumerPurpose =
  | "product_approval"
  | "scheduling_eligibility_input";

export type ReadinessRequirement =
  | "satisfied"
  | "not_required"
  | "unsatisfied";

export type ReadinessQualificationReason =
  | "projection_binding_mismatch"
  | "assessment_not_head"
  | "assessment_head_hash_mismatch"
  | "readiness_stale"
  | "disposition_blocked"
  | "disposition_needs_refinement"
  | "disposition_must_decompose"
  | "epic_cannot_be_not_applicable";

export type ReadinessQualification = Readonly<{
  qualified: boolean;
  purpose: ReadinessConsumerPurpose;
  requirement: ReadinessRequirement;
  assessmentRef: EvidenceRef;
  assessmentSha256: Sha256Digest;
  applicability: ReadinessApplicability;
  disposition: ReadinessDisposition;
  freshness: ReadinessFreshness;
  reasons: readonly ReadinessQualificationReason[];
}>;

export type QualifyReadinessForConsumptionInput = Readonly<{
  assessment: ReadinessAssessment;
  freshness: ReadinessFreshnessProjection;
  currentHead: ReadinessAssessmentHead;
  purpose: ReadinessConsumerPurpose;
}>;

export type ReadinessResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; rejection: ReadinessRejection }>;

export type ReadinessRejectionCode =
  | "invalid_input"
  | "invalid_binding"
  | "invalid_evidence"
  | "invalid_provenance"
  | "invalid_lineage"
  | "duplicate_assessment"
  | "invalid_freshness_context"
  | "qualification_mismatch";

export type ReadinessRejectionReason =
  | "plain_object"
  | "exact_fields"
  | "symbol_key"
  | "accessor"
  | "invalid_scalar"
  | "invalid_sha256"
  | "invalid_source_revision"
  | "invalid_enum"
  | "invalid_safe_integer"
  | "duplicate_entry"
  | "epic_not_applicable"
  | "payload_kind_mismatch"
  | "self_reference"
  | "producer_not_authorized"
  | "invalid_producer_authority"
  | "invalid_quantitative_finding"
  | "repository_binding_mismatch"
  | "policy_binding_mismatch"
  | "invalid_exception_binding"
  | "invalid_authority_binding"
  | "invalid_canonical_hash"
  | "history_subject_mismatch"
  | "history_sequence_gap"
  | "history_predecessor_mismatch"
  | "history_fork"
  | "candidate_reuse_forbidden"
  | "duplicate_assessment_fingerprint"
  | "context_evidence_mismatch"
  | "invalid_context_state"
  | "projection_assessment_mismatch"
  | "invalid_purpose";

export type ReadinessRejection = Readonly<{
  code: ReadinessRejectionCode;
  path: string;
  reason: ReadinessRejectionReason;
  relatedRef: string | null;
}>;
