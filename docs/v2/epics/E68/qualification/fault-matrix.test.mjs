import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  canonicalFaultMatrixJson,
  runAndCleanFaultAuthorityMatrix,
  runFaultAuthorityMatrix,
} from "./fault-matrix.mjs";

function root(prefix = "workflowd-e68-matrix-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("fault and authority matrix is deterministic and keeps native fallback", () => {
  const firstRoot = root();
  const secondRoot = root();
  try {
    const first = runFaultAuthorityMatrix({ root: firstRoot });
    const second = runFaultAuthorityMatrix({ root: secondRoot });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.value.matrixSha256, second.value.matrixSha256);
    assert.equal(first.value.nativeFallback, true);
    assert.equal(first.value.candidates.length, 5);
    assert.deepEqual(first.value.matrix.observations.map((item) => item.name), [
      "checkpoint-replay", "timer-wakeup", "retry", "cancellation",
      "duplicate-idempotency", "stale-fencing", "schema-drift",
      "unknown-effect", "artifact-integrity",
    ]);
    assert.ok(first.value.candidates.slice(1).every((candidate) => candidate.status === "blocked"));
    assert.ok(first.value.authority.every((check) => check.status === "pass"));
    assert.equal(canonicalFaultMatrixJson(first.value).ok, true);
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("matrix rejects missing roots and never follows a descriptor outside the root", () => {
  const result = runFaultAuthorityMatrix({});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.rejection.code, "invalid_root");

  const rootPath = root();
  const outside = root("workflowd-e68-matrix-outside-");
  try {
    writeFileSync(join(outside, "e68-candidate.json"), "{}", { mode: 0o600 });
    const resultWithDescriptor = runFaultAuthorityMatrix({
      root: rootPath,
      candidateRoots: { temporal: outside },
    });
    assert.equal(resultWithDescriptor.ok, true);
    assert.deepEqual(readdirSync(rootPath).sort(), ["step-ledger.sqlite"]);
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("convenience runner removes the explicit temporary root", () => {
  const rootPath = root();
  const result = runAndCleanFaultAuthorityMatrix({ root: rootPath });
  assert.equal(result.ok, true);
  assert.throws(() => readdirSync(rootPath), /ENOENT/);
});
