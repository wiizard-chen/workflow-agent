import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assessReadiness,
  createGovernanceEvidence,
  createReadinessCandidateBinding,
  projectReadinessFreshness,
  qualifyReadinessForConsumption,
} from "@pi-workflow/v2-readiness";

import {
  assertDeepFrozen,
  candidate,
  candidateInput,
  currentContext,
  evidenceInput,
  jsonClone,
  projection,
  readinessLayers,
  success,
} from "./t4-helpers.mjs";

function validOperationCases() {
  const bound = candidate();
  const layers = readinessLayers(bound);
  const assessment = success(assessReadiness({
    assessmentRef: "assessment:attack-base",
    candidate: bound,
    evidence: layers,
    history: [],
  }));
  const current = currentContext(assessment);
  return [
    ["candidate", createReadinessCandidateBinding, () => candidateInput(), "subject"],
    ["evidence", createGovernanceEvidence, () => evidenceInput(bound, "semantic", {
      kind: "semantic",
      finding: "pass",
      requirementRefs: ["requirement:1"],
    }), "producer"],
    ["assessment", assessReadiness, () => ({
      assessmentRef: "assessment:descriptor",
      candidate: jsonClone(bound),
      evidence: jsonClone(layers),
      history: [],
    }), "evidence"],
    ["freshness", projectReadinessFreshness, () => ({
      assessment: jsonClone(assessment),
      current: jsonClone(current),
    }), "assessment"],
    ["qualification", qualifyReadinessForConsumption, () => ({
      assessment: jsonClone(assessment),
      freshness: projection(assessment),
      currentHead: {
        assessmentRef: assessment.assessmentRef,
        canonicalSha256: assessment.canonicalSha256,
      },
      purpose: "product_approval",
    }), "assessment"],
  ];
}

test("all five operations reject root prototypes, symbols, and accessors without invoking code", () => {
  for (const [label, operation, makeInput, accessorField] of validOperationCases()) {
    const inherited = Object.assign(Object.create({ inherited: true }), makeInput());
    const prototypeResult = operation(inherited);
    assert.equal(prototypeResult.ok, false, `${label}: prototype`);
    assert.equal(prototypeResult.rejection.reason, "plain_object", label);

    const symbolic = makeInput();
    symbolic[Symbol(`attack:${label}`)] = true;
    const symbolResult = operation(symbolic);
    assert.equal(symbolResult.ok, false, `${label}: symbol`);
    assert.equal(symbolResult.rejection.reason, "symbol_key", label);

    let calls = 0;
    const accessor = makeInput();
    Object.defineProperty(accessor, accessorField, {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error("accessor must not execute");
      },
    });
    const accessorResult = operation(accessor);
    assert.equal(accessorResult.ok, false, `${label}: accessor`);
    assert.equal(accessorResult.rejection.reason, "accessor", label);
    assert.equal(calls, 0, label);
  }
});

test("nested array descriptors and cyclic values return typed data instead of throwing", () => {
  const [, , assessmentCase] = validOperationCases();
  const [, operation, makeInput] = assessmentCase;
  let calls = 0;
  const accessorInput = makeInput();
  const attackedArray = [];
  Object.defineProperty(attackedArray, "0", {
    enumerable: true,
    configurable: true,
    get() {
      calls += 1;
      throw new Error("array accessor must not execute");
    },
  });
  accessorInput.evidence = attackedArray;
  const accessorResult = operation(accessorInput);
  assert.equal(accessorResult.ok, false);
  assert.equal(accessorResult.rejection.reason, "accessor");
  assert.equal(accessorResult.rejection.path, "/evidence/0");
  assert.equal(calls, 0);

  const accessorBeforeSparse = makeInput();
  const sparseAccessor = [];
  sparseAccessor.length = 2;
  Object.defineProperty(sparseAccessor, "0", {
    enumerable: true,
    configurable: true,
    get() {
      calls += 1;
      throw new Error("sparse accessor must not execute");
    },
  });
  accessorBeforeSparse.evidence = sparseAccessor;
  const sparseAccessorResult = operation(accessorBeforeSparse);
  assert.equal(sparseAccessorResult.ok, false);
  assert.equal(sparseAccessorResult.rejection.reason, "accessor");
  assert.equal(sparseAccessorResult.rejection.path, "/evidence/0");
  assert.equal(calls, 0);

  const extraNumericKey = makeInput();
  Object.defineProperty(extraNumericKey.evidence, "4294967295", {
    configurable: true,
    enumerable: true,
    value: "smuggled",
    writable: true,
  });
  const numericKeyResult = operation(extraNumericKey);
  assert.equal(numericKeyResult.ok, false);
  assert.equal(numericKeyResult.rejection.reason, "exact_fields");
  assert.equal(numericKeyResult.rejection.path, "/evidence/4294967295");

  for (const [label, invoke, build] of validOperationCases()) {
    const input = build();
    switch (label) {
      case "candidate":
        input.subject.id = input;
        break;
      case "evidence":
        input.producer.actorRef = input;
        break;
      case "assessment":
        input.candidate.subject.id = input;
        break;
      case "freshness":
        input.current.subject.id = input;
        break;
      case "qualification":
        input.currentHead.assessmentRef = input;
        break;
    }
    assert.doesNotThrow(() => {
      const result = invoke(input);
      assert.equal(result.ok, false, label);
      assert.ok(result.rejection.reason, label);
    });
  }
});

