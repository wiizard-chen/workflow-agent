import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  openCommandJournal,
} from "@pi-workflow/workflowd";
import { loadNativeSqlite } from "../dist/persistence/native-sqlite.js";
import {
  acceptCommandIntent,
  createSyntheticE11Registry,
  PROTOCOL_VERSION,
} from "@pi-workflow/v2-protocol";

const PRINCIPAL = Object.freeze({
  kind: "scheduler",
  principalId: "workflowd",
  connectionId: "socket-1",
  connectionGeneration: 1,
  daemonEpoch: "epoch-1",
  capabilityRefs: Object.freeze(["journal.write"]),
});

function temporaryRoot(prefix = "workflowd-e05-") {
  return mkdtempSync(join(realpathSync(tmpdir()), prefix));
}

function accepted(registry, commandId, expectedRevision, stepId = commandId) {
  const result = acceptCommandIntent(registry, {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    schemaId: "synthetic.e11.job.start",
    schemaVersion: 1,
    payload: { jobId: "job-1", stepId },
    correlationId: `correlation-${commandId}`,
    aggregate: { type: "synthetic-job", id: "job-1", expectedRevision },
  }, PRINCIPAL);
  assert.equal(result.ok, true);
  return result.value;
}

function event(eventId, stepId = eventId) {
  return {
    eventId,
    schemaId: "synthetic.e11.job.started",
    schemaVersion: 1,
    payload: { jobId: "job-1", stepId },
  };
}

function open(root, now = 1_700_000_000_000, mode) {
  return openCommandJournal({
    runtimeRoot: root,
    databasePath: join(root, "workflow.db"),
    now: () => now,
    ...(mode ? { mode } : {}),
  });
}

function closeAndRemove(root, journal) {
  if (journal?.ok) journal.value.close();
  rmSync(root, { recursive: true, force: true });
}

test("E05 owns an exact extension and supports writable, reopen, and read-only modes", () => {
  const root = temporaryRoot();
  try {
    const first = open(root);
    assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.rejection));
    if (!first.ok) return;
    assert.equal(first.value.status.schemaVersion, 2);
    assert.equal(first.value.status.eventCount, 0);
    first.value.close();

    const reopened = open(root);
    assert.equal(reopened.ok, true, reopened.ok ? "" : JSON.stringify(reopened.rejection));
    if (!reopened.ok) return;
    reopened.value.close();

    const readOnly = open(root, 1_700_000_000_001, "read-only");
    assert.equal(readOnly.ok, true, readOnly.ok ? "" : JSON.stringify(readOnly.rejection));
    if (!readOnly.ok) return;
    assert.equal(readOnly.value.status.status, "read-only");
    assert.equal(readOnly.value.commit({ accepted: {}, result: null, events: [], outbox: [] }).rejection.code, "invalid_input");
    readOnly.value.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E05 commits one atomic event/projection/outbox set and replays by command identity", () => {
  const root = temporaryRoot();
  const registry = createSyntheticE11Registry();
  assert.equal(registry.ok, true);
  const journal = open(root);
  try {
    assert.equal(journal.ok, true);
    if (!journal.ok || !registry.ok) return;
    const command = accepted(registry.value, "command-1", 0, "step-1");
    const first = journal.value.commit({
      accepted: command,
      result: { accepted: true },
      events: [event("event-1", "step-1")],
      projections: [{ projectionName: "job", projectionKey: "job-1", sourceEventId: "event-1", sourceAggregateRevision: 1, value: { status: "started" } }],
      outbox: [{ eventId: "event-1", intentKind: "notify", payload: { status: "started" } }],
    });
    assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.rejection));
    if (!first.ok) return;
    assert.equal(first.value.replayed, false);
    assert.equal(first.value.revision, 1);
    assert.equal(journal.value.inspect().eventCount, 1);
    assert.equal(journal.value.inspect().projectionCount, 1);
    assert.equal(journal.value.inspect().outboxCount, 1);

    const replay = journal.value.commit({ accepted: command, result: { ignored: true }, events: [], outbox: [] });
    assert.deepEqual(replay, { ok: true, value: { ...first.value, replayed: true } });
    const events = journal.value.readEvents();
    assert.equal(events.ok, true);
    if (events.ok) {
      assert.equal(events.value[0].sequence, 1);
      assert.equal(events.value[0].globalCursor, 1);
      assert.equal(events.value[0].principal.connectionId, "socket-1");
      assert.equal(events.value[0].causationId, "command-1");
    }
  } finally {
    closeAndRemove(root, journal);
  }
});

