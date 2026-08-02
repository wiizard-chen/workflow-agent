import assert from "node:assert/strict";
import test from "node:test";

import {
  projectReadinessFreshness,
  qualifyReadinessForConsumption,
} from "@pi-workflow/v2-readiness";

import {
  assess,
  candidate,
  currentContext,
  currentStates,
  digest,
  exceptionPair,
  jsonClone,
  policy,
  projection,
  readinessLayers,
  rehashAssessment,
  success,
} from "./t4-helpers.mjs";

const staleReasonOrder = [
  "subject_revision_changed",
  "bundle_changed",
  "repository_base_changed",
  "policy_changed",
  "requirement_set_changed",
  "evidence_invalidated",
  "exception_invalidated",
  "source_missing",
  "assessment_head_changed",
];

function readyAssessment() {
  const bound = candidate();
  return success(assess(bound, readinessLayers(bound), [], "assessment:ready"));
}

function exceptionAssessment() {
  const bound = candidate();
  const layers = readinessLayers(bound, { minutes: 121 });
  const quantitative = layers.find((item) => item.kind === "quantitative");
  const [exception, authority] = exceptionPair(bound, quantitative);
  return success(assess(bound, [...layers, exception, authority], [], "assessment:exception"));
}

test("each of the nine freshness reasons is independently reachable", () => {
  const ordinary = readyAssessment();
  const withException = exceptionAssessment();
  const cases = [
    ["subject_revision_changed", ordinary, (current) => { current.subject.revision += 1; }],
    ["bundle_changed", ordinary, (current) => { current.bundle.manifestSha256 = "b".repeat(64); }],
    ["repository_base_changed", ordinary, (current) => { current.repository.baseRevision = "base-2"; }],
    ["policy_changed", ordinary, (current) => { current.policy.profileRevision = "policy-v2"; }],
    ["requirement_set_changed", ordinary, (current) => { current.requirementSet.revision = "requirements-v2"; }],
    ["evidence_invalidated", ordinary, (current) => {
      const state = current.evidence.find((item) => item.kind === "semantic");
      state.state = "invalidated";
    }],
    ["exception_invalidated", withException, (current) => {
      const state = current.evidence.find((item) => item.kind === "quantitative_exception");
      state.canonicalSha256 = "c".repeat(64);
    }],
    ["source_missing", ordinary, (current) => {
      const state = current.evidence.find((item) => item.kind === "semantic");
      state.state = "missing";
      state.canonicalSha256 = null;
    }],
    ["assessment_head_changed", ordinary, (current) => { current.assessmentHead.assessmentRef = "assessment:new-head"; }],
  ];

  for (const [reason, value, mutate] of cases) {
    const current = currentContext(value);
    mutate(current);
    const result = success(projectReadinessFreshness({ assessment: value, current }));
    assert.equal(result.freshness, "stale", reason);
    assert.deepEqual(result.reasons, [reason], reason);
  }
});

test("combined freshness reasons are unique and use the approved order", () => {
  const value = exceptionAssessment();
  const current = currentContext(value);
  current.subject.revision += 1;
  current.bundle.ref = "bundle:changed";
  current.repository.id = "repository:changed";
  current.policy.ref = "policy:changed";
  current.requirementSet.ref = "requirements:changed";
  const semantic = current.evidence.find((item) => item.kind === "semantic");
  semantic.state = "invalidated";
  const exception = current.evidence.find((item) => item.kind === "quantitative_exception");
  exception.state = "invalidated";
  const authority = current.evidence.find((item) => item.kind === "authority");
  authority.state = "missing";
  authority.canonicalSha256 = null;
  current.assessmentHead.canonicalSha256 = "d".repeat(64);

  const result = success(projectReadinessFreshness({ assessment: value, current }));
  assert.equal(result.freshness, "stale");
  assert.deepEqual(result.reasons, staleReasonOrder);
});

test("freshness context rejects duplicate, missing, extra, unsorted, wrong-kind, and state attacks", () => {
  const value = readyAssessment();
  const validStates = currentStates(value);
  const attacks = [
    ["duplicate", [...validStates, { ...validStates[0] }], "duplicate_entry"],
    ["missing", validStates.slice(1), "context_evidence_mismatch"],
    ["extra", [...validStates, {
      evidenceRef: "zz-extra",
      kind: "semantic",
      state: "current",
      canonicalSha256: "e".repeat(64),
    }], "context_evidence_mismatch"],
    ["unsorted", [...validStates].reverse(), "context_evidence_mismatch"],
    ["wrong kind", validStates.map((item, index) => index === 0 ? { ...item, kind: "authority" } : item), "context_evidence_mismatch"],
    ["current null", validStates.map((item, index) => index === 0 ? { ...item, canonicalSha256: null } : item), "invalid_context_state"],
    ["invalidated null", validStates.map((item, index) => index === 0 ? { ...item, state: "invalidated", canonicalSha256: null } : item), "invalid_context_state"],
    ["missing digest", validStates.map((item, index) => index === 0 ? { ...item, state: "missing" } : item), "invalid_context_state"],
  ];
  for (const [label, states, reason] of attacks) {
    const result = projectReadinessFreshness({
      assessment: value,
      current: currentContext(value, states),
    });
    assert.equal(result.ok, false, label);
    assert.equal(result.rejection.code, "invalid_freshness_context", label);
    assert.equal(result.rejection.reason, reason, label);
  }
});