test("throwing and revoked proxies fail closed across all five operations", () => {
  for (const [label, operation, makeInput] of validOperationCases()) {
    const root = new Proxy(makeInput(), {
      getPrototypeOf() {
        throw new Error("root proxy trap");
      },
    });
    assert.doesNotThrow(() => {
      const result = operation(root);
      assert.equal(result.ok, false, `${label}: root proxy`);
    });

    const nested = makeInput();
    const nestedField = label === "candidate"
      ? "subject"
      : label === "evidence"
        ? "producer"
        : label === "assessment"
          ? "candidate"
          : label === "freshness"
            ? "current"
            : "currentHead";
    nested[nestedField] = new Proxy(nested[nestedField], {
      ownKeys() {
        throw new Error("nested proxy trap");
      },
    });
    assert.doesNotThrow(() => {
      const result = operation(nested);
      assert.equal(result.ok, false, `${label}: nested proxy`);
    });

    const arrayInput = makeInput();
    const revocable = Proxy.revocable([], {});
    revocable.revoke();
    if (label === "candidate") arrayInput.subject = revocable.proxy;
    if (label === "evidence") arrayInput.payload.requirementRefs = revocable.proxy;
    if (label === "assessment") arrayInput.evidence = revocable.proxy;
    if (label === "freshness") arrayInput.current.evidence = revocable.proxy;
    if (label === "qualification") arrayInput.freshness.reasons = revocable.proxy;
    assert.doesNotThrow(() => {
      const result = operation(arrayInput);
      assert.equal(result.ok, false, `${label}: revoked array proxy`);
    });
  }
});

