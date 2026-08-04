import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createAllowlistedResourceLoader,
  createPiLeadSessionFactory,
  createWorkerHost,
  runWorkerProcess,
} from "@pi-workflow/workflow-worker";

function root(prefix = "workflow-worker-e09-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function leaseAuthority(nowRef, { denyAcquire = false } = {}) {
  const records = new Map();
  let token = 0;
  const authority = {
    acquire(request) {
      if (denyAcquire) return { ok: false, rejection: { code: "lease_held", diagnostic: "lease_required" } };
      const key = `${request.resourceKind}:${request.resourceId}`;
      const current = records.get(key);
      if (current?.status === "active" && nowRef.value < current.expiresAtEpochMs) return { ok: false, rejection: { code: "lease_held", diagnostic: "lease_required" } };
      const record = Object.freeze({ ...request, leaseId: `lease-${++token}`, fencingToken: token, issuedAtEpochMs: nowRef.value, heartbeatAtEpochMs: nowRef.value, expiresAtEpochMs: nowRef.value + 1_000, status: "active" });
      records.set(key, record);
      return { ok: true, value: record };
    },
    guard(credentials) {
      const current = records.get(`${credentials.resourceKind}:${credentials.resourceId}`);
      if (!current || current.leaseId !== credentials.leaseId || current.fencingToken !== credentials.fencingToken) return { ok: false, rejection: { code: "lease_fenced", diagnostic: "lease_lost" } };
      if (current.status !== "active") return { ok: false, rejection: { code: "lease_revoked", diagnostic: "lease_lost" } };
      if (nowRef.value >= current.expiresAtEpochMs) return { ok: false, rejection: { code: "lease_expired", diagnostic: "lease_lost" } };
      return { ok: true, value: { record: current, checkedAtEpochMs: nowRef.value } };
    },
    createHeartbeat(credentials) {
      let status = "idle";
      let failure;
      const beat = () => {
        const guarded = authority.guard(credentials);
        if (!guarded.ok) {
          failure = guarded.rejection;
          status = "failed";
          return guarded;
        }
        return { ok: true, value: guarded.value.record };
      };
      return { ok: true, value: {
        get status() { return status; },
        get failure() { return failure; },
        beat,
        start() { const first = beat(); if (!first.ok) return first; status = "running"; return { ok: true, value: true }; },
        stop() { status = "stopped"; },
      } };
    },
    revoke(credentials) {
      const key = `${credentials.resourceKind}:${credentials.resourceId}`;
      const current = records.get(key);
      if (!current || current.leaseId !== credentials.leaseId || current.fencingToken !== credentials.fencingToken) return { ok: false, rejection: { code: "lease_fenced", diagnostic: "lease_lost" } };
      const revoked = Object.freeze({ ...current, status: "revoked", revokedAtEpochMs: nowRef.value });
      records.set(key, revoked);
      return { ok: true, value: revoked };
    },
  };
  return authority;
}

function options(runtimeRoot, authority, adapter, nowRef) {
  return {
    workerId: "worker-e09",
    cwd: runtimeRoot,
    runtimeRoot,
    leaseStore: authority,
    leaseRequest: { resourceKind: "epic", resourceId: "epic-e09", ownerId: "worker-e09" },
    resources: [{ id: "runtime-status", kind: "runtime", capabilities: ["diagnostic-read"] }],
    createLeadSession: adapter,
    now: () => nowRef.value,
    heartbeatPollMs: 20,
  };
}

