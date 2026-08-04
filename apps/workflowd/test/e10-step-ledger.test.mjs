import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openArtifactStore, openLeaseStore, openStepLedger } from "@pi-workflow/workflowd";

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pi-workflow-e10-"));
  const databasePath = join(root, "runtime.db");
  let now = 1_000;
  const clock = () => now;
  const leases = openLeaseStore({ runtimeRoot: root, databasePath, now: clock, heartbeatIntervalMs: 100, leaseTtlMs: 10_000 });
  assert.equal(leases.ok, true, leases.ok ? "" : JSON.stringify(leases.rejection));
  const lease = leases.value.acquire({ resourceKind: "repository", resourceId: "repo-1", ownerId: "owner-1" });
  assert.equal(lease.ok, true, lease.ok ? "" : JSON.stringify(lease.rejection));
  const artifacts = openArtifactStore({ artifactRoot: join(root, "artifacts"), now: clock });
  assert.equal(artifacts.ok, true, artifacts.ok ? "" : JSON.stringify(artifacts.rejection));
  const ledger = openStepLedger({ runtimeRoot: root, databasePath, now: clock, leaseStore: leases.value, artifactStore: artifacts.value });
  assert.equal(ledger.ok, true, ledger.ok ? "" : JSON.stringify(ledger.rejection));
  return { root, clock, setNow: (value) => { now = value; }, leases: leases.value, credentials: lease.value, artifacts: artifacts.value, ledger: ledger.value };
}

function closeFixture(value) {
  value.ledger.close();
  value.artifacts.close();
  value.leases.close();
  rmSync(value.root, { recursive: true, force: true });
}

test("E10 state path persists immutable attempt and supports idempotent replay", () => {
  const f = fixture();
  try {
    const planned = f.ledger.plan({ stepId: "step-1", policyHash: "policy-v1", role: "engineering-lead", model: "diagnostic", outputLocation: "out/1", workerGeneration: 1 }, f.credentials);
    assert.equal(planned.ok, true, planned.ok ? "" : JSON.stringify(planned.rejection));
    assert.equal(planned.value.state, "planned");
    const preparedInput = { stepId: "step-1", idempotencyKey: "attempt-1", inputJson: { z: 1, a: "x" }, policySha256: "policy-v1", role: "engineering-lead", model: "diagnostic", outputLocation: "out/1", workerGeneration: 1 };
    const prepared = f.ledger.prepare(preparedInput, f.credentials);
    assert.equal(prepared.ok, true, prepared.ok ? "" : JSON.stringify(prepared.rejection));
    assert.equal(prepared.value.attempt.sequence, 1);
    const replay = f.ledger.prepare(preparedInput, f.credentials);
    assert.equal(replay.ok, true, replay.ok ? "" : JSON.stringify(replay.rejection));
    assert.equal(replay.value.attempt.stepAttemptId, prepared.value.attempt.stepAttemptId);
    const executing = f.ledger.transition({ stepId: "step-1", expectedRevision: 1, operationKey: "exec-1", toState: "executing" }, f.credentials);
    assert.equal(executing.ok, true, executing.ok ? "" : JSON.stringify(executing.rejection));
    const effect = f.ledger.observeEffect({ stepId: "step-1", expectedRevision: 2, operationKey: "effect-1", effect: { effectKey: "effect-1", outcome: "confirmed" } }, f.credentials);
    assert.equal(effect.ok, true, effect.ok ? "" : JSON.stringify(effect.rejection));
    const record = f.ledger.get("step-1");
    assert.equal(record.ok, true);
    assert.equal(record.value.state, "effect-observed");
    assert.equal(Object.isFrozen(record.value), true);
  } finally {
    closeFixture(f);
  }
});

