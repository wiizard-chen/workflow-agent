import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DATABASE_FILENAME,
  DATABASE_MODE,
  FIXTURE_SCHEMA_VERSION,
  FIXTURE_VERSION,
  NATIVE_CANDIDATE_ID,
  OBSERVATION_NAMES,
  ROOT_MODE,
  createNativeFixture,
  createNativeStepLedgerFixture,
  runFixture,
} from "./fixture.mjs";

function withRoot(callback) {
  const root = mkdtempSync(join(tmpdir(), "e68-native-fixture-"));
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertResult(result) {
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.rejection));
  return result.value;
}

function attempt(id = "attempt-1", task = "task-1", fencingToken = 1) {
  return { taskId: task, attemptId: id, fencingToken };
}

function step(overrides = {}) {
  return {
    ...attempt(),
    stepId: "step-1",
    idempotencyKey: "step-key-1",
    fencingToken: 1,
    state: "completed",
    payload: { ordinal: 1, logical: "value" },
    ...overrides,
  };
}

test("import is side-effect free and explicit root is mandatory", () => {
  assert.equal(createNativeStepLedgerFixture().ok, false);
  assert.equal(createNativeStepLedgerFixture({ root: process.cwd() }).ok, false);
  assert.equal(createNativeStepLedgerFixture({ root: "/" }).ok, false);
});

test("fresh fixture uses only a temporary root, native SQLite WAL, and metadata-only schema", () => withRoot((root) => {
  const fixture = assertResult(createNativeStepLedgerFixture({ root }));
  const status = assertResult(fixture.inspect());
  assert.equal(status.fixtureVersion, FIXTURE_VERSION);
  assert.equal(status.schemaVersion, FIXTURE_SCHEMA_VERSION);
  assert.deepEqual(status.pragmas, {
    journalMode: "wal",
    synchronous: 2,
    foreignKeys: 1,
    busyTimeout: 5000,
  });
  assert.deepEqual(status.tables, [
    "checkpoint",
    "external_effect",
    "fixture_meta",
    "step_attempt",
    "task_attempt",
    "timer",
  ]);
  assert.deepEqual(readdirSync(root).sort(), [DATABASE_FILENAME, `${DATABASE_FILENAME}-shm`, `${DATABASE_FILENAME}-wal`].sort());
  assert.equal(statSync(root).mode & 0o777, ROOT_MODE);
  assert.equal(statSync(join(root, DATABASE_FILENAME)).mode & 0o777, DATABASE_MODE);
  assert.equal(fixture.candidateId, NATIVE_CANDIDATE_ID);
  assertResult(fixture.close());
}));

