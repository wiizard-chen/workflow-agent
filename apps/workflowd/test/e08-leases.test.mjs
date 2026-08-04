import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { openCommandJournal, openLeaseStore } from "@pi-workflow/workflowd";

function root(prefix = "workflowd-e08-") {
  return mkdtempSync(join(realpathSync(tmpdir()), prefix));
}

function open(rootPath, nowRef, mode) {
  return openLeaseStore({
    runtimeRoot: rootPath,
    databasePath: join(rootPath, "workflow.db"),
    now: () => nowRef.value,
    ...(mode ? { mode } : {}),
  });
}

function close(opened) {
  if (opened?.ok) opened.value.close();
}

function request(ownerId = "worker-a") {
  return { resourceKind: "epic", resourceId: "epic-1", ownerId };
}

test("E08 opens an exact version-3 lease extension without import side effects", () => {
  const runtimeRoot = root();
  const now = { value: 1_700_000_000_000 };
  try {
    const opened = open(runtimeRoot, now);
    assert.equal(opened.ok, true, opened.ok ? "" : JSON.stringify(opened.rejection));
    if (!opened.ok) return;
    const inspected = opened.value.inspect();
    assert.equal(inspected.ok, true, inspected.ok ? "" : JSON.stringify(inspected.rejection));
    if (!inspected.ok) return;
    assert.deepEqual(inspected.value, {
      status: "read-write",
      schemaVersion: 3,
      leaseCount: 0,
      activeCount: 0,
      highestFencingToken: 0,
      heartbeatIntervalMs: 5000,
      leaseTtlMs: 20000,
    });
    opened.value.close();
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E08 allocation is exclusive, expiry re-grants, and fencing is monotonic", () => {
  const runtimeRoot = root();
  const now = { value: 1_700_000_000_000 };
  const opened = open(runtimeRoot, now);
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const first = opened.value.acquire(request());
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value.fencingToken, 1);
    assert.equal(opened.value.acquire(request("worker-b")).rejection.code, "lease_held");
    now.value += 20_000;
    const second = opened.value.acquire(request("worker-b"));
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.value.fencingToken, 2);
    const stale = opened.value.guard(first.value);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.rejection.code, "lease_fenced");
    const current = opened.value.guard(second.value);
    assert.equal(current.ok, true, current.ok ? "" : JSON.stringify(current.rejection));
    const inspected = opened.value.inspect();
    assert.equal(inspected.ok, true);
    if (inspected.ok) assert.equal(inspected.value.highestFencingToken, 2);
  } finally {
    close(opened);
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E08 renew, heartbeat, revoke, and guard bind exact credentials", () => {
  const runtimeRoot = root();
  const now = { value: 1_700_000_000_000 };
  const opened = open(runtimeRoot, now);
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const acquired = opened.value.acquire(request());
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    now.value += 1000;
    const renewed = opened.value.renew(acquired.value);
    assert.equal(renewed.ok, true, renewed.ok ? "" : JSON.stringify(renewed.rejection));
    if (!renewed.ok) return;
    assert.equal(renewed.value.heartbeatAtEpochMs, now.value);
    assert.equal(opened.value.heartbeat(acquired.value).ok, true);
    const wrongOwner = opened.value.renew({ ...renewed.value, ownerId: "worker-b" });
    assert.equal(wrongOwner.ok, false);
    if (!wrongOwner.ok) assert.equal(wrongOwner.rejection.code, "lease_fenced");
    const revoked = opened.value.revoke(renewed.value);
    assert.equal(revoked.ok, true, revoked.ok ? "" : JSON.stringify(revoked.rejection));
    if (!revoked.ok) return;
    const after = opened.value.guard(revoked.value);
    assert.equal(after.ok, false);
    if (!after.ok) assert.equal(after.rejection.code, "lease_revoked");
    const replay = opened.value.revoke(revoked.value);
    assert.deepEqual(replay, revoked);
  } finally {
    close(opened);
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E08 lease and fencing token survive close/reopen", () => {
  const runtimeRoot = root();
  const now = { value: 1_700_000_000_000 };
  let first;
  try {
    first = open(runtimeRoot, now);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const acquired = first.value.acquire(request());
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    first.value.close();
    now.value += 20_001;
    const reopened = open(runtimeRoot, now);
    assert.equal(reopened.ok, true, reopened.ok ? "" : JSON.stringify(reopened.rejection));
    if (!reopened.ok) return;
    const reacquired = reopened.value.acquire(request("worker-b"));
    assert.equal(reacquired.ok, true);
    if (reacquired.ok) assert.equal(reacquired.value.fencingToken, 2);
    reopened.value.close();
  } finally {
    close(first);
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E08 composite opener upgrades E05 and reopens the shared v3 runtime", () => {
  const runtimeRoot = root();
  const now = { value: 1_700_000_000_000 };
  try {
    const journal = openCommandJournal({ runtimeRoot, databasePath: join(runtimeRoot, "workflow.db"), now: () => now.value });
    assert.equal(journal.ok, true, journal.ok ? "" : JSON.stringify(journal.rejection));
    if (!journal.ok) return;
    assert.equal(journal.value.status.schemaVersion, 2);
    journal.value.close();

    const lease = open(runtimeRoot, now);
    assert.equal(lease.ok, true, lease.ok ? "" : JSON.stringify(lease.rejection));
    if (!lease.ok) return;
    lease.value.close();

    const v2Only = openCommandJournal({ runtimeRoot, databasePath: join(runtimeRoot, "workflow.db"), now: () => now.value });
    assert.equal(v2Only.ok, false);
    if (!v2Only.ok) assert.equal(v2Only.rejection.code, "migration_failed");
    const composite = openCommandJournal({ runtimeRoot, databasePath: join(runtimeRoot, "workflow.db"), includeLeaseSchema: true, now: () => now.value });
    assert.equal(composite.ok, true, composite.ok ? "" : JSON.stringify(composite.rejection));
    if (composite.ok) {
      assert.equal(composite.value.status.schemaVersion, 3);
      composite.value.close();
    }
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E08 heartbeat controller is bounded and stops after lease loss", () => {
  const runtimeRoot = root();
  const now = { value: 1_700_000_000_000 };
  const opened = open(runtimeRoot, now, "read-write");
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const acquired = opened.value.acquire(request());
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    const controller = opened.value.createHeartbeat(acquired.value);
    assert.equal(controller.ok, true);
    if (!controller.ok) return;
    assert.equal(controller.value.status, "idle");
    assert.equal(controller.value.start().ok, true);
    assert.equal(controller.value.status, "running");
    controller.value.stop();
    assert.equal(controller.value.status, "stopped");
    assert.equal(controller.value.beat().rejection.code, "store_closed");
  } finally {
    close(opened);
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E08 heartbeat failure is observable and cannot resurrect an expired lease", () => {
  const runtimeRoot = root();
  const now = { value: 1_700_000_000_000 };
  const opened = openLeaseStore({
    runtimeRoot,
    databasePath: join(runtimeRoot, "workflow.db"),
    now: () => now.value,
    heartbeatIntervalMs: 100,
    leaseTtlMs: 200,
  });
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const acquired = opened.value.acquire(request());
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    const controller = opened.value.createHeartbeat(acquired.value);
    assert.equal(controller.ok, true);
    if (!controller.ok) return;
    assert.equal(controller.value.start().ok, true);
    now.value += 200;
    const failed = controller.value.beat();
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.rejection.code, "lease_expired");
    assert.equal(controller.value.status, "failed");
    assert.equal(controller.value.failure?.code, "lease_expired");
  } finally {
    close(opened);
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E08 read-only and hostile inputs fail closed", () => {
  const runtimeRoot = root();
  const now = { value: 1_700_000_000_000 };
  const writable = open(runtimeRoot, now);
  try {
    assert.equal(writable.ok, true);
    if (!writable.ok) return;
    const acquired = writable.value.acquire(request());
    assert.equal(acquired.ok, true);
    writable.value.close();
    const readOnly = open(runtimeRoot, now, "read-only");
    assert.equal(readOnly.ok, true, readOnly.ok ? "" : JSON.stringify(readOnly.rejection));
    if (!readOnly.ok) return;
    assert.equal(readOnly.value.acquire(request()).rejection.code, "read_only");
    const accessor = { get resourceKind() { throw new Error("must_not_read"); }, resourceId: "x", ownerId: "x" };
    assert.equal(readOnly.value.acquire(accessor).rejection.code, "invalid_input");
    assert.equal(readOnly.value.guard({ resourceKind: "epic", resourceId: "epic-1", ownerId: "worker-a", leaseId: "forged", fencingToken: 1 }).rejection.code, "lease_fenced");
    readOnly.value.close();
  } finally {
    close(writable);
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
