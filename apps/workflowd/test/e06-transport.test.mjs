import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createWorkflowClient,
  createWorkflowDaemon,
} from "@pi-workflow/workflowd";
import { encodeFrame, FrameDecoder } from "../dist/transport/framing.js";

function root(prefix = "workflowd-e06-") {
  return mkdtempSync(join(realpathSync(tmpdir()), prefix));
}

function command(commandId = "command-1", expectedRevision = 0) {
  return {
    intent: {
      protocolVersion: 1,
      commandId,
      schemaId: "synthetic.e11.job.start",
      schemaVersion: 1,
      payload: { jobId: "job-1", stepId: commandId },
      correlationId: `correlation-${commandId}`,
      aggregate: { type: "synthetic-job", id: "job-1", expectedRevision },
    },
    result: { accepted: true },
    events: [{ eventId: `event-${commandId}`, schemaId: "synthetic.e11.job.started", schemaVersion: 1, payload: { jobId: "job-1", stepId: commandId } }],
    outbox: [],
  };
}

function makeDaemon(runtimeRoot, socketPath) {
  return createWorkflowDaemon({
    runtimeRoot,
    databasePath: join(runtimeRoot, "workflow.db"),
    socketPath,
    now: () => 1_700_000_000_000,
    resolvePrincipal: (material) => ({
      kind: "scheduler",
      principalId: "workflowd-test",
      connectionId: material.connectionId,
      connectionGeneration: material.connectionGeneration,
      daemonEpoch: material.daemonEpoch,
      capabilityRefs: ["test.command"],
    }),
  });
}

async function closeDaemon(daemon) {
  if (daemon?.ok) await daemon.value.close();
}

test("E06 daemon start is side-effect-free until start, owns a 0600 socket, and cleans it on close", async () => {
  const runtimeRoot = root();
  const socketPath = join(runtimeRoot, "workflowd.sock");
  const daemon = makeDaemon(runtimeRoot, socketPath);
  try {
    assert.equal(daemon.ok, true);
    assert.equal(existsSync(socketPath), false);
    if (!daemon.ok) return;
    const started = await daemon.value.start();
    assert.equal(started.ok, true, started.ok ? "" : JSON.stringify(started.rejection));
    assert.equal(lstatSync(socketPath).isSocket(), true);
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    await daemon.value.close();
    assert.equal(existsSync(socketPath), false);
  } finally {
    await closeDaemon(daemon);
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
test("E06 typed client negotiates, commits through E05, subscribes, and replays after reconnect", async () => {
  const runtimeRoot = root();
  const socketPath = join(runtimeRoot, "workflowd.sock");
  const daemon = makeDaemon(runtimeRoot, socketPath);
  let client;
  try {
    assert.equal(daemon.ok, true);
    if (!daemon.ok) return;
    assert.equal((await daemon.value.start()).ok, true);
    const created = createWorkflowClient({ socketPath, clientName: "e06-test" });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    client = created;
    assert.equal((await client.value.connect()).ok, true);
    const health = await client.value.health();
    assert.equal(health.ok, true);
    if (health.ok) assert.equal(health.value.journal.schemaVersion, 2);

    const received = [];
    const subscribed = await client.value.subscribeEvents({ afterGlobalCursor: 0 }, (event) => received.push(event));
    assert.deepEqual(subscribed, { ok: true, value: true });
    const first = await client.value.commitCommand(command());
    assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.rejection));
    if (!first.ok) return;
    assert.equal(first.value.replayed, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, 1);
    assert.equal(received[0].globalCursor, 1);

    const replay = await client.value.replayEvents({ afterGlobalCursor: 0 });
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.value[0].eventId, "event-command-1");
    const duplicate = await client.value.commitCommand({ ...command(), result: { ignored: true }, events: [], outbox: [] });
    assert.equal(duplicate.ok, true);
    if (duplicate.ok) assert.equal(duplicate.value.replayed, true);
    await client.value.close();

    const restartedClient = createWorkflowClient({ socketPath, clientName: "e06-reconnect" });
    assert.equal(restartedClient.ok, true);
    if (!restartedClient.ok) return;
    assert.equal((await restartedClient.value.connect()).ok, true);
    const resumed = await restartedClient.value.replayEvents({ afterGlobalCursor: 0 });
    assert.equal(resumed.ok, true);
    if (resumed.ok) assert.deepEqual(resumed.value.map((event) => event.globalCursor), [1]);
    await restartedClient.value.close();
  } finally {
    if (client?.ok) await client.value.close();
    await closeDaemon(daemon);
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E06 incompatible clients stay in diagnostics mode and cannot mutate", async () => {
  const runtimeRoot = root();
  const socketPath = join(runtimeRoot, "workflowd.sock");
  const daemon = makeDaemon(runtimeRoot, socketPath);
  try {
    assert.equal(daemon.ok, true);
    if (!daemon.ok) return;
    assert.equal((await daemon.value.start()).ok, true);
    const client = createWorkflowClient({ socketPath, clientName: "old-client", supportedProtocolVersions: [2] });
    assert.equal(client.ok, true);
    if (!client.ok) return;
    const handshake = await client.value.connect();
    assert.equal(handshake.ok, false);
    if (!handshake.ok) assert.equal(handshake.rejection.code, "protocol_incompatible");
    const health = await client.value.health();
    assert.equal(health.ok, true);
    const commit = await client.value.commitCommand(command());
    assert.equal(commit.ok, false);
    if (!commit.ok) assert.equal(commit.rejection.code, "read_only_diagnostics");
    await client.value.close();
  } finally {
    await closeDaemon(daemon);
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E06 malformed frame and unsafe socket replacement fail closed", async () => {
  const runtimeRoot = root();
  const socketPath = join(runtimeRoot, "workflowd.sock");
  const daemon = makeDaemon(runtimeRoot, socketPath);
  try {
    assert.equal(daemon.ok, true);
    if (!daemon.ok) return;
    assert.equal((await daemon.value.start()).ok, true);
    const rawClosed = await new Promise((resolve) => {
      const socket = net.createConnection(socketPath);
      socket.once("connect", () => socket.write(Buffer.from([0, 0, 0, 0])));
      socket.once("close", () => resolve(true));
      socket.once("error", () => resolve(true));
    });
    assert.equal(rawClosed, true);
    await daemon.value.close();
    writeFileSync(socketPath, "not-a-socket", { mode: 0o600 });
    const replacement = makeDaemon(runtimeRoot, socketPath);
    assert.equal(replacement.ok, true);
    if (replacement.ok) {
      const started = await replacement.value.start();
      assert.equal(started.ok, false);
      if (!started.ok) assert.equal(started.rejection.code, "socket_conflict");
      await replacement.value.close();
    }
  } finally {
    await closeDaemon(daemon);
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E06 framing is incremental and bounded", () => {
  const encoded = encodeFrame({ jsonrpc: "2.0", id: 1, method: "health" });
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;
  const decoder = new FrameDecoder();
  const first = decoder.push(encoded.value.subarray(0, 2));
  assert.deepEqual(first, { ok: true, value: [] });
  const second = decoder.push(encoded.value.subarray(2));
  assert.equal(second.ok, true);
  if (second.ok) assert.deepEqual(second.value, [{ jsonrpc: "2.0", id: 1, method: "health" }]);
  const oversize = Buffer.alloc(4);
  oversize.writeUInt32BE(1024 * 1024 + 1, 0);
  const rejected = new FrameDecoder().push(oversize);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.rejection.code, "frame_too_large");
});
