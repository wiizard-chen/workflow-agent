import type { EvidenceRef, PositiveOrdinal } from "@pi-workflow/v2-domain";

import { inspectCandidateBinding, validateCandidateBinding } from "./candidate.js";
import { inspectGovernanceEvidence } from "./evidence.js";
import {
  accept,
  canonicalHash,
  childPath,
  compareUtf16,
  field,
  inspectExactArray,
  inspectExactObject,
  reject,
  remapRejection,
  validateDomainScalar,
  validateEnum,
  validateSha256,
} from "./internal.js";
import type {
  AssessReadinessInput,
  AuthorityEvidencePayload,
  EvidenceKind,
  GovernanceEvidence,
  QuantitativeEvidencePayload,
  QuantitativeExceptionEvidencePayload,
  ReadinessAssessment,
  ReadinessCandidateBinding,
  ReadinessDisposition,
  ReadinessEvidenceBinding,
  ReadinessReasonCode,
  ReadinessRejectionCode,
  ReadinessResult,
  RepositoryFeasibilityEvidencePayload,
  ApplicabilityPolicyEvidencePayload,
  SemanticEvidencePayload,
  Sha256Digest,
} from "./types.js";

const EVIDENCE_KINDS = [
  "semantic",
  "quantitative",
  "repository_feasibility",
  "applicability_policy",
  "quantitative_exception",
  "authority",
] as const;

const DISPOSITIONS = [
  "ready",
  "needs_refinement",
  "must_decompose",
  "blocked",
] as const;

export const READINESS_REASON_ORDER = [
  "not_applicable_by_policy",
  "missing_applicability_policy",
  "ambiguous_applicability_policy",
  "applicability_policy_mismatch",
  "missing_semantic_evidence",
  "ambiguous_semantic_evidence",
  "semantic_needs_refinement",
  "semantic_must_decompose",
  "missing_quantitative_evidence",
  "ambiguous_quantitative_evidence",
  "quantitative_minor_overrun",
  "quantitative_severe_overrun",
  "quantitative_finding_mismatch",
  "missing_repository_feasibility",
  "ambiguous_repository_feasibility",
  "repository_feasibility_blocked",
  "wrong_candidate_evidence",
  "evidence_integrity_failure",
  "evidence_provenance_failure",
  "invalid_quantitative_exception",
  "quantitative_exception_applied",
] as const satisfies readonly ReadinessReasonCode[];

const REASON_RANK = new Map<ReadinessReasonCode, number>(
  READINESS_REASON_ORDER.map((reason, index) => [reason, index]),
);

const DISPOSITION_RANK: Readonly<Record<ReadinessDisposition, number>> = {
  ready: 0,
  blocked: 1,
  needs_refinement: 2,
  must_decompose: 3,
};

function compareBindings(
  left: ReadinessEvidenceBinding,
  right: ReadinessEvidenceBinding,
): number {
  return compareUtf16(left.evidenceRef, right.evidenceRef) ||
    compareUtf16(left.kind, right.kind) ||
    compareUtf16(left.canonicalSha256, right.canonicalSha256);
}

function sameSubject(
  left: ReadinessCandidateBinding,
  right: ReadinessCandidateBinding,
): boolean {
  return left.subject.kind === right.subject.kind &&
    left.subject.id === right.subject.id;
}

function expectedQuantitativeFinding(
  minutes: number,
): QuantitativeEvidencePayload["finding"] {
  return minutes <= 120
    ? "within_budget"
    : minutes <= 240
      ? "minor_overrun"
      : "severe_overrun";
}