test("E10 artifact validation and completion fail closed on tamper", () => {
  const f = fixture();
  try {
    const artifact = f.artifacts.put(new TextEncoder().encode("immutable"), { mediaType: "text/plain", authority: "test", retentionClass: "standard" });
    assert.equal(artifact.ok, true, artifact.ok ? "" : JSON.stringify(artifact.rejection));
    const plan = f.ledger.plan({ stepId: "step-2", policyHash: "policy-v1", role: "engineering-lead", model: "diagnostic", outputLocation: "out/2", workerGeneration: 1 }, f.credentials);
    assert.equal(plan.ok, true);
    const prepare = f.ledger.prepare({ stepId: "step-2", idempotencyKey: "attempt-2", inputJson: {}, policySha256: "policy-v1", role: "engineering-lead", model: "diagnostic", outputLocation: "out/2", workerGeneration: 1 }, f.credentials);
    assert.equal(prepare.ok, true);
    assert.equal(f.ledger.transition({ stepId: "step-2", expectedRevision: 1, operationKey: "exec-2", toState: "executing" }, f.credentials).ok, true);
    assert.equal(f.ledger.observeEffect({ stepId: "step-2", expectedRevision: 2, operationKey: "effect-2", effect: { effectKey: "effect-2", outcome: "confirmed", artifactId: artifact.value.artifactId, artifactSha256: artifact.value.sha256 } }, f.credentials).ok, true);
    const validated = f.ledger.validate({ stepId: "step-2", expectedRevision: 3, operationKey: "validate-2", validation: { artifactId: artifact.value.artifactId, artifactSha256: artifact.value.sha256, validatedAtEpochMs: 1_000 } }, f.credentials);
    assert.equal(validated.ok, true, validated.ok ? "" : JSON.stringify(validated.rejection));
    const completed = f.ledger.complete({ stepId: "step-2", expectedRevision: 4, operationKey: "complete-2" }, f.credentials);
    assert.equal(completed.ok, true, completed.ok ? "" : JSON.stringify(completed.rejection));
    assert.equal(completed.value.state, "completed");
  } finally {
    closeFixture(f);
  }
});

test("E10 stale revisions and unknown recovery are explicit", () => {
  const f = fixture();
  try {
    assert.equal(f.ledger.plan({ stepId: "step-3", policyHash: "policy-v1", role: "engineering-lead", model: "diagnostic", outputLocation: "out/3", workerGeneration: 1 }, f.credentials).ok, true);
    assert.equal(f.ledger.prepare({ stepId: "step-3", idempotencyKey: "attempt-3", inputJson: {}, policySha256: "policy-v1", role: "engineering-lead", model: "diagnostic", outputLocation: "out/3", workerGeneration: 1 }, f.credentials).ok, true);
    assert.equal(f.ledger.transition({ stepId: "step-3", expectedRevision: 0, operationKey: "stale", toState: "executing" }, f.credentials).rejection.code, "expected_revision_mismatch");
    assert.equal(f.ledger.transition({ stepId: "step-3", expectedRevision: 1, operationKey: "exec-3", toState: "executing" }, f.credentials).ok, true);
    const report = f.ledger.scan();
    assert.equal(report.ok, true, report.ok ? "" : JSON.stringify(report.rejection));
    assert.equal(report.value.status, "needs-recovery");
    assert.equal(report.value.cases[0].action, "manual-recovery");
    assert.equal(report.value.reportSha256.length, 64);
    const manual = f.ledger.manualRecovery({ stepId: "step-3", expectedRevision: 2, operationKey: "manual-3", evidence: { reason: "operator-required" } }, f.credentials);
    assert.equal(manual.ok, true, manual.ok ? "" : JSON.stringify(manual.rejection));
    const supersede = f.ledger.supersede({ stepId: "step-3", expectedRevision: 2, operationKey: "supersede-3", evidence: { reason: "cancelled" } }, f.credentials);
    assert.equal(supersede.ok, true, supersede.ok ? "" : JSON.stringify(supersede.rejection));
  } finally {
    closeFixture(f);
  }
});

