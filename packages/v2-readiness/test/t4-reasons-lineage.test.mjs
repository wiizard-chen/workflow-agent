import assert from "node:assert/strict";
import test from "node:test";

import {
  assess,
  candidate,
  digest,
  evidence,
  evidenceInput,
  exceptionPair,
  forgeEvidence,
  policy,
  quantitative,
  readinessLayers,
  rehashAssessment,
  repository,
  semantic,
  success,
} from "./t4-helpers.mjs";

const expectedReasonOrder = [
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
];

function reasonCases() {
  const epic = candidate();
  const layers = readinessLayers(epic);
  const initiative = candidate({
    subject: { kind: "initiative", id: "initiative:1", revision: 1 },
  });
  const initiativeLayers = readinessLayers(initiative);
  const notApplicable = candidate({
    subject: { kind: "initiative", id: "initiative:na", revision: 1 },
    applicability: "not_applicable",
  });

  const policyOne = policy(initiative, "applicable", { evidenceRef: "policy:evidence:1" });
  const policyTwo = policy(initiative, "applicable", { evidenceRef: "policy:evidence:2" });
  const mismatchPolicy = policy(initiative, "not_applicable", { evidenceRef: "policy:evidence:mismatch" });
  const notApplicablePolicy = policy(notApplicable, "not_applicable");

  const semanticTwo = semantic(epic, "pass", { evidenceRef: "evidence:semantic:2" });
  const quantitativeTwo = quantitative(epic, 120, { evidenceRef: "evidence:quantitative:2" });
  const repositoryTwo = repository(epic, "feasible", { evidenceRef: "evidence:repository:2" });

  const mismatchInput = evidenceInput(epic, "quantitative", {
    kind: "quantitative",
    estimatedActiveMinutes: 121,
    finding: "within_budget",
  }, { evidenceRef: "evidence:quantitative:mismatch" });

  const wrongCandidate = evidence(epic, "authority", {
    kind: "authority",
    authority: "human_portfolio_governor",
    decisionRef: "decision:wrong-candidate",
    scope: "readiness_quantitative_exception",
  }, {
    evidenceRef: "evidence:wrong-candidate",
    candidateSha256: "b".repeat(64),
  });

  const semanticRecord = layers.find((item) => item.kind === "semantic");
  const quantitativeRecord = layers.find((item) => item.kind === "quantitative");
  const { canonicalSha256: _quantitativeHash, ...quantitativeInput } = quantitativeRecord;
  const colliding = forgeEvidence({
    ...quantitativeInput,
    evidenceRef: semanticRecord.evidenceRef,
  });

  const poison = forgeEvidence(evidenceInput(epic, "authority", {
    kind: "authority",
    authority: "human_portfolio_governor",
    decisionRef: "decision:poison",
    scope: "readiness_quantitative_exception",
  }, {
    evidenceRef: "evidence:poison",
    producer: { kind: "product_ai", actorRef: "actor:ai", selfReportedTrust: "human" },
  }));

  const invalidException = evidence(epic, "quantitative_exception", {
    kind: "quantitative_exception",
    quantitativeEvidenceRef: quantitativeRecord.evidenceRef,
    decisionRef: "decision:missing-authority",
    authorityEvidenceRef: "evidence:authority:missing",
    rationaleRef: "reason:invalid",
  }, { evidenceRef: "evidence:exception:invalid" });

  const minorLayers = readinessLayers(epic, { minutes: 121 });
  const minorQuantitative = minorLayers.find((item) => item.kind === "quantitative");
  const [validException, validAuthority] = exceptionPair(epic, minorQuantitative);

  return [
    ["not_applicable_by_policy", notApplicable, [notApplicablePolicy], "ready", ["not_applicable_by_policy"]],
    ["missing_applicability_policy", initiative, initiativeLayers, "blocked", ["missing_applicability_policy"]],
    ["ambiguous_applicability_policy", initiative, [...initiativeLayers, policyOne, policyTwo], "blocked", ["ambiguous_applicability_policy"]],
    ["applicability_policy_mismatch", initiative, [...initiativeLayers, mismatchPolicy], "blocked", ["applicability_policy_mismatch"]],
    ["missing_semantic_evidence", epic, layers.filter((item) => item.kind !== "semantic"), "blocked", ["missing_semantic_evidence"]],
    ["ambiguous_semantic_evidence", epic, [...layers, semanticTwo], "blocked", ["ambiguous_semantic_evidence"]],
    ["semantic_needs_refinement", epic, [semantic(epic, "needs_refinement"), layers[1], layers[2]], "needs_refinement", ["semantic_needs_refinement"]],
    ["semantic_must_decompose", epic, [semantic(epic, "must_decompose"), layers[1], layers[2]], "must_decompose", ["semantic_must_decompose"]],
    ["missing_quantitative_evidence", epic, layers.filter((item) => item.kind !== "quantitative"), "blocked", ["missing_quantitative_evidence"]],
    ["ambiguous_quantitative_evidence", epic, [...layers, quantitativeTwo], "blocked", ["ambiguous_quantitative_evidence"]],
    ["quantitative_minor_overrun", epic, minorLayers, "needs_refinement", ["quantitative_minor_overrun"]],
    ["quantitative_severe_overrun", epic, readinessLayers(epic, { minutes: 241 }), "must_decompose", ["quantitative_severe_overrun"]],
    ["quantitative_finding_mismatch", epic, [layers[0], forgeEvidence(mismatchInput), layers[2]], "blocked", ["quantitative_finding_mismatch"]],
    ["missing_repository_feasibility", epic, layers.filter((item) => item.kind !== "repository_feasibility"), "blocked", ["missing_repository_feasibility"]],
    ["ambiguous_repository_feasibility", epic, [...layers, repositoryTwo], "blocked", ["ambiguous_repository_feasibility"]],
    ["repository_feasibility_blocked", epic, [layers[0], layers[1], repository(epic, "blocked")], "blocked", ["repository_feasibility_blocked"]],
    ["wrong_candidate_evidence", epic, [...layers, wrongCandidate], "blocked", ["wrong_candidate_evidence"]],
    ["evidence_integrity_failure", epic, [semanticRecord, colliding, layers[2]], "blocked", ["evidence_integrity_failure"]],
    ["evidence_provenance_failure", epic, [...layers, poison], "blocked", ["evidence_provenance_failure"]],
    ["invalid_quantitative_exception", epic, [...layers, invalidException], "blocked", ["invalid_quantitative_exception"]],
    ["quantitative_exception_applied", epic, [...minorLayers, validException, validAuthority], "ready", ["quantitative_minor_overrun", "quantitative_exception_applied"]],
  ];
}