test("each of the eight qualification reasons is independently reachable", () => {
  const ready = readyAssessment();
  const blockedBound = candidate();
  const blocked = success(assess(blockedBound, [], [], "assessment:blocked"));
  const needsBound = candidate();
  const needs = success(assess(
    needsBound,
    readinessLayers(needsBound, { semanticFinding: "needs_refinement" }),
    [],
    "assessment:needs",
  ));
  const mustBound = candidate();
  const must = success(assess(
    mustBound,
    readinessLayers(mustBound, { semanticFinding: "must_decompose" }),
    [],
    "assessment:must",
  ));

  const { canonicalSha256: _candidateHash, ...candidateBytes } = ready.candidate;
  const impossibleCandidateBytes = { ...candidateBytes, applicability: "not_applicable" };
  const impossibleCandidate = {
    ...impossibleCandidateBytes,
    canonicalSha256: digest(impossibleCandidateBytes),
  };
  const impossibleEpic = rehashAssessment(ready, {
    candidate: impossibleCandidate,
    applicability: "not_applicable",
  });

  const exactHead = (value) => ({
    assessmentRef: value.assessmentRef,
    canonicalSha256: value.canonicalSha256,
  });
  const cases = [
    ["projection_binding_mismatch", ready, {
      freshness: { ...projection(ready), assessmentRef: "assessment:other" },
      currentHead: exactHead(ready),
    }],
    ["assessment_not_head", ready, {
      freshness: projection(ready),
      currentHead: { ...exactHead(ready), assessmentRef: "assessment:new-head" },
    }],
    ["assessment_head_hash_mismatch", ready, {
      freshness: projection(ready),
      currentHead: { ...exactHead(ready), canonicalSha256: "f".repeat(64) },
    }],
    ["readiness_stale", ready, {
      freshness: projection(ready, "stale", ["bundle_changed"]),
      currentHead: exactHead(ready),
    }],
    ["disposition_blocked", blocked, {
      freshness: projection(blocked),
      currentHead: exactHead(blocked),
    }],
    ["disposition_needs_refinement", needs, {
      freshness: projection(needs),
      currentHead: exactHead(needs),
    }],
    ["disposition_must_decompose", must, {
      freshness: projection(must),
      currentHead: exactHead(must),
    }],
    ["epic_cannot_be_not_applicable", impossibleEpic, {
      freshness: projection(impossibleEpic),
      currentHead: exactHead(impossibleEpic),
    }],
  ];

  for (const [reason, value, fields] of cases) {
    const result = success(qualifyReadinessForConsumption({
      assessment: value,
      ...fields,
      purpose: "product_approval",
    }));
    assert.equal(result.qualified, false, reason);
    assert.equal(result.requirement, "unsatisfied", reason);
    assert.deepEqual(result.reasons, [reason], reason);
  }
});

test("qualification positives cover both purposes and Initiative applicability", () => {
  const epic = readyAssessment();
  for (const purpose of ["product_approval", "scheduling_eligibility_input"]) {
    const result = success(qualifyReadinessForConsumption({
      assessment: epic,
      freshness: projection(epic),
      currentHead: { assessmentRef: epic.assessmentRef, canonicalSha256: epic.canonicalSha256 },
      purpose,
    }));
    assert.equal(result.qualified, true);
    assert.equal(result.requirement, "satisfied");
  }

  const initiative = candidate({
    subject: { kind: "initiative", id: "initiative:applicable", revision: 1 },
  });
  const applicable = success(assess(
    initiative,
    [...readinessLayers(initiative), policy(initiative)],
    [],
    "assessment:initiative",
  ));
  const applicableResult = success(qualifyReadinessForConsumption({
    assessment: applicable,
    freshness: projection(applicable),
    currentHead: { assessmentRef: applicable.assessmentRef, canonicalSha256: applicable.canonicalSha256 },
    purpose: "product_approval",
  }));
  assert.equal(applicableResult.requirement, "satisfied");

  const notApplicableBound = candidate({
    subject: { kind: "initiative", id: "initiative:not-required", revision: 1 },
    applicability: "not_applicable",
  });
  const notApplicable = success(assess(
    notApplicableBound,
    [policy(notApplicableBound, "not_applicable")],
    [],
    "assessment:not-required",
  ));
  const notRequired = success(qualifyReadinessForConsumption({
    assessment: notApplicable,
    freshness: projection(notApplicable),
    currentHead: { assessmentRef: notApplicable.assessmentRef, canonicalSha256: notApplicable.canonicalSha256 },
    purpose: "scheduling_eligibility_input",
  }));
  assert.equal(notRequired.qualified, true);
  assert.equal(notRequired.requirement, "not_required");
});