test("E10 adopt recovery requires hash-bound artifact evidence", () => {
  const f = fixture();
  try {
    assert.equal(f.ledger.plan({ stepId: "step-adopt", policyHash: "policy-v1", role: "engineering-lead", model: "diagnostic", outputLocation: "out/adopt", workerGeneration: 1 }, f.credentials).ok, true);
    assert.equal(f.ledger.prepare({ stepId: "step-adopt", idempotencyKey: "attempt-adopt", inputJson: {}, policySha256: "policy-v1", role: "engineering-lead", model: "diagnostic", outputLocation: "out/adopt", workerGeneration: 1 }, f.credentials).ok, true);
    assert.equal(f.ledger.transition({ stepId: "step-adopt", expectedRevision: 1, operationKey: "exec-adopt", toState: "executing" }, f.credentials).ok, true);
    const missingBinding = f.ledger.recordRecoveryDecision({ stepId: "step-adopt", expectedRevision: 2, operationKey: "adopt-missing", action: "adopt", evidence: { reason: "not-an-artifact" } }, f.credentials);
    assert.equal(missingBinding.ok, false);
    if (!missingBinding.ok) assert.equal(missingBinding.rejection.code, "invalid_input");
    const artifact = f.artifacts.put(new TextEncoder().encode("adopt-evidence"), { mediaType: "text/plain", authority: "test", retentionClass: "standard" });
    assert.equal(artifact.ok, true, artifact.ok ? "" : JSON.stringify(artifact.rejection));
    if (!artifact.ok) return;
    const bound = f.ledger.recordRecoveryDecision({ stepId: "step-adopt", expectedRevision: 2, operationKey: "adopt-bound", action: "adopt", evidence: { artifactId: artifact.value.artifactId, artifactSha256: artifact.value.sha256 } }, f.credentials);
    assert.equal(bound.ok, true, bound.ok ? "" : JSON.stringify(bound.rejection));
    const wrongHash = f.ledger.recordRecoveryDecision({ stepId: "step-adopt", expectedRevision: 2, operationKey: "adopt-drift", action: "adopt", evidence: { artifactId: artifact.value.artifactId, artifactSha256: "0".repeat(64) } }, f.credentials);
    assert.equal(wrongHash.ok, false);
    if (!wrongHash.ok) assert.ok(["artifact_corrupt", "artifact_unavailable", "artifact_missing"].includes(wrongHash.rejection.code));
  } finally {
    closeFixture(f);
  }
});