test("append is idempotent, conflicts fail closed, and stale fencing cannot mutate", () => withRoot((root) => {
  const fixture = assertResult(createNativeFixture({ root }));
  assert.equal(assertResult(fixture.startAttempt(attempt())).outcome, "inserted");
  const first = assertResult(fixture.appendStep(step()));
  assert.equal(first.outcome, "inserted");
  assert.equal(first.sequence, 1);
  const duplicate = assertResult(fixture.appendStep(step()));
  assert.equal(duplicate.outcome, "duplicate");
  const conflict = fixture.appendStep(step({ payload: { ordinal: 2, logical: "different" } }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.rejection.code, "idempotency_conflict");
  assertResult(fixture.advanceFence({ attemptId: "attempt-1", fencingToken: 2 }));
  const stale = fixture.appendStep(step({ idempotencyKey: "stale-key", fencingToken: 1 }));
  assert.equal(stale.ok, false);
  assert.equal(stale.rejection.code, "stale_fencing");
  assert.equal(assertResult(fixture.inspect()).counts.steps, 1);
  assertResult(fixture.close());
}));

test("checkpoint survives explicit close/reopen and recovery is explicit", () => withRoot((root) => {
  const fixture = assertResult(createNativeStepLedgerFixture({ root }));
  assertResult(fixture.startAttempt(attempt()));
  const appended = assertResult(fixture.appendStep(step()));
  assert.equal(assertResult(fixture.checkpoint({
    taskId: "task-1",
    attemptId: "attempt-1",
    stepId: "step-1",
    sequence: appended.sequence,
    fencingToken: 1,
    state: "completed",
    payload: { ordinal: 1, logical: "value" },
  })).outcome, "inserted");
  const before = assertResult(fixture.recover({ stepId: "step-1" }));
  assert.deepEqual(before, {
    status: "recovered",
    stepId: "step-1",
    recoveryAction: "resume_from_checkpoint",
    checkpointSequence: 1,
    state: "completed",
    artifactSha256: firstArtifactHash(),
  });
  assertResult(fixture.reopen());
  assert.deepEqual(assertResult(fixture.recover({ stepId: "step-1" })), before);
  assertResult(fixture.close());
  assert.equal(fixture.recover({ stepId: "step-1" }).rejection.code, "fixture_closed");
}));

function firstArtifactHash() {
  // The fixture's artifact identity is the canonical payload hash.  Keeping
  // the expected value here makes the restart assertion independent of the
  // SQLite row representation.
  return "68b21f40caed77b2b1401055e6e0b247dc40602fe2d46fde66f3b0e266d14786";
}

test("retry, cancellation, and timer wakeup are logical deterministic facts", () => withRoot((root) => {
  const fixture = assertResult(createNativeStepLedgerFixture({ root }));
  const retryAttempt = attempt("retry-attempt", "retry-task");
  assertResult(fixture.startAttempt(retryAttempt));
  assertResult(fixture.appendStep({ ...retryAttempt, stepId: "retry-step", idempotencyKey: "retry-initial", state: "prepared", payload: { attempt: 1 } }));
  const retried = assertResult(fixture.retryStep({ ...retryAttempt, stepId: "retry-step", idempotencyKey: "retry-next", payload: { attempt: 2 } }));
  assert.equal(retried.sequence, 2);
  const cancelAttempt = attempt("cancel-attempt", "cancel-task");
  assertResult(fixture.startAttempt(cancelAttempt));
  const cancelled = assertResult(fixture.cancelStep({ ...cancelAttempt, stepId: "cancel-step", idempotencyKey: "cancel-key", payload: { reason: "test" } }));
  assert.equal(cancelled.outcome, "inserted");
  const timer = assertResult(fixture.scheduleTimer({ stepId: "timer-step", dueTick: 4 }));
  assert.equal(timer.state, "pending");
  const early = assertResult(fixture.wakeTimers({ tick: 3 }));
  assert.deepEqual(early.wokenStepIds, []);
  const wake = assertResult(fixture.wakeTimers({ tick: 4 }));
  assert.deepEqual(wake.wokenStepIds, ["timer-step"]);
  assert.equal(assertResult(fixture.scheduleTimer({ stepId: "timer-step", dueTick: 4 })).state, "woken");
  assertResult(fixture.close());
}));

test("unknown external effects never claim success and require reconciliation", () => withRoot((root) => {
  const fixture = assertResult(createNativeStepLedgerFixture({ root }));
  const a = attempt("effect-attempt", "effect-task");
  assertResult(fixture.startAttempt(a));
  const input = { ...a, effectKey: "effect-1", stepId: "effect-step", idempotencyKey: "effect-key" };
  const created = assertResult(fixture.recordUnknownEffect(input));
  assert.equal(created.status, "unknown");
  assert.equal(created.recoveryAction, "reconcile_before_retry");
  const recovered = assertResult(fixture.recover({ stepId: "effect-step" }));
  assert.equal(recovered.status, "unknown_effect");
  assert.equal(recovered.recoveryAction, "reconcile_before_retry");
  const duplicate = assertResult(fixture.recordUnknownEffect(input));
  assert.equal(duplicate.outcome, "duplicate");
  assert.equal(duplicate.status, "unknown");
  assert.equal(duplicate.recoveryAction, "reconcile_before_retry");
  assertResult(fixture.reconcileUnknownEffect({ effectKey: "effect-1", outcome: "rejected" }));
  const after = assertResult(fixture.recover({ stepId: "effect-step" }));
  assert.equal(after.status, "no_checkpoint");
  assertResult(fixture.close());
}));

test("schema drift is observable without mutation and artifact hashes ignore key insertion order", () => withRoot((root) => {
  const fixture = assertResult(createNativeStepLedgerFixture({ root }));
  const drift = assertResult(fixture.inspectSchema({ expectedVersion: FIXTURE_SCHEMA_VERSION + 1 }));
  assert.deepEqual(drift, {
    status: "schema_drift",
    actualVersion: FIXTURE_SCHEMA_VERSION,
    expectedVersion: FIXTURE_SCHEMA_VERSION + 1,
    recoveryAction: "block_until_migrated",
  });
  const a = assertResult(fixture.artifactSha256({ a: 1, b: { x: true, y: "z" } }));
  const b = assertResult(fixture.artifactSha256({ b: { y: "z", x: true }, a: 1 }));
  assert.equal(a.sha256, b.sha256);
  assert.equal(Object.hasOwn(a, "canonicalJson"), false);
  assertResult(fixture.close());
}));

test("matrix covers all required recovery/fault observations and is repeatably hashed", () => withRoot((root) => {
  const fixture = assertResult(createNativeStepLedgerFixture({ root }));
  const first = assertResult(fixture.runMatrix());
  const second = assertResult(fixture.runMatrix());
  assert.deepEqual(first, second);
  assert.deepEqual(first.observations.map(({ name }) => name), OBSERVATION_NAMES);
  assert.ok(first.observations.every(({ status, inputSha256, outputSha256 }) => status === "pass" && /^[a-f0-9]{64}$/.test(inputSha256) && /^[a-f0-9]{64}$/.test(outputSha256)));
  assert.equal(first.candidateId, NATIVE_CANDIDATE_ID);
  assert.equal(first.database, DATABASE_FILENAME);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.observations), true);
  assert.equal(JSON.stringify(first).includes(root), false);
  assertResult(fixture.close());
}));