function isLocallyProvenant(evidence: GovernanceEvidence): boolean {
  if (
    evidence.payload.kind !== evidence.kind ||
    evidence.evidenceRef === evidence.sourceRef ||
    evidence.producer.authorityEvidenceRef === evidence.evidenceRef
  ) {
    return false;
  }

  const expectedProducer: Readonly<Record<EvidenceKind, string>> = {
    semantic: "deterministic_evaluator",
    quantitative: "deterministic_evaluator",
    repository_feasibility: "engineering_lead",
    applicability_policy: "deterministic_evaluator",
    quantitative_exception: "human_governor",
    authority: "human_governor",
  };
  if (evidence.producer.kind !== expectedProducer[evidence.kind]) {
    return false;
  }

  if (evidence.kind === "quantitative_exception") {
    const payload = evidence.payload as QuantitativeExceptionEvidencePayload;
    return evidence.producer.authorityEvidenceRef !== null &&
      evidence.producer.authorityEvidenceRef === payload.authorityEvidenceRef &&
      payload.authorityEvidenceRef !== evidence.evidenceRef;
  }

  return evidence.producer.authorityEvidenceRef === null;
}

function inspectEvidenceBinding(
  value: unknown,
  path: string,
  code: ReadinessRejectionCode,
): ReadinessResult<ReadinessEvidenceBinding> {
  const object = inspectExactObject(
    value,
    ["evidenceRef", "kind", "canonicalSha256"],
    code,
    path,
  );
  if (!object.ok) return object;
  const evidenceRef = validateDomainScalar(
    "EvidenceRef",
    field(object.value, "evidenceRef"),
    code,
    childPath(path, "evidenceRef"),
  );
  if (!evidenceRef.ok) return evidenceRef;
  const kind = validateEnum(
    field(object.value, "kind"),
    EVIDENCE_KINDS,
    code,
    childPath(path, "kind"),
  );
  if (!kind.ok) return kind;
  const digest = validateSha256(
    field(object.value, "canonicalSha256"),
    code,
    childPath(path, "canonicalSha256"),
  );
  if (!digest.ok) return digest;
  return accept(Object.freeze({
    evidenceRef: evidenceRef.value as EvidenceRef,
    kind: kind.value,
    canonicalSha256: digest.value,
  }));
}

function inspectOrderedBindings(
  value: unknown,
  path: string,
  code: ReadinessRejectionCode,
): ReadinessResult<readonly ReadinessEvidenceBinding[]> {
  const array = inspectExactArray(value, code, path);
  if (!array.ok) return array;
  const bindings: ReadinessEvidenceBinding[] = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const binding = inspectEvidenceBinding(
      array.value[index],
      childPath(path, String(index)),
      code,
    );
    if (!binding.ok) return binding;
    bindings.push(binding.value);
  }
  for (let index = 1; index < bindings.length; index += 1) {
    const comparison = compareBindings(bindings[index - 1]!, bindings[index]!);
    if (comparison > 0) {
      return reject(code, childPath(path, String(index)), "invalid_scalar");
    }
    if (comparison === 0) {
      return reject(
        code,
        childPath(path, String(index)),
        "duplicate_entry",
        bindings[index]!.evidenceRef,
      );
    }
  }
  return accept(Object.freeze(bindings));
}

function inspectOrderedReasons(
  value: unknown,
  path: string,
  code: ReadinessRejectionCode,
): ReadinessResult<readonly ReadinessReasonCode[]> {
  const array = inspectExactArray(value, code, path);
  if (!array.ok) return array;
  const reasons: ReadinessReasonCode[] = [];
  let previousRank = -1;
  for (let index = 0; index < array.value.length; index += 1) {
    const reason = validateEnum(
      array.value[index],
      READINESS_REASON_ORDER,
      code,
      childPath(path, String(index)),
    );
    if (!reason.ok) return reason;
    const rank = REASON_RANK.get(reason.value) as number;
    if (rank <= previousRank) {
      return reject(
        code,
        childPath(path, String(index)),
        rank === previousRank ? "duplicate_entry" : "invalid_scalar",
        reason.value,
      );
    }
    previousRank = rank;
    reasons.push(reason.value);
  }
  return accept(Object.freeze(reasons));
}

