import type {
  ActorRef,
  DecisionRef,
  EvidenceRef,
  LaunchPermitId,
  ReasonRef,
  RepositoryId,
  RoleRunId,
} from "@pi-workflow/v2-domain";

import {
  accept,
  canonicalHash,
  childPath,
  field,
  inspectExactObject,
  reject,
  validateDomainScalar,
  validateEnum,
  validatePositiveSafeInteger,
  validateSha256,
  validateSourceRevision,
  validateUniqueSortedStrings,
} from "./internal.js";
import type {
  ApplicabilityPolicyEvidencePayload,
  AuthorityEvidencePayload,
  CreateGovernanceEvidenceInput,
  EvidenceKind,
  EvidenceProducer,
  EvidenceProducerKind,
  GovernanceEvidence,
  GovernanceEvidencePayload,
  QuantitativeEvidencePayload,
  QuantitativeExceptionEvidencePayload,
  ReadinessApplicability,
  ReadinessResult,
  RepositoryFeasibilityEvidencePayload,
  SemanticEvidencePayload,
  Sha256Digest,
  SourceRevision,
} from "./types.js";

const EVIDENCE_KINDS = [
  "semantic",
  "quantitative",
  "repository_feasibility",
  "applicability_policy",
  "quantitative_exception",
  "authority",
] as const;
const PRODUCER_KINDS = [
  "product_ai",
  "engineering_lead",
  "human_governor",
  "deterministic_evaluator",
] as const;
const TRUST = ["untrusted", "trusted", "verified", "human"] as const;

type EvidenceParts = Readonly<{
  input: CreateGovernanceEvidenceInput;
  claimedDigest: Sha256Digest | null;
}>;

function scalar<K extends "EvidenceRef" | "ActorRef" | "RepositoryId" | "RoleRunId" | "LaunchPermitId" | "DecisionRef" | "ReasonRef">(
  kind: K,
  value: unknown,
  path: string,
) {
  return validateDomainScalar(kind, value, "invalid_evidence", path);
}

function inspectProducer(value: unknown, path: string): ReadinessResult<EvidenceProducer> {
  const inspected = inspectExactObject(
    value,
    ["kind", "actorRef", "authorityEvidenceRef", "selfReportedTrust"],
    "invalid_evidence",
    path,
  );
  if (!inspected.ok) return inspected;
  const kind = validateEnum(field(inspected.value, "kind"), PRODUCER_KINDS, "invalid_evidence", childPath(path, "kind"));
  if (!kind.ok) return kind;
  const actor = scalar("ActorRef", field(inspected.value, "actorRef"), childPath(path, "actorRef"));
  if (!actor.ok) return actor;

  const authorityValue = field(inspected.value, "authorityEvidenceRef");
  let authority: EvidenceRef | null = null;
  if (authorityValue !== null) {
    const parsed = scalar("EvidenceRef", authorityValue, childPath(path, "authorityEvidenceRef"));
    if (!parsed.ok) return parsed;
    authority = parsed.value;
  }

  const trustValue = field(inspected.value, "selfReportedTrust");
  let trust: EvidenceProducer["selfReportedTrust"] = null;
  if (trustValue !== null) {
    const parsed = validateEnum(trustValue, TRUST, "invalid_evidence", childPath(path, "selfReportedTrust"));
    if (!parsed.ok) return parsed;
    trust = parsed.value;
  }
  return accept(Object.freeze({
    kind: kind.value as EvidenceProducerKind,
    actorRef: actor.value as ActorRef,
    authorityEvidenceRef: authority,
    selfReportedTrust: trust,
  }));
}