test("fresh roots produce the same matrix digest and convenience runner closes", () => {
  const roots = [mkdtempSync(join(tmpdir(), "e68-native-a-")), mkdtempSync(join(tmpdir(), "e68-native-b-"))];
  try {
    const first = assertResult(runFixture({ root: roots[0] }));
    const second = assertResult(runFixture({ root: roots[1] }));
    assert.equal(first.matrixSha256, second.matrixSha256);
    assert.equal(first.runtime, "node-v23.6.0+sqlite-v3.47.2+os-independent");
    assert.equal(first.fixtureVersion, FIXTURE_VERSION);
  } finally {
    roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
  }
});

test("input accessors, proxies, unknown fields, cycles, sparse arrays, and callbacks fail closed", () => withRoot((root) => {
  const fixture = assertResult(createNativeStepLedgerFixture({ root }));
  const accessor = attempt();
  Object.defineProperty(accessor, "taskId", { get() { throw new Error("must not run"); } });
  assert.equal(fixture.startAttempt(accessor).ok, false);
  assert.equal(fixture.startAttempt({ ...attempt(), unexpected: true }).ok, false);
  const hostile = new Proxy(attempt(), { ownKeys() { throw new Error("ownKeys"); } });
  assert.equal(fixture.startAttempt(hostile).ok, false);
  assertResult(fixture.startAttempt(attempt()));
  const cyclicPayload = {};
  cyclicPayload.self = cyclicPayload;
  assert.equal(fixture.appendStep(step({ idempotencyKey: "cycle-key", payload: cyclicPayload })).ok, false);
  const sparse = [];
  sparse.length = 2;
  assert.equal(fixture.appendStep(step({ idempotencyKey: "sparse-key", payload: sparse })).ok, false);
  assert.equal(fixture.appendStep(step({ idempotencyKey: "callback-key", payload: { callback() {} } })).ok, false);
  assertResult(fixture.close());
}));