export function validateAssessmentSemanticConsistency(
  assessment: ReadinessAssessment,
  path = "",
  code: ReadinessRejectionCode = "invalid_lineage",
  allowEpicNotApplicable = false,
): ReadinessResult<ReadinessAssessment> {
  if (
    allowEpicNotApplicable &&
    assessment.candidate.subject.kind === "epic" &&
    assessment.applicability === "not_applicable"
  ) {
    return accept(assessment);
  }

  const reasons = new Set(assessment.reasonCodes);
  const mustDecompose = reasons.has("semantic_must_decompose") ||
    reasons.has("quantitative_severe_overrun");
  const needsRefinement = reasons.has("semantic_needs_refinement") ||
    (reasons.has("quantitative_minor_overrun") &&
      !reasons.has("quantitative_exception_applied"));
  const blockedReasons: readonly ReadinessReasonCode[] = [
    "missing_applicability_policy",
    "ambiguous_applicability_policy",
    "applicability_policy_mismatch",
    "missing_semantic_evidence",
    "ambiguous_semantic_evidence",
    "missing_quantitative_evidence",
    "ambiguous_quantitative_evidence",
    "quantitative_finding_mismatch",
    "missing_repository_feasibility",
    "ambiguous_repository_feasibility",
    "repository_feasibility_blocked",
    "wrong_candidate_evidence",
    "evidence_integrity_failure",
    "evidence_provenance_failure",
    "invalid_quantitative_exception",
  ];
  const blocked = blockedReasons.some((reason) => reasons.has(reason));
  const derivedDisposition: ReadinessDisposition = mustDecompose
    ? "must_decompose"
    : needsRefinement
      ? "needs_refinement"
      : blocked
        ? "blocked"
        : "ready";
  if (assessment.disposition !== derivedDisposition) {
    return reject(code, childPath(path, "disposition"), "invalid_scalar", assessment.assessmentRef);
  }
  if (
    reasons.has("not_applicable_by_policy") &&
    assessment.applicability !== "not_applicable"
  ) {
    return reject(code, childPath(path, "reasonCodes"), "invalid_scalar", assessment.assessmentRef);
  }
  if (
    reasons.has("quantitative_exception_applied") &&
    !reasons.has("quantitative_minor_overrun")
  ) {
    return reject(code, childPath(path, "reasonCodes"), "invalid_scalar", assessment.assessmentRef);
  }

  if (assessment.disposition !== "ready") return accept(assessment);
  const identities = new Set<string>();
  const counts = new Map<EvidenceKind, number>();
  for (const binding of assessment.evidence) {
    if (identities.has(binding.evidenceRef)) {
      return reject(code, childPath(path, "evidence"), "duplicate_entry", binding.evidenceRef);
    }
    identities.add(binding.evidenceRef);
    counts.set(binding.kind, (counts.get(binding.kind) ?? 0) + 1);
  }
  const count = (kind: EvidenceKind): number => counts.get(kind) ?? 0;

  if (assessment.applicability === "not_applicable") {
    if (
      assessment.candidate.subject.kind !== "initiative" ||
      assessment.evidence.length !== 1 ||
      count("applicability_policy") !== 1 ||
      assessment.reasonCodes.length !== 1 ||
      assessment.reasonCodes[0] !== "not_applicable_by_policy"
    ) {
      return reject(code, path, "invalid_scalar", assessment.assessmentRef);
    }
    return accept(assessment);
  }

  const policyCount = assessment.candidate.subject.kind === "initiative" ? 1 : 0;
  const exceptionCount = count("quantitative_exception");
  const authorityCount = count("authority");
  const hasPair = exceptionCount === 1 && authorityCount === 1;
  const hasNoPair = exceptionCount === 0 && authorityCount === 0;
  const exactInventory =
    (hasPair || hasNoPair) &&
    count("semantic") === 1 &&
    count("quantitative") === 1 &&
    count("repository_feasibility") === 1 &&
    count("applicability_policy") === policyCount &&
    assessment.evidence.length === 3 + policyCount + (hasPair ? 2 : 0);
  const exactReasons = hasPair
    ? assessment.reasonCodes.length === 2 &&
      assessment.reasonCodes[0] === "quantitative_minor_overrun" &&
      assessment.reasonCodes[1] === "quantitative_exception_applied"
    : assessment.reasonCodes.length === 0;
  return exactInventory && exactReasons
    ? accept(assessment)
    : reject(code, path, "invalid_scalar", assessment.assessmentRef);
}