function inspectPayload(kind: EvidenceKind, value: unknown, path: string): ReadinessResult<GovernanceEvidencePayload> {
  switch (kind) {
    case "semantic": {
      const object = inspectExactObject(value, ["kind", "finding", "requirementRefs"], "invalid_evidence", path);
      if (!object.ok) return object;
      const payloadKind = validateEnum(field(object.value, "kind"), EVIDENCE_KINDS, "invalid_evidence", childPath(path, "kind"));
      if (!payloadKind.ok) return payloadKind;
      const finding = validateEnum(field(object.value, "finding"), ["pass", "needs_refinement", "must_decompose"] as const, "invalid_evidence", childPath(path, "finding"));
      if (!finding.ok) return finding;
      const refs = validateUniqueSortedStrings(field(object.value, "requirementRefs"), "EvidenceRef", "invalid_evidence", childPath(path, "requirementRefs"), true);
      if (!refs.ok) return refs;
      return accept(Object.freeze({ kind: payloadKind.value, finding: finding.value, requirementRefs: refs.value as readonly EvidenceRef[] }) as SemanticEvidencePayload);
    }
    case "quantitative": {
      const object = inspectExactObject(value, ["kind", "estimatedActiveMinutes", "finding"], "invalid_evidence", path);
      if (!object.ok) return object;
      const payloadKind = validateEnum(field(object.value, "kind"), EVIDENCE_KINDS, "invalid_evidence", childPath(path, "kind"));
      if (!payloadKind.ok) return payloadKind;
      const minutes = validatePositiveSafeInteger(field(object.value, "estimatedActiveMinutes"), "invalid_evidence", childPath(path, "estimatedActiveMinutes"));
      if (!minutes.ok) return minutes;
      const finding = validateEnum(field(object.value, "finding"), ["within_budget", "minor_overrun", "severe_overrun"] as const, "invalid_evidence", childPath(path, "finding"));
      if (!finding.ok) return finding;
      return accept(Object.freeze({ kind: payloadKind.value, estimatedActiveMinutes: minutes.value, finding: finding.value }) as QuantitativeEvidencePayload);
    }
    case "repository_feasibility": {
      const object = inspectExactObject(value, ["kind", "finding", "repositoryId", "baseRevision", "roleRunId", "launchPermitId"], "invalid_evidence", path);
      if (!object.ok) return object;
      const payloadKind = validateEnum(field(object.value, "kind"), EVIDENCE_KINDS, "invalid_evidence", childPath(path, "kind"));
      if (!payloadKind.ok) return payloadKind;
      const finding = validateEnum(field(object.value, "finding"), ["feasible", "blocked"] as const, "invalid_evidence", childPath(path, "finding"));
      if (!finding.ok) return finding;
      const repositoryId = scalar("RepositoryId", field(object.value, "repositoryId"), childPath(path, "repositoryId"));
      if (!repositoryId.ok) return repositoryId;
      const baseRevision = validateSourceRevision(field(object.value, "baseRevision"), "invalid_evidence", childPath(path, "baseRevision"));
      if (!baseRevision.ok) return baseRevision;
      const roleRunId = scalar("RoleRunId", field(object.value, "roleRunId"), childPath(path, "roleRunId"));
      if (!roleRunId.ok) return roleRunId;
      const launchPermitId = scalar("LaunchPermitId", field(object.value, "launchPermitId"), childPath(path, "launchPermitId"));
      if (!launchPermitId.ok) return launchPermitId;
      return accept(Object.freeze({ kind: payloadKind.value, finding: finding.value, repositoryId: repositoryId.value as RepositoryId, baseRevision: baseRevision.value as SourceRevision, roleRunId: roleRunId.value as RoleRunId, launchPermitId: launchPermitId.value as LaunchPermitId }) as RepositoryFeasibilityEvidencePayload);
    }
    case "applicability_policy": {
      const object = inspectExactObject(value, ["kind", "subjectKind", "applicability", "policyRef", "profileRevision"], "invalid_evidence", path);
      if (!object.ok) return object;
      const payloadKind = validateEnum(field(object.value, "kind"), EVIDENCE_KINDS, "invalid_evidence", childPath(path, "kind"));
      if (!payloadKind.ok) return payloadKind;
      const subjectKind = validateEnum(field(object.value, "subjectKind"), ["initiative"] as const, "invalid_evidence", childPath(path, "subjectKind"));
      if (!subjectKind.ok) return subjectKind;
      const applicability = validateEnum(field(object.value, "applicability"), ["applicable", "not_applicable"] as const, "invalid_evidence", childPath(path, "applicability"));
      if (!applicability.ok) return applicability;
      const policyRef = scalar("EvidenceRef", field(object.value, "policyRef"), childPath(path, "policyRef"));
      if (!policyRef.ok) return policyRef;
      const profileRevision = validateSourceRevision(field(object.value, "profileRevision"), "invalid_evidence", childPath(path, "profileRevision"));
      if (!profileRevision.ok) return profileRevision;
      return accept(Object.freeze({ kind: payloadKind.value, subjectKind: subjectKind.value, applicability: applicability.value as ReadinessApplicability, policyRef: policyRef.value as EvidenceRef, profileRevision: profileRevision.value as SourceRevision }) as ApplicabilityPolicyEvidencePayload);
    }
    case "quantitative_exception": {
      const object = inspectExactObject(value, ["kind", "quantitativeEvidenceRef", "decisionRef", "authorityEvidenceRef", "rationaleRef"], "invalid_evidence", path);
      if (!object.ok) return object;
      const payloadKind = validateEnum(field(object.value, "kind"), EVIDENCE_KINDS, "invalid_evidence", childPath(path, "kind"));
      if (!payloadKind.ok) return payloadKind;
      const quantitativeEvidenceRef = scalar("EvidenceRef", field(object.value, "quantitativeEvidenceRef"), childPath(path, "quantitativeEvidenceRef"));
      if (!quantitativeEvidenceRef.ok) return quantitativeEvidenceRef;
      const decisionRef = scalar("DecisionRef", field(object.value, "decisionRef"), childPath(path, "decisionRef"));
      if (!decisionRef.ok) return decisionRef;
      const authorityEvidenceRef = scalar("EvidenceRef", field(object.value, "authorityEvidenceRef"), childPath(path, "authorityEvidenceRef"));
      if (!authorityEvidenceRef.ok) return authorityEvidenceRef;
      const rationaleRef = scalar("ReasonRef", field(object.value, "rationaleRef"), childPath(path, "rationaleRef"));
      if (!rationaleRef.ok) return rationaleRef;
      return accept(Object.freeze({ kind: payloadKind.value, quantitativeEvidenceRef: quantitativeEvidenceRef.value as EvidenceRef, decisionRef: decisionRef.value as DecisionRef, authorityEvidenceRef: authorityEvidenceRef.value as EvidenceRef, rationaleRef: rationaleRef.value as ReasonRef }) as QuantitativeExceptionEvidencePayload);
    }
    case "authority": {
      const object = inspectExactObject(value, ["kind", "authority", "decisionRef", "scope"], "invalid_evidence", path);
      if (!object.ok) return object;
      const payloadKind = validateEnum(field(object.value, "kind"), EVIDENCE_KINDS, "invalid_evidence", childPath(path, "kind"));
      if (!payloadKind.ok) return payloadKind;
      const authority = validateEnum(field(object.value, "authority"), ["human_portfolio_governor"] as const, "invalid_evidence", childPath(path, "authority"));
      if (!authority.ok) return authority;
      const decisionRef = scalar("DecisionRef", field(object.value, "decisionRef"), childPath(path, "decisionRef"));
      if (!decisionRef.ok) return decisionRef;
      const scope = validateEnum(field(object.value, "scope"), ["readiness_quantitative_exception"] as const, "invalid_evidence", childPath(path, "scope"));
      if (!scope.ok) return scope;
      return accept(Object.freeze({ kind: payloadKind.value, authority: authority.value, decisionRef: decisionRef.value as DecisionRef, scope: scope.value }) as AuthorityEvidencePayload);
    }
  }
}

