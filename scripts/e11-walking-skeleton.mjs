import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createWorkflowClient,
  createWorkflowDaemon,
  openArtifactStore,
  openLeaseStore,
  openStepLedger,
} from "@pi-workflow/workflowd";
import { createWorkerHost } from "@pi-workflow/workflow-worker";
import {
  acceptQueryIntent,
  createSyntheticE11Registry,
} from "@pi-workflow/v2-protocol";

const JOB_ID = "e11-job-001";
const STEP_ID = "e11-step-001";
const WORKER_ID = "e11-worker-001";
const OWNER_ID = "e11-coordinator";
const ROLE = "synthetic-e11-role";
const MODEL = "synthetic-e11";
const POLICY_HASH = createHash("sha256").update("synthetic-e11-policy", "utf8").digest("hex");
const INPUT = Object.freeze({ jobId: JOB_ID, stepId: STEP_ID, purpose: "walking-skeleton" });
const INPUT_HASH = createHash("sha256").update(JSON.stringify(INPUT), "utf8").digest("hex");

function ok(result, label) {
  assert.equal(result?.ok, true, `${label}: ${result?.rejection?.code ?? "not_ok"}:${result?.rejection?.diagnostic ?? ""}:${result?.rejection?.path ?? ""}:${result?.rejection?.detail ?? ""}`);
  return result.value;
}

function rejected(result, label) {
  assert.equal(result?.ok, false, `${label}: expected rejection`);
  return result.rejection;
}

function principal(connection, daemonEpoch) {
  return Object.freeze({
    kind: "product-agent",
    principalId: OWNER_ID,
    connectionId: connection.connectionId,
    connectionGeneration: connection.connectionGeneration,
    daemonEpoch,
    capabilityRefs: Object.freeze(["synthetic:e11"]),
  });
}

function startIntent(commandId, connection, daemonEpoch, expectedRevision) {
  return Object.freeze({
    protocolVersion: 1,
    commandId,
    schemaId: "synthetic.e11.job.start",
    schemaVersion: 1,
    payload: Object.freeze({ jobId: JOB_ID, stepId: STEP_ID }),
    correlationId: "e11-correlation-001",
    aggregate: Object.freeze({ type: "synthetic-job", id: JOB_ID, expectedRevision }),
  });
}

function startedEvent(eventId) {
  return Object.freeze({
    eventId,
    schemaId: "synthetic.e11.job.started",
    schemaVersion: 1,
    payload: Object.freeze({ jobId: JOB_ID, stepId: STEP_ID }),
  });
}

function completedEvent(eventId, artifactId) {
  return Object.freeze({
    eventId,
    schemaId: "synthetic.e11.job.completed",
    schemaVersion: 1,
    payload: Object.freeze({ jobId: JOB_ID, stepId: STEP_ID, artifactRef: artifactId }),
  });
}

function canonicalResultBytes() {
  return Buffer.from('{"jobId":"e11-job-001","role":"synthetic-e11-role","status":"ok","stepId":"e11-step-001"}\n', "utf8");
}

function rolePermit(snapshot) {
  assert.ok(snapshot?.generation >= 1);
  assert.ok(snapshot?.lease?.leaseId);
  assert.ok(snapshot?.lease?.fencingToken >= 1);
  return Object.freeze({
    kind: "synthetic-e11-permit",
    permitId: "e11-permit-001",
    jobId: JOB_ID,
    stepId: STEP_ID,
    role: ROLE,
    generation: snapshot.generation,
    leaseId: snapshot.lease.leaseId,
    fencingToken: snapshot.lease.fencingToken,
    used: false,
  });
}

function createSyntheticLead({ coordinator, runRole }) {
  return async (context) => Object.freeze({
    sessionId: `e11-session-g${context.generation}`,
    sessionFile: context.sessionFile,
    prompt: async (text) => {
      assert.equal(text, "run synthetic e11 role");
      const snapshot = coordinator.host.snapshot();
      const permit = rolePermit(snapshot);
      const output = runRole({ permit, jobId: JOB_ID, stepId: STEP_ID, input: INPUT, snapshot });
      return Buffer.from(output).toString("utf8");
    },
    abort: async () => undefined,
    dispose: () => undefined,
  });
}

function makeRuntimeClock() {
  let now = 1_800_000_000_000;
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
  };
}

/**
 * Test-only synthetic orchestration. This is deliberately root-level and is
 * not imported by either application package or exposed as production role
 * execution authority.
 */
