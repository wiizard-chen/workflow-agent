# V2 E70 — Readiness and governance evidence

| Field | Value |
|---|---|
| Initiative | `workflow-agent-c2b` |
| Epic | `workflow-agent-c2b.6` |
| Map ID | `E70` |
| Document version | `draft-v2` |
| Product status | **PENDING HUMAN CONFIRMATION** |
| Approval status | **NOT APPROVED** |
| Engineering eligibility | **INELIGIBLE** |
| Primary repository | `workflow-agent` |
| Primary package | `@pi-workflow/v2-readiness` |
| Delivery Units | 1 |
| Target Active Engineering Time | `2h` |
| Maximum implementation tasks | 5 |
| Verification Profile | `strict` |
| Approval manifest | Candidate only; exact hash in `bundle/manifest.sha256` |
| Authoritative approval hash | Not assigned |

> This is a documentation-only candidate contract. It authorizes no approval, Readiness run, task creation, implementation, dependency installation, branch/worktree creation, commit, push, pull request, or external effect. The filenames under `bundle/` are compatibility names and confer no approval authority. Until a human confirms the exact candidate Manifest SHA-256 and the confirmation is written to and read back from Beads, this PRD is **NOT APPROVED** and engineering remains **INELIGIBLE**.

## 1. Authority, dependency baseline, and frozen decisions

This PRD is subordinate to:

