import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { createAllowlistedResourceLoader } from "./resources.js";
import { defaultStatePath, isWorkerPathSafe, readWorkerState, writeWorkerState } from "./persistence.js";
import type {
  DiagnosticResult,
  DiagnosticPrompt,
  LeadSession,
  LeaseCredentials,
  LeaseRecord,
  LeaseOperationRejection,
  LeaseOperationResult,
  WorkerFailure,
  WorkerFailureCode,
  WorkerHeartbeat,
  WorkerHost,
  WorkerHostOptions,
  WorkerResource,
  WorkerResult,
  WorkerSnapshot,
  WorkerState,
  WorkerStateRecord,
} from "./types.js";

const MAX_TEXT_BYTES = 64 * 1024;
const MAX_POLL_MS = 60_000;
const MIN_POLL_MS = 20;
const ABORT_TIMEOUT_MS = 2_000;
const PROMPT_TIMEOUT_MS = 120_000;
const FORBIDDEN_PROMPT = /\b(?:bash|shell|exec(?:ute)?|write|edit|delete|remove|rename|move|git|beads|subagent|launch|commit|push|pull|apply|patch|mkdir|chmod|network|http|tool|mutation|repository)\b/i;
const LEASE_FAILURES = new Set(["lease_held", "lease_not_found", "lease_expired", "lease_revoked", "lease_fenced", "store_closed", "transaction_failed", "schema_corrupt", "read_only"]);

function failure<T>(code: WorkerFailureCode, diagnostic: string, extra: Partial<WorkerFailure> = {}): WorkerResult<T> {
  return Object.freeze({ ok: false as const, rejection: Object.freeze({ code, diagnostic, ...extra }) });
}

function success<T>(value: T): WorkerResult<T> {
  return Object.freeze({ ok: true as const, value });
}

function exactObject(value: unknown): value is Record<string, unknown> {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  } catch {
    return false;
  }
}

function text(value: unknown, maxBytes = MAX_TEXT_BYTES): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function resourceKind(value: unknown): value is WorkerHostOptions["leaseRequest"]["resourceKind"] {
  return value === "epic" || value === "delivery-unit" || value === "integration" || value === "release" || value === "product-session" || value === "repository";
}

function leaseRecord(value: unknown): value is LeaseRecord {
  try {
    if (!exactObject(value) || !resourceKind(value.resourceKind) || !text(value.resourceId) || !text(value.ownerId) || !text(value.leaseId) || !integer(value.fencingToken, 1)) return false;
    return integer(value.issuedAtEpochMs) && integer(value.heartbeatAtEpochMs) && integer(value.expiresAtEpochMs) && value.issuedAtEpochMs <= value.heartbeatAtEpochMs && value.expiresAtEpochMs > value.heartbeatAtEpochMs && value.status === "active";
  } catch {
    return false;
  }
}

function credentials(record: LeaseRecord): LeaseCredentials {
  return Object.freeze({ resourceKind: record.resourceKind, resourceId: record.resourceId, ownerId: record.ownerId, leaseId: record.leaseId, fencingToken: record.fencingToken });
}

function canonicalLeaseCredentials(value: unknown): LeaseCredentials | undefined {
  try {
    if (!exactObject(value)) return undefined;
    const required = ["resourceKind", "resourceId", "ownerId", "leaseId", "fencingToken"] as const;
    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of required) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      descriptors.set(key, descriptor);
    }
    const resourceKindValue = descriptors.get("resourceKind")?.value;
    const resourceId = descriptors.get("resourceId")?.value;
    const ownerId = descriptors.get("ownerId")?.value;
    const leaseId = descriptors.get("leaseId")?.value;
    const fencingToken = descriptors.get("fencingToken")?.value;
    if (!resourceKind(resourceKindValue) || !text(resourceId) || !text(ownerId) || !text(leaseId) || !integer(fencingToken, 1)) return undefined;
    return Object.freeze({ resourceKind: resourceKindValue, resourceId, ownerId, leaseId, fencingToken });
  } catch {
    return undefined;
  }
}

