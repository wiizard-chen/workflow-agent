import {
  assessReadiness,
  createGovernanceEvidence,
  createReadinessCandidateBinding,
  projectReadinessFreshness,
  qualifyReadinessForConsumption,
  type ApplicabilityPolicyEvidencePayload,
  type AssessReadinessInput,
  type AuthorityEvidencePayload,
  type CreateGovernanceEvidenceInput,
  type CreateReadinessCandidateBindingInput,
  type EvidenceKind,
  type EvidenceProducer,
  type EvidenceProducerKind,
  type GovernanceEvidence,
  type GovernanceEvidencePayload,
  type ProjectReadinessFreshnessInput,
  type QualifyReadinessForConsumptionInput,
  type QuantitativeEvidencePayload,
  type QuantitativeExceptionEvidencePayload,
  type ReadinessApplicability,
  type ReadinessAssessment,
  type ReadinessAssessmentHead,
  type ReadinessCandidateBinding,
  type ReadinessConsumerPurpose,
  type ReadinessCurrentContext,
  type ReadinessDisposition,
  type ReadinessEvidenceBinding,
  type ReadinessEvidenceCurrentState,
  type ReadinessFreshness,
  type ReadinessFreshnessProjection,
  type ReadinessQualification,
  type ReadinessQualificationReason,
  type ReadinessReasonCode,
  type ReadinessRejection,
  type ReadinessRejectionCode,
  type ReadinessRejectionReason,
  type ReadinessRequirement,
  type ReadinessResult,
  type ReadinessStaleReason,
  type ReadinessSubject,
  type RepositoryFeasibilityEvidencePayload,
  type SemanticEvidencePayload,
  type Sha256Digest,
  type SourceRevision,
} from "@pi-workflow/v2-readiness";

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? true
    : false;
type Assert<T extends true> = T;

type PublicTypes = [
  Sha256Digest,
  SourceRevision,
  ReadinessSubject,
  ReadinessApplicability,
  CreateReadinessCandidateBindingInput,
  ReadinessCandidateBinding,
  EvidenceKind,
  EvidenceProducerKind,
  EvidenceProducer,
  SemanticEvidencePayload,
  QuantitativeEvidencePayload,
  RepositoryFeasibilityEvidencePayload,
  ApplicabilityPolicyEvidencePayload,
  QuantitativeExceptionEvidencePayload,
  AuthorityEvidencePayload,
  GovernanceEvidencePayload,
  CreateGovernanceEvidenceInput,
  GovernanceEvidence,
  ReadinessDisposition,
  ReadinessReasonCode,
  ReadinessEvidenceBinding,
  ReadinessAssessment,
  AssessReadinessInput,
  ReadinessFreshness,
  ReadinessStaleReason,
  ReadinessEvidenceCurrentState,
  ReadinessAssessmentHead,
  ReadinessCurrentContext,
  ReadinessFreshnessProjection,
  ProjectReadinessFreshnessInput,
  ReadinessConsumerPurpose,
  ReadinessRequirement,
  ReadinessQualificationReason,
  ReadinessQualification,
  QualifyReadinessForConsumptionInput,
  ReadinessResult<unknown>,
  ReadinessRejectionCode,
  ReadinessRejectionReason,
  ReadinessRejection,
];

type _PublicTypeCount = Assert<Equal<PublicTypes["length"], 39>>;
type _CandidateSignature = Assert<Equal<
  typeof createReadinessCandidateBinding,
  (input: CreateReadinessCandidateBindingInput) => ReadinessResult<ReadinessCandidateBinding>
>>;
type _EvidenceSignature = Assert<Equal<
  typeof createGovernanceEvidence,
  (input: CreateGovernanceEvidenceInput) => ReadinessResult<GovernanceEvidence>
>>;
type _AssessmentSignature = Assert<Equal<
  typeof assessReadiness,
  (input: AssessReadinessInput) => ReadinessResult<ReadinessAssessment>
>>;
type _FreshnessSignature = Assert<Equal<
  typeof projectReadinessFreshness,
  (input: ProjectReadinessFreshnessInput) => ReadinessResult<ReadinessFreshnessProjection>
>>;
type _QualificationSignature = Assert<Equal<
  typeof qualifyReadinessForConsumption,
  (input: QualifyReadinessForConsumptionInput) => ReadinessResult<ReadinessQualification>
>>;

declare const candidateInput: CreateReadinessCandidateBindingInput;
declare const evidenceInput: CreateGovernanceEvidenceInput;
declare const assessmentInput: AssessReadinessInput;
declare const freshnessInput: ProjectReadinessFreshnessInput;
declare const qualificationInput: QualifyReadinessForConsumptionInput;
declare const assessment: ReadinessAssessment;
declare const qualification: ReadinessQualification;

createReadinessCandidateBinding(candidateInput);
createGovernanceEvidence(evidenceInput);
assessReadiness(assessmentInput);
projectReadinessFreshness(freshnessInput);
qualifyReadinessForConsumption(qualificationInput);

// @ts-expect-error successful domain records are readonly
assessment.sequence = 2;
// @ts-expect-error assessment collections are readonly
assessment.reasonCodes.push("missing_semantic_evidence");
// @ts-expect-error candidate members are recursively readonly
assessment.candidate.subject.revision = 4;
// @ts-expect-error qualification reasons are readonly
qualification.reasons.push("readiness_stale");
// @ts-expect-error the applicability vocabulary is closed
const invalidApplicability: ReadinessApplicability = "optional";
// @ts-expect-error the consumer purpose vocabulary is closed
const invalidPurpose: ReadinessConsumerPurpose = "engineering_start";
// @ts-expect-error caller-supplied candidate hashes are outside creator input
createReadinessCandidateBinding({ ...candidateInput, canonicalSha256: "a".repeat(64) });
// @ts-expect-error caller-supplied derived assessment fields are outside input
assessReadiness({ ...assessmentInput, disposition: "ready" });

declare const result: ReadinessResult<ReadinessAssessment>;
if (result.ok) {
  const value: ReadinessAssessment = result.value;
  void value;
} else {
  const rejection: ReadinessRejection = result.rejection;
  void rejection;
}

// @ts-expect-error package-private canonical helpers are not exported
type NoCanonicalHash = import("@pi-workflow/v2-readiness").CanonicalHash<unknown>;
// @ts-expect-error E02 types are not re-exported
type NoEpicId = import("@pi-workflow/v2-readiness").EpicId;
// @ts-expect-error no public internal subpath exists
type NoInternalSubpath = import("@pi-workflow/v2-readiness/internal").ObjectFields;

void (null as unknown as _PublicTypeCount);
void (null as unknown as _CandidateSignature);
void (null as unknown as _EvidenceSignature);
void (null as unknown as _AssessmentSignature);
void (null as unknown as _FreshnessSignature);
void (null as unknown as _QualificationSignature);
void (null as unknown as NoCanonicalHash);
void (null as unknown as NoEpicId);
void (null as unknown as NoInternalSubpath);
