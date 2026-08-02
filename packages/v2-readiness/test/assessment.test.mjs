import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalizeJson } from "@pi-workflow/v2-domain";

import {
  assessReadiness,
  createGovernanceEvidence,
  createReadinessCandidateBinding,
} from "../dist/index.js";

const SHA = "a".repeat(64);

function digest(value) {
  const canonical = canonicalizeJson(value);
  assert.equal(canonical.ok, true);
  return createHash("sha256").update(canonical.text, "utf8").digest("hex");
}

function value(result) {
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.rejection));
  return result.value;
}

function candidate(overrides = {}) {
  return value(createReadinessCandidateBinding({
    subject: { kind: "epic", id: "epic-70", revision: 1 },
    bundle: { ref: "bundle:e70", manifestSha256: SHA },
    repository: { id: "repository:workflow-agent", baseRevision: "base-1" },
    policy: { ref: "policy:readiness", profileRevision: "policy-v1" },
    requirementSet: { ref: "requirements:e70", revision: "requirements-v1" },
    applicability: "applicable",
    ...overrides,
  }));
}

function evidence(candidateBinding, kind, payload, overrides = {}) {
  const authorityEvidenceRef = kind === "quantitative_exception"
    ? payload.authorityEvidenceRef
    : null;
  return value(createGovernanceEvidence({
    evidenceRef: `evidence:${kind}`,
    kind,
    candidateSha256: candidateBinding.canonicalSha256,
    sourceRef: `source:${kind}`,
    sourceRevision: "source-v1",
    producer: {
      kind: kind === "repository_feasibility"
        ? "engineering_lead"
        : kind === "quantitative_exception" || kind === "authority"
          ? "human_governor"
          : "deterministic_evaluator",
      actorRef: "actor:governor",
      authorityEvidenceRef,
      selfReportedTrust: null,
    },
    payload,
    ...overrides,
  }));
}

function readinessLayers(candidateBinding, quantitative = {
  kind: "quantitative",
  estimatedActiveMinutes: 120,
  finding: "within_budget",
}) {
  return [
    evidence(candidateBinding, "semantic", {
      kind: "semantic",
      finding: "pass",
      requirementRefs: ["requirement:1"],
    }),
    evidence(candidateBinding, "quantitative", quantitative),
    evidence(candidateBinding, "repository_feasibility", {
      kind: "repository_feasibility",
      finding: "feasible",
      repositoryId: candidateBinding.repository.id,
      baseRevision: candidateBinding.repository.baseRevision,
      roleRunId: "role-run:1",
      launchPermitId: "launch-permit:1",
    }),
  ];
}

function assess(candidateBinding, suppliedEvidence, history = [], assessmentRef = "assessment:1") {
  return assessReadiness({
    assessmentRef,
    candidate: candidateBinding,
    evidence: suppliedEvidence,
    history,
  });
}

function forgeEvidence(input) {
  return { ...input, canonicalSha256: digest(input) };
}

test("ready assessment binds sorted evidence, lineage, canonical hash, and frozen copies", () => {
  const bound = candidate();
  const inputEvidence = readinessLayers(bound).reverse();
  const result = value(assess(bound, inputEvidence));
  assert.equal(result.disposition, "ready");
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.sequence, 1);
  assert.equal(result.previousAssessmentRef, null);
  assert.deepEqual(
    result.evidence.map((binding) => binding.evidenceRef),
    ["evidence:quantitative", "evidence:repository_feasibility", "evidence:semantic"],
  );
  assert.equal(result.evidenceSetSha256, digest(result.evidence));
  const { canonicalSha256, ...unhashed } = result;
  assert.equal(canonicalSha256, digest(unhashed));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.candidate.subject), true);
  assert.equal(Object.isFrozen(result.evidence), true);
  assert.equal(Object.isFrozen(inputEvidence), false);
});

test("disposition precedence preserves semantic decomposition over blocked layers", () => {
  const bound = candidate();
  const semantic = evidence(bound, "semantic", {
    kind: "semantic",
    finding: "must_decompose",
    requirementRefs: ["requirement:1"],
  });
  const result = value(assess(bound, [semantic]));
  assert.equal(result.disposition, "must_decompose");
  assert.deepEqual(result.reasonCodes, [
    "semantic_must_decompose",
    "missing_quantitative_evidence",
    "missing_repository_feasibility",
  ]);
});