test("qualification rejects malformed projection order, purpose, and forged assessment bytes", () => {
  const value = readyAssessment();
  const head = { assessmentRef: value.assessmentRef, canonicalSha256: value.canonicalSha256 };
  const attacks = [
    ["duplicate projection reason", {
      assessment: value,
      freshness: projection(value, "stale", ["bundle_changed", "bundle_changed"]),
      currentHead: head,
      purpose: "product_approval",
    }, "duplicate_entry"],
    ["out-of-order projection", {
      assessment: value,
      freshness: projection(value, "stale", ["bundle_changed", "subject_revision_changed"]),
      currentHead: head,
      purpose: "product_approval",
    }, "projection_assessment_mismatch"],
    ["purpose", {
      assessment: value,
      freshness: projection(value),
      currentHead: head,
      purpose: "approve_now",
    }, "invalid_purpose"],
    ["forged assessment", {
      assessment: { ...value, canonicalSha256: "0".repeat(64) },
      freshness: projection(value),
      currentHead: head,
      purpose: "product_approval",
    }, "invalid_canonical_hash"],
  ];
  for (const [label, input, reason] of attacks) {
    const before = JSON.stringify(input);
    const result = qualifyReadinessForConsumption(input);
    assert.equal(result.ok, false, label);
    assert.equal(result.rejection.code, "qualification_mismatch", label);
    assert.equal(result.rejection.reason, reason, label);
    assert.equal(JSON.stringify(input), before, label);
    assert.equal(Object.isFrozen(input), false, label);
  }
});

test("canonical but impossible ready assessments cannot qualify", () => {
  const ready = readyAssessment();
  const emptyReady = rehashAssessment(ready, {
    evidence: [],
    evidenceSetSha256: digest([]),
    reasonCodes: [],
  });
  const emptyResult = qualifyReadinessForConsumption({
    assessment: emptyReady,
    freshness: projection(emptyReady),
    currentHead: {
      assessmentRef: emptyReady.assessmentRef,
      canonicalSha256: emptyReady.canonicalSha256,
    },
    purpose: "product_approval",
  });
  assert.equal(emptyResult.ok, false);
  assert.equal(emptyResult.rejection.reason, "projection_assessment_mismatch");

  const notApplicableBound = candidate({
    subject: { kind: "initiative", id: "initiative:forged-na", revision: 1 },
    applicability: "not_applicable",
  });
  const legitimate = success(assess(
    notApplicableBound,
    [policy(notApplicableBound, "not_applicable")],
    [],
    "assessment:forged-na",
  ));
  const noPolicy = rehashAssessment(legitimate, {
    evidence: [],
    evidenceSetSha256: digest([]),
  });
  const noPolicyResult = qualifyReadinessForConsumption({
    assessment: noPolicy,
    freshness: projection(noPolicy),
    currentHead: {
      assessmentRef: noPolicy.assessmentRef,
      canonicalSha256: noPolicy.canonicalSha256,
    },
    purpose: "scheduling_eligibility_input",
  });
  assert.equal(noPolicyResult.ok, false);
  assert.equal(noPolicyResult.rejection.reason, "projection_assessment_mismatch");
});

test("duplicate EvidenceRef blocked assessments cannot be projected or qualified", async () => {
  const { forgeEvidence } = await import("./t4-helpers.mjs");
  const bound = candidate();
  const layers = readinessLayers(bound);
  const semantic = layers.find((item) => item.kind === "semantic");
  const quantitative = layers.find((item) => item.kind === "quantitative");
  const { canonicalSha256: _digest, ...quantitativeBytes } = quantitative;
  const collision = forgeEvidence({ ...quantitativeBytes, evidenceRef: semantic.evidenceRef });
  const blocked = success(assess(
    bound,
    [semantic, collision, layers.find((item) => item.kind === "repository_feasibility")],
    [],
    "assessment:duplicate-ref",
  ));
  assert.equal(blocked.disposition, "blocked");
  assert.deepEqual(blocked.reasonCodes, ["evidence_integrity_failure"]);

  const projected = projectReadinessFreshness({
    assessment: blocked,
    current: currentContext(blocked, [...new Map(blocked.evidence.map((binding) => [
      binding.evidenceRef,
      { ...binding, state: "current" },
    ])).values()]),
  });
  assert.equal(projected.ok, false);
  assert.equal(projected.rejection.reason, "context_evidence_mismatch");

  const direct = success(qualifyReadinessForConsumption({
    assessment: blocked,
    freshness: projection(blocked),
    currentHead: {
      assessmentRef: blocked.assessmentRef,
      canonicalSha256: blocked.canonicalSha256,
    },
    purpose: "product_approval",
  }));
  assert.equal(direct.qualified, false);
  assert.deepEqual(direct.reasons, ["disposition_blocked"]);
});
