import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalizeJson } from "@pi-workflow/v2-domain";
import {
  createReadinessCandidateBinding,
  projectReadinessFreshness,
  qualifyReadinessForConsumption,
} from "@pi-workflow/v2-readiness";

const sha = (character) => character.repeat(64);

function digest(value) {
  const canonical = canonicalizeJson(value);
  assert.equal(canonical.ok, true);
  return createHash("sha256").update(canonical.text, "utf8").digest("hex");
}

function candidate({ kind = "epic", applicability = "applicable" } = {}) {
  const result = createReadinessCandidateBinding({
    subject: { kind, id: `${kind}-1`, revision: 3 },
    bundle: { ref: "bundle-1", manifestSha256: sha("a") },
    repository: { id: "repository-1", baseRevision: "base-1" },
    policy: { ref: "policy-1", profileRevision: "policy-v1" },
    requirementSet: { ref: "requirements-1", revision: "requirements-v1" },
    applicability,
  });
  assert.equal(result.ok, true);
  return result.value;
}

function assessment({
  boundCandidate = candidate(),
  disposition = "ready",
  evidence = [
    { evidenceRef: "evidence-quantitative", kind: "quantitative", canonicalSha256: sha("1") },
    { evidenceRef: "evidence-repository", kind: "repository_feasibility", canonicalSha256: sha("2") },
    { evidenceRef: "evidence-semantic", kind: "semantic", canonicalSha256: sha("3") },
  ],
  reasonCodes = [],
} = {}) {
  const withoutDigest = {
    assessmentRef: "assessment-1",
    candidate: boundCandidate,
    applicability: boundCandidate.applicability,
    disposition,
    evidence,
    evidenceSetSha256: digest(evidence),
    reasonCodes,
    sequence: 1,
    previousAssessmentRef: null,
    previousAssessmentSha256: null,
  };
  return { ...withoutDigest, canonicalSha256: digest(withoutDigest) };
}

function currentContext(value, states = currentStates(value)) {
  return {
    subject: { ...value.candidate.subject },
    bundle: { ...value.candidate.bundle },
    repository: { ...value.candidate.repository },
    policy: { ...value.candidate.policy },
    requirementSet: { ...value.candidate.requirementSet },
    evidence: states,
    assessmentHead: {
      assessmentRef: value.assessmentRef,
      canonicalSha256: value.canonicalSha256,
    },
  };
}

function currentStates(value) {
  return value.evidence.map((binding) => ({
    evidenceRef: binding.evidenceRef,
    kind: binding.kind,
    state: "current",
    canonicalSha256: binding.canonicalSha256,
  }));
}

test("freshness projects current without mutating assessment bytes", () => {
  const value = assessment();
  const before = JSON.stringify(value);
  const current = currentContext(value);
  const result = projectReadinessFreshness({ assessment: value, current });
  assert.deepEqual(result, {
    ok: true,
    value: {
      freshness: "current",
      reasons: [],
      assessmentRef: value.assessmentRef,
      assessmentSha256: value.canonicalSha256,
    },
  });
  assert.equal(JSON.stringify(value), before);
  assert.equal(Object.isFrozen(value), false);
  assert.equal(Object.isFrozen(current), false);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.reasons), true);
});

test("freshness emits all nine stale reasons once in approved order", () => {
  const bindings = [
    { evidenceRef: "evidence-a", kind: "semantic", canonicalSha256: sha("1") },
    { evidenceRef: "evidence-b", kind: "quantitative_exception", canonicalSha256: sha("2") },
    { evidenceRef: "evidence-c", kind: "authority", canonicalSha256: sha("3") },
  ];
  const value = assessment({ evidence: bindings });
  const current = currentContext(value, [
    { evidenceRef: "evidence-a", kind: "semantic", state: "invalidated", canonicalSha256: sha("1") },
    { evidenceRef: "evidence-b", kind: "quantitative_exception", state: "current", canonicalSha256: sha("4") },
    { evidenceRef: "evidence-c", kind: "authority", state: "missing", canonicalSha256: null },
  ]);
  current.subject.revision += 1;
  current.bundle.ref = "bundle-2";
  current.repository.baseRevision = "base-2";
  current.policy.profileRevision = "policy-v2";
  current.requirementSet.revision = "requirements-v2";
  current.assessmentHead.assessmentRef = "assessment-2";

  const result = projectReadinessFreshness({ assessment: value, current });
  assert.equal(result.ok, true);
  assert.equal(result.value.freshness, "stale");
  assert.deepEqual(result.value.reasons, [
    "subject_revision_changed",
    "bundle_changed",
    "repository_base_changed",
    "policy_changed",
    "requirement_set_changed",
    "evidence_invalidated",
    "exception_invalidated",
    "source_missing",
    "assessment_head_changed",
  ]);
});

