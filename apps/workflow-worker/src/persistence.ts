import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { LeaseCredentials, WorkerFailure, WorkerResult, WorkerState, WorkerStateRecord } from "./types.js";

const MAX_JSON_BYTES = 128 * 1024;
const MAX_TEXT_BYTES = 4096;

function failure<T>(diagnostic: string, cause?: string): WorkerResult<T> {
  return Object.freeze({ ok: false as const, rejection: Object.freeze({ code: "persistence_failed" as const, diagnostic, ...(cause ? { cause } : {}) }) });
}

function success<T>(value: T): WorkerResult<T> {
  return Object.freeze({ ok: true as const, value });
}

function safeText(value: unknown, maxBytes = MAX_TEXT_BYTES): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function safeResourceId(value: unknown): value is string {
  return safeText(value, 256) && !value.startsWith("/") && !value.includes("\\") && !/(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(value);
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function safeState(value: unknown): value is WorkerState {
  return value === "idle" || value === "starting" || value === "running" || value === "aborting" || value === "exited";
}

function safeCredentials(value: unknown): value is LeaseCredentials {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 5 || keys.some((key) => typeof key !== "string" || !["resourceKind", "resourceId", "ownerId", "leaseId", "fencingToken"].includes(key))) return false;
    const record = value as Record<string, unknown>;
    const kind = record.resourceKind;
    return kind === "epic" || kind === "delivery-unit" || kind === "integration" || kind === "release" || kind === "product-session" || kind === "repository"
      ? safeText(record.resourceId) && safeText(record.ownerId) && safeText(record.leaseId) && safeInteger(record.fencingToken, 1)
      : false;
  } catch {
    return false;
  }
}

function safeFailure(value: unknown): value is WorkerFailure {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const record = value as Record<string, unknown>;
    return safeText(record.code) && safeText(record.diagnostic) && (record.cause === undefined || safeText(record.cause)) && (record.lease === undefined || safeCredentials(record.lease));
  } catch {
    return false;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${String.fromCharCode(47)}`) && !isAbsolute(rel));
}

function noSymlinkPath(root: string, path: string): boolean {
  try {
    if (!inside(root, path)) return false;
    const rootPath = resolve(root);
    const target = resolve(path);
    const rel = relative(rootPath, target);
    const parts = rel === "" ? [] : rel.split("/");
    let cursor = rootPath;
    if (lstatSync(cursor).isSymbolicLink()) return false;
    for (const part of parts) {
      cursor = resolve(cursor, part);
      try {
        if (lstatSync(cursor).isSymbolicLink()) return false;
      } catch (error) {
        if (cursor === target || (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) continue;
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function isWorkerPathSafe(runtimeRoot: string, path: string): boolean {
  return noSymlinkPath(runtimeRoot, path);
}

export function defaultStatePath(runtimeRoot: string, workerId: string): string {
  return resolve(runtimeRoot, "worker", `${workerId}.json`);
}

export function readWorkerState(runtimeRoot: string, statePath: string): WorkerResult<WorkerStateRecord | undefined> {
  if (!noSymlinkPath(runtimeRoot, statePath)) return failure("state_path_outside_runtime_root");
  try {
    const content = readFileSync(statePath, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_JSON_BYTES) return failure("state_file_too_large");
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return failure("state_record_invalid");
    const value = parsed as Record<string, unknown>;
    const allowed = new Set(["version", "workerId", "generation", "sessionId", "sessionFile", "resourceIds", "lease", "state", "createdAtEpochMs", "updatedAtEpochMs", "handoffFromGeneration", "handoffSnapshotHash", "failure"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) return failure("state_record_fields_invalid");
    if (value.version !== 1 || !safeText(value.workerId) || !safeInteger(value.generation, 1) || !safeText(value.sessionId) || !safeText(value.sessionFile) || !noSymlinkPath(runtimeRoot, value.sessionFile) ||
        !Array.isArray(value.resourceIds) || value.resourceIds.length === 0 || value.resourceIds.some((id) => !safeResourceId(id)) || new Set(value.resourceIds as unknown[]).size !== value.resourceIds.length || !safeCredentials(value.lease) || !safeState(value.state) ||
        !safeInteger(value.createdAtEpochMs) || !safeInteger(value.updatedAtEpochMs) || value.updatedAtEpochMs < value.createdAtEpochMs ||
        (value.handoffFromGeneration !== undefined && (!safeInteger(value.handoffFromGeneration, 1) || value.handoffFromGeneration >= value.generation)) ||
        (value.handoffSnapshotHash !== undefined && (!safeText(value.handoffSnapshotHash, 128) || !/^[a-f0-9]{64}$/.test(value.handoffSnapshotHash))) || !safeFailure(value.failure)) {
      return failure("state_record_invalid");
    }
    return success(Object.freeze({
      version: 1,
      workerId: value.workerId,
      generation: value.generation,
      sessionId: value.sessionId,
      sessionFile: value.sessionFile,
      resourceIds: Object.freeze([...(value.resourceIds as string[])]),
      lease: Object.freeze({ ...(value.lease as LeaseCredentials) }),
      state: value.state,
      createdAtEpochMs: value.createdAtEpochMs,
      updatedAtEpochMs: value.updatedAtEpochMs,
      ...(value.handoffFromGeneration !== undefined ? { handoffFromGeneration: value.handoffFromGeneration } : {}),
      ...(value.handoffSnapshotHash !== undefined ? { handoffSnapshotHash: value.handoffSnapshotHash } : {}),
      ...(value.failure !== undefined ? { failure: Object.freeze({ ...(value.failure as WorkerFailure) }) } : {}),
    }));
  } catch (error) {
    const missing = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
    return missing ? success(undefined) : failure("state_file_read_failed");
  }
}

export function writeWorkerState(runtimeRoot: string, statePath: string, state: WorkerStateRecord): WorkerResult<true> {
  if (!noSymlinkPath(runtimeRoot, statePath)) return failure("state_path_outside_runtime_root");
  let temporaryPath: string | undefined;
  try {
    const targetDirectory = dirname(statePath);
    mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
    temporaryPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
    const payload = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_JSON_BYTES) return failure("state_record_too_large");
    const descriptor = openSync(temporaryPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, payload, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, statePath);
    return success(true);
  } catch (error) {
    if (temporaryPath !== undefined) { try { unlinkSync(temporaryPath); } catch { /* best-effort cleanup */ } }
    return failure("state_file_write_failed");
  }
}