function matchesLeaseRequest(record: LeaseRecord, request: WorkerHostOptions["leaseRequest"]): boolean {
  return record.resourceKind === request.resourceKind && record.resourceId === request.resourceId && record.ownerId === request.ownerId;
}

function matchesLeaseCredentials(record: LeaseRecord, expected: LeaseCredentials): boolean {
  return record.resourceKind === expected.resourceKind && record.resourceId === expected.resourceId && record.ownerId === expected.ownerId && record.leaseId === expected.leaseId && record.fencingToken === expected.fencingToken;
}

function leaseResultShape(value: unknown): value is LeaseOperationResult<unknown> {
  try {
    if (!exactObject(value)) return false;
    const okDescriptor = Object.getOwnPropertyDescriptor(value, "ok");
    if (!okDescriptor || !("value" in okDescriptor) || typeof okDescriptor.value !== "boolean") return false;
    if (okDescriptor.value) {
      const resultValue = Object.getOwnPropertyDescriptor(value, "value");
      return resultValue !== undefined && "value" in resultValue;
    }
    return canonicalLeaseRejection((Object.getOwnPropertyDescriptor(value, "rejection") as PropertyDescriptor | undefined)?.value) !== undefined;
  } catch {
    return false;
  }
}

function canonicalLeaseRejection(value: unknown): LeaseOperationRejection | undefined {
  try {
    if (!exactObject(value)) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || keys.some((key) => key !== "code" && key !== "diagnostic")) return undefined;
    const code = Object.getOwnPropertyDescriptor(value, "code");
    const diagnostic = Object.getOwnPropertyDescriptor(value, "diagnostic");
    if (!code || !("value" in code) || typeof code.value !== "string" || !diagnostic || !("value" in diagnostic) || typeof diagnostic.value !== "string") return undefined;
    return Object.freeze({ code: code.value, diagnostic: diagnostic.value });
  } catch {
    return undefined;
  }
}

function leaseError(result: { readonly rejection: unknown }, code: WorkerFailureCode): WorkerFailure {
  const rejection = canonicalLeaseRejection(result.rejection);
  if (rejection === undefined) return Object.freeze({ code: "adapter_failed", diagnostic: "lease_result_invalid" });
  const mapped = LEASE_FAILURES.has(rejection.code) ? code : "adapter_failed";
  return Object.freeze({ code: mapped, diagnostic: rejection.diagnostic, lease: rejection });
}