test("freshness rejects malformed state and non-exact evidence identity sets", () => {
  const binding = { evidenceRef: "evidence-a", kind: "semantic", canonicalSha256: sha("1") };
  const value = assessment({ evidence: [binding] });

  const invalidState = currentContext(value, [{
    evidenceRef: binding.evidenceRef,
    kind: binding.kind,
    state: "current",
    canonicalSha256: null,
  }]);
  const invalidStateResult = projectReadinessFreshness({ assessment: value, current: invalidState });
  assert.equal(invalidStateResult.ok, false);
  assert.equal(invalidStateResult.rejection.code, "invalid_freshness_context");
  assert.equal(invalidStateResult.rejection.reason, "invalid_context_state");

  const duplicate = currentContext(value, [
    ...currentStates(value),
    ...currentStates(value),
  ]);
  const duplicateResult = projectReadinessFreshness({ assessment: value, current: duplicate });
  assert.equal(duplicateResult.ok, false);
  assert.equal(duplicateResult.rejection.reason, "duplicate_entry");

  const missing = currentContext(value, []);
  const missingResult = projectReadinessFreshness({ assessment: value, current: missing });
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.rejection.reason, "context_evidence_mismatch");
  assert.equal(missingResult.rejection.relatedRef, binding.evidenceRef);
});

test("qualification returns satisfied only for current ready head", () => {
  const value = assessment();
  const projection = projectReadinessFreshness({
    assessment: value,
    current: currentContext(value),
  });
  assert.equal(projection.ok, true);
  const result = qualifyReadinessForConsumption({
    assessment: value,
    freshness: projection.value,
    currentHead: { assessmentRef: value.assessmentRef, canonicalSha256: value.canonicalSha256 },
    purpose: "product_approval",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.qualified, true);
  assert.equal(result.value.requirement, "satisfied");
  assert.deepEqual(result.value.reasons, []);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.reasons), true);
});

test("qualification treats well-formed binding/head/stale/disposition differences as ordered negatives", () => {
  const value = assessment({
    disposition: "blocked",
    reasonCodes: ["missing_semantic_evidence"],
  });
  const result = qualifyReadinessForConsumption({
    assessment: value,
    freshness: {
      freshness: "stale",
      reasons: ["assessment_head_changed"],
      assessmentRef: "another-assessment",
      assessmentSha256: sha("9"),
    },
    currentHead: { assessmentRef: "new-head", canonicalSha256: sha("8") },
    purpose: "scheduling_eligibility_input",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.qualified, false);
  assert.equal(result.value.requirement, "unsatisfied");
  assert.deepEqual(result.value.reasons, [
    "projection_binding_mismatch",
    "assessment_not_head",
    "assessment_head_hash_mismatch",
    "readiness_stale",
    "disposition_blocked",
  ]);
});

test("qualification returns not_required only for a current ready Initiative policy result", () => {
  const value = assessment({
    boundCandidate: candidate({ kind: "initiative", applicability: "not_applicable" }),
    evidence: [{
      evidenceRef: "evidence-policy",
      kind: "applicability_policy",
      canonicalSha256: sha("4"),
    }],
    reasonCodes: ["not_applicable_by_policy"],
  });
  const projection = projectReadinessFreshness({ assessment: value, current: currentContext(value) });
  assert.equal(projection.ok, true);
  const result = qualifyReadinessForConsumption({
    assessment: value,
    freshness: projection.value,
    currentHead: { assessmentRef: value.assessmentRef, canonicalSha256: value.canonicalSha256 },
    purpose: "product_approval",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.qualified, true);
  assert.equal(result.value.requirement, "not_required");
});

test("qualification keeps canonical Epic not_applicable as a defensive negative", () => {
  const applicable = candidate();
  const candidateWithoutDigest = { ...applicable, applicability: "not_applicable" };
  delete candidateWithoutDigest.canonicalSha256;
  const forgedCandidate = {
    ...candidateWithoutDigest,
    canonicalSha256: digest(candidateWithoutDigest),
  };
  const value = assessment({ boundCandidate: forgedCandidate });
  const result = qualifyReadinessForConsumption({
    assessment: value,
    freshness: {
      freshness: "current",
      reasons: [],
      assessmentRef: value.assessmentRef,
      assessmentSha256: value.canonicalSha256,
    },
    currentHead: { assessmentRef: value.assessmentRef, canonicalSha256: value.canonicalSha256 },
    purpose: "product_approval",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.qualified, false);
  assert.equal(result.value.requirement, "unsatisfied");
  assert.deepEqual(result.value.reasons, ["epic_cannot_be_not_applicable"]);
});

test("qualification rejects internally contradictory projection and forged assessment digest", () => {
  const value = assessment();
  const contradictory = qualifyReadinessForConsumption({
    assessment: value,
    freshness: {
      freshness: "current",
      reasons: ["bundle_changed"],
      assessmentRef: value.assessmentRef,
      assessmentSha256: value.canonicalSha256,
    },
    currentHead: { assessmentRef: value.assessmentRef, canonicalSha256: value.canonicalSha256 },
    purpose: "product_approval",
  });
  assert.equal(contradictory.ok, false);
  assert.equal(contradictory.rejection.code, "qualification_mismatch");
  assert.equal(contradictory.rejection.reason, "projection_assessment_mismatch");

  const forged = { ...value, canonicalSha256: sha("f") };
  const forgedResult = qualifyReadinessForConsumption({
    assessment: forged,
    freshness: {
      freshness: "current",
      reasons: [],
      assessmentRef: forged.assessmentRef,
      assessmentSha256: forged.canonicalSha256,
    },
    currentHead: { assessmentRef: forged.assessmentRef, canonicalSha256: forged.canonicalSha256 },
    purpose: "product_approval",
  });
  assert.equal(forgedResult.ok, false);
  assert.equal(forgedResult.rejection.code, "qualification_mismatch");
  assert.equal(forgedResult.rejection.reason, "invalid_canonical_hash");
});