/**
 * Validates the portable assessment bytes without applying consumer-specific
 * semantics. In particular, Epic/not_applicable remains structurally
 * inspectable so qualification can report its approved successful-negative
 * reason instead of turning it into an unrelated parse failure.
 */
export function inspectReadinessAssessment(
  value: unknown,
  path = "",
  code: ReadinessRejectionCode = "invalid_lineage",
): ReadinessResult<ReadinessAssessment> {
  const object = inspectExactObject(
    value,
    [
      "assessmentRef",
      "candidate",
      "applicability",
      "disposition",
      "evidence",
      "evidenceSetSha256",
      "reasonCodes",
      "sequence",
      "previousAssessmentRef",
      "previousAssessmentSha256",
      "canonicalSha256",
    ],
    code,
    path,
  );
  if (!object.ok) return object;

  const assessmentRef = validateDomainScalar(
    "EvidenceRef",
    field(object.value, "assessmentRef"),
    code,
    childPath(path, "assessmentRef"),
  );
  if (!assessmentRef.ok) return assessmentRef;
  const candidate = remapRejection(
    inspectCandidateBinding(field(object.value, "candidate"), childPath(path, "candidate")),
    code,
  );
  if (!candidate.ok) return candidate;
  const applicability = validateEnum(
    field(object.value, "applicability"),
    ["applicable", "not_applicable"] as const,
    code,
    childPath(path, "applicability"),
  );
  if (!applicability.ok) return applicability;
  if (applicability.value !== candidate.value.applicability) {
    return reject(
      code,
      childPath(path, "applicability"),
      "invalid_scalar",
      assessmentRef.value,
    );
  }
  const disposition = validateEnum(
    field(object.value, "disposition"),
    DISPOSITIONS,
    code,
    childPath(path, "disposition"),
  );
  if (!disposition.ok) return disposition;
  const evidence = inspectOrderedBindings(
    field(object.value, "evidence"),
    childPath(path, "evidence"),
    code,
  );
  if (!evidence.ok) return evidence;
  const evidenceSetSha256 = validateSha256(
    field(object.value, "evidenceSetSha256"),
    code,
    childPath(path, "evidenceSetSha256"),
  );
  if (!evidenceSetSha256.ok) return evidenceSetSha256;
  const recomputedEvidenceSet = canonicalHash(evidence.value, code, childPath(path, "evidence"));
  if (!recomputedEvidenceSet.ok) return recomputedEvidenceSet;
  if (recomputedEvidenceSet.value.digest !== evidenceSetSha256.value) {
    return reject(
      code,
      childPath(path, "evidenceSetSha256"),
      "invalid_canonical_hash",
      assessmentRef.value,
    );
  }
  const reasons = inspectOrderedReasons(
    field(object.value, "reasonCodes"),
    childPath(path, "reasonCodes"),
    code,
  );
  if (!reasons.ok) return reasons;
  const sequence = validateDomainScalar(
    "PositiveOrdinal",
    field(object.value, "sequence"),
    code,
    childPath(path, "sequence"),
  );
  if (!sequence.ok) return sequence;

  const previousRefValue = field(object.value, "previousAssessmentRef");
  let previousAssessmentRef: EvidenceRef | null = null;
  if (previousRefValue !== null) {
    const previousRef = validateDomainScalar(
      "EvidenceRef",
      previousRefValue,
      code,
      childPath(path, "previousAssessmentRef"),
    );
    if (!previousRef.ok) return previousRef;
    previousAssessmentRef = previousRef.value as EvidenceRef;
  }
  const previousHashValue = field(object.value, "previousAssessmentSha256");
  let previousAssessmentSha256: Sha256Digest | null = null;
  if (previousHashValue !== null) {
    const previousHash = validateSha256(
      previousHashValue,
      code,
      childPath(path, "previousAssessmentSha256"),
    );
    if (!previousHash.ok) return previousHash;
    previousAssessmentSha256 = previousHash.value;
  }
  if ((previousAssessmentRef === null) !== (previousAssessmentSha256 === null)) {
    return reject(
      code,
      childPath(path, "previousAssessmentRef"),
      "history_predecessor_mismatch",
      assessmentRef.value,
    );
  }
  if ((sequence.value === 1) !== (previousAssessmentRef === null)) {
    return reject(
      code,
      childPath(path, "previousAssessmentRef"),
      "history_predecessor_mismatch",
      assessmentRef.value,
    );
  }
  const claimedDigest = validateSha256(
    field(object.value, "canonicalSha256"),
    code,
    childPath(path, "canonicalSha256"),
  );
  if (!claimedDigest.ok) return claimedDigest;

  const unhashed = Object.freeze({
    assessmentRef: assessmentRef.value as EvidenceRef,
    candidate: candidate.value,
    applicability: applicability.value,
    disposition: disposition.value,
    evidence: evidence.value,
    evidenceSetSha256: evidenceSetSha256.value,
    reasonCodes: reasons.value,
    sequence: sequence.value as PositiveOrdinal,
    previousAssessmentRef,
    previousAssessmentSha256,
  });
  const canonical = canonicalHash(unhashed, code, path);
  if (!canonical.ok) return canonical;
  if (canonical.value.digest !== claimedDigest.value) {
    return reject(
      code,
      childPath(path, "canonicalSha256"),
      "invalid_canonical_hash",
      assessmentRef.value,
    );
  }
  return accept(Object.freeze({
    ...(canonical.value.value as typeof unhashed),
    canonicalSha256: canonical.value.digest,
  }));
}