test("sparse maximum-length arrays reject in bounded time", () => {
  const script = `
    import { createGovernanceEvidence } from "@pi-workflow/v2-readiness";
    const requirementRefs = [];
    requirementRefs.length = 4294967295;
    const result = createGovernanceEvidence({
      evidenceRef: "evidence:sparse",
      kind: "semantic",
      candidateSha256: "${"a".repeat(64)}",
      sourceRef: "source:sparse",
      sourceRevision: "v1",
      producer: {
        kind: "deterministic_evaluator",
        actorRef: "actor:1",
        authorityEvidenceRef: null,
        selfReportedTrust: null,
      },
      payload: { kind: "semantic", finding: "pass", requirementRefs },
    });
    if (result.ok || result.rejection.reason !== "exact_fields") process.exitCode = 2;
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 1_000,
  });
  assert.equal(child.error, undefined, String(child.error));
  assert.equal(child.status, 0, child.stderr);
});

test("validation priority is prototype, symbol, canonical field, scalar, hash, then relationship", () => {
  const prototypeAndSymbol = Object.assign(Object.create({}), candidateInput());
  prototypeAndSymbol[Symbol("later")] = true;
  assert.equal(createReadinessCandidateBinding(prototypeAndSymbol).rejection.reason, "plain_object");

  let calls = 0;
  const symbolAndAccessor = candidateInput();
  symbolAndAccessor[Symbol("first")] = true;
  Object.defineProperty(symbolAndAccessor, "subject", {
    enumerable: true,
    get() {
      calls += 1;
      throw new Error("must not run");
    },
  });
  assert.equal(createReadinessCandidateBinding(symbolAndAccessor).rejection.reason, "symbol_key");
  assert.equal(calls, 0);

  const canonicalFieldOrder = candidateInput();
  canonicalFieldOrder.aaa = true;
  Object.defineProperty(canonicalFieldOrder, "zzz", {
    enumerable: true,
    get() {
      calls += 1;
      throw new Error("must not run");
    },
  });
  const fieldResult = createReadinessCandidateBinding(canonicalFieldOrder);
  assert.deepEqual(fieldResult.rejection, {
    code: "invalid_input",
    path: "/aaa",
    reason: "exact_fields",
    relatedRef: null,
  });
  assert.equal(calls, 0);

  const scalarOrder = candidateInput({ applicability: "later-invalid" });
  scalarOrder.bundle.manifestSha256 = "A".repeat(64);
  const scalarResult = createReadinessCandidateBinding(scalarOrder);
  assert.equal(scalarResult.rejection.path, "/bundle/manifestSha256");
  assert.equal(scalarResult.rejection.reason, "invalid_sha256");
});

test("canonical digest attacks are rejected at every downstream trust boundary", () => {
  const bound = candidate();
  const layers = readinessLayers(bound);
  const validAssessment = success(assessReadiness({
    assessmentRef: "assessment:hash",
    candidate: bound,
    evidence: layers,
    history: [],
  }));

  const forgedCandidate = { ...bound, canonicalSha256: "b".repeat(64) };
  const candidateResult = assessReadiness({
    assessmentRef: "assessment:forged-candidate",
    candidate: forgedCandidate,
    evidence: layers,
    history: [],
  });
  assert.equal(candidateResult.ok, false);
  assert.equal(candidateResult.rejection.reason, "invalid_canonical_hash");

  const forgedEvidence = { ...layers[0], canonicalSha256: "c".repeat(64) };
  const evidenceResult = assessReadiness({
    assessmentRef: "assessment:forged-evidence",
    candidate: bound,
    evidence: [forgedEvidence, layers[1], layers[2]],
    history: [],
  });
  assert.equal(evidenceResult.ok, false);
  assert.equal(evidenceResult.rejection.reason, "invalid_canonical_hash");

  const forgedAssessment = { ...validAssessment, canonicalSha256: "d".repeat(64) };
  const freshnessResult = projectReadinessFreshness({
    assessment: forgedAssessment,
    current: currentContext(validAssessment),
  });
  assert.equal(freshnessResult.ok, false);
  assert.equal(freshnessResult.rejection.reason, "invalid_canonical_hash");

  const qualificationResult = qualifyReadinessForConsumption({
    assessment: forgedAssessment,
    freshness: projection(validAssessment),
    currentHead: {
      assessmentRef: validAssessment.assessmentRef,
      canonicalSha256: validAssessment.canonicalSha256,
    },
    purpose: "product_approval",
  });
  assert.equal(qualificationResult.ok, false);
  assert.equal(qualificationResult.rejection.reason, "invalid_canonical_hash");
});

test("all five successful operations copy/freeze outputs without mutating or freezing caller values", () => {
  const boundInput = candidateInput();
  const evidenceBound = candidate();
  const semanticInput = evidenceInput(evidenceBound, "semantic", {
    kind: "semantic",
    finding: "pass",
    requirementRefs: ["requirement:2", "requirement:1"],
  });
  const layers = readinessLayers(evidenceBound);
  const assessmentInput = {
    assessmentRef: "assessment:immutability",
    candidate: jsonClone(evidenceBound),
    evidence: jsonClone(layers),
    history: [],
  };
  const assessment = success(assessReadiness(assessmentInput));
  const freshnessInput = {
    assessment: jsonClone(assessment),
    current: currentContext(assessment),
  };
  const qualificationInput = {
    assessment: jsonClone(assessment),
    freshness: projection(assessment),
    currentHead: {
      assessmentRef: assessment.assessmentRef,
      canonicalSha256: assessment.canonicalSha256,
    },
    purpose: "product_approval",
  };
  const cases = [
    [createReadinessCandidateBinding, boundInput],
    [createGovernanceEvidence, semanticInput],
    [assessReadiness, assessmentInput],
    [projectReadinessFreshness, freshnessInput],
    [qualifyReadinessForConsumption, qualificationInput],
  ];
  for (const [operation, input] of cases) {
    const before = JSON.stringify(input);
    const result = success(operation(input));
    assert.equal(JSON.stringify(input), before);
    assert.equal(Object.isFrozen(input), false);
    assertDeepFrozen(result);
  }
  assert.deepEqual(success(createGovernanceEvidence(semanticInput)).payload.requirementRefs, [
    "requirement:1",
    "requirement:2",
  ]);
});