test("all 21 readiness reason codes are reachable with exact dispositions", () => {
  const reached = new Set();
  for (const [label, bound, suppliedEvidence, disposition, reasons] of reasonCases()) {
    const result = success(assess(bound, suppliedEvidence, [], `assessment:${label}`));
    assert.equal(result.disposition, disposition, label);
    assert.deepEqual(result.reasonCodes, reasons, label);
    for (const reason of result.reasonCodes) reached.add(reason);
  }
  assert.deepEqual([...reached].sort(), [...expectedReasonOrder].sort());
});

test("disposition and reason reductions use their approved independent orders", () => {
  const bound = candidate();
  const result = success(assess(bound, [
    semantic(bound, "must_decompose"),
    quantitative(bound, 121),
  ], [], "assessment:precedence"));
  assert.equal(result.disposition, "must_decompose");
  assert.deepEqual(result.reasonCodes, [
    "semantic_must_decompose",
    "quantitative_minor_overrun",
    "missing_repository_feasibility",
  ]);
});

test("wrong-candidate exceptions and duplicate evidence retain fail-closed priority", () => {
  const bound = candidate();
  const layers = readinessLayers(bound);
  const wrongException = evidence(bound, "quantitative_exception", {
    kind: "quantitative_exception",
    quantitativeEvidenceRef: "evidence:quantitative",
    decisionRef: "decision:wrong",
    authorityEvidenceRef: "evidence:authority",
    rationaleRef: "reason:wrong",
  }, { candidateSha256: "b".repeat(64) });
  const wrong = success(assess(bound, [...layers, wrongException], [], "assessment:wrong-exception"));
  assert.deepEqual(wrong.reasonCodes, [
    "wrong_candidate_evidence",
    "invalid_quantitative_exception",
  ]);

  const malformedHistory = rehashAssessment(success(assess(bound, [], [], "assessment:history")), {
    sequence: 2,
    previousAssessmentRef: "assessment:missing",
    previousAssessmentSha256: "c".repeat(64),
  });
  const duplicate = assess(bound, [...layers, layers[0]], [malformedHistory], "assessment:priority");
  assert.equal(duplicate.ok, false);
  assert.deepEqual(duplicate.rejection, {
    code: "invalid_evidence",
    path: "/evidence/3",
    reason: "duplicate_entry",
    relatedRef: layers[0].evidenceRef,
  });
});