function validateHistory(
  value: unknown,
  candidate: ReadinessCandidateBinding,
): ReadinessResult<readonly ReadinessAssessment[]> {
  const array = inspectExactArray(value, "invalid_lineage", "/history");
  if (!array.ok) return array;
  const history: ReadinessAssessment[] = [];
  const identities = new Set<string>();
  const fingerprints = new Set<string>();

  for (let index = 0; index < array.value.length; index += 1) {
    const path = `/history/${index}`;
    const assessment = inspectReadinessAssessment(array.value[index], path);
    if (!assessment.ok) return assessment;
    const current = assessment.value;
    if (
      current.candidate.subject.kind === "epic" &&
      current.candidate.applicability === "not_applicable"
    ) {
      return reject(
        "invalid_lineage",
        `${path}/candidate/applicability`,
        "epic_not_applicable",
        current.assessmentRef,
      );
    }
    const semantic = validateAssessmentSemanticConsistency(current, path);
    if (!semantic.ok) return semantic;
    if (!sameSubject(current.candidate, candidate)) {
      return reject(
        "invalid_lineage",
        `${path}/candidate/subject`,
        "history_subject_mismatch",
        current.assessmentRef,
      );
    }
    if (identities.has(current.assessmentRef)) {
      return reject(
        "invalid_lineage",
        `${path}/assessmentRef`,
        "duplicate_entry",
        current.assessmentRef,
      );
    }
    identities.add(current.assessmentRef);

    const expectedSequence = index + 1;
    if (current.sequence !== expectedSequence) {
      return reject(
        "invalid_lineage",
        `${path}/sequence`,
        "history_sequence_gap",
        current.assessmentRef,
      );
    }
    if (index === 0) {
      if (
        current.previousAssessmentRef !== null ||
        current.previousAssessmentSha256 !== null
      ) {
        return reject(
          "invalid_lineage",
          `${path}/previousAssessmentRef`,
          "history_predecessor_mismatch",
          current.assessmentRef,
        );
      }
    } else {
      const previous = history[index - 1] as ReadinessAssessment;
      if (
        current.previousAssessmentRef !== previous.assessmentRef ||
        current.previousAssessmentSha256 !== previous.canonicalSha256
      ) {
        const earlier = history.slice(0, -1).some((entry) =>
          entry.assessmentRef === current.previousAssessmentRef &&
          entry.canonicalSha256 === current.previousAssessmentSha256
        );
        return reject(
          "invalid_lineage",
          `${path}/previousAssessmentRef`,
          earlier ? "history_fork" : "history_predecessor_mismatch",
          current.assessmentRef,
        );
      }
    }

    const fingerprint = `${current.candidate.canonicalSha256}\u0000${current.evidenceSetSha256}\u0000${current.previousAssessmentSha256 ?? ""}`;
    if (fingerprints.has(fingerprint)) {
      return reject(
        "duplicate_assessment",
        path,
        "duplicate_assessment_fingerprint",
        current.assessmentRef,
      );
    }
    fingerprints.add(fingerprint);
    history.push(current);
  }
  return accept(Object.freeze(history));
}