test("E10 option validation rejects nested accessor capabilities without invoking them", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pi-workflow-e10-hostile-"));
  const databasePath = join(root, "runtime.db");
  let touched = false;
  const hostileLease = {};
  Object.defineProperty(hostileLease, "guard", { get() { touched = true; throw new Error("must-not-run"); } });
  try {
    const opened = openStepLedger({ runtimeRoot: root, databasePath, now: () => 1_000, leaseStore: hostileLease });
    assert.equal(opened.ok, false);
    assert.equal(touched, false);
    if (!opened.ok) assert.equal(opened.rejection.code, "invalid_input");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E10 reopens the version-4 ledger, fences stale credentials, and keeps read-only scans safe", () => {
  const f = fixture();
  try {
    const planned = f.ledger.plan({ stepId: "step-reopen", policyHash: "policy-v1", role: "engineering-lead", model: "diagnostic", outputLocation: "out/reopen", workerGeneration: 1 }, f.credentials);
    assert.equal(planned.ok, true, planned.ok ? "" : JSON.stringify(planned.rejection));
    const oldCredentials = f.credentials;
    f.ledger.close();
    f.artifacts.close();
    f.leases.close();
    f.setNow(12_000);

    const reopenedLeases = openLeaseStore({ runtimeRoot: f.root, databasePath: join(f.root, "runtime.db"), now: f.clock, heartbeatIntervalMs: 100, leaseTtlMs: 10_000 });
    assert.equal(reopenedLeases.ok, true, reopenedLeases.ok ? "" : JSON.stringify(reopenedLeases.rejection));
    if (!reopenedLeases.ok) return;
    const reacquired = reopenedLeases.value.acquire({ resourceKind: "repository", resourceId: "repo-1", ownerId: "owner-2" });
    assert.equal(reacquired.ok, true, reacquired.ok ? "" : JSON.stringify(reacquired.rejection));
    if (!reacquired.ok) return;
    assert.equal(reacquired.value.fencingToken, 2);
    const reopenedArtifacts = openArtifactStore({ artifactRoot: join(f.root, "artifacts"), now: f.clock });
    assert.equal(reopenedArtifacts.ok, true, reopenedArtifacts.ok ? "" : JSON.stringify(reopenedArtifacts.rejection));
    if (!reopenedArtifacts.ok) return;
    const reopened = openStepLedger({ runtimeRoot: f.root, databasePath: join(f.root, "runtime.db"), now: f.clock, leaseStore: reopenedLeases.value, artifactStore: reopenedArtifacts.value });
    assert.equal(reopened.ok, true, reopened.ok ? "" : JSON.stringify(reopened.rejection));
    if (!reopened.ok) return;
    const persisted = reopened.value.get("step-reopen");
    assert.equal(persisted.ok, true);
    assert.equal(persisted.value.state, "planned");
    const stale = reopened.value.plan({ stepId: "step-stale", policyHash: "policy-v1", role: "engineering-lead", model: "diagnostic", outputLocation: "out/stale", workerGeneration: 1 }, oldCredentials);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.rejection.code, "lease_fenced");
    const readOnly = openStepLedger({ runtimeRoot: f.root, databasePath: join(f.root, "runtime.db"), mode: "read-only", now: f.clock, leaseStore: reopenedLeases.value, artifactStore: reopenedArtifacts.value });
    assert.equal(readOnly.ok, true, readOnly.ok ? "" : JSON.stringify(readOnly.rejection));
    if (!readOnly.ok) return;
    assert.equal(readOnly.value.scan().ok, true);
    const denied = readOnly.value.plan({ stepId: "step-denied", policyHash: "policy-v1", role: "engineering-lead", model: "diagnostic", outputLocation: "out/denied", workerGeneration: 1 }, reacquired.value);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.rejection.code, "read_only");
    readOnly.value.close();
    reopened.value.close();
    reopenedArtifacts.value.close();
    reopenedLeases.value.close();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("E10 v4 restart preserves projections and rejects stale fencing", () => {
  const f = fixture();
  try {
    assert.equal(f.ledger.plan({ stepId: "step-4", policyHash: "policy-v1", role: "engineering-lead", model: "diagnostic", outputLocation: "out/4", workerGeneration: 1 }, f.credentials).ok, true);
    assert.equal(f.ledger.prepare({ stepId: "step-4", idempotencyKey: "attempt-4", inputJson: {}, policySha256: "policy-v1", role: "engineering-lead", model: "diagnostic", outputLocation: "out/4", workerGeneration: 1 }, f.credentials).ok, true);
    f.ledger.close();
    f.artifacts.close();
    f.leases.close();
    f.setNow(20_000);
    const leases = openLeaseStore({ runtimeRoot: f.root, databasePath: join(f.root, "runtime.db"), now: f.clock, heartbeatIntervalMs: 100, leaseTtlMs: 10_000 });
    assert.equal(leases.ok, true, leases.ok ? "" : JSON.stringify(leases.rejection));
    const current = leases.value.acquire({ resourceKind: "repository", resourceId: "repo-1", ownerId: "owner-2" });
    assert.equal(current.ok, true, current.ok ? "" : JSON.stringify(current.rejection));
    const ledger = openStepLedger({ runtimeRoot: f.root, databasePath: join(f.root, "runtime.db"), now: f.clock, leaseStore: leases.value });
    assert.equal(ledger.ok, true, ledger.ok ? "" : JSON.stringify(ledger.rejection));
    const restored = ledger.value.get("step-4");
    assert.equal(restored.ok, true);
    assert.equal(restored.value.state, "prepared");
    const stale = ledger.value.transition({ stepId: "step-4", expectedRevision: 1, operationKey: "stale-fence", toState: "executing" }, f.credentials);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.rejection.code, "lease_fenced");
    const readOnly = openStepLedger({ runtimeRoot: f.root, databasePath: join(f.root, "runtime.db"), mode: "read-only", now: f.clock, leaseStore: leases.value });
    assert.equal(readOnly.ok, true, readOnly.ok ? "" : JSON.stringify(readOnly.rejection));
    assert.equal(readOnly.value.get("step-4").ok, true);
    const denied = readOnly.value.plan({ stepId: "new", policyHash: "p", role: "r", model: "m", outputLocation: "o", workerGeneration: 1 }, current.value);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.rejection.code, "read_only");
    readOnly.value.close();
    ledger.value.close();
    leases.value.close();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