test("a Human Governor exception applies only to one exact minor overrun", () => {
  const bound = candidate();
  const layers = readinessLayers(bound, {
    kind: "quantitative",
    estimatedActiveMinutes: 121,
    finding: "minor_overrun",
  });
  const quantitative = layers.find((item) => item.kind === "quantitative");
  const authority = evidence(bound, "authority", {
    kind: "authority",
    authority: "human_portfolio_governor",
    decisionRef: "decision:1",
    scope: "readiness_quantitative_exception",
  });
  const exception = evidence(bound, "quantitative_exception", {
    kind: "quantitative_exception",
    quantitativeEvidenceRef: quantitative.evidenceRef,
    decisionRef: "decision:1",
    authorityEvidenceRef: authority.evidenceRef,
    rationaleRef: "reason:minor-overrun",
  });
  const applied = value(assess(bound, [...layers, exception, authority]));
  assert.equal(applied.disposition, "ready");
  assert.deepEqual(applied.reasonCodes, [
    "quantitative_minor_overrun",
    "quantitative_exception_applied",
  ]);

  const wrongActorInput = {
    ...authority,
    producer: { ...authority.producer, actorRef: "actor:other" },
  };
  const { canonicalSha256: _oldHash, ...wrongActorUnhashed } = wrongActorInput;
  const wrongActor = {
    ...wrongActorUnhashed,
    canonicalSha256: digest(wrongActorUnhashed),
  };
  const invalid = value(assess(bound, [...layers, exception, wrongActor]));
  assert.equal(invalid.disposition, "needs_refinement");
  assert.deepEqual(invalid.reasonCodes, [
    "quantitative_minor_overrun",
    "evidence_provenance_failure",
    "invalid_quantitative_exception",
  ]);
});

test("assessment records self-consistent semantic poison as blocked reasons", () => {
  const bound = candidate();
  const [, quantitative, repository] = readinessLayers(bound);
  const poisonedInput = {
    evidenceRef: "evidence:semantic-poison",
    kind: "semantic",
    candidateSha256: bound.canonicalSha256,
    sourceRef: "source:semantic-poison",
    sourceRevision: "source-v1",
    producer: {
      kind: "product_ai",
      actorRef: "actor:ai",
      authorityEvidenceRef: null,
      selfReportedTrust: "human",
    },
    payload: {
      kind: "semantic",
      finding: "pass",
      requirementRefs: ["requirement:1"],
    },
  };
  const result = value(assess(bound, [forgeEvidence(poisonedInput), quantitative, repository]));
  assert.equal(result.disposition, "blocked");
  assert.deepEqual(result.reasonCodes, [
    "missing_semantic_evidence",
    "evidence_provenance_failure",
  ]);

  const mismatchInput = {
    evidenceRef: "evidence:quantitative-mismatch",
    kind: "quantitative",
    candidateSha256: bound.canonicalSha256,
    sourceRef: "source:quantitative-mismatch",
    sourceRevision: "source-v1",
    producer: {
      kind: "deterministic_evaluator",
      actorRef: "actor:evaluator",
      authorityEvidenceRef: null,
      selfReportedTrust: null,
    },
    payload: {
      kind: "quantitative",
      estimatedActiveMinutes: 121,
      finding: "within_budget",
    },
  };
  const [semantic, , feasible] = readinessLayers(bound);
  const mismatch = value(assess(
    bound,
    [semantic, forgeEvidence(mismatchInput), feasible],
    [],
    "assessment:mismatch",
  ));
  assert.equal(mismatch.disposition, "blocked");
  assert.deepEqual(mismatch.reasonCodes, ["quantitative_finding_mismatch"]);
});

test("wrong candidate, EvidenceRef collision, and exact duplicate fail closed distinctly", () => {
  const bound = candidate();
  const layers = readinessLayers(bound);
  const wrong = evidence(bound, "authority", {
    kind: "authority",
    authority: "human_portfolio_governor",
    decisionRef: "decision:wrong",
    scope: "readiness_quantitative_exception",
  }, { candidateSha256: "b".repeat(64) });
  const wrongResult = value(assess(bound, [...layers, wrong]));
  assert.equal(wrongResult.disposition, "blocked");
  assert.deepEqual(wrongResult.reasonCodes, ["wrong_candidate_evidence"]);

  const wrongException = evidence(bound, "quantitative_exception", {
    kind: "quantitative_exception",
    quantitativeEvidenceRef: "evidence:quantitative",
    decisionRef: "decision:wrong-candidate",
    authorityEvidenceRef: "evidence:authority",
    rationaleRef: "reason:wrong-candidate",
  }, { candidateSha256: "b".repeat(64) });
  const wrongExceptionResult = value(assess(
    bound,
    [...layers, wrongException],
    [],
    "assessment:wrong-exception",
  ));
  assert.deepEqual(wrongExceptionResult.reasonCodes, [
    "wrong_candidate_evidence",
    "invalid_quantitative_exception",
  ]);

  const semantic = layers.find((item) => item.kind === "semantic");
  const quantitative = layers.find((item) => item.kind === "quantitative");
  const { canonicalSha256: _hash, ...quantitativeInput } = quantitative;
  const collidingInput = {
    ...quantitativeInput,
    evidenceRef: semantic.evidenceRef,
  };
  const colliding = forgeEvidence(collidingInput);
  const collisionResult = value(assess(
    bound,
    [semantic, colliding, layers[2]],
    [],
    "assessment:collision",
  ));
  assert.equal(collisionResult.disposition, "blocked");
  assert.deepEqual(collisionResult.reasonCodes, ["evidence_integrity_failure"]);
  assert.equal(collisionResult.evidence.length, 3);

  const duplicate = assess(
    bound,
    [...layers, layers[0]],
    [],
    "assessment:duplicate",
  );
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.rejection.code, "invalid_evidence");
  assert.equal(duplicate.rejection.reason, "duplicate_entry");
});