function inspectParts(value: unknown, path: string, withDigest: boolean): ReadinessResult<EvidenceParts> {
  const expected = ["evidenceRef", "kind", "candidateSha256", "sourceRef", "sourceRevision", "producer", "payload", ...(withDigest ? ["canonicalSha256"] : [])];
  const object = inspectExactObject(value, expected, "invalid_evidence", path);
  if (!object.ok) return object;
  const evidenceRef = scalar("EvidenceRef", field(object.value, "evidenceRef"), childPath(path, "evidenceRef"));
  if (!evidenceRef.ok) return evidenceRef;
  const kind = validateEnum(field(object.value, "kind"), EVIDENCE_KINDS, "invalid_evidence", childPath(path, "kind"));
  if (!kind.ok) return kind;
  const candidateSha256 = validateSha256(field(object.value, "candidateSha256"), "invalid_evidence", childPath(path, "candidateSha256"));
  if (!candidateSha256.ok) return candidateSha256;
  const sourceRef = scalar("EvidenceRef", field(object.value, "sourceRef"), childPath(path, "sourceRef"));
  if (!sourceRef.ok) return sourceRef;
  const sourceRevision = validateSourceRevision(field(object.value, "sourceRevision"), "invalid_evidence", childPath(path, "sourceRevision"));
  if (!sourceRevision.ok) return sourceRevision;
  const producer = inspectProducer(field(object.value, "producer"), childPath(path, "producer"));
  if (!producer.ok) return producer;
  const payload = inspectPayload(kind.value, field(object.value, "payload"), childPath(path, "payload"));
  if (!payload.ok) return payload;

  let claimedDigest: Sha256Digest | null = null;
  if (withDigest) {
    const digest = validateSha256(field(object.value, "canonicalSha256"), "invalid_evidence", childPath(path, "canonicalSha256"));
    if (!digest.ok) return digest;
    claimedDigest = digest.value;
  }
  return accept(Object.freeze({
    input: Object.freeze({ evidenceRef: evidenceRef.value as EvidenceRef, kind: kind.value, candidateSha256: candidateSha256.value, sourceRef: sourceRef.value as EvidenceRef, sourceRevision: sourceRevision.value as SourceRevision, producer: producer.value, payload: payload.value }),
    claimedDigest,
  }));
}

