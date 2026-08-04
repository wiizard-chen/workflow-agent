import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalDecisionJson,
  createDecisionRecord,
  GLOBAL_RECOMMENDATION,
} from "./decision-record.mjs";

function root(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("decision record is deterministic, blocked-safe, and native-only", () => {
  const firstRoot = root("workflowd-e68-decision-");
  const secondRoot = root("workflowd-e68-decision-");
  try {
    const first = createDecisionRecord({ root: firstRoot });
    const second = createDecisionRecord({ root: secondRoot });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.value.decisionSha256, second.value.decisionSha256);
    assert.equal(first.value.globalRecommendation, GLOBAL_RECOMMENDATION);
    assert.equal(first.value.productionAdapterSelected, false);
    assert.equal(first.value.separateAdrRequired, true);
    assert.equal(first.value.candidateDispositions.length, 5);
    assert.equal(first.value.candidateDispositions.filter((item) => item.disposition === "BLOCKED").length, 4);
    assert.equal(first.value.qualificationRecord.disposition, "BLOCKED");
    assert.equal(canonicalDecisionJson(first.value).ok, true);
    assert.equal(Object.isFrozen(first.value), true);
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("decision requires an explicit temporary root and rejects tampered digest", () => {
  const missing = createDecisionRecord();
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.rejection.code, "invalid_root");

  const rootPath = root("workflowd-e68-decision-");
  try {
    const result = createDecisionRecord({ root: rootPath });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tampered = { ...result.value, globalRecommendation: "ADOPT_EXTERNAL" };
    assert.equal(canonicalDecisionJson(tampered).ok, false);
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
  }
});