export async function runWalkingSkeleton() {
  // The artifact/path policies intentionally reject symlinked path
  // components; `/private/tmp` is the canonical macOS temporary root.
  const root = await mkdtemp(join("/private/tmp", "pi-workflow-e11-"));
  const runtimeRoot = root;
  const artifactRoot = resolve(root, "artifacts");
  const daemonSocket = resolve(runtimeRoot, "workflow.sock");
  const daemonDatabase = resolve(root, "journal.sqlite");
  const leaseStepDatabase = resolve(root, "lease-step.sqlite");
  const clock = makeRuntimeClock();
  rejected(createWorkflowDaemon({
    runtimeRoot,
    databasePath: daemonDatabase,
    socketPath: resolve(root, "..", "e11-outside.sock"),
    now: clock.now,
  }), "temporary socket path escape");
  const daemonResult = createWorkflowDaemon({
    runtimeRoot,
    databasePath: daemonDatabase,
    socketPath: daemonSocket,
    now: clock.now,
    resolvePrincipal: (connection) => principal(connection, connection.daemonEpoch),
  });
  const daemon = ok(daemonResult, "daemon create");
  const artifactStore = ok(openArtifactStore({ artifactRoot, now: clock.now }), "artifact open");
  const leaseStore = ok(openLeaseStore({ runtimeRoot, databasePath: leaseStepDatabase, now: clock.now, heartbeatIntervalMs: 100, leaseTtlMs: 1_000 }), "lease open");
  const stepLedger = ok(openStepLedger({ runtimeRoot, databasePath: leaseStepDatabase, now: clock.now, leaseStore, artifactStore }), "step open");
  const client = ok(createWorkflowClient({ socketPath: daemonSocket, clientName: "e11-test-client" }), "client create");
  const registry = ok(createSyntheticE11Registry(), "synthetic registry");
  const coordinator = { host: undefined };
  const permitUses = [];
  const roleInvocations = [];
  let consumedPermit;
  const runRole = ({ permit, jobId, stepId, input, snapshot }) => {
    assert.equal(permit.kind, "synthetic-e11-permit");
    assert.equal(permit.jobId, JOB_ID);
    assert.equal(permit.stepId, STEP_ID);
    assert.equal(permit.role, ROLE);
    assert.equal(jobId, JOB_ID);
    assert.equal(stepId, STEP_ID);
    assert.deepEqual(input, INPUT);
    assert.equal(permit.generation, snapshot.generation);
    assert.equal(permit.leaseId, snapshot.lease.leaseId);
    assert.equal(permit.fencingToken, snapshot.lease.fencingToken);
    assert.equal(permitUses.length, 0, "synthetic permit replay");
    consumedPermit = permit;
    permitUses.push(permit.permitId);
    roleInvocations.push({ generation: snapshot.generation, fencingToken: snapshot.lease.fencingToken });
    return canonicalResultBytes();
  };
  const events = [];
  let firstHost;
  let secondHost;
  try {
    ok(await daemon.start(), "daemon start");
    const handshake = ok(await client.connect(), "client connect");

    // Protocol query validation is intentionally read-only; E06 currently
    // exposes replay/health but not a generic query mutation bridge.
    const query = acceptQueryIntent(registry, {
      protocolVersion: 1,
      queryId: "e11-read-001",
      schemaId: "synthetic.e11.job.read",
      schemaVersion: 1,
      payload: { jobId: JOB_ID },
      correlationId: "e11-correlation-001",
    }, principal(handshake, handshake.daemonEpoch));
    ok(query, "synthetic query contract");
    rejected(acceptQueryIntent(registry, {
      protocolVersion: 1,
      queryId: "e11-read-bad",
      schemaId: "synthetic.e11.job.read",
      schemaVersion: 1,
      payload: { jobId: JOB_ID, forged: true },
      correlationId: "e11-correlation-001",
    }, principal(handshake, handshake.daemonEpoch)), "forged query payload");

    const startCommand = {
      intent: startIntent("e11-start-command-001", handshake, handshake.daemonEpoch, 0),
      result: { accepted: true, coordinator: "synthetic-e11" },
      events: [startedEvent("e11-event-started-001")],
      outbox: [],
    };
    const start = ok(await client.commitCommand(startCommand), "start command");
    assert.equal(start.replayed, false);
    assert.equal(start.revision, 1);
    assert.deepEqual(start.eventIds, ["e11-event-started-001"]);
    const duplicateStart = ok(await client.commitCommand(startCommand), "duplicate start");
    assert.equal(duplicateStart.replayed, true);
    assert.deepEqual(duplicateStart.eventIds, start.eventIds);

    const workerOptions = {
      workerId: WORKER_ID,
      cwd: root,
      runtimeRoot,
      leaseStore,
      leaseRequest: { resourceKind: "product-session", resourceId: JOB_ID, ownerId: OWNER_ID },
      resources: [{ id: "synthetic-runtime", kind: "runtime", capabilities: ["diagnostic-read"] }],
      heartbeatPollMs: 20,
      now: clock.now,
      createLeadSession: (context) => createSyntheticLead({ coordinator, runRole })(context),
    };
    const worker = ok(createWorkerHost(workerOptions), "worker create");
    firstHost = worker;
    coordinator.host = worker;
    const firstSnapshot = ok(await worker.start(), "worker start");
    assert.equal(firstSnapshot.generation, 1);
    assert.equal(firstSnapshot.state, "running");
    const firstLease = firstSnapshot.lease;

    const planned = ok(stepLedger.plan({
      stepId: STEP_ID,
      policyHash: POLICY_HASH,
      role: ROLE,
      model: MODEL,
      outputLocation: join(artifactRoot, "objects"),
      workerGeneration: firstSnapshot.generation,
    }, firstLease), "step plan");
    assert.equal(planned.state, "planned");
    const prepared = ok(stepLedger.prepare({
      stepId: STEP_ID,
      idempotencyKey: "e11-attempt-001",
      inputJson: INPUT,
      policySha256: POLICY_HASH,
      role: ROLE,
      model: MODEL,
      outputLocation: join(artifactRoot, "objects"),
      workerGeneration: firstSnapshot.generation,
    }, firstLease), "step prepare");
    assert.equal(prepared.step.state, "prepared");
    const prepareReplay = ok(stepLedger.prepare({
      stepId: STEP_ID,
      idempotencyKey: "e11-attempt-001",
      inputJson: INPUT,
      policySha256: POLICY_HASH,
      role: ROLE,
      model: MODEL,
      outputLocation: join(artifactRoot, "objects"),
      workerGeneration: firstSnapshot.generation,
    }, firstLease), "duplicate step prepare");
    assert.equal(prepareReplay.attempt.stepAttemptId, prepared.attempt.stepAttemptId);
    const executing = ok(stepLedger.transition({ stepId: STEP_ID, expectedRevision: prepared.step.revision, operationKey: "e11-step-executing-001", toState: "executing" }, firstLease), "step executing");
    assert.equal(executing.state, "executing");

    const healthDuringRole = client.health();
    const diagnostic = ok(await worker.diagnose({ text: "run synthetic e11 role" }), "synthetic role");
    const health = ok(await healthDuringRole, "health during role");
    assert.equal(health.protocolVersion, 1);
    assert.throws(() => runRole({ permit: consumedPermit, jobId: JOB_ID, stepId: STEP_ID, input: INPUT, snapshot: firstSnapshot }), /synthetic permit replay/);
    const bytes = Buffer.from(diagnostic.text, "utf8");
    const artifact = ok(artifactStore.put(bytes, {
      mediaType: "application/json",
      authority: "workflowd.synthetic-e11",
      retentionClass: "standard",
      redaction: { status: "not-required" },
    }), "artifact put");
    const verified = ok(artifactStore.verify(artifact.artifactId), "artifact verify");
    assert.equal(verified.sha256, artifact.sha256);
    assert.equal(verified.artifactId, artifact.artifactId);
    assert.equal(artifact.byteSize, bytes.byteLength);
    const observed = ok(stepLedger.observeEffect({
      stepId: STEP_ID,
      expectedRevision: executing.revision,
      operationKey: "e11-step-effect-001",
      effect: { effectKey: "e11-effect-001", outcome: "confirmed", artifactId: artifact.artifactId, artifactSha256: artifact.sha256 },
    }, firstLease), "step effect observed");
    assert.equal(observed.state, "effect-observed");

    // Handoff is the injected restart boundary. It revokes the old lease,
    // allocates a strictly newer fence, and starts a new generation without
    // replaying the already-consumed synthetic effect.
    const secondSnapshot = ok(await worker.handoff(), "worker handoff");
    assert.equal(secondSnapshot.generation, firstSnapshot.generation + 1);
    assert.ok(secondSnapshot.lease.fencingToken > firstLease.fencingToken);
    secondHost = worker;
    rejected(stepLedger.validate({ stepId: STEP_ID, expectedRevision: observed.revision, operationKey: "e11-stale-validate-001", validation: { artifactId: artifact.artifactId, artifactSha256: artifact.sha256, validatedAtEpochMs: clock.now() } }, firstLease), "stale fencing mutation");
    const adopted = ok(stepLedger.adopt({ stepId: STEP_ID, expectedRevision: observed.revision, operationKey: "e11-adopt-001", effectKey: "e11-effect-001", artifactId: artifact.artifactId, artifactSha256: artifact.sha256 }, secondSnapshot.lease), "artifact adopt");
    assert.equal(adopted.state, "effect-observed");
    const validated = ok(stepLedger.validate({ stepId: STEP_ID, expectedRevision: adopted.revision, operationKey: "e11-validate-001", validation: { artifactId: artifact.artifactId, artifactSha256: artifact.sha256, validatedAtEpochMs: clock.now() } }, secondSnapshot.lease), "step validate");
    assert.equal(validated.state, "validated");
    const completed = ok(stepLedger.complete({ stepId: STEP_ID, expectedRevision: validated.revision, operationKey: "e11-complete-step-001" }, secondSnapshot.lease), "step complete");
    assert.equal(completed.state, "completed");
    assert.equal(roleInvocations.length, 1, "recovery reran synthetic role");
    assert.equal(permitUses.length, 1, "synthetic permit was not one-time");

    const completeCommand = {
      intent: startIntent("e11-complete-command-001", handshake, handshake.daemonEpoch, 1),
      result: { artifactRef: artifact.artifactId, completed: true },
      events: [completedEvent("e11-event-completed-001", artifact.artifactId)],
      outbox: [],
    };
    const completion = ok(await client.commitCommand(completeCommand), "completion command");
    assert.equal(completion.replayed, false);
    assert.equal(completion.revision, 2);
    const duplicateCompletion = ok(await client.commitCommand(completeCommand), "duplicate completion");
    assert.equal(duplicateCompletion.replayed, true);
    assert.deepEqual(duplicateCompletion.eventIds, completion.eventIds);
    rejected(await client.commitCommand({
      intent: startIntent("e11-forged-completion-001", handshake, handshake.daemonEpoch, 2),
      result: { artifactRef: artifact.artifactId, completed: true },
      events: [{ ...completedEvent("e11-event-forged-001", artifact.artifactId), payload: { jobId: JOB_ID, stepId: STEP_ID, artifactRef: artifact.artifactId, forged: true } }],
      outbox: [],
    }), "forged completion payload");
    rejected(await client.commitCommand({
      intent: startIntent("e11-stale-command-001", handshake, handshake.daemonEpoch, 0),
      result: { accepted: true },
      events: [startedEvent("e11-event-stale-001")],
      outbox: [],
    }), "stale aggregate revision");

    const replay = ok(await client.replayEvents({ afterGlobalCursor: 0, limit: 16 }), "event replay");
    assert.deepEqual(replay.map((event) => event.schemaId), ["synthetic.e11.job.started", "synthetic.e11.job.completed"]);
    assert.equal(replay.at(-1).globalCursor, 2);
    const cursorReplay = ok(await client.replayEvents({ afterGlobalCursor: replay.at(-1).globalCursor, limit: 16 }), "cursor replay");
    assert.equal(cursorReplay.length, 0);

    // Tamper is detected before any completion authority can be invoked.
    const artifactPath = join(artifactRoot, artifact.relativePath);
    const originalArtifact = await readFile(artifactPath);
    await writeFile(artifactPath, Buffer.from("tampered\n", "utf8"));
    rejected(artifactStore.verify(artifact.artifactId), "artifact tamper");
    await writeFile(artifactPath, originalArtifact);
    ok(artifactStore.read(artifact.artifactId), "artifact read after tamper recovery");
    const scan = ok(artifactStore.scan(), "artifact scan");
    assert.equal(scan.status, "clean");
    const ledger = ok(stepLedger.get(STEP_ID), "step read");
    assert.equal(ledger.state, "completed");
    const recovery = ok(stepLedger.scan(), "recovery scan");
    assert.equal(recovery.status, "clean");

    // A revoked lease is observed by the Worker heartbeat/pulse and exits the
    // host exactly once; no stale generation can mutate after this point.
    ok(leaseStore.revoke(secondSnapshot.lease), "revoke lease for loss test");
    rejected(await worker.pulse(), "lease loss pulse");
    assert.equal(worker.snapshot().state, "exited");

    await worker.close();
    await client.close();
    await daemon.close();
    artifactStore.close();
    stepLedger.close();
    leaseStore.close();
    return Object.freeze({
      jobId: JOB_ID,
      stepId: STEP_ID,
      artifactId: artifact.artifactId,
      artifactSha256: artifact.sha256,
      generation: secondSnapshot.generation,
      fencingToken: secondSnapshot.lease.fencingToken,
      roleInvocations: roleInvocations.length,
      eventCount: replay.length,
      recoveryStatus: recovery.status,
      tempRoot: root,
    });
  } finally {
    try { await secondHost?.close(); } catch { /* cleanup */ }
    if (secondHost !== firstHost) {
      try { await firstHost?.close(); } catch { /* cleanup */ }
    }
    try { await client.close(); } catch { /* cleanup */ }
    try { await daemon.close(); } catch { /* cleanup */ }
    try { artifactStore.close(); } catch { /* cleanup */ }
    try { stepLedger.close(); } catch { /* cleanup */ }
    try { leaseStore.close(); } catch { /* cleanup */ }
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runWalkingSkeleton();
  console.log(JSON.stringify(result));
}