function deriveAssessment(
  assessmentRef: EvidenceRef,
  candidate: ReadinessCandidateBinding,
  evidence: readonly GovernanceEvidence[],
  history: readonly ReadinessAssessment[],
): ReadinessResult<ReadinessAssessment> {
  const reasons = new Set<ReadinessReasonCode>();
  const dispositionCandidates: ReadinessDisposition[] = [];
  const block = (reason: ReadinessReasonCode): void => {
    reasons.add(reason);
    dispositionCandidates.push("blocked");
  };

  const byRef = new Map<string, Sha256Digest>();
  for (const item of evidence) {
    const previous = byRef.get(item.evidenceRef);
    if (previous === item.canonicalSha256) {
      return reject(
        "invalid_evidence",
        "/evidence",
        "duplicate_entry",
        item.evidenceRef,
      );
    }
    if (previous !== undefined && previous !== item.canonicalSha256) {
      block("evidence_integrity_failure");
    } else {
      byRef.set(item.evidenceRef, item.canonicalSha256);
    }
  }

  const correctCandidate = evidence.filter((item) => {
    if (item.candidateSha256 !== candidate.canonicalSha256) {
      block("wrong_candidate_evidence");
      return false;
    }
    return true;
  });
  if (evidence.some((item) =>
    item.kind === "quantitative_exception" &&
    item.candidateSha256 !== candidate.canonicalSha256
  )) {
    block("invalid_quantitative_exception");
  }
  const locallyValid = correctCandidate.filter((item) => {
    if (!isLocallyProvenant(item)) {
      block("evidence_provenance_failure");
      return false;
    }
    return true;
  });

  const byKind = <K extends EvidenceKind>(kind: K): GovernanceEvidence[] =>
    locallyValid.filter((item) => item.kind === kind);

  const policyEvidence = byKind("applicability_policy");
  if (candidate.subject.kind === "epic") {
    if (policyEvidence.length > 0) block("evidence_provenance_failure");
  } else if (policyEvidence.length === 0) {
    block("missing_applicability_policy");
  } else if (policyEvidence.length > 1) {
    block("ambiguous_applicability_policy");
  } else {
    const policy = policyEvidence[0]!.payload as ApplicabilityPolicyEvidencePayload;
    if (
      policy.policyRef !== candidate.policy.ref ||
      policy.profileRevision !== candidate.policy.profileRevision ||
      policy.applicability !== candidate.applicability
    ) {
      block("applicability_policy_mismatch");
    } else if (candidate.applicability === "not_applicable") {
      reasons.add("not_applicable_by_policy");
      dispositionCandidates.push("ready");
    }
  }

  if (candidate.applicability === "not_applicable") {
    if (evidence.some((item) => item.kind === "quantitative_exception")) {
      block("invalid_quantitative_exception");
    }
    if (locallyValid.some((item) => item.kind !== "applicability_policy")) {
      block("evidence_provenance_failure");
    }
  } else {
    const semantic = byKind("semantic");
    if (semantic.length === 0) {
      block("missing_semantic_evidence");
    } else if (semantic.length > 1) {
      block("ambiguous_semantic_evidence");
    } else {
      const payload = semantic[0]!.payload as SemanticEvidencePayload;
      if (payload.finding === "needs_refinement") {
        reasons.add("semantic_needs_refinement");
        dispositionCandidates.push("needs_refinement");
      } else if (payload.finding === "must_decompose") {
        reasons.add("semantic_must_decompose");
        dispositionCandidates.push("must_decompose");
      } else {
        dispositionCandidates.push("ready");
      }
    }

    const quantitative = byKind("quantitative");
    let validMinor: GovernanceEvidence | null = null;
    if (quantitative.length === 0) {
      block("missing_quantitative_evidence");
    } else if (quantitative.length > 1) {
      block("ambiguous_quantitative_evidence");
    } else {
      const record = quantitative[0]!;
      const payload = record.payload as QuantitativeEvidencePayload;
      const expected = expectedQuantitativeFinding(payload.estimatedActiveMinutes);
      if (payload.finding !== expected) {
        block("quantitative_finding_mismatch");
      } else if (expected === "minor_overrun") {
        reasons.add("quantitative_minor_overrun");
        validMinor = record;
      } else if (expected === "severe_overrun") {
        reasons.add("quantitative_severe_overrun");
        dispositionCandidates.push("must_decompose");
      } else {
        dispositionCandidates.push("ready");
      }
    }

    const repositories = byKind("repository_feasibility");
    const matchingRepositories = repositories.filter((record) => {
      const payload = record.payload as RepositoryFeasibilityEvidencePayload;
      if (
        payload.repositoryId !== candidate.repository.id ||
        payload.baseRevision !== candidate.repository.baseRevision
      ) {
        block("evidence_provenance_failure");
        return false;
      }
      return true;
    });
    if (matchingRepositories.length === 0) {
      block("missing_repository_feasibility");
    } else if (matchingRepositories.length > 1) {
      block("ambiguous_repository_feasibility");
    } else {
      const payload = matchingRepositories[0]!.payload as RepositoryFeasibilityEvidencePayload;
      if (payload.finding === "blocked") {
        block("repository_feasibility_blocked");
      } else {
        dispositionCandidates.push("ready");
      }
    }

    const allCorrectExceptions = correctCandidate.filter((item) =>
      item.kind === "quantitative_exception"
    );
    const exceptions = byKind("quantitative_exception");
    const authorities = byKind("authority");
    let exceptionApplied = false;
    if (allCorrectExceptions.length > 0) {
      if (
        allCorrectExceptions.length === 1 &&
        exceptions.length === 1 &&
        authorities.length === 1 &&
        validMinor !== null
      ) {
        const exception = exceptions[0]!;
        const exceptionPayload = exception.payload as QuantitativeExceptionEvidencePayload;
        const authority = authorities[0]!;
        const authorityPayload = authority.payload as AuthorityEvidencePayload;
        exceptionApplied =
          exceptionPayload.quantitativeEvidenceRef === validMinor.evidenceRef &&
          exceptionPayload.authorityEvidenceRef === authority.evidenceRef &&
          exception.producer.authorityEvidenceRef === authority.evidenceRef &&
          exceptionPayload.decisionRef === authorityPayload.decisionRef &&
          exception.producer.actorRef === authority.producer.actorRef;
      }
      if (exceptionApplied) {
        reasons.add("quantitative_exception_applied");
      } else {
        block("invalid_quantitative_exception");
      }
    }
    if (validMinor !== null) {
      dispositionCandidates.push(exceptionApplied ? "ready" : "needs_refinement");
    }
    if (!exceptionApplied && authorities.length > 0) {
      block("evidence_provenance_failure");
    }
  }

  if (dispositionCandidates.length === 0) {
    dispositionCandidates.push("ready");
  }
  const disposition = dispositionCandidates.reduce((selected, next) =>
    DISPOSITION_RANK[next] > DISPOSITION_RANK[selected] ? next : selected
  );
  const reasonCodes = Object.freeze(
    [...reasons].sort((left, right) =>
      (REASON_RANK.get(left) as number) - (REASON_RANK.get(right) as number)
    ),
  );
  const bindings = Object.freeze(
    evidence
      .map((item) => Object.freeze({
        evidenceRef: item.evidenceRef,
        kind: item.kind,
        canonicalSha256: item.canonicalSha256,
      }))
      .sort(compareBindings),
  );
  const evidenceSet = canonicalHash(bindings, "invalid_evidence", "/evidence");
  if (!evidenceSet.ok) return evidenceSet;
  const previous = history.length === 0 ? null : history[history.length - 1]!;
  const unhashed = Object.freeze({
    assessmentRef,
    candidate,
    applicability: candidate.applicability,
    disposition,
    evidence: bindings,
    evidenceSetSha256: evidenceSet.value.digest,
    reasonCodes,
    sequence: (history.length + 1) as PositiveOrdinal,
    previousAssessmentRef: previous?.assessmentRef ?? null,
    previousAssessmentSha256: previous?.canonicalSha256 ?? null,
  });
  const canonical = canonicalHash(unhashed, "invalid_input");
  if (!canonical.ok) return canonical;
  return accept(Object.freeze({
    ...(canonical.value.value as typeof unhashed),
    canonicalSha256: canonical.value.digest,
  }));
}