test("not-applicable Initiative never ignores unnecessary quantitative exceptions", () => {
  const bound = candidate({
    subject: { kind: "initiative", id: "initiative:no-exception", revision: 1 },
    applicability: "not_applicable",
  });
  const policyEvidence = policy(bound, "not_applicable");
  const unnecessary = evidence(bound, "quantitative_exception", {
    kind: "quantitative_exception",
    quantitativeEvidenceRef: "evidence:quantitative:unused",
    decisionRef: "decision:unused",
    authorityEvidenceRef: "evidence:authority:unused",
    rationaleRef: "reason:unused",
  });
  const result = success(assess(
    bound,
    [policyEvidence, unnecessary],
    [],
    "assessment:not-applicable-exception",
  ));
  assert.equal(result.disposition, "blocked");
  assert.deepEqual(result.reasonCodes, [
    "not_applicable_by_policy",
    "evidence_provenance_failure",
    "invalid_quantitative_exception",
  ]);
});

test("lineage accepts only a complete oldest-first single head", () => {
  const bound = candidate();
  const blocked = success(assess(bound, [], [], "assessment:a"));
  const ready = success(assess(bound, readinessLayers(bound), [blocked], "assessment:b"));

  const sameCandidateRetry = assess(bound, readinessLayers(bound), [blocked], "assessment:retry");
  assert.equal(sameCandidateRetry.ok, true);

  const sameReadyCandidate = assess(bound, readinessLayers(bound), [blocked, ready], "assessment:reuse");
  assert.equal(sameReadyCandidate.ok, false);
  assert.equal(sameReadyCandidate.rejection.reason, "candidate_reuse_forbidden");

  const nextCandidate = candidate({ subject: { ...bound.subject, revision: 2 } });
  const successor = success(assess(nextCandidate, readinessLayers(nextCandidate), [blocked, ready], "assessment:c"));
  assert.equal(successor.sequence, 3);
  assert.equal(successor.previousAssessmentRef, ready.assessmentRef);

  const identityReuse = assess(bound, readinessLayers(bound), [blocked], blocked.assessmentRef);
  assert.equal(identityReuse.ok, false);
  assert.equal(identityReuse.rejection.reason, "duplicate_entry");

  const otherSubject = candidate({ subject: { kind: "epic", id: "epic:other", revision: 1 } });
  const subjectMismatch = assess(otherSubject, readinessLayers(otherSubject), [blocked], "assessment:other");
  assert.equal(subjectMismatch.ok, false);
  assert.equal(subjectMismatch.rejection.reason, "history_subject_mismatch");

  const gap = rehashAssessment(blocked, { sequence: 2 });
  const gapResult = assess(bound, readinessLayers(bound), [gap], "assessment:gap");
  assert.equal(gapResult.ok, false);
  assert.equal(gapResult.rejection.reason, "history_predecessor_mismatch");

  const fork = rehashAssessment(ready, {
    assessmentRef: "assessment:fork",
    sequence: 3,
    previousAssessmentRef: blocked.assessmentRef,
    previousAssessmentSha256: blocked.canonicalSha256,
  });
  const forkResult = assess(nextCandidate, readinessLayers(nextCandidate), [blocked, ready, fork], "assessment:after-fork");
  assert.equal(forkResult.ok, false);
  assert.equal(forkResult.rejection.reason, "history_fork");

  const forged = { ...ready, canonicalSha256: "f".repeat(64) };
  const forgedResult = assess(nextCandidate, readinessLayers(nextCandidate), [blocked, forged], "assessment:forged");
  assert.equal(forgedResult.ok, false);
  assert.equal(forgedResult.rejection.reason, "invalid_canonical_hash");

  const contradictory = rehashAssessment(ready, {
    disposition: "blocked",
    reasonCodes: [],
  });
  const contradictoryResult = assess(
    nextCandidate,
    readinessLayers(nextCandidate),
    [blocked, contradictory],
    "assessment:contradictory-history",
  );
  assert.equal(contradictoryResult.ok, false);
  assert.equal(contradictoryResult.rejection.code, "invalid_lineage");
  assert.equal(contradictoryResult.rejection.reason, "invalid_scalar");
});

test("neutral assessment validation rejects impossible local predecessor cardinality", async () => {
  const { projectReadinessFreshness } = await import("@pi-workflow/v2-readiness");
  const bound = candidate();
  const first = success(assess(bound, readinessLayers(bound)));
  const impossible = rehashAssessment(first, {
    sequence: 2,
    previousAssessmentRef: null,
    previousAssessmentSha256: null,
  });
  const result = projectReadinessFreshness({
    assessment: impossible,
    current: {
      subject: { ...bound.subject },
      bundle: { ...bound.bundle },
      repository: { ...bound.repository },
      policy: { ...bound.policy },
      requirementSet: { ...bound.requirementSet },
      evidence: impossible.evidence.map((item) => ({ ...item, state: "current" })),
      assessmentHead: {
        assessmentRef: impossible.assessmentRef,
        canonicalSha256: impossible.canonicalSha256,
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.rejection.reason, "history_predecessor_mismatch");
});