function validateLocalSemantics(input: CreateGovernanceEvidenceInput, path: string): ReadinessResult<CreateGovernanceEvidenceInput> {
  if (input.payload.kind !== input.kind) {
    return reject("invalid_evidence", childPath(childPath(path, "payload"), "kind"), "payload_kind_mismatch");
  }
  if (input.evidenceRef === input.sourceRef) {
    return reject("invalid_evidence", childPath(path, "sourceRef"), "self_reference", input.evidenceRef);
  }
  if (input.producer.authorityEvidenceRef === input.evidenceRef) {
    return reject("invalid_provenance", childPath(childPath(path, "producer"), "authorityEvidenceRef"), "self_reference", input.evidenceRef);
  }

  const expectedProducer: Readonly<Record<EvidenceKind, EvidenceProducerKind>> = {
    semantic: "deterministic_evaluator",
    quantitative: "deterministic_evaluator",
    repository_feasibility: "engineering_lead",
    applicability_policy: "deterministic_evaluator",
    quantitative_exception: "human_governor",
    authority: "human_governor",
  };
  if (input.producer.kind !== expectedProducer[input.kind]) {
    return reject("invalid_provenance", childPath(childPath(path, "producer"), "kind"), "producer_not_authorized", input.evidenceRef);
  }

  if (input.kind === "quantitative_exception") {
    const payload = input.payload as QuantitativeExceptionEvidencePayload;
    if (
      input.producer.authorityEvidenceRef === null ||
      input.producer.authorityEvidenceRef !== payload.authorityEvidenceRef
    ) {
      return reject("invalid_provenance", childPath(childPath(path, "producer"), "authorityEvidenceRef"), "invalid_producer_authority", payload.authorityEvidenceRef);
    }
    if (payload.authorityEvidenceRef === input.evidenceRef) {
      return reject("invalid_provenance", childPath(childPath(path, "payload"), "authorityEvidenceRef"), "self_reference", input.evidenceRef);
    }
  } else if (input.producer.authorityEvidenceRef !== null) {
    return reject("invalid_provenance", childPath(childPath(path, "producer"), "authorityEvidenceRef"), "invalid_producer_authority", input.producer.authorityEvidenceRef);
  }

  if (input.kind === "quantitative") {
    const payload = input.payload as QuantitativeEvidencePayload;
    const expected = payload.estimatedActiveMinutes <= 120
      ? "within_budget"
      : payload.estimatedActiveMinutes <= 240
        ? "minor_overrun"
        : "severe_overrun";
    if (payload.finding !== expected) {
      return reject("invalid_evidence", childPath(childPath(path, "payload"), "finding"), "invalid_quantitative_finding", input.evidenceRef);
    }
  }
  return accept(input);
}

export function createGovernanceEvidence(input: CreateGovernanceEvidenceInput): ReadinessResult<GovernanceEvidence> {
  const inspected = inspectParts(input, "", false);
  if (!inspected.ok) return inspected;
  const semantic = validateLocalSemantics(inspected.value.input, "");
  if (!semantic.ok) return semantic;
  const canonical = canonicalHash(semantic.value, "invalid_evidence");
  if (!canonical.ok) return canonical;
  return accept(Object.freeze({ ...(canonical.value.value as CreateGovernanceEvidenceInput), canonicalSha256: canonical.value.digest }));
}

export function inspectGovernanceEvidence(value: unknown, path = ""): ReadinessResult<GovernanceEvidence> {
  const inspected = inspectParts(value, path, true);
  if (!inspected.ok) return inspected;
  const canonical = canonicalHash(inspected.value.input, "invalid_evidence", path);
  if (!canonical.ok) return canonical;
  if (canonical.value.digest !== inspected.value.claimedDigest) {
    return reject("invalid_evidence", childPath(path, "canonicalSha256"), "invalid_canonical_hash", inspected.value.input.evidenceRef);
  }
  return accept(Object.freeze({ ...(canonical.value.value as CreateGovernanceEvidenceInput), canonicalSha256: canonical.value.digest }));
}

export function validateGovernanceEvidence(value: unknown, path = ""): ReadinessResult<GovernanceEvidence> {
  const inspected = inspectGovernanceEvidence(value, path);
  if (!inspected.ok) return inspected;
  const { canonicalSha256: _canonicalSha256, ...input } = inspected.value;
  const semantic = validateLocalSemantics(input, path);
  return semantic.ok ? inspected : semantic;
}
