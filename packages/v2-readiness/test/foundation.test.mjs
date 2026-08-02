import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalizeJson } from "@pi-workflow/v2-domain";

import {
  createGovernanceEvidence,
  createReadinessCandidateBinding,
} from "../dist/index.js";

const SHA = "a".repeat(64);

function canonicalDigest(value) {
  const canonical = canonicalizeJson(value);
  assert.equal(canonical.ok, true);
  return createHash("sha256").update(canonical.text, "utf8").digest("hex");
}

function candidateInput(overrides = {}) {
  return {
    subject: { kind: "epic", id: "epic-70", revision: 2 },
    bundle: { ref: "bundle:e70", manifestSha256: SHA },
    repository: { id: "repository:workflow-agent", baseRevision: "536d986" },
    policy: { ref: "policy:readiness", profileRevision: "v2" },
    requirementSet: { ref: "requirements:e70", revision: "approved-v2" },
    applicability: "applicable",
    ...overrides,
  };
}

function evidenceInput(kind, payload, producer = {}) {
  return {
    evidenceRef: `evidence:${kind}`,
    kind,
    candidateSha256: SHA,
    sourceRef: `source:${kind}`,
    sourceRevision: "revision-1",
    producer: {
      kind: kind === "repository_feasibility"
        ? "engineering_lead"
        : kind === "quantitative_exception" || kind === "authority"
          ? "human_governor"
          : "deterministic_evaluator",
      actorRef: "actor:one",
      authorityEvidenceRef: kind === "quantitative_exception"
        ? "evidence:authority"
        : null,
      selfReportedTrust: null,
      ...producer,
    },
    payload,
  };
}

test("candidate binding is copied, recursively frozen, and canonically hashed", () => {
  const input = candidateInput();
  const result = createReadinessCandidateBinding(input);
  assert.equal(result.ok, true);
  assert.equal(result.value.canonicalSha256, canonicalDigest(input));
  assert.equal(Object.isFrozen(input), false);
  assert.notEqual(result.value.subject, input.subject);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.subject), true);
  input.subject.id = "changed";
  assert.equal(result.value.subject.id, "epic-70");
});

test("candidate validation rejects exact-field, digest, and Epic applicability attacks", () => {
  assert.deepEqual(createReadinessCandidateBinding({ ...candidateInput(), extra: true }), {
    ok: false,
    rejection: { code: "invalid_input", path: "/extra", reason: "exact_fields", relatedRef: null },
  });
  assert.deepEqual(createReadinessCandidateBinding(candidateInput({ bundle: { ref: "bundle:e70", manifestSha256: "A".repeat(64) } })), {
    ok: false,
    rejection: { code: "invalid_input", path: "/bundle/manifestSha256", reason: "invalid_sha256", relatedRef: null },
  });
  assert.deepEqual(createReadinessCandidateBinding(candidateInput({ applicability: "not_applicable" })), {
    ok: false,
    rejection: { code: "invalid_binding", path: "/applicability", reason: "epic_not_applicable", relatedRef: null },
  });
});

test("all six evidence payloads produce independently frozen canonical records", () => {
  const cases = [
    evidenceInput("semantic", { kind: "semantic", finding: "pass", requirementRefs: ["requirement:z", "requirement:a"] }),
    evidenceInput("quantitative", { kind: "quantitative", estimatedActiveMinutes: 120, finding: "within_budget" }),
    evidenceInput("repository_feasibility", { kind: "repository_feasibility", finding: "feasible", repositoryId: "repository:workflow-agent", baseRevision: "536d986", roleRunId: "role-run:1", launchPermitId: "permit:1" }),
    evidenceInput("applicability_policy", { kind: "applicability_policy", subjectKind: "initiative", applicability: "applicable", policyRef: "policy:readiness", profileRevision: "v2" }),
    evidenceInput("quantitative_exception", { kind: "quantitative_exception", quantitativeEvidenceRef: "evidence:quantitative", decisionRef: "decision:1", authorityEvidenceRef: "evidence:authority", rationaleRef: "reason:1" }),
    evidenceInput("authority", { kind: "authority", authority: "human_portfolio_governor", decisionRef: "decision:1", scope: "readiness_quantitative_exception" }),
  ];
  for (const input of cases) {
    const result = createGovernanceEvidence(input);
    assert.equal(result.ok, true, input.kind);
    const { canonicalSha256, ...stored } = result.value;
    assert.equal(canonicalSha256, canonicalDigest(stored));
    assert.equal(Object.isFrozen(result.value), true);
    assert.equal(Object.isFrozen(result.value.payload), true);
    assert.equal(Object.isFrozen(input), false);
  }
  const semantic = createGovernanceEvidence(cases[0]);
  assert.equal(semantic.ok, true);
  assert.deepEqual(semantic.value.payload.requirementRefs, ["requirement:a", "requirement:z"]);
});

test("evidence creator rejects forged authority, self trust, mismatch, and duplicates", () => {
  const productAi = createGovernanceEvidence(evidenceInput(
    "semantic",
    { kind: "semantic", finding: "pass", requirementRefs: ["requirement:1"] },
    { kind: "product_ai", selfReportedTrust: "human" },
  ));
  assert.equal(productAi.ok, false);
  assert.equal(productAi.rejection.reason, "producer_not_authorized");

  const mismatch = createGovernanceEvidence(evidenceInput(
    "quantitative",
    { kind: "quantitative", estimatedActiveMinutes: 121, finding: "within_budget" },
  ));
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.rejection.reason, "invalid_quantitative_finding");

  const duplicate = createGovernanceEvidence(evidenceInput(
    "semantic",
    { kind: "semantic", finding: "pass", requirementRefs: ["requirement:1", "requirement:1"] },
  ));
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.rejection.reason, "duplicate_entry");
});

test("accessors are rejected without invocation", () => {
  let invoked = false;
  const input = candidateInput();
  Object.defineProperty(input, "applicability", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("must not run");
    },
  });
  const result = createReadinessCandidateBinding(input);
  assert.equal(result.ok, false);
  assert.equal(result.rejection.reason, "accessor");
  assert.equal(invoked, false);
});