test("E05 rejects collisions and stale revisions without partial facts while journaling deterministic stale results", () => {
  const root = temporaryRoot();
  const registry = createSyntheticE11Registry();
  assert.equal(registry.ok, true);
  const journal = open(root);
  try {
    assert.equal(journal.ok, true);
    if (!journal.ok || !registry.ok) return;
    const first = journal.value.commit({ accepted: accepted(registry.value, "command-1", 0), result: { ok: true }, events: [event("event-1")], outbox: [] });
    assert.equal(first.ok, true);
    const beforeCollision = journal.value.inspect();
    const collision = journal.value.commit({ accepted: accepted(registry.value, "command-1", 0, "different-step"), result: null, events: [event("event-2")], outbox: [] });
    assert.equal(collision.ok, false);
    if (!collision.ok) assert.equal(collision.rejection.code, "idempotency_collision");
    assert.deepEqual(journal.value.inspect(), beforeCollision);

    const eventCollision = journal.value.commit({ accepted: accepted(registry.value, "command-event-collision", 1), result: {}, events: [event("event-1", "reused")], outbox: [] });
    assert.equal(eventCollision.ok, false);
    if (!eventCollision.ok) assert.equal(eventCollision.rejection.code, "event_conflict");
    assert.deepEqual(journal.value.inspect(), beforeCollision);

    const staleCommand = accepted(registry.value, "command-stale", 0, "stale");
    const stale = journal.value.commit({ accepted: staleCommand, result: { ignored: true }, events: [event("event-stale")], outbox: [] });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.rejection.code, "expected_revision_mismatch");
    assert.equal(journal.value.inspect().eventCount, 1);
    assert.equal(journal.value.inspect().commandCount, 2);
    const staleReplay = journal.value.commit({ accepted: staleCommand, result: { changed: true }, events: [], outbox: [] });
    assert.equal(staleReplay.ok, false);
    if (!staleReplay.ok) assert.equal(staleReplay.rejection.code, "expected_revision_mismatch");

    const projectionConflict = journal.value.commit({
      accepted: accepted(registry.value, "command-projection-conflict", 1),
      result: {},
      events: [event("event-2")],
      projections: [
        { projectionName: "same", projectionKey: "key", sourceEventId: "event-2", sourceAggregateRevision: 2, value: { version: "a" } },
        { projectionName: "same", projectionKey: "key", sourceEventId: "event-2", sourceAggregateRevision: 2, value: { version: "b" } },
      ],
      outbox: [],
    });
    assert.equal(projectionConflict.ok, false);
    if (!projectionConflict.ok) assert.equal(projectionConflict.rejection.code, "projection_conflict");
    assert.equal(journal.value.inspect().eventCount, 1);
    assert.equal(journal.value.inspect().projectionCount, 0);
  } finally {
    closeAndRemove(root, journal);
  }
});