test("Initiative applicability is explicit and not-applicable remains ready", () => {
  const initiative = candidate({
    subject: { kind: "initiative", id: "initiative:workflow", revision: 3 },
    applicability: "not_applicable",
  });
  const policy = evidence(initiative, "applicability_policy", {
    kind: "applicability_policy",
    subjectKind: "initiative",
    applicability: "not_applicable",
    policyRef: initiative.policy.ref,
    profileRevision: initiative.policy.profileRevision,
  });
  const result = value(assess(initiative, [policy]));
  assert.equal(result.applicability, "not_applicable");
  assert.equal(result.disposition, "ready");
  assert.deepEqual(result.reasonCodes, ["not_applicable_by_policy"]);
});

test("lineage permits same-candidate blocked retry and forbids ready reuse", () => {
  const bound = candidate();
  const blocked = value(assess(bound, [], [], "assessment:blocked"));
  assert.equal(blocked.disposition, "blocked");
  const retried = value(assess(
    bound,
    readinessLayers(bound),
    [blocked],
    "assessment:retry",
  ));
  assert.equal(retried.sequence, 2);
  assert.equal(retried.previousAssessmentRef, blocked.assessmentRef);
  assert.equal(retried.previousAssessmentSha256, blocked.canonicalSha256);
  assert.equal(retried.disposition, "ready");

  const forbidden = assess(
    bound,
    readinessLayers(bound),
    [blocked, retried],
    "assessment:forbidden",
  );
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.rejection.reason, "candidate_reuse_forbidden");
});

test("forged evidence digest and malformed history reject as operations", () => {
  const bound = candidate();
  const forged = { ...readinessLayers(bound)[0], canonicalSha256: "b".repeat(64) };
  const evidenceResult = assess(bound, [forged]);
  assert.equal(evidenceResult.ok, false);
  assert.equal(evidenceResult.rejection.code, "invalid_evidence");
  assert.equal(evidenceResult.rejection.reason, "invalid_canonical_hash");

  const first = value(assess(bound, [], [], "assessment:first"));
  const { canonicalSha256: _hash, ...gapUnhashed } = first;
  const gap = {
    ...gapUnhashed,
    sequence: 2,
    previousAssessmentRef: "assessment:missing",
    previousAssessmentSha256: SHA,
  };
  gap.canonicalSha256 = digest(gap);
  const historyResult = assess(
    bound,
    readinessLayers(bound),
    [gap],
    "assessment:after-gap",
  );
  assert.equal(historyResult.ok, false);
  assert.equal(historyResult.rejection.code, "invalid_lineage");
  assert.equal(historyResult.rejection.reason, "history_sequence_gap");

  const noPredecessor = { ...gap, previousAssessmentRef: null, previousAssessmentSha256: null };
  const { canonicalSha256: _gapHash, ...noPredecessorUnhashed } = noPredecessor;
  noPredecessor.canonicalSha256 = digest(noPredecessorUnhashed);
  const predecessorResult = assess(
    bound,
    readinessLayers(bound),
    [noPredecessor],
    "assessment:no-predecessor",
  );
  assert.equal(predecessorResult.ok, false);
  assert.equal(predecessorResult.rejection.reason, "history_predecessor_mismatch");

  const layers = readinessLayers(bound);
  const duplicateBeforeHistory = assess(
    bound,
    [...layers, layers[0]],
    [gap],
    "assessment:duplicate-before-history",
  );
  assert.equal(duplicateBeforeHistory.ok, false);
  assert.equal(duplicateBeforeHistory.rejection.code, "invalid_evidence");
  assert.equal(duplicateBeforeHistory.rejection.reason, "duplicate_entry");
});