- [Initiative Charter](../../../INITIATIVE_CHARTER.md#7-3-three-layer-readiness-gate)
- [Architecture RFC](../../../ARCHITECTURE_RFC.md#11-4-readiness-handoff-and-no-cycle-approval)
- [Initial Epic Map](../../../INITIAL_EPIC_MAP.md#e70-readiness-and-governance-evidence)
- [Third-Party Reuse Survey](../../../THIRD_PARTY_REUSE_SURVEY.md#1-decision-posture)
- [E02 Domain Kernel PRD](../../E02/PRD.md#2-bounded-result)

E70 is based on the locally completed E02 candidate commit `536d98693506fc30ea2388d61e135e8c81262813`. Its approved E02 Manifest SHA-256 is `95a111697d11d867c9a28368b9d8edf4bcc6dd4da716f9a93347264cec3096c8`, its E02 PRD SHA-256 is `b61d2642e66183a8eb772d9986fffbf4f56fe7932b1a016c279fe2845c136b58`, and its delivered `packages/v2-domain/src/index.ts` SHA-256 is `04bcc42725ed99305cd8b50ee9404182edb13e173d8792e1f278d04371179e95`. A different commit, Manifest, PRD, or package source is a different dependency baseline and requires a new E70 candidate Bundle.

The historical E70 draft-v1 product contract was approved at `2026-08-02T16:29:35Z` under Manifest `d0e5cd1a3754d168b144ed696a79dba3aee9c4698372fbda77a6293721c4ead3` and source PRD `a71cfc195c8f8f3df94a7393e20aec57bd324e8b89ae88ba059cfdaa8637e0f2`. Its three-layer Readiness result was `NEEDS_REFINEMENT`: public operation/reason/context contracts were incomplete and the E02 live-worktree verifier made the strict suite impossible for later Epic paths. Draft-v2 supersedes v1 content only if its own exact Manifest is confirmed; the v1 approval remains immutable history and does not approve v2.

The following product decisions are frozen in this candidate:

| Decision | Frozen rule |
|---|---|
| R01 | Readiness binds an exact subject ID/revision, Bundle Manifest, repository/base revision, policy/profile revision, and requirement set using RFC 8785 canonical SHA-256. |
| R02 | Applicability, disposition, and freshness are orthogonal closed dimensions. |
| R03 | Assessments and governance evidence are immutable `EvidenceRef`-identified records; recalculation appends, never overwrites. |
| R04 | Freshness is a pure caller-input projection with no implicit clock or TTL. |
| R05 | Epic readiness requires semantic, quantitative, and repository-feasibility evidence; Initiative applicability must be explicit policy evidence. |
| R06 | Product AI and self-reported trust labels cannot establish evidence authority. Repository feasibility binds `RoleRunId` and `LaunchPermitId`. |
| R07 | Disposition precedence is `must_decompose > needs_refinement > blocked > ready`. |
| R08 | Only a quantitative estimate greater than 120 and at most 240 active minutes may use a Human Governor exception. |
| R09 | Assessment lineage is single-headed, hash-linked, and sequence-numbered; only the current head is consumable. |
| R10 | A `blocked` result may be retried against the same candidate; `needs_refinement` and `must_decompose` require a new candidate. |
| R11 | E70 is one pure package depending only on E02 and exposes exactly five public operations from a single `.` entrypoint. |
| R12 | Readiness never mutates Product, Approval, queue, Allocation, Engineering, closure, persistence, or an external system. |

## 2. Bounded result and package boundary

E70 delivers one independently revertible package at `packages/v2-readiness/`, named `@pi-workflow/v2-readiness`, with a single `.` entrypoint and a direct workspace dependency only on `@pi-workflow/v2-domain`. It consumes E02 identities, RFC 8785 canonicalization, immutable-value conventions, and scalar seams without changing E02 production source, package manifest, declarations, or exact exports. Section 12 permits one test-only fixture-scoping repair and no other `packages/v2-domain/**` change.

The package owns exact candidate binding, immutable governance evidence qualification, immutable hash-linked `ReadinessAssessment` records, pure freshness projection, and fail-closed consumer qualification. Its exact public function surface is:

```ts
createReadinessCandidateBinding
createGovernanceEvidence
assessReadiness
projectReadinessFreshness
qualifyReadinessForConsumption
```

All operations are deterministic and pure for the same explicit inputs. Invalid input returns a typed rejection as data and does not throw. Successful values are recursively copied and frozen; caller inputs are neither mutated nor frozen. Arrays with set semantics are rejected on duplicates and stored in ascending canonical UTF-16 order. Hashes are lowercase 64-character SHA-256 hex over UTF-8 RFC 8785 canonical JSON text.

## 3. Exact candidate binding

```ts
type Sha256Digest = string; // validated lowercase [0-9a-f]{64}
type SourceRevision = string; // validated non-empty, opaque, byte-preserved

type ReadinessSubject =
  | Readonly<{ kind: "initiative"; id: InitiativeId; revision: Revision }>
  | Readonly<{ kind: "epic"; id: EpicId; revision: Revision }>;

type ReadinessApplicability = "applicable" | "not_applicable";

type CreateReadinessCandidateBindingInput = Readonly<{
  subject: ReadinessSubject;
  bundle: Readonly<{ ref: BundleRef; manifestSha256: Sha256Digest }>;
  repository: Readonly<{ id: RepositoryId; baseRevision: SourceRevision }>;
  policy: Readonly<{ ref: EvidenceRef; profileRevision: SourceRevision }>;
  requirementSet: Readonly<{ ref: EvidenceRef; revision: SourceRevision }>;
  applicability: ReadinessApplicability;
}>;

type ReadinessCandidateBinding =
  CreateReadinessCandidateBindingInput & Readonly<{
  canonicalSha256: Sha256Digest;
}>;
```

`createReadinessCandidateBinding` accepts exactly `CreateReadinessCandidateBindingInput`, validates every E02 scalar and local digest/revision constraint, canonicalizes the input, calculates the digest, and returns the frozen record. No caller-supplied candidate digest is trusted.

An Epic binding must be `applicable`; `not_applicable` for an Epic rejects. An Initiative binding may be either value, but the requested value is not self-authorizing: assessment must include valid policy evidence explicitly asserting the same applicability for the exact policy revision and candidate. Missing or ambiguous Initiative applicability fails closed.

Any change to a bound field creates a different candidate. Human-readable titles, mutable labels, wall-clock age, working directory, environment, Git inspection, or network state are not candidate inputs.

## 4. Governance evidence model and qualification

### 4.1 Immutable evidence envelope

```ts
type EvidenceKind =
  | "semantic"
  | "quantitative"
  | "repository_feasibility"
  | "applicability_policy"
  | "quantitative_exception"
  | "authority";

type EvidenceProducerKind =
  | "product_ai"
  | "engineering_lead"
  | "human_governor"
  | "deterministic_evaluator";

type EvidenceProducer = Readonly<{
  kind: EvidenceProducerKind;
  actorRef: ActorRef;
  authorityEvidenceRef: EvidenceRef | null;
  selfReportedTrust: "untrusted" | "trusted" | "verified" | "human" | null;
}>;

type CreateGovernanceEvidenceInput = Readonly<{
  evidenceRef: EvidenceRef;
  kind: EvidenceKind;
  candidateSha256: Sha256Digest;
  sourceRef: EvidenceRef;
  sourceRevision: SourceRevision;
  producer: EvidenceProducer;
  payload: GovernanceEvidencePayload;
}>;

type GovernanceEvidence =
  CreateGovernanceEvidenceInput & Readonly<{
  canonicalSha256: Sha256Digest;
}>;
```

`createGovernanceEvidence` validates the closed per-kind payload and provenance shape available within one record, recomputes `canonicalSha256`, and freezes a copy. An evidence record cannot cite itself as `sourceRef` or `authorityEvidenceRef`. Cross-record candidate/repository/policy/exception/authority binding and duplicate `evidenceRef` handling occur in `assessReadiness`: different hashes are an integrity failure and exact duplicates are rejected rather than silently collapsed.

`selfReportedTrust` is descriptive input only. It never changes producer kind, establishes Human Governor authority, upgrades Product AI evidence, or satisfies a mandatory evidence layer. Product AI may propose source material but cannot author qualifying `semantic`, `quantitative`, `repository_feasibility`, `quantitative_exception`, or `authority` evidence.

### 4.2 Closed payloads

```ts
type SemanticEvidencePayload = Readonly<{
  kind: "semantic";
  finding: "pass" | "needs_refinement" | "must_decompose";
  requirementRefs: readonly EvidenceRef[];
}>;

type QuantitativeEvidencePayload = Readonly<{
  kind: "quantitative";
  estimatedActiveMinutes: number;
  finding: "within_budget" | "minor_overrun" | "severe_overrun";
}>;

type RepositoryFeasibilityEvidencePayload = Readonly<{
  kind: "repository_feasibility";
  finding: "feasible" | "blocked";
  repositoryId: RepositoryId;
  baseRevision: SourceRevision;
  roleRunId: RoleRunId;
  launchPermitId: LaunchPermitId;
}>;

type ApplicabilityPolicyEvidencePayload = Readonly<{
  kind: "applicability_policy";
  subjectKind: "initiative";
  applicability: ReadinessApplicability;
  policyRef: EvidenceRef;
  profileRevision: SourceRevision;
}>;

type QuantitativeExceptionEvidencePayload = Readonly<{
  kind: "quantitative_exception";
  quantitativeEvidenceRef: EvidenceRef;
  decisionRef: DecisionRef;
  authorityEvidenceRef: EvidenceRef;
  rationaleRef: ReasonRef;
}>;

type AuthorityEvidencePayload = Readonly<{
  kind: "authority";
  authority: "human_portfolio_governor";
  decisionRef: DecisionRef;
  scope: "readiness_quantitative_exception";
}>;

type GovernanceEvidencePayload =
  | SemanticEvidencePayload
  | QuantitativeEvidencePayload
  | RepositoryFeasibilityEvidencePayload
  | ApplicabilityPolicyEvidencePayload
  | QuantitativeExceptionEvidencePayload
  | AuthorityEvidencePayload;
```

Payload `kind` must equal envelope `kind`. Semantic, quantitative, and applicability-policy evidence must come from a `deterministic_evaluator`; repository feasibility must come from `engineering_lead`; quantitative exception and authority evidence must come from `human_governor`. The evaluator/Lead records require `authorityEvidenceRef = null`. A quantitative exception requires a non-null reference to one supplied `authority` record; an authority record itself requires null. Thus the only legal authority edge is exception → authority, and cycles cannot be constructed. In all cases `sourceRef` and `sourceRevision` identify opaque external source content and are never resolved by E70. E70 validates provenance; it does not implement the E58 evaluator that produces findings.

Semantic `requirementRefs` is a non-empty unique set. Quantitative minutes is a positive safe integer and its finding must exactly match `<=120 → within_budget`, `121..240 → minor_overrun`, or `>240 → severe_overrun`; mismatch rejects in `createGovernanceEvidence` and a forged/tampered record contributes assessment integrity failure. Every evidence set has an exact kind inventory: applicable Epic uses semantic + quantitative + repository feasibility, plus exception + authority only for a minor overrun; applicable Initiative adds exactly one applicability-policy record; non-applicable Initiative uses only applicability-policy. A duplicate mandatory kind contributes its corresponding `ambiguous_applicability_policy`, `ambiguous_semantic_evidence`, `ambiguous_quantitative_evidence`, or `ambiguous_repository_feasibility`; an unnecessary/duplicate exception contributes `invalid_quantitative_exception`; an unpaired authority, forbidden applicability-policy record, readiness-layer record for a non-applicable Initiative, or any other extra record contributes `evidence_provenance_failure`. None can be ignored.

Repository-feasibility evidence must come from `engineering_lead`, contain non-empty `RoleRunId` and `LaunchPermitId`, and exactly match candidate repository/base revision. E70 validates binding only; it does not implement E59 analysis, launch permits, Runtime role execution, repository reads, or codebase inspection.

An Initiative requires exactly one unambiguous `applicability_policy` record matching its candidate policy reference/revision and applicability. An Epic rejects applicability-policy evidence as inapplicable noise and always requires all three readiness layers.

### 4.3 Mandatory evidence and fail-closed behavior

For an applicable candidate, assessment requires exactly one qualifying semantic finding, quantitative finding, and repository-feasibility finding. Multiple distinct qualifying records for a mandatory layer are ambiguous and yield `blocked`; missing, wrong-candidate, conflicting, tampered-integrity, or invalid-provenance evidence also yields `blocked` with the closed reasons above. If an evidence array element is so structurally malformed that its `evidenceRef` and claimed digest cannot be recovered without invoking an accessor, the assessment operation rejects `invalid_evidence` instead of fabricating a finding.

For a `not_applicable` Initiative, exact policy evidence is mandatory, readiness-layer evidence is not consumed, and a valid assessment has disposition `ready`. `not_applicable` does not mean the candidate or policy binding may be omitted.

Evidence whose candidate digest differs never contributes. Evidence integrity/provenance failure is recorded even if another record could otherwise satisfy the same layer; callers cannot hide a poisoned record by adding a good one.

## 5. Assessment, disposition, exception, and immutability

### 5.1 Immutable assessment

```ts
type ReadinessDisposition =
  | "ready"
  | "needs_refinement"
  | "must_decompose"
  | "blocked";

type ReadinessReasonCode =
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

type ReadinessEvidenceBinding = Readonly<{
  evidenceRef: EvidenceRef;
  kind: EvidenceKind;
  canonicalSha256: Sha256Digest;
}>;

type ReadinessAssessment = Readonly<{
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
```

`assessReadiness` accepts an assessment identity, exact candidate, supplied evidence set, and complete prior subject history. It validates the complete set, derives applicability and disposition, stores every evidence identity/kind/hash binding in canonical order, derives `evidenceSetSha256` from that list, sorts reasons by the union order above, hashes the assessment without `canonicalSha256`, and returns a copied, recursively frozen record. Callers cannot supply applicability, disposition, evidence bindings/digest, reason codes, sequence, predecessor fields, or final digest.

Disposition candidates are accumulated independently and reduced with this exact precedence:

```text
must_decompose > needs_refinement > blocked > ready
```

Rules are exact:

- semantic `must_decompose` contributes `must_decompose`; semantic `needs_refinement` contributes `needs_refinement`; semantic `pass` contributes `ready`;
- quantitative `estimatedActiveMinutes <= 120` must say `within_budget` and contributes `ready`;
- `121..240` must say `minor_overrun` and contributes `needs_refinement` unless one valid exception applies, when it contributes `ready`;
- `>240` must say `severe_overrun` and contributes `must_decompose`;
- a non-positive/non-safe estimate, estimate/finding mismatch, missing mandatory evidence, ambiguity, repository `blocked`, provenance failure, or integrity failure contributes `blocked`;
- contradictory findings are not normalized and fail closed.

The precedence deliberately preserves a known semantic/decomposition result even when another layer is blocked. `ready` occurs only when every applicable mandatory rule contributes `ready` and no invalid evidence is present.

### 5.2 Quantitative exception

Only one exact `quantitative_exception` may waive one exact quantitative record whose estimate is `121..240`. It must bind a `DecisionRef`, rationale, and separate authority evidence proving the same `DecisionRef` and `human_portfolio_governor` scope for `readiness_quantitative_exception`; its producer is `human_governor`, and its actor matches the authority evidence producer actor.

An exception cannot waive semantic failure, estimates above 240, missing evidence, repository infeasibility, stale inputs, source absence, provenance/integrity failure, or invalidation. An unnecessary, duplicate, conflicting, wrong-range, wrong-candidate, wrong-source, or unauthorized exception is invalid evidence and contributes `blocked`.

No record is updated when an exception is introduced or invalidated. A new assessment references the new evidence set; historical assessment bytes remain unchanged.

## 6. Lineage, retry, and duplicate protection

The assessment input is exact:

```ts
type AssessReadinessInput = Readonly<{
  assessmentRef: EvidenceRef;
  candidate: ReadinessCandidateBinding;
  evidence: readonly GovernanceEvidence[];
  history: readonly ReadinessAssessment[];
}>;
```

Assessment history for a logical subject is a single hash-linked sequence:

- the first assessment has `sequence = 1` and both predecessor fields null;
- every successor has previous sequence plus one and exactly matches previous assessment reference and digest;
- every supplied history item is re-canonicalized without its digest, has a valid digest, and has the same subject kind and ID;
- history is supplied oldest-first, begins at sequence 1, contains no gaps/forks, and its final entry is the only current head;
- an `assessmentRef` already in supplied lineage is rejected;
- reusing an identical candidate digest, `evidenceSetSha256`, and predecessor digest is a duplicate assessment even under a new identity;
- forks, gaps, predecessor mismatch, subject mismatch, or non-head predecessor reject.

After `blocked`, the next assessment may retain the exact candidate so corrected/new evidence can be supplied. After `needs_refinement` or `must_decompose`, a successor must bind a different candidate. A `ready` or `not_applicable` head may only be superseded by a different candidate. Reassessment never mutates history.

The package does not discover or persist history. The caller supplies complete history for that subject; E70 validates it before deriving the successor. Empty history means the first assessment. History containing another subject, malformed canonical bytes, a duplicate identity/fingerprint, a gap, or a fork rejects rather than being ignored.

## 7. Freshness projection

```ts
type ReadinessFreshness = "current" | "stale";

type ReadinessStaleReason =
  | "subject_revision_changed"
  | "bundle_changed"
  | "repository_base_changed"
  | "policy_changed"
  | "requirement_set_changed"
  | "evidence_invalidated"
  | "exception_invalidated"
  | "source_missing"
  | "assessment_head_changed";

type ReadinessFreshnessProjection = Readonly<{
  freshness: ReadinessFreshness;
  reasons: readonly ReadinessStaleReason[];
  assessmentRef: EvidenceRef;
  assessmentSha256: Sha256Digest;
}>;

type ReadinessEvidenceCurrentState = Readonly<{
  evidenceRef: EvidenceRef;
  kind: EvidenceKind;
  state: "current" | "invalidated" | "missing";
  canonicalSha256: Sha256Digest | null;
}>;

type ReadinessAssessmentHead = Readonly<{
  assessmentRef: EvidenceRef;
  canonicalSha256: Sha256Digest;
}>;

type ReadinessCurrentContext = Readonly<{
  subject: ReadinessSubject;
  bundle: Readonly<{ ref: BundleRef; manifestSha256: Sha256Digest }>;
  repository: Readonly<{ id: RepositoryId; baseRevision: SourceRevision }>;
  policy: Readonly<{ ref: EvidenceRef; profileRevision: SourceRevision }>;
  requirementSet: Readonly<{ ref: EvidenceRef; revision: SourceRevision }>;
  evidence: readonly ReadinessEvidenceCurrentState[];
  assessmentHead: ReadinessAssessmentHead;
}>;

type ProjectReadinessFreshnessInput = Readonly<{
  assessment: ReadinessAssessment;
  current: ReadinessCurrentContext;
}>;
```

`projectReadinessFreshness` accepts exactly `ProjectReadinessFreshnessInput` and performs no I/O. Current-context `evidence` has set semantics, is sorted by `evidenceRef`, and must contain exactly one entry for every assessment evidence binding and no extra entry. A `current` entry requires a non-null matching digest; an `invalidated` entry requires its last-known non-null digest; a `missing` entry requires null. Kind and identity must match the assessment binding.

Current subject kind/ID/revision mismatch adds `subject_revision_changed`; Bundle ref/digest mismatch adds `bundle_changed`; repository ID/base mismatch adds `repository_base_changed`; policy ref/profile mismatch adds `policy_changed`; requirement-set ref/revision mismatch adds `requirement_set_changed`. A `missing` evidence entry adds `source_missing`; an `invalidated` or digest-mismatched non-exception adds `evidence_invalidated`; the same condition for `quantitative_exception` adds `exception_invalidated`; a different current head reference or digest adds `assessment_head_changed`. Reasons are unique and emitted in the closed union order above. Zero reasons yields `current`; one or more yields `stale`. A malformed/duplicate/missing/extra context entry is an operation rejection, not a fabricated freshness result.

Freshness never changes assessment disposition, hash, or evidence. There is no implicit `Date.now`, timestamp comparison, age, TTL, filesystem read, Git lookup, network call, or environment dependency.

## 8. Consumer qualification and authority handoff

```ts
type ReadinessConsumerPurpose =
  | "product_approval"
  | "scheduling_eligibility_input";

type ReadinessRequirement =
  | "satisfied"
  | "not_required"
  | "unsatisfied";

type ReadinessQualificationReason =
  | "projection_binding_mismatch"
  | "assessment_not_head"
  | "assessment_head_hash_mismatch"
  | "readiness_stale"
  | "disposition_blocked"
  | "disposition_needs_refinement"
  | "disposition_must_decompose"
  | "epic_cannot_be_not_applicable";

type ReadinessQualification = Readonly<{
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

type QualifyReadinessForConsumptionInput = Readonly<{
  assessment: ReadinessAssessment;
  freshness: ReadinessFreshnessProjection;
  currentHead: ReadinessAssessmentHead;
  purpose: ReadinessConsumerPurpose;
}>;
```

`qualifyReadinessForConsumption` accepts exactly `QualifyReadinessForConsumptionInput`. Reasons are unique and emitted in the union order above.

It returns a typed immutable result and never invokes E74 or E71:

- `qualified` is true only when assessment/projection digests match, assessment is the asserted current head, freshness is `current`, provenance/integrity remains valid, and disposition is `ready`;
- an applicable Epic or Initiative then returns `requirement = "satisfied"`;
- a `not_applicable` Initiative returns `requirement = "not_required"` only while exact policy evidence remains current;
- stale, non-head, blocked, needs-refinement, must-decompose, or well-formed mismatched input returns `qualified = false`, `requirement = "unsatisfied"`, and canonical reasons;
- an Epic can never return `not_required`.

Malformed input, an invalid assessment canonical digest, or a projection that cannot be structurally bound to the supplied assessment returns a typed operation rejection. A well-formed projection carrying a different assessment ref/hash is a successful negative qualification with `projection_binding_mismatch`; this distinction is part of the attack tests.

The result is evidence for a downstream precondition only. E74 owns Product/Approval. E71 owns eligibility/queue/Allocation. E70 cannot approve, activate, enqueue, prioritize, allocate, start Engineering, accept a Task, close an aggregate, or perform an effect. Approval does not back-propagate into Readiness.

## 9. Typed rejection and public export contract

```ts
type ReadinessResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; rejection: ReadinessRejection }>;

type ReadinessRejectionCode =
  | "invalid_input"
  | "invalid_binding"
  | "invalid_evidence"
  | "invalid_provenance"
  | "invalid_lineage"
  | "duplicate_assessment"
  | "invalid_freshness_context"
  | "qualification_mismatch";

type ReadinessRejectionReason =
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

type ReadinessRejection = Readonly<{
  code: ReadinessRejectionCode;
  path: string;
  reason: ReadinessRejectionReason;
  relatedRef: string | null;
}>;

function createReadinessCandidateBinding(
  input: CreateReadinessCandidateBindingInput,
): ReadinessResult<ReadinessCandidateBinding>;

function createGovernanceEvidence(
  input: CreateGovernanceEvidenceInput,
): ReadinessResult<GovernanceEvidence>;

function assessReadiness(
  input: AssessReadinessInput,
): ReadinessResult<ReadinessAssessment>;

function projectReadinessFreshness(
  input: ProjectReadinessFreshnessInput,
): ReadinessResult<ReadinessFreshnessProjection>;

function qualifyReadinessForConsumption(
  input: QualifyReadinessForConsumptionInput,
): ReadinessResult<ReadinessQualification>;
```

`path` is an RFC 6901 JSON Pointer and root is the empty string. Every operation validates depth-first with this exact global priority: root/plain-object prototype; symbol keys; accessors/extra/missing fields in canonical UTF-16 field order; local scalar/digest/source-revision/enum constraints in declared field order; nested canonical hash; duplicate set identities; cross-record binding/provenance; history/context/projection relationship; then derivation. At one node, the reason priority is the order of `ReadinessRejectionReason` above. Exactly one rejection returns: the earliest path by traversal, then earliest reason.

Code mapping is exact: candidate structure/binding uses `invalid_input` or `invalid_binding`; evidence shape/content uses `invalid_evidence`, while producer/authority rules use `invalid_provenance`; history structural relationships use `invalid_lineage`, except fingerprint reuse uses `duplicate_assessment`; freshness context uses `invalid_freshness_context`; qualification structure/binding uses `qualification_mismatch`. Assessment findings such as absent mandatory evidence are successful immutable assessments with `blocked`; malformed operation structures, forged canonical hashes, and impossible lineage reject.

The public `.` entrypoint export allowlist is exact:

```text
Types:
Sha256Digest
SourceRevision
ReadinessSubject
ReadinessApplicability
CreateReadinessCandidateBindingInput
ReadinessCandidateBinding
EvidenceKind
EvidenceProducerKind
EvidenceProducer
SemanticEvidencePayload
QuantitativeEvidencePayload
RepositoryFeasibilityEvidencePayload
ApplicabilityPolicyEvidencePayload
QuantitativeExceptionEvidencePayload
AuthorityEvidencePayload
GovernanceEvidencePayload
CreateGovernanceEvidenceInput
GovernanceEvidence
ReadinessDisposition
ReadinessReasonCode
ReadinessEvidenceBinding
ReadinessAssessment
AssessReadinessInput
ReadinessFreshness
ReadinessStaleReason
ReadinessEvidenceCurrentState
ReadinessAssessmentHead
ReadinessCurrentContext
ReadinessFreshnessProjection
ProjectReadinessFreshnessInput
ReadinessConsumerPurpose
ReadinessRequirement
ReadinessQualificationReason
ReadinessQualification
QualifyReadinessForConsumptionInput
ReadinessResult
ReadinessRejectionCode
ReadinessRejectionReason
ReadinessRejection

Values:
createReadinessCandidateBinding
createGovernanceEvidence
assessReadiness
projectReadinessFreshness
qualifyReadinessForConsumption
```

No other name is exported. The package does not re-export E02, Node crypto APIs, internal canonical/hash helpers, fixtures, or implementation brands. No subpath export is allowed.

## 10. Explicit non-goals and stop boundary

- No E58 semantic/quantitative evaluator or risk scorer.
- No E59 repository analyzer, codebase reader, or feasibility role execution.
- No E19 policy resolver, policy store, or authorization engine.
- No E74 Product lifecycle, ApprovalAttempt, approval decision, or activation.
- No E71 eligibility decision, queue, Scheduling, capacity, priority, or Allocation.
- No E73 plan, preflight, execution, compensation, or reconciliation.
- No E75–E83 lifecycle or projection authority.
- No protocol, JSON Schema transport boundary, RPC, daemon, SQLite, persistence, migration, Beads adapter, event store, or materialized view.
- No Runtime, Worker, role launcher, permit issuer, lease, fence, Scheduler, Permission, Git/GitHub broker, or third-party backend.
- No clock, timestamp chronology, timeout, TTL, randomness, environment, cwd, filesystem, Git, GitHub, network, or process-state read.
- No writable universal status, lifecycle, eligibility, Product, queue, Engineering, or closure field.
- No dependency or export changes to `@pi-workflow/v2-domain`.
- No approval inference from filenames, chat history, Product AI output, self-reported trust, or generated Bundle existence.
- No implementation outside the Section 12 allowed change surface.

The package can be removed without migration, broker compensation, process shutdown, Product mutation, queue repair, or external cleanup. That is the E70 stop boundary.

## 11. Acceptance criteria — continuous reduced set

- **AC-001 — Candidate binding.** Runtime and type tests prove exact subject ID/revision, Bundle ref/Manifest SHA-256, repository/base revision, policy/profile revision, requirement set, and applicability binding; deterministic RFC 8785 SHA-256; malformed/extra-field rejection; and digest change for every bound-field change.
- **AC-002 — Applicability.** Tests prove every Epic is `applicable`, every Initiative has one explicit exact-policy applicability record, missing/ambiguous/mismatched policy fails closed, and `not_applicable` remains separate from disposition and freshness.
- **AC-003 — Evidence qualification.** Tests prove applicable candidates require semantic, quantitative, and repository-feasibility layers; feasibility binds E02 `RoleRunId`/`LaunchPermitId` and repository baseline; Product AI/trust labels cannot create authority; invalid, ambiguous, poisoned, or wrong-candidate evidence fails closed.
- **AC-004 — Disposition and precedence.** A complete decision table proves the closed set and exact `must_decompose > needs_refinement > blocked > ready` reduction, including semantic findings, quantitative boundaries, repository blocking, missing evidence, contradictory input, and combinations.
- **AC-005 — Exception.** Tests prove only one Human Governor decision may waive an exact `121..240` minute finding with matching `DecisionRef`, rationale, and authority; semantic failure, `>240`, stale, missing evidence, provenance/integrity failure, invalidation, duplication, or mismatch cannot be waived.
- **AC-006 — Provenance.** Tests prove opaque source binding, the only legal exception → authority edge, closed producer/kind matrix, Product AI/trust-label attacks, feasibility role/permit binding, Human Governor actor/scope matching, candidate/source revisions, duplicate-ref collision handling, and fail-closed unresolved/self authority references.
- **AC-007 — Immutability.** Tests prove all successful nested output is copied/frozen, caller input is not frozen/mutated, evidence/assessments are never overwritten, hashes use canonical content, and invalid caller values return typed data rather than throw.
- **AC-008 — Lineage and retry.** Tests prove complete-history validation, first/head/successor rules, monotonic sequence, predecessor ref/hash, evidence-set fingerprint, duplicate/fork/gap rejection, same-candidate retry only after `blocked`, and new candidate after `needs_refinement`, `must_decompose`, `ready`, or `not_applicable`.
- **AC-009 — Freshness.** Tests cover the exact current-context schema, all nine stale reasons alone/in combination, canonical order, invalidation/source absence/head change, malformed/duplicate/missing/extra context rejection, zero-reason `current`, assessment byte preservation, and absence of clock/TTL/I/O.
- **AC-010 — Consumption handoff.** Tests prove the exact qualification schema/reason order, only current-head/current/integrity-valid `ready` qualifies, explicit Initiative non-applicability returns `not_required`, Epic never does, structural versus well-formed mismatch behavior fails closed, and no downstream authority is invoked.
- **AC-011 — Package and E02 boundary.** Workspace/type tests prove the exact Section 9 type/value allowlist, one `.` entrypoint, only E02 direct dependency, no subpath/internal/crypto re-exports, and byte-for-byte unchanged E02 production source/package manifest/exports/declarations/public key set. The sole E02 test-file exception is the fixture-scoping repair named in Section 12; it cannot change E02 production or weaken the existing attack matrix.
- **AC-012 — Strict delivery evidence.** Clean-room build, runtime/type attack suites, package/export inspection, boundary validator, frozen-fixture E02 verifier test, new E70 cumulative verifier, Bundle check, generated hash readback, allowed-path audit, no-side-effect scan, and `git diff --check` pass from the frozen E02 commit with independent evidence.

## 12. Delivery plan, allowed change surface, and verification contract

The later implementation may use at most five tasks:

1. package plus candidate/policy/evidence foundation;
2. assessment, provenance, and exception engine;
3. lineage, freshness, and consumer qualification;
4. exhaustive runtime/type attack tests;
5. workspace, boundary, Bundle, and independent-verifier evidence.

This is a PRD constraint, not authorization to create tasks. Only these future implementation paths are allowed:

```text
packages/v2-readiness/**
package.json
package-lock.json
tsconfig.v2.json
scripts/validate-v2-boundaries.mjs
scripts/clean-v2-output.mjs
scripts/verify-e70-worktree.mjs
packages/v2-domain/test/t5-worktree-verifier.test.mjs
docs/v2/ARCHITECTURE_RFC.md
docs/v2/INITIAL_EPIC_MAP.md
docs/v2/INITIATIVE_CHARTER.md
docs/v2/THIRD_PARTY_REUSE_SURVEY.md
docs/v2/epics/E70/**
```

Authority-document changes are allowed only to reconcile an explicitly approved E70 contract and require a new Bundle. E02 production source, package manifest, exports, declarations, verifier implementation, and attack matrix are frozen. The one allowed E02 test change may alter imports/helpers and the positive test only as needed to replace the live-repository call to `verifyE02Worktree(workspaceRoot)` with an isolated exact-E02 fixture at commit `536d98693506fc30ea2388d61e135e8c81262813`; the fixture must still execute the frozen `scripts/verify-e02-worktree.mjs`, assert the same Manifest/baseline/hygiene evidence, leave every negative mutation case byte-for-byte unchanged, clean up its temporary clone/worktree, and create no repository-visible state. Skipping or weakening this test is forbidden.

`scripts/verify-e70-worktree.mjs` is the cumulative E70 delivery verifier. It binds the approved v2 Manifest, requires HEAD descendant relation to E02 commit, freezes all E02 production/Bundle inputs, permits exactly the approved E70 path surface, rejects index flags/symlinks/gitlinks/generated tracked output/whitespace/invalid UTF-8/hidden paths, runs Bundle readback, and proves pre/post snapshot equality. It does not modify or generalize the E02 verifier.

The future implementation strict verification contract is:

```text
npm run clean:v2
npm run build:v2
npm run typecheck:v2
npm run test:v2
npm run validate:v2-boundaries
node docs/v2/epics/E70/generate-bundle.mjs --check
node scripts/verify-e70-worktree.mjs
npm pack --dry-run --workspace @pi-workflow/v2-readiness
git diff --check
```

The PRD-candidate stage runs only Bundle check, embedded JSON/hash/link/safe-HTML readback, Beads write/readback, allowed-path audit, and `git diff --check`. It does not run or imply engineering Readiness.

## 13. Approval and next gate

The exact SHA-256 of `bundle/manifest.json` is the only candidate confirmation handle. Valid product approval requires an explicit Human Governor statement naming that digest, followed by Beads write/readback recording principal, digest, time, source PRD hash, and approved product status.

Approval would authorize only the next governance gate. It would not itself authorize Readiness execution, task split, implementation, commit, push, pull request, merge, scheduling, or any external effect.