export function assessReadiness(
  input: AssessReadinessInput,
): ReadinessResult<ReadinessAssessment> {
  const object = inspectExactObject(
    input,
    ["assessmentRef", "candidate", "evidence", "history"],
    "invalid_input",
    "",
  );
  if (!object.ok) return object;
  const assessmentRef = validateDomainScalar(
    "EvidenceRef",
    field(object.value, "assessmentRef"),
    "invalid_input",
    "/assessmentRef",
  );
  if (!assessmentRef.ok) return assessmentRef;
  const candidate = validateCandidateBinding(field(object.value, "candidate"), "/candidate");
  if (!candidate.ok) return candidate;
  const evidenceArray = inspectExactArray(field(object.value, "evidence"), "invalid_evidence", "/evidence");
  if (!evidenceArray.ok) return evidenceArray;
  const evidence: GovernanceEvidence[] = [];
  for (let index = 0; index < evidenceArray.value.length; index += 1) {
    const inspected = inspectGovernanceEvidence(
      evidenceArray.value[index],
      `/evidence/${index}`,
    );
    if (!inspected.ok) return inspected;
    evidence.push(inspected.value);
  }
  const exactEvidenceIdentities = new Map<string, Sha256Digest>();
  for (let index = 0; index < evidence.length; index += 1) {
    const item = evidence[index]!;
    const previousDigest = exactEvidenceIdentities.get(item.evidenceRef);
    if (previousDigest === item.canonicalSha256) {
      return reject(
        "invalid_evidence",
        `/evidence/${index}`,
        "duplicate_entry",
        item.evidenceRef,
      );
    }
    if (previousDigest === undefined) {
      exactEvidenceIdentities.set(item.evidenceRef, item.canonicalSha256);
    }
  }
  const history = validateHistory(field(object.value, "history"), candidate.value);
  if (!history.ok) return history;
  if (history.value.some((item) => item.assessmentRef === assessmentRef.value)) {
    return reject(
      "invalid_lineage",
      "/assessmentRef",
      "duplicate_entry",
      assessmentRef.value,
    );
  }

  const head = history.value.length === 0
    ? null
    : history.value[history.value.length - 1]!;
  if (
    head !== null &&
    head.candidate.canonicalSha256 === candidate.value.canonicalSha256 &&
    (head.disposition !== "blocked" || head.applicability === "not_applicable")
  ) {
    return reject(
      "invalid_lineage",
      "/candidate/canonicalSha256",
      "candidate_reuse_forbidden",
      head.assessmentRef,
    );
  }

  const derived = deriveAssessment(
    assessmentRef.value as EvidenceRef,
    candidate.value,
    Object.freeze(evidence),
    history.value,
  );
  if (!derived.ok) return derived;
  const newFingerprint = `${derived.value.candidate.canonicalSha256}\u0000${derived.value.evidenceSetSha256}\u0000${derived.value.previousAssessmentSha256 ?? ""}`;
  for (const prior of history.value) {
    const priorFingerprint = `${prior.candidate.canonicalSha256}\u0000${prior.evidenceSetSha256}\u0000${prior.previousAssessmentSha256 ?? ""}`;
    if (priorFingerprint === newFingerprint) {
      return reject(
        "duplicate_assessment",
        "",
        "duplicate_assessment_fingerprint",
        prior.assessmentRef,
      );
    }
  }
  return derived;
}