function pathInside(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${String.fromCharCode(47)}`) && !relativePath.startsWith("/"));
}

function parsePrompt(value: unknown): WorkerResult<DiagnosticPrompt> {
  try {
    if (!exactObject(value) || Object.keys(value).some((key) => key !== "text") || !text(value.text)) return failure("prompt_rejected", "diagnostic_prompt_invalid");
    if (FORBIDDEN_PROMPT.test(value.text)) return failure("prompt_rejected", "diagnostic_capability_denied");
    return success(Object.freeze({ text: value.text }));
  } catch {
    return failure("prompt_rejected", "diagnostic_prompt_invalid");
  }
}

function parseOptions(value: unknown): WorkerResult<WorkerHostOptions> {
  try {
    if (!exactObject(value)) return failure("invalid_input", "worker_options_invalid");
    const required = ["workerId", "cwd", "runtimeRoot", "leaseStore", "leaseRequest", "resources", "createLeadSession"];
    const allowed = new Set([...required, "statePath", "now", "heartbeatPollMs"]);
    if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) return failure("invalid_input", "worker_options_fields_invalid");
    if (!text(value.workerId) || !text(value.cwd) || !text(value.runtimeRoot) || !exactObject(value.leaseStore) || typeof value.leaseStore.acquire !== "function" || typeof value.leaseStore.guard !== "function" || typeof value.leaseStore.createHeartbeat !== "function" || !exactObject(value.leaseRequest) || !resourceKind(value.leaseRequest.resourceKind) || !text(value.leaseRequest.resourceId) || !text(value.leaseRequest.ownerId) || !Array.isArray(value.resources) || typeof value.createLeadSession !== "function") {
      return failure("invalid_input", "worker_options_value_invalid");
    }
    if (value.statePath !== undefined && !text(value.statePath)) return failure("invalid_input", "worker_state_path_invalid");
    if (value.now !== undefined && typeof value.now !== "function") return failure("invalid_input", "worker_clock_invalid");
    if (value.heartbeatPollMs !== undefined && (!integer(value.heartbeatPollMs, MIN_POLL_MS) || value.heartbeatPollMs > MAX_POLL_MS)) return failure("invalid_input", "worker_heartbeat_poll_invalid");
    return success(value as WorkerHostOptions);
  } catch {
    return failure("invalid_input", "worker_options_invalid");
  }
}

function currentTime(now: () => number): WorkerResult<number> {
  try {
    const value = now();
    return integer(value) ? success(value) : failure("invalid_input", "worker_clock_value_invalid");
  } catch {
    return failure("invalid_input", "worker_clock_failed");
  }
}

function sessionError(error: unknown): WorkerFailure {
  return Object.freeze({ code: "adapter_failed", diagnostic: "lead_session_failed" });
}

type TimedResult<T> = Readonly<{ readonly kind: "value"; readonly value: T }> | Readonly<{ readonly kind: "error"; readonly error: unknown }> | Readonly<{ readonly kind: "timeout" }>;

async function timed<T>(work: () => Promise<T>, timeoutMs: number): Promise<TimedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimedResult<T>>((resolve) => { timer = setTimeout(() => resolve(Object.freeze({ kind: "timeout" as const })), timeoutMs); });
  const operation = Promise.resolve().then(work).then(
    (value) => Object.freeze({ kind: "value" as const, value }),
    (error: unknown) => Object.freeze({ kind: "error" as const, error }),
  );
  try { return await Promise.race([operation, timeout]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

export function createWorkerHost(optionsInput: unknown): WorkerResult<WorkerHost> {
  const parsed = parseOptions(optionsInput);
  if (!parsed.ok) return parsed;
  const options = parsed.value;
  const statePath = options.statePath ?? defaultStatePath(options.runtimeRoot, options.workerId);
  if (!pathInside(options.runtimeRoot, statePath) || !isWorkerPathSafe(options.runtimeRoot, statePath)) return failure("invalid_input", "worker_state_path_outside_runtime_root");
  const loaderResult = createAllowlistedResourceLoader(options.resources);
  if (!loaderResult.ok) return loaderResult;
  const loader = loaderResult.value;
  const now = options.now ?? (() => Date.now());
  let closed = false;
  let state: WorkerState = "idle";
  let generation: number | undefined;
  let sessionId: string | undefined;
  let sessionFile: string | undefined;
  let lease: LeaseCredentials | undefined;
  let lead: LeadSession | undefined;
  let heartbeat: WorkerHeartbeat | undefined;
  let failureRef: WorkerFailure | undefined;
  let createdAtEpochMs: number | undefined;
  let updatedAtEpochMs: number | undefined;
  let handoffFromGeneration: number | undefined;
  let handoffSnapshotHash: string | undefined;
  let monitorTimer: ReturnType<typeof setInterval> | undefined;
  let abortPromise: Promise<WorkerResult<WorkerSnapshot>> | undefined;

  const heartbeatStatus = (): WorkerSnapshot["heartbeatStatus"] => {
    if (heartbeat === undefined) return "none";
    try {
      const value = heartbeat.status;
      return value === "idle" || value === "running" || value === "stopped" || value === "failed" ? value : "failed";
    } catch {
      return "failed";
    }
  };

  const snapshot = (): WorkerSnapshot => Object.freeze({
    workerId: options.workerId,
    generation,
    sessionId,
    state,
    heartbeatStatus: heartbeatStatus(),
    failure: failureRef,
    lease,
  });

  const persist = (nextState = state): WorkerResult<true> => {
    if (generation === undefined || sessionId === undefined || sessionFile === undefined || lease === undefined || createdAtEpochMs === undefined) return success(true);
    const timestamp = currentTime(now);
    if (!timestamp.ok) return timestamp;
    const floor = Math.max(createdAtEpochMs, updatedAtEpochMs ?? createdAtEpochMs);
    const monotonicTimestamp = Math.max(timestamp.value, floor);
    updatedAtEpochMs = monotonicTimestamp;
    const record: WorkerStateRecord = Object.freeze({
      version: 1,
      workerId: options.workerId,
      generation,
      sessionId,
      sessionFile,
      resourceIds: Object.freeze(loader.list().map((resource) => resource.id)),
      lease,
      state: nextState,
      createdAtEpochMs,
      updatedAtEpochMs: monotonicTimestamp,
      ...(failureRef ? { failure: failureRef } : {}),
      ...(handoffFromGeneration !== undefined ? { handoffFromGeneration } : {}),
      ...(handoffSnapshotHash !== undefined ? { handoffSnapshotHash } : {}),
    });
    return writeWorkerState(options.runtimeRoot, statePath, record);
  };

  const stopMonitor = (): void => {
    if (monitorTimer !== undefined) {
      clearInterval(monitorTimer);
      monitorTimer = undefined;
    }
  };

  const revokeCredentials = (credentialsInput: LeaseCredentials | undefined): void => {
    if (credentialsInput === undefined) return;
    try {
      const revoke = options.leaseStore.revoke;
      if (revoke !== undefined) revoke(credentialsInput);
    } catch { /* cleanup is best effort; stale fencing remains authoritative */ }
  };

  const revokeLease = (): void => {
    revokeCredentials(lease);
  };

  const abortInternal = async (reason: string, terminalFailure?: WorkerFailure): Promise<WorkerResult<WorkerSnapshot>> => {
    if (abortPromise !== undefined) return abortPromise;
    abortPromise = (async () => {
      if (state === "idle" || state === "exited") {
        if (terminalFailure !== undefined) failureRef = terminalFailure;
        if (reason !== "worker_handoff") revokeLease();
        return success(snapshot());
      }
      state = "aborting";
      if (terminalFailure !== undefined) failureRef = terminalFailure;
      stopMonitor();
      try { heartbeat?.stop(); } catch {
        if (failureRef === undefined) failureRef = Object.freeze({ code: "heartbeat_failed", diagnostic: "lease_heartbeat_stop_failed" });
      }
      if (lead !== undefined) {
        const aborted = await timed(() => lead?.abort(reason) ?? Promise.resolve(), ABORT_TIMEOUT_MS);
        if (aborted.kind !== "value" && failureRef === undefined) failureRef = Object.freeze({ code: "adapter_failed", diagnostic: aborted.kind === "timeout" ? "lead_abort_timeout" : "lead_abort_failed" });
        const disposed = await timed(() => Promise.resolve(lead?.dispose()), ABORT_TIMEOUT_MS);
        if (disposed.kind !== "value" && failureRef === undefined) failureRef = Object.freeze({ code: "adapter_failed", diagnostic: disposed.kind === "timeout" ? "lead_dispose_timeout" : "lead_dispose_failed" });
      }
      lead = undefined;
      if (reason !== "worker_handoff") revokeLease();
      state = "exited";
      const persisted = persist("exited");
      if (!persisted.ok && failureRef === undefined) failureRef = persisted.rejection;
      return success(snapshot());
    })();
    return abortPromise;
  };

  const monitorHeartbeat = (): void => {
    stopMonitor();
    const poll = options.heartbeatPollMs ?? 100;
    monitorTimer = setInterval(() => {
      try {
        if (state !== "running" || heartbeat === undefined || heartbeat.status !== "failed") return;
        const heartbeatFailure = canonicalLeaseRejection(heartbeat.failure);
        const error = Object.freeze({ code: "heartbeat_failed" as const, diagnostic: heartbeatFailure?.diagnostic ?? "heartbeat_failed", lease: heartbeatFailure });
        void abortInternal("lease_lost", error);
      } catch {
        const error = Object.freeze({ code: "heartbeat_failed" as const, diagnostic: "heartbeat_failed" });
        void abortInternal("lease_lost", error);
      }
    }, poll);
    const maybeUnref = monitorTimer as unknown as { unref?: () => void };
    try { maybeUnref.unref?.(); } catch { /* timer liveness is not authority */ }
  };

  const startWithLease = async (record: LeaseRecord, nextGeneration: number, resume: boolean, handoffFromGenerationInput?: number): Promise<WorkerResult<WorkerSnapshot>> => {
    const nextLease = credentials(record);
    if (closed) {
      revokeCredentials(nextLease);
      return failure("worker_closed", "worker_closed");
    }
    let heartbeatResult: ReturnType<WorkerHostOptions["leaseStore"]["createHeartbeat"]>;
    try {
      heartbeatResult = options.leaseStore.createHeartbeat(nextLease);
      if (!leaseResultShape(heartbeatResult)) {
        revokeCredentials(nextLease);
        return failure("lease_required", "lease_heartbeat_unavailable");
      }
    } catch {
      revokeCredentials(nextLease);
      return failure("lease_required", "lease_heartbeat_unavailable");
    }
    if (!heartbeatResult.ok) {
      const heartbeatFailure = leaseError(heartbeatResult, "lease_required");
      revokeCredentials(nextLease);
      return failure(heartbeatFailure.code, heartbeatFailure.diagnostic, heartbeatFailure.lease === undefined ? {} : { lease: heartbeatFailure.lease });
    }
    state = "starting";
    generation = nextGeneration;
    lease = nextLease;
    heartbeat = heartbeatResult.value;
    let started: ReturnType<WorkerHeartbeat["start"]>;
    try {
      started = heartbeat.start();
      if (!leaseResultShape(started)) throw new Error("heartbeat_start_result_invalid");
    } catch {
      failureRef = Object.freeze({ code: "heartbeat_failed", diagnostic: "lease_heartbeat_start_failed" });
      try { heartbeat.stop(); } catch { /* cleanup is best effort */ }
      revokeLease();
      state = "idle";
      return failure(failureRef.code, failureRef.diagnostic);
    }
    if (!started.ok) {
      failureRef = leaseError(started, "lease_lost");
      revokeLease();
      state = "idle";
      return failure(failureRef.code, failureRef.diagnostic, { lease: failureRef.lease });
    }
    const suggestedSessionFile = resume && sessionFile !== undefined ? sessionFile : resolve(options.runtimeRoot, "worker-sessions", `${options.workerId}-g${nextGeneration}.jsonl`);
    if (!pathInside(options.runtimeRoot, suggestedSessionFile) || !isWorkerPathSafe(options.runtimeRoot, suggestedSessionFile)) {
      failureRef = Object.freeze({ code: "invalid_input", diagnostic: "worker_session_path_outside_runtime_root" });
      try { heartbeat.stop(); } catch { /* cleanup is best effort */ }
      revokeLease();
      state = "idle";
      return failure(failureRef.code, failureRef.diagnostic);
    }
    try {
      const created = await options.createLeadSession(Object.freeze({ cwd: options.cwd, runtimeRoot: options.runtimeRoot, statePath, sessionFile: suggestedSessionFile, generation: nextGeneration, resume, resources: loader.list(), loader }));
      if (!exactObject(created) || !text(created.sessionId) || !text(created.sessionFile) || !pathInside(options.runtimeRoot, created.sessionFile) || !isWorkerPathSafe(options.runtimeRoot, created.sessionFile) || typeof created.prompt !== "function" || typeof created.abort !== "function" || typeof created.dispose !== "function") throw new Error("lead_session_shape_invalid");
      if (closed || state !== "starting") {
        await timed(() => Promise.resolve(created.dispose()), ABORT_TIMEOUT_MS);
        return failure("worker_closed", "worker_start_cancelled");
      }
      if (resume && sessionId !== undefined && created.sessionId !== sessionId) throw new Error("lead_session_id_mismatch");
      lead = created;
      sessionId = created.sessionId;
      sessionFile = created.sessionFile;
      if (createdAtEpochMs === undefined) {
        const created = currentTime(now);
        if (!created.ok) throw new Error("worker_clock_value_invalid");
        createdAtEpochMs = created.value;
      }
      handoffFromGeneration = handoffFromGenerationInput;
      failureRef = undefined;
      state = "running";
      const persisted = persist("running");
      if (!persisted.ok) throw new Error(persisted.rejection.diagnostic);
      monitorHeartbeat();
      return success(snapshot());
    } catch (error) {
      failureRef = sessionError(error);
      await abortInternal("worker_start_failed", failureRef);
      revokeLease();
      return failure(failureRef.code, failureRef.diagnostic, { cause: failureRef.cause });
    }
  };

  const start = async (): Promise<WorkerResult<WorkerSnapshot>> => {
    if (closed) return failure("worker_closed", "worker_closed");
    if (state !== "idle") return failure("invalid_state", "worker_already_started");
    generation = 1;
    sessionId = undefined;
    sessionFile = undefined;
    createdAtEpochMs = undefined;
    updatedAtEpochMs = undefined;
    handoffFromGeneration = undefined;
    handoffSnapshotHash = undefined;
    let acquired: ReturnType<WorkerHostOptions["leaseStore"]["acquire"]>;
    try {
      acquired = options.leaseStore.acquire(options.leaseRequest);
      if (!leaseResultShape(acquired)) return failure("lease_required", "lease_acquire_failed");
    } catch { return failure("lease_required", "lease_acquire_failed"); }
    if (!acquired.ok) {
      return failure("lease_required", acquired.rejection.diagnostic, { lease: acquired.rejection });
    }
    const acquiredCredentials = canonicalLeaseCredentials(acquired.value);
    if (!leaseRecord(acquired.value)) {
      revokeCredentials(acquiredCredentials);
      return failure("lease_required", "lease_record_invalid");
    }
    if (!matchesLeaseRequest(acquired.value, options.leaseRequest)) {
      revokeCredentials(acquiredCredentials);
      return failure("lease_required", "lease_request_mismatch");
    }
    return startWithLease(acquired.value, 1, false);
  };

  const resume = async (): Promise<WorkerResult<WorkerSnapshot>> => {
    if (closed) return failure("worker_closed", "worker_closed");
    if (state !== "idle") return failure("invalid_state", "worker_already_started");
    const stored = readWorkerState(options.runtimeRoot, statePath);
    if (!stored.ok) return stored;
    if (stored.value === undefined || stored.value.workerId !== options.workerId || stored.value.state !== "running") return failure("invalid_state", "worker_resume_state_unavailable");
    const resourceIds = loader.list().map((resource) => resource.id);
    if (stored.value.resourceIds.length !== resourceIds.length || stored.value.resourceIds.some((id, index) => id !== resourceIds[index])) return failure("persistence_failed", "worker_resource_ids_mismatch");
    generation = stored.value.generation;
    sessionId = stored.value.sessionId;
    sessionFile = stored.value.sessionFile;
    createdAtEpochMs = stored.value.createdAtEpochMs;
    updatedAtEpochMs = stored.value.updatedAtEpochMs;
    handoffFromGeneration = stored.value.handoffFromGeneration;
    handoffSnapshotHash = stored.value.handoffSnapshotHash;
    let guarded: ReturnType<WorkerHostOptions["leaseStore"]["guard"]>;
    try {
      guarded = options.leaseStore.guard(stored.value.lease);
      if (!leaseResultShape(guarded)) return failure("lease_lost", "lease_guard_failed");
    } catch { return failure("lease_lost", "lease_guard_failed"); }
    if (!guarded.ok || !leaseRecord(guarded.value.record)) return !guarded.ok ? failure("lease_lost", guarded.rejection.diagnostic, { lease: guarded.rejection }) : failure("lease_lost", "lease_record_invalid");
    if (!matchesLeaseRequest(guarded.value.record, options.leaseRequest) || !matchesLeaseCredentials(guarded.value.record, stored.value.lease)) return failure("lease_lost", "lease_request_mismatch");
    return startWithLease(guarded.value.record, stored.value.generation, true);
  };

  const handoff = async (): Promise<WorkerResult<WorkerSnapshot>> => {
    if (closed) return failure("worker_closed", "worker_closed");
    if (state !== "running" || lease === undefined || generation === undefined) return failure("invalid_state", "worker_not_running");
    const previousGeneration = generation;
    const previousLease = lease;
    if (options.leaseStore.revoke === undefined) return failure("lease_required", "lease_revoke_capability_required");
    const nextHandoffHash = createHash("sha256").update(JSON.stringify({ workerId: options.workerId, generation, sessionId, sessionFile, lease: previousLease, resources: loader.list().map((resource) => resource.id) })).digest("hex");
    await abortInternal("worker_handoff");
    let revoked: ReturnType<NonNullable<WorkerHostOptions["leaseStore"]["revoke"]>>;
    try {
      revoked = options.leaseStore.revoke(previousLease);
      if (!leaseResultShape(revoked)) return failure("lease_lost", "lease_revoke_failed");
    } catch { return failure("lease_lost", "lease_revoke_failed"); }
    if (!revoked.ok) return failure("lease_lost", revoked.rejection.diagnostic, { lease: revoked.rejection });
    let acquired: ReturnType<WorkerHostOptions["leaseStore"]["acquire"]>;
    try {
      acquired = options.leaseStore.acquire(options.leaseRequest);
      if (!leaseResultShape(acquired)) return failure("lease_required", "lease_acquire_failed");
    } catch { return failure("lease_required", "lease_acquire_failed"); }
    if (!acquired.ok) return failure("lease_required", acquired.rejection.diagnostic, { lease: acquired.rejection });
    const acquiredCredentials = canonicalLeaseCredentials(acquired.value);
    if (!leaseRecord(acquired.value)) {
      revokeCredentials(acquiredCredentials);
      return failure("lease_required", "lease_record_invalid");
    }
    if (!matchesLeaseRequest(acquired.value, options.leaseRequest)) {
      revokeCredentials(acquiredCredentials);
      return failure("lease_required", "lease_request_mismatch");
    }
    if (acquired.value.fencingToken <= previousLease.fencingToken || acquired.value.leaseId === previousLease.leaseId) {
      revokeCredentials(acquiredCredentials);
      return failure("lease_lost", "handoff_fencing_not_advanced");
    }
    sessionId = undefined;
    sessionFile = undefined;
    handoffFromGeneration = previousGeneration;
    handoffSnapshotHash = nextHandoffHash;
    failureRef = undefined;
    abortPromise = undefined;
    return startWithLease(acquired.value, previousGeneration + 1, false, previousGeneration);
  };

  const diagnose = async (promptInput: unknown): Promise<WorkerResult<DiagnosticResult>> => {
    const prompt = parsePrompt(promptInput);
    if (!prompt.ok) return prompt;
    if (closed || state !== "running" || lead === undefined || sessionId === undefined) return failure("invalid_state", "worker_not_running");
    if (lease === undefined) return failure("lease_lost", "worker_lease_missing");
    let guarded: ReturnType<WorkerHostOptions["leaseStore"]["guard"]>;
    try { guarded = options.leaseStore.guard(lease); } catch {
      const lost = Object.freeze({ code: "lease_lost" as const, diagnostic: "lease_guard_failed" });
      await abortInternal("lease_lost", lost);
      return failure(lost.code, lost.diagnostic);
    }
    if (!leaseResultShape(guarded)) {
      const lost = Object.freeze({ code: "lease_lost" as const, diagnostic: "lease_guard_failed" });
      await abortInternal("lease_lost", lost);
      return failure(lost.code, lost.diagnostic);
    }
    if (!guarded.ok || !leaseRecord(guarded.value.record) || !matchesLeaseCredentials(guarded.value.record, lease)) {
      const lost: WorkerFailure = !guarded.ok ? leaseError(guarded, "lease_lost") : Object.freeze({ code: "lease_lost" as const, diagnostic: "lease_record_invalid" });
      await abortInternal("lease_lost", lost);
      return failure(lost.code, lost.diagnostic, lost.lease === undefined ? {} : { lease: lost.lease });
    }
    try {
      const outputResult = await timed(() => lead?.prompt(prompt.value.text) ?? Promise.reject(new Error("lead_session_missing")), PROMPT_TIMEOUT_MS);
      if (outputResult.kind === "timeout") {
        const timedOut = Object.freeze({ code: "adapter_failed" as const, diagnostic: "diagnostic_prompt_timeout" });
        await abortInternal("diagnostic_timeout", timedOut);
        return failure(timedOut.code, timedOut.diagnostic);
      }
      if (outputResult.kind === "error") throw outputResult.error;
      const output = outputResult.value;
      if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > MAX_TEXT_BYTES) return failure("adapter_failed", "diagnostic_output_invalid");
      if (state !== "running") return failure("lease_lost", "worker_stopped_during_prompt");
      let afterPrompt: ReturnType<WorkerHostOptions["leaseStore"]["guard"]>;
      try { afterPrompt = options.leaseStore.guard(lease); } catch {
        const lost = Object.freeze({ code: "lease_lost" as const, diagnostic: "lease_guard_failed" });
        await abortInternal("lease_lost", lost);
        return failure(lost.code, lost.diagnostic);
      }
      if (!leaseResultShape(afterPrompt)) {
        const lost = Object.freeze({ code: "lease_lost" as const, diagnostic: "lease_guard_failed" });
        await abortInternal("lease_lost", lost);
        return failure(lost.code, lost.diagnostic);
      }
      if (!afterPrompt.ok || !leaseRecord(afterPrompt.value.record) || !matchesLeaseCredentials(afterPrompt.value.record, lease)) {
        const lost: WorkerFailure = !afterPrompt.ok ? leaseError(afterPrompt, "lease_lost") : Object.freeze({ code: "lease_lost", diagnostic: "lease_record_invalid" });
        await abortInternal("lease_lost", lost);
        return failure(lost.code, lost.diagnostic, lost.lease === undefined ? {} : { lease: lost.lease });
      }
      return success(Object.freeze({ text: output, sessionId }));
    } catch (error) {
      const promptFailure = sessionError(error);
      await abortInternal("diagnostic_failed", promptFailure);
      return failure(promptFailure.code, promptFailure.diagnostic, { cause: promptFailure.cause });
    }
  };

  const pulse = async (): Promise<WorkerResult<WorkerSnapshot>> => {
    if (closed) return failure("worker_closed", "worker_closed");
    if (state !== "running" || heartbeat === undefined) return failure("invalid_state", "worker_not_running");
    const currentLease = lease;
    if (currentLease === undefined) {
      const heartbeatFailure = Object.freeze({ code: "heartbeat_failed" as const, diagnostic: "worker_lease_missing" });
      await abortInternal("lease_lost", heartbeatFailure);
      return failure(heartbeatFailure.code, heartbeatFailure.diagnostic);
    }
    let beat: ReturnType<WorkerHeartbeat["beat"]>;
    try {
      beat = heartbeat.beat();
      if (!leaseResultShape(beat)) throw new Error("heartbeat_result_invalid");
    } catch {
      const heartbeatFailure = Object.freeze({ code: "heartbeat_failed" as const, diagnostic: "heartbeat_failed" });
      await abortInternal("lease_lost", heartbeatFailure);
      return failure(heartbeatFailure.code, heartbeatFailure.diagnostic);
    }
    if (!beat.ok) {
      const heartbeatFailure = leaseError(beat, "heartbeat_failed");
      await abortInternal("lease_lost", heartbeatFailure);
      return failure(heartbeatFailure.code, heartbeatFailure.diagnostic, { lease: heartbeatFailure.lease });
    }
    if (!leaseRecord(beat.value) || !matchesLeaseCredentials(beat.value, currentLease)) {
      const heartbeatFailure = Object.freeze({ code: "heartbeat_failed" as const, diagnostic: "lease_record_mismatch" });
      await abortInternal("lease_lost", heartbeatFailure);
      return failure(heartbeatFailure.code, heartbeatFailure.diagnostic);
    }
    return success(snapshot());
  };

  const abort = async (reasonInput?: unknown): Promise<WorkerResult<WorkerSnapshot>> => {
    const reason = reasonInput === undefined ? "operator_abort" : text(reasonInput, 1024) ? reasonInput : "operator_abort";
    return abortInternal(reason);
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    if (state !== "idle" && state !== "exited") await abortInternal("worker_close");
    stopMonitor();
    closed = true;
  };

  const host: WorkerHost = Object.freeze({ start, resume, handoff, diagnose, pulse, abort, snapshot, close });
  return success(host);
}
