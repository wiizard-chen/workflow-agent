import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { canonicalizeJson } from "@pi-workflow/v2-domain";
import {
  assessReadiness,
  createGovernanceEvidence,
  createReadinessCandidateBinding,
} from "@pi-workflow/v2-readiness";

export const SHA = "a".repeat(64);

export function digest(value) {
  const canonical = canonicalizeJson(value);
  assert.equal(canonical.ok, true, canonical.ok ? undefined : canonical.rejection.reason);
  return createHash("sha256").update(canonical.text, "utf8").digest("hex");
}

export function success(result) {
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.rejection));
  return result.value;
}

export function candidateInput(overrides = {}) {
  return {
    subject: { kind: "epic", id: "epic:e70", revision: 1 },
    bundle: { ref: "bundle:e70", manifestSha256: SHA },
    repository: { id: "repository:workflow-agent", baseRevision: "base-1" },
    policy: { ref: "policy:readiness", profileRevision: "policy-v1" },
    requirementSet: { ref: "requirements:e70", revision: "requirements-v1" },
    applicability: "applicable",
    ...overrides,
  };
}

export function candidate(overrides = {}) {
  return success(createReadinessCandidateBinding(candidateInput(overrides)));
}

export function evidenceInput(bound, kind, payload, overrides = {}) {
  const producer = {
    kind: kind === "repository_feasibility"
      ? "engineering_lead"
      : kind === "quantitative_exception" || kind === "authority"
        ? "human_governor"
        : "deterministic_evaluator",
    actorRef: "actor:governor",
    authorityEvidenceRef: kind === "quantitative_exception"
      ? payload.authorityEvidenceRef
      : null,
    selfReportedTrust: null,
    ...(overrides.producer ?? {}),
  };
  const { producer: _producer, ...rest } = overrides;
  return {
    evidenceRef: `evidence:${kind}`,
    kind,
    candidateSha256: bound.canonicalSha256,
    sourceRef: `source:${kind}`,
    sourceRevision: "source-v1",
    producer,
    payload,
    ...rest,
  };
}

export function evidence(bound, kind, payload, overrides = {}) {
  return success(createGovernanceEvidence(evidenceInput(bound, kind, payload, overrides)));
}

export function semantic(bound, finding = "pass", overrides = {}) {
  return evidence(bound, "semantic", {
    kind: "semantic",
    finding,
    requirementRefs: ["requirement:1"],
  }, overrides);
}

export function quantitative(bound, minutes = 120, overrides = {}) {
  const finding = minutes <= 120
    ? "within_budget"
    : minutes <= 240
      ? "minor_overrun"
      : "severe_overrun";
  return evidence(bound, "quantitative", {
    kind: "quantitative",
    estimatedActiveMinutes: minutes,
    finding,
  }, overrides);
}

export function repository(bound, finding = "feasible", overrides = {}) {
  return evidence(bound, "repository_feasibility", {
    kind: "repository_feasibility",
    finding,
    repositoryId: bound.repository.id,
    baseRevision: bound.repository.baseRevision,
    roleRunId: "role-run:1",
    launchPermitId: "launch-permit:1",
  }, overrides);
}

export function policy(bound, applicability = bound.applicability, overrides = {}) {
  return evidence(bound, "applicability_policy", {
    kind: "applicability_policy",
    subjectKind: "initiative",
    applicability,
    policyRef: bound.policy.ref,
    profileRevision: bound.policy.profileRevision,
  }, overrides);
}

export function readinessLayers(bound, options = {}) {
  return [
    semantic(bound, options.semanticFinding ?? "pass", options.semanticOverrides),
    quantitative(bound, options.minutes ?? 120, options.quantitativeOverrides),
    repository(bound, options.repositoryFinding ?? "feasible", options.repositoryOverrides),
  ];
}

export function exceptionPair(bound, quantitativeRecord) {
  const authority = evidence(bound, "authority", {
    kind: "authority",
    authority: "human_portfolio_governor",
    decisionRef: "decision:1",
    scope: "readiness_quantitative_exception",
  });
  const exception = evidence(bound, "quantitative_exception", {
    kind: "quantitative_exception",
    quantitativeEvidenceRef: quantitativeRecord.evidenceRef,
    decisionRef: "decision:1",
    authorityEvidenceRef: authority.evidenceRef,
    rationaleRef: "reason:minor-overrun",
  });
  return [exception, authority];
}

export function assess(bound, suppliedEvidence, history = [], assessmentRef = "assessment:1") {
  return assessReadiness({
    assessmentRef,
    candidate: bound,
    evidence: suppliedEvidence,
    history,
  });
}

export function forgeEvidence(input) {
  return { ...input, canonicalSha256: digest(input) };
}

export function rehashAssessment(value, changes = {}) {
  const { canonicalSha256: _canonicalSha256, ...unhashed } = { ...value, ...changes };
  return { ...unhashed, canonicalSha256: digest(unhashed) };
}

export function currentStates(value) {
  return value.evidence.map((binding) => ({
    evidenceRef: binding.evidenceRef,
    kind: binding.kind,
    state: "current",
    canonicalSha256: binding.canonicalSha256,
  }));
}

export function currentContext(value, states = currentStates(value)) {
  return {
    subject: { ...value.candidate.subject },
    bundle: { ...value.candidate.bundle },
    repository: { ...value.candidate.repository },
    policy: { ...value.candidate.policy },
    requirementSet: { ...value.candidate.requirementSet },
    evidence: states.map((state) => ({ ...state })),
    assessmentHead: {
      assessmentRef: value.assessmentRef,
      canonicalSha256: value.canonicalSha256,
    },
  };
}

export function projection(value, freshness = "current", reasons = []) {
  return {
    freshness,
    reasons,
    assessmentRef: value.assessmentRef,
    assessmentSha256: value.canonicalSha256,
  };
}

export function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}