test("E09 fresh-process import has no filesystem side effect", () => {
  const runtimeRoot = root("workflow-worker-e09-import-");
  try {
    const script = [
      'import { readdirSync } from "node:fs";',
      'const root = process.argv[1];',
      'const before = readdirSync(root).sort();',
      'await import("@pi-workflow/workflow-worker");',
      'const after = readdirSync(root).sort();',
      'if (JSON.stringify(before) !== JSON.stringify(after)) process.exitCode = 1;',
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, runtimeRoot], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E09 allowlist rejects hostile resource shape and keeps no discovery surface", () => {
  let reads = 0;
  const hostile = Object.defineProperty({}, "id", { get() { reads += 1; return "bad"; }, enumerable: true });
  const result = createAllowlistedResourceLoader([hostile]);
  assert.equal(result.ok, false);
  assert.equal(reads, 0);
  let proxyReads = 0;
  const proxy = new Proxy({ id: "status", kind: "runtime", capabilities: ["diagnostic-read"] }, {
    get() { proxyReads += 1; return "../outside"; },
  });
  const proxied = createAllowlistedResourceLoader([proxy]);
  assert.equal(proxied.ok, true);
  if (proxied.ok) assert.deepEqual(proxied.value.list().map((item) => item.id), ["status"]);
  assert.equal(proxyReads, 0);
  let capabilityReads = 0;
  const capabilityProxy = new Proxy(["diagnostic-read"], { get() { capabilityReads += 1; return "write"; } });
  const nestedProxy = createAllowlistedResourceLoader([{ id: "nested", kind: "runtime", capabilities: capabilityProxy }]);
  assert.equal(nestedProxy.ok, true);
  if (nestedProxy.ok) assert.deepEqual(nestedProxy.value.list().map((item) => item.id), ["nested"]);
  assert.equal(capabilityReads, 0);
  const valid = createAllowlistedResourceLoader([{ id: "status", kind: "runtime", capabilities: ["diagnostic-read"] }]);
  assert.equal(valid.ok, true);
  if (valid.ok) assert.deepEqual(valid.value.list().map((item) => item.id), ["status"]);
});

test("E09 starts a diagnostic-only host, persists generation, and rejects mutation prompts", async () => {
  const runtimeRoot = root();
  const nowRef = { value: 1_700_000_000_000 };
  const authority = leaseAuthority(nowRef);
  const calls = { prompts: 0, aborts: 0, disposes: 0 };
  const adapter = async (context) => {
    assert.equal(context.resume, false);
    assert.deepEqual(context.loader.list().map((item) => item.id), ["runtime-status"]);
    return {
      sessionId: `session-${context.generation}`,
      sessionFile: join(context.runtimeRoot, "worker-sessions", `session-${context.generation}.jsonl`),
      async prompt(text) { calls.prompts += 1; return `diagnostic:${text}`; },
      async abort() { calls.aborts += 1; },
      dispose() { calls.disposes += 1; },
    };
  };
  const opened = createWorkerHost(options(runtimeRoot, authority, adapter, nowRef));
  try {
    assert.equal(opened.ok, true, opened.ok ? "" : JSON.stringify(opened.rejection));
    if (!opened.ok) return;
    const started = await opened.value.start();
    assert.equal(started.ok, true, started.ok ? "" : JSON.stringify(started.rejection));
    if (!started.ok) return;
    assert.equal(started.value.state, "running");
    assert.equal(started.value.generation, 1);
    const file = join(runtimeRoot, "worker", "worker-e09.json");
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(persisted.generation, 1);
    const diagnostic = await opened.value.diagnose({ text: "summarize runtime health" });
    assert.deepEqual(diagnostic, { ok: true, value: { text: "diagnostic:summarize runtime health", sessionId: "session-1" } });
    const denied = await opened.value.diagnose({ text: "run shell and write a file" });
    assert.equal(denied.ok, false);
    assert.equal(calls.prompts, 1);
    assert.equal((await opened.value.abort("test")).ok, true);
    assert.equal(calls.aborts, 1);
    assert.equal(calls.disposes, 1);
  } finally {
    await opened.value?.close?.();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E09 heartbeat loss aborts exactly once and process runner observes host exit", async () => {
  const runtimeRoot = root();
  const nowRef = { value: 1_700_000_000_000 };
  const authority = leaseAuthority(nowRef);
  let aborts = 0;
  const adapter = async (context) => ({
    sessionId: `session-${context.generation}`,
    sessionFile: join(context.runtimeRoot, "worker-sessions", `session-${context.generation}.jsonl`),
    async prompt() { return "ok"; },
    async abort() { aborts += 1; },
    dispose() {},
  });
  const opened = createWorkerHost(options(runtimeRoot, authority, adapter, nowRef));
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal((await opened.value.start()).ok, true);
    nowRef.value += 1_001;
    const lost = await opened.value.pulse();
    assert.equal(lost.ok, false);
    assert.equal(opened.value.snapshot().state, "exited");
    assert.equal(aborts, 1);

    const secondRoot = root("workflow-worker-e09-process-");
    const secondNow = { value: 1_700_000_000_000 };
    const secondAuthority = leaseAuthority(secondNow);
    const second = createWorkerHost(options(secondRoot, secondAuthority, adapter, secondNow));
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const processResult = runWorkerProcess({ host: second.value, installSignalHandlers: false });
    setTimeout(() => { secondNow.value += 1_001; void second.value.pulse(); }, 20);
    const result = await processResult;
    assert.equal(result.exitCode, 1);
    rmSync(secondRoot, { recursive: true, force: true });
  } finally {
    await opened.value?.close?.();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E09 process runner maps missing lease, startup failure, and AbortSignal stop", async () => {
  const deniedRoot = root("workflow-worker-e09-process-denied-");
  const deniedNow = { value: 1_700_000_000_000 };
  const deniedAuthority = leaseAuthority(deniedNow, { denyAcquire: true });
  const deniedHost = createWorkerHost(options(deniedRoot, deniedAuthority, async () => {
    throw new Error("must_not_create_session");
  }, deniedNow));
  assert.equal(deniedHost.ok, true);
  if (!deniedHost.ok) return;
  const deniedResult = await runWorkerProcess({ host: deniedHost.value, installSignalHandlers: false });
  assert.equal(deniedResult.exitCode, 78);
  rmSync(deniedRoot, { recursive: true, force: true });

  const failedRoot = root("workflow-worker-e09-process-failed-");
  const failedNow = { value: 1_700_000_000_000 };
  const failedAuthority = leaseAuthority(failedNow);
  const failedHost = createWorkerHost(options(failedRoot, failedAuthority, async () => {
    throw new Error("startup_failed");
  }, failedNow));
  assert.equal(failedHost.ok, true);
  if (!failedHost.ok) return;
  const failedResult = await runWorkerProcess({ host: failedHost.value, installSignalHandlers: false });
  assert.equal(failedResult.exitCode, 1);
  rmSync(failedRoot, { recursive: true, force: true });

  const signalRoot = root("workflow-worker-e09-process-abort-");
  const signalNow = { value: 1_700_000_000_000 };
  const signalAuthority = leaseAuthority(signalNow);
  const signalHost = createWorkerHost(options(signalRoot, signalAuthority, async (context) => ({
    sessionId: `session-${context.generation}`,
    sessionFile: join(context.runtimeRoot, "worker-sessions", `session-${context.generation}.jsonl`),
    async prompt() { return "ok"; },
    async abort() {},
    dispose() {},
  }), signalNow));
  assert.equal(signalHost.ok, true);
  if (!signalHost.ok) return;
  const controller = new AbortController();
  const processResult = runWorkerProcess({ host: signalHost.value, abortSignal: controller.signal, installSignalHandlers: false });
  setTimeout(() => controller.abort(), 20);
  const stopped = await processResult;
  assert.equal(stopped.exitCode, 0);
  assert.equal(stopped.snapshot.state, "exited");
  rmSync(signalRoot, { recursive: true, force: true });

  const terminatedRoot = root("workflow-worker-e09-process-signal-");
  const terminatedNow = { value: 1_700_000_000_000 };
  const terminatedAuthority = leaseAuthority(terminatedNow);
  const terminatedHost = createWorkerHost(options(terminatedRoot, terminatedAuthority, async (context) => ({
    sessionId: `session-${context.generation}`,
    sessionFile: join(context.runtimeRoot, "worker-sessions", `session-${context.generation}.jsonl`),
    async prompt() { return "ok"; },
    async abort() {},
    dispose() {},
  }), terminatedNow));
  assert.equal(terminatedHost.ok, true);
  if (!terminatedHost.ok) return;
  const signalResult = runWorkerProcess({ host: terminatedHost.value, installSignalHandlers: true });
  setTimeout(() => { process.emit("SIGTERM"); }, 20);
  const terminated = await signalResult;
  assert.equal(terminated.exitCode, 0);
  assert.equal(terminated.snapshot.state, "exited");
  rmSync(terminatedRoot, { recursive: true, force: true });
});

test("E09 canonicalizes hostile lease rejections before the abort path", async () => {
  const runtimeRoot = root("workflow-worker-e09-hostile-rejection-");
  const nowRef = { value: 1_700_000_000_000 };
  const baseAuthority = leaseAuthority(nowRef);
  const hostile = { code: "lease_expired", diagnostic: "lease_lost" };
  Object.defineProperty(hostile, "extra", { enumerable: true, get() { throw new Error("hostile_rejection_accessor"); } });
  let beats = 0;
  let aborts = 0;
  const authority = {
    ...baseAuthority,
    createHeartbeat(credentials) {
      const created = baseAuthority.createHeartbeat(credentials);
      if (!created.ok) return created;
      const heartbeat = created.value;
      return { ok: true, value: {
        get status() { return heartbeat.status; },
        get failure() { return heartbeat.failure; },
        start() { return heartbeat.start(); },
        stop() { heartbeat.stop(); },
        beat() { beats += 1; return { ok: false, rejection: hostile }; },
      } };
    },
  };
  const adapter = async (context) => ({
    sessionId: `session-${context.generation}`,
    sessionFile: join(context.runtimeRoot, "worker-sessions", `session-${context.generation}.jsonl`),
    async prompt() { return "ok"; },
    async abort() { aborts += 1; },
    dispose() {},
  });
  const opened = createWorkerHost(options(runtimeRoot, authority, adapter, nowRef));
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal((await opened.value.start()).ok, true);
    const pulse = await opened.value.pulse();
    assert.equal(pulse.ok, false);
    assert.equal(aborts, 1);
    assert.equal(opened.value.snapshot().state, "exited");
  } finally {
    await opened.value?.close?.();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E09 revokes an acquired lease when heartbeat setup fails", async () => {
  const runtimeRoot = root("workflow-worker-e09-acquire-revoke-");
  const nowRef = { value: 1_700_000_000_000 };
  const record = { resourceKind: "epic", resourceId: "epic-e09", ownerId: "worker-e09", leaseId: "lease-1", fencingToken: 1, issuedAtEpochMs: nowRef.value, heartbeatAtEpochMs: nowRef.value, expiresAtEpochMs: nowRef.value + 1_000, status: "active" };
  const revoked = [];
  const authority = {
    acquire() { return { ok: true, value: record }; },
    guard() { return { ok: true, value: { record, checkedAtEpochMs: nowRef.value } }; },
    createHeartbeat() { throw new Error("heartbeat_setup_failed"); },
    revoke(credentials) { revoked.push(credentials); return { ok: true, value: { ...record, ...credentials, status: "revoked" } }; },
  };
  let adapterCalls = 0;
  const opened = createWorkerHost(options(runtimeRoot, authority, async () => { adapterCalls += 1; throw new Error("must_not_create_session"); }, nowRef));
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const started = await opened.value.start();
    assert.equal(started.ok, false);
    assert.equal(revoked.length, 1);
    assert.equal(revoked[0].leaseId, record.leaseId);
    assert.equal(adapterCalls, 0);
  } finally {
    await opened.value?.close?.();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E09 revokes a lease that fails record validation", async () => {
  const runtimeRoot = root("workflow-worker-e09-record-revoke-");
  const nowRef = { value: 1_700_000_000_000 };
  const record = { resourceKind: "epic", resourceId: "epic-e09", ownerId: "worker-e09", leaseId: "lease-invalid", fencingToken: 1, issuedAtEpochMs: nowRef.value, heartbeatAtEpochMs: nowRef.value, expiresAtEpochMs: nowRef.value, status: "revoked" };
  const revoked = [];
  let heartbeatCalls = 0;
  const authority = {
    acquire() { return { ok: true, value: record }; },
    guard() { return { ok: false, rejection: { code: "lease_revoked", diagnostic: "lease_revoked" } }; },
    createHeartbeat() { heartbeatCalls += 1; throw new Error("must_not_create_heartbeat"); },
    revoke(credentials) { revoked.push(credentials); return { ok: true, value: { ...record, ...credentials, status: "revoked" } }; },
  };
  const opened = createWorkerHost(options(runtimeRoot, authority, async () => { throw new Error("must_not_create_session"); }, nowRef));
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const started = await opened.value.start();
    assert.equal(started.ok, false);
    assert.equal(heartbeatCalls, 0);
    assert.equal(revoked.length, 1);
    assert.equal(revoked[0].leaseId, record.leaseId);
  } finally {
    await opened.value?.close?.();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E09 handoff revokes a newly acquired lease when fencing does not advance", async () => {
  const runtimeRoot = root("workflow-worker-e09-handoff-revoke-");
  const nowRef = { value: 1_700_000_000_000 };
  const first = { resourceKind: "epic", resourceId: "epic-e09", ownerId: "worker-e09", leaseId: "lease-1", fencingToken: 1, issuedAtEpochMs: nowRef.value, heartbeatAtEpochMs: nowRef.value, expiresAtEpochMs: nowRef.value + 1_000, status: "active" };
  const second = { ...first, leaseId: "lease-2" };
  let acquireCalls = 0;
  const revoked = [];
  const authority = {
    acquire() { acquireCalls += 1; return { ok: true, value: acquireCalls === 1 ? first : second }; },
    guard(credentials) { return { ok: true, value: { record: credentials.leaseId === first.leaseId ? first : second, checkedAtEpochMs: nowRef.value } }; },
    createHeartbeat(credentials) {
      let status = "idle";
      return { ok: true, value: { get status() { return status; }, get failure() { return undefined; }, beat() { return { ok: true, value: credentials.leaseId === first.leaseId ? first : second }; }, start() { status = "running"; return { ok: true, value: true }; }, stop() { status = "stopped"; } } };
    },
    revoke(credentials) { revoked.push(credentials); return { ok: true, value: { ...(credentials.leaseId === first.leaseId ? first : second), status: "revoked" } }; },
  };
  const adapter = async (context) => ({ sessionId: `session-${context.generation}`, sessionFile: join(context.runtimeRoot, "worker-sessions", `session-${context.generation}.jsonl`), async prompt() { return "ok"; }, async abort() {}, dispose() {} });
  const opened = createWorkerHost(options(runtimeRoot, authority, adapter, nowRef));
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal((await opened.value.start()).ok, true);
    const handed = await opened.value.handoff();
    assert.equal(handed.ok, false);
    if (!handed.ok) assert.equal(handed.rejection.diagnostic, "handoff_fencing_not_advanced");
    assert.deepEqual(revoked.map((item) => item.leaseId), [first.leaseId, second.leaseId]);
  } finally {
    await opened.value?.close?.();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E09 lease guard failure after a prompt aborts the lead before reporting success", async () => {
  const runtimeRoot = root("workflow-worker-e09-post-guard-");
  const nowRef = { value: 1_700_000_000_000 };
  const baseAuthority = leaseAuthority(nowRef);
  let guardCalls = 0;
  let aborts = 0;
  const authority = {
    ...baseAuthority,
    guard(credentials) {
      guardCalls += 1;
      if (guardCalls === 2) throw new Error("guard_unavailable");
      return baseAuthority.guard(credentials);
    },
  };
  const adapter = async (context) => ({
    sessionId: `session-${context.generation}`,
    sessionFile: join(context.runtimeRoot, "worker-sessions", `session-${context.generation}.jsonl`),
    async prompt() { return "must-not-be-accepted"; },
    async abort() { aborts += 1; },
    dispose() {},
  });
  const opened = createWorkerHost(options(runtimeRoot, authority, adapter, nowRef));
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal((await opened.value.start()).ok, true);
    const result = await opened.value.diagnose({ text: "summarize runtime health" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "lease_lost");
    assert.equal(aborts, 1);
    assert.equal(opened.value.snapshot().state, "exited");
  } finally {
    await opened.value?.close?.();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E09 close during session creation cancels the start and disposes the late session", async () => {
  const runtimeRoot = root("workflow-worker-e09-start-race-");
  const nowRef = { value: 1_700_000_000_000 };
  const authority = leaseAuthority(nowRef);
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  let resolveSession;
  let disposes = 0;
  const adapter = async (context) => {
    entered();
    return new Promise((resolve) => { resolveSession = () => resolve({
      sessionId: `session-${context.generation}`,
      sessionFile: join(context.runtimeRoot, "worker-sessions", `session-${context.generation}.jsonl`),
      async prompt() { return "late"; },
      async abort() {},
      dispose() { disposes += 1; },
    }); });
  };
  const opened = createWorkerHost(options(runtimeRoot, authority, adapter, nowRef));
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const startPromise = opened.value.start();
    await enteredPromise;
    await opened.value.close();
    resolveSession();
    const started = await startPromise;
    assert.equal(started.ok, false);
    if (!started.ok) assert.equal(started.rejection.code, "worker_closed");
    assert.equal(disposes, 1);
    assert.equal(opened.value.snapshot().state, "exited");
  } finally {
    await opened.value?.close?.();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E09 handoff creates a fresh fenced generation and rejects stale resume", async () => {
  const runtimeRoot = root();
  const nowRef = { value: 1_700_000_000_000 };
  const authority = leaseAuthority(nowRef);
  const adapter = async (context) => ({
    sessionId: `session-${context.generation}`,
    sessionFile: join(runtimeRoot, "worker-sessions", `session-${context.generation}.jsonl`),
    async prompt() { return "ok"; },
    async abort() {},
    dispose() {},
  });
  const opened = createWorkerHost(options(runtimeRoot, authority, adapter, nowRef));
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal((await opened.value.start()).ok, true);
    const handed = await opened.value.handoff();
    assert.equal(handed.ok, true, handed.ok ? "" : JSON.stringify(handed.rejection));
    if (!handed.ok) return;
    assert.equal(handed.value.generation, 2);
    const persisted = JSON.parse(readFileSync(join(runtimeRoot, "worker", "worker-e09.json"), "utf8"));
    assert.equal(persisted.handoffFromGeneration, 1);
    assert.match(persisted.handoffSnapshotHash, /^[a-f0-9]{64}$/);
  } finally {
    await opened.value?.close?.();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E09 resume reads the durable generation and fails closed on malformed state", async () => {
  const runtimeRoot = root("workflow-worker-e09-resume-");
  const nowRef = { value: 1_700_000_000_000 };
  const authority = leaseAuthority(nowRef);
  const adapter = async (context) => ({
    sessionId: `session-${context.generation}`,
    sessionFile: join(context.runtimeRoot, "worker-sessions", `session-${context.generation}.jsonl`),
    async prompt() { return "ok"; },
    async abort() {},
    dispose() {},
  });
  const first = createWorkerHost(options(runtimeRoot, authority, adapter, nowRef));
  try {
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal((await first.value.start()).ok, true);
    const second = createWorkerHost(options(runtimeRoot, authority, async (context) => {
      assert.equal(context.resume, true);
      return adapter(context);
    }, nowRef));
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const resumed = await second.value.resume();
    assert.equal(resumed.ok, true, resumed.ok ? "" : JSON.stringify(resumed.rejection));
    if (resumed.ok) assert.equal(resumed.value.generation, 1);
    await second.value.close();
    await first.value.close();

    writeFileSync(join(runtimeRoot, "worker", "worker-e09.json"), "{}\n", { mode: 0o600 });
    const malformed = createWorkerHost(options(runtimeRoot, authority, adapter, nowRef));
    assert.equal(malformed.ok, true);
    if (malformed.ok) {
      const result = await malformed.value.resume();
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.rejection.code, "persistence_failed");
      await malformed.value.close();
    }
  } finally {
    await first.value?.close?.();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E09 resume rejects persisted resource IDs outside the active allowlist", async () => {
  const runtimeRoot = root("workflow-worker-e09-resource-state-");
  const nowRef = { value: 1_700_000_000_000 };
  const authority = leaseAuthority(nowRef);
  const adapter = async (context) => ({ sessionId: `session-${context.generation}`, sessionFile: join(context.runtimeRoot, "worker-sessions", `session-${context.generation}.jsonl`), async prompt() { return "ok"; }, async abort() {}, dispose() {} });
  const first = createWorkerHost(options(runtimeRoot, authority, adapter, nowRef));
  let adapterCalls = 0;
  try {
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal((await first.value.start()).ok, true);
    const statePath = join(runtimeRoot, "worker", "worker-e09.json");
    const stored = JSON.parse(readFileSync(statePath, "utf8"));
    stored.resourceIds = ["runtime-status", "unknown-runtime-resource"];
    writeFileSync(statePath, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    const second = createWorkerHost(options(runtimeRoot, authority, async (context) => { adapterCalls += 1; return adapter(context); }, nowRef));
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const resumed = await second.value.resume();
    assert.equal(resumed.ok, false);
    if (!resumed.ok) assert.equal(resumed.rejection.code, "persistence_failed");
    assert.equal(adapterCalls, 0);
    await second.value.close();
  } finally {
    await first.value?.close?.();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E09 persistence keeps terminal timestamps monotonic across clock rollback", async () => {
  const runtimeRoot = root("workflow-worker-e09-clock-rollback-");
  const nowRef = { value: 1_700_000_000_000 };
  const authority = leaseAuthority(nowRef);
  const adapter = async (context) => ({ sessionId: `session-${context.generation}`, sessionFile: join(context.runtimeRoot, "worker-sessions", `session-${context.generation}.jsonl`), async prompt() { return "ok"; }, async abort() {}, dispose() {} });
  const opened = createWorkerHost(options(runtimeRoot, authority, adapter, nowRef));
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal((await opened.value.start()).ok, true);
    nowRef.value -= 10_000;
    assert.equal((await opened.value.abort("clock_rollback")).ok, true);
    const stored = JSON.parse(readFileSync(join(runtimeRoot, "worker", "worker-e09.json"), "utf8"));
    assert.ok(stored.updatedAtEpochMs >= stored.createdAtEpochMs);
  } finally {
    await opened.value?.close?.();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("E09 Pi SDK adapter does not discover repository extensions or settings", async () => {
  const runtimeRoot = root("workflow-worker-e09-sdk-");
  try {
    const marker = join(runtimeRoot, "extension-loaded");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(runtimeRoot, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(runtimeRoot, ".pi", "extensions", "evil.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded");`);
    const resources = createAllowlistedResourceLoader([{ id: "status", kind: "runtime", capabilities: ["diagnostic-read"] }]);
    assert.equal(resources.ok, true);
    if (!resources.ok) return;
    const factory = createPiLeadSessionFactory();
    const session = await factory({
      cwd: runtimeRoot,
      runtimeRoot,
      statePath: join(runtimeRoot, "worker", "state.json"),
      sessionFile: join(runtimeRoot, "worker-sessions", "session.jsonl"),
      generation: 1,
      resume: false,
      resources: resources.value.list(),
      loader: resources.value,
    });
    assert.equal(typeof session.sessionId, "string");
    assert.equal(typeof session.sessionFile, "string");
    assert.equal(Object.keys(session).sort().join(","), "abort,dispose,prompt,sessionFile,sessionId");
    await session.dispose();
    assert.throws(() => readFileSync(marker, "utf8"), /ENOENT/);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