test("E05 outbox leases are deterministic, fenced, and idempotent", () => {
  const root = temporaryRoot();
  const registry = createSyntheticE11Registry();
  assert.equal(registry.ok, true);
  const journal = open(root, 1_700_000_000_000);
  try {
    assert.equal(journal.ok, true);
    if (!journal.ok || !registry.ok) return;
    const committed = journal.value.commit({ accepted: accepted(registry.value, "command-1", 0), result: {}, events: [event("event-1")], outbox: [{ eventId: "event-1", intentKind: "notify", payload: { n: 1 } }] });
    assert.equal(committed.ok, true);
    if (!committed.ok) return;
    const outboxId = committed.value.outboxIds[0];
    const firstClaim = journal.value.claimOutbox("worker-a", 1_700_000_000_000);
    assert.deepEqual(firstClaim, { ok: true, value: [{ outboxId, owner: "worker-a", generation: 1 }] });
    assert.deepEqual(journal.value.claimOutbox("worker-b", 1_700_000_000_001), { ok: true, value: [] });
    const forgedAck = journal.value.ackOutbox({ outboxId, owner: "worker-b", generation: 1, acknowledgement: { delivered: true } });
    assert.equal(forgedAck.ok, false);
    if (!forgedAck.ok) assert.equal(forgedAck.rejection.code, "outbox_fenced");
    const reclaimed = journal.value.claimOutbox("worker-b", 1_700_000_005_001);
    assert.deepEqual(reclaimed, { ok: true, value: [{ outboxId, owner: "worker-b", generation: 2 }] });
    const staleAck = journal.value.ackOutbox({ outboxId, owner: "worker-a", generation: 1, acknowledgement: { delivered: true } });
    assert.equal(staleAck.ok, false);
    if (!staleAck.ok) assert.equal(staleAck.rejection.code, "outbox_fenced");
    assert.deepEqual(journal.value.ackOutbox({ outboxId, owner: "worker-b", generation: 2, acknowledgement: { delivered: true } }), { ok: true, value: true });
    assert.deepEqual(journal.value.ackOutbox({ outboxId, owner: "worker-b", generation: 2, acknowledgement: { delivered: true } }), { ok: true, value: true });
    const conflictAck = journal.value.ackOutbox({ outboxId, owner: "worker-b", generation: 2, acknowledgement: { delivered: false } });
    assert.equal(conflictAck.ok, false);
    if (!conflictAck.ok) assert.equal(conflictAck.rejection.code, "outbox_conflict");
    const outbox = journal.value.readOutbox({ status: "acked" });
    assert.equal(outbox.ok, true);
    if (outbox.ok) assert.equal(outbox.value[0].status, "acked");
  } finally {
    closeAndRemove(root, journal);
  }
});

test("E05 rejects forged accepted envelopes and hostile exact inputs before mutation", () => {
  const root = temporaryRoot();
  const registry = createSyntheticE11Registry();
  assert.equal(registry.ok, true);
  const journal = open(root);
  try {
    assert.equal(journal.ok, true);
    if (!journal.ok || !registry.ok) return;
    const authority = accepted(registry.value, "command-1", 0);
    const forged = { ...authority };
    const result = journal.value.commit({ accepted: forged, result: {}, events: [event("event-1")], outbox: [] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "invalid_input");
    assert.equal(journal.value.inspect().commandCount, 0);

    const getter = { accepted: authority, result: {}, events: [event("event-1")], outbox: [] };
    Object.defineProperty(getter, "result", { get() { throw new Error("must-not-run"); } });
    const getterResult = journal.value.commit(getter);
    assert.equal(getterResult.ok, false);
    if (!getterResult.ok) assert.equal(getterResult.rejection.code, "invalid_input");
    assert.equal(journal.value.inspect().commandCount, 0);
  } finally {
    closeAndRemove(root, journal);
  }
});

test("E05 reopen diagnoses tampered event cursors instead of continuing", () => {
  const root = temporaryRoot();
  const registry = createSyntheticE11Registry();
  assert.equal(registry.ok, true);
  const journal = open(root);
  try {
    assert.equal(journal.ok, true);
    if (!journal.ok || !registry.ok) return;
    const committed = journal.value.commit({ accepted: accepted(registry.value, "command-1", 0), result: {}, events: [event("event-1")], outbox: [] });
    assert.equal(committed.ok, true);
    journal.value.close();
    const loaded = loadNativeSqlite();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const raw = loaded.driver.open(join(root, "workflow.db"), false);
    raw.prepare("UPDATE workflow_event_log SET global_cursor = 9 WHERE event_id = $eventId").run({ $eventId: "event-1" });
    raw.close();
    const reopened = open(root);
    assert.equal(reopened.ok, false);
    if (!reopened.ok) assert.equal(reopened.rejection.code, "schema_corrupt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
