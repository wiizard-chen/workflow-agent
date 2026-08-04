import { randomBytes } from "node:crypto";

import {
  openRuntimeDatabaseInternal,
  type RuntimeDatabaseInternal,
} from "../persistence/factory.js";
import {
  acquireMigrationLock,
  type MigrationLock,
} from "../persistence/migration-lock.js";
import { createBootstrapRuntimeMigrations } from "../persistence/migrations.js";
import { safeDiagnostic } from "../persistence/errors.js";
import type { NativeSqliteConnection } from "../persistence/native-sqlite.js";
import { E05_RUNTIME_EXTENSION, E05_RUNTIME_MIGRATION } from "../persistence/e05-schema.js";
import { E08_RUNTIME_EXTENSION, E08_RUNTIME_MIGRATION } from "./schema.js";
import { E10_RUNTIME_EXTENSION, E10_RUNTIME_MIGRATION } from "../steps/schema.js";
import {
  LEASE_RESOURCE_KINDS,
  type HeartbeatController,
  type HeartbeatStatus,
  type LeaseCredentials,
  type LeaseInspection,
  type LeaseOpenResult,
  type LeaseOptions,
  type LeaseProof,
  type LeaseRecord,
  type LeaseRejectionCode,
  type LeaseRequest,
  type LeaseResourceKind,
  type LeaseResult,
  type LeaseStore,
} from "./types.js";

const MAX_IDENTIFIER_BYTES = 256;
const MAX_PATH_BYTES = 4096;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MIN_INTERVAL_MS = 100;
const MAX_POLICY_MS = 86_400_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_TTL_MS = 20_000;

function rejection<T = never>(code: LeaseRejectionCode, diagnostic: string): LeaseResult<T> {
  return Object.freeze({ ok: false as const, rejection: Object.freeze({ code, diagnostic }) });
}

function success<T>(value: T): LeaseResult<T> {
  return Object.freeze({ ok: true as const, value });
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> | undefined {
  if (!isObject(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    const allowed = new Set([...required, ...optional]);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
    const values: Array<readonly [string, unknown]> = [];
    for (const key of keys) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      values.push([key, descriptor.value]);
    }
    for (const key of required) if (!Object.hasOwn(value, key)) return undefined;
    return Object.freeze(Object.fromEntries(values));
  } catch {
    return undefined;
  }
}

function text(value: unknown, maxBytes = MAX_IDENTIFIER_BYTES): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= MAX_DATE_MS;
}

function token(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= Number.MAX_SAFE_INTEGER;
}

function rowField(row: unknown, key: string): unknown {
  if (!isObject(row)) return undefined;
  try { return (row as Record<string, unknown>)[key]; } catch { return undefined; }
}

function rowInteger(row: unknown, key: string, minimum = 0): number | undefined {
  const value = rowField(row, key);
  if (typeof value === "bigint" && value >= BigInt(minimum) && value <= BigInt(MAX_DATE_MS)) return Number(value);
  return integer(value, minimum) ? value : undefined;
}

function rowToken(row: unknown, key: string): number | undefined {
  const value = rowField(row, key);
  if (typeof value === "bigint" && value >= 1n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return token(value) ? value : undefined;
}

function resourceKind(value: unknown): value is LeaseResourceKind {
  return typeof value === "string" && (LEASE_RESOURCE_KINDS as readonly string[]).includes(value);
}

function parseOptions(value: unknown): LeaseResult<LeaseOptions> {
  const exact = ownRecord(value, ["runtimeRoot", "databasePath", "now"], ["backupDirectory", "mode", "heartbeatIntervalMs", "leaseTtlMs"]);
  if (!exact || !text(exact.runtimeRoot, MAX_PATH_BYTES) || !text(exact.databasePath, MAX_PATH_BYTES) || typeof exact.now !== "function") {
    return rejection("invalid_input", "lease_options_invalid");
  }
  if (exact.backupDirectory !== undefined && !text(exact.backupDirectory, MAX_PATH_BYTES)) return rejection("invalid_input", "backup_path_invalid");
  if (exact.mode !== undefined && exact.mode !== "read-only" && exact.mode !== "read-write") return rejection("invalid_input", "lease_mode_invalid");
  const ttl = exact.leaseTtlMs === undefined ? DEFAULT_LEASE_TTL_MS : exact.leaseTtlMs;
  const interval = exact.heartbeatIntervalMs === undefined ? DEFAULT_HEARTBEAT_INTERVAL_MS : exact.heartbeatIntervalMs;
  if (!integer(ttl, MIN_INTERVAL_MS) || ttl > MAX_POLICY_MS || !integer(interval, MIN_INTERVAL_MS) || interval > MAX_POLICY_MS || interval * 2 > ttl) {
    return rejection("invalid_input", "lease_policy_invalid");
  }
  return success(Object.freeze({
    runtimeRoot: exact.runtimeRoot,
    databasePath: exact.databasePath,
    ...(exact.backupDirectory !== undefined ? { backupDirectory: exact.backupDirectory } : {}),
    ...(exact.mode !== undefined ? { mode: exact.mode } : {}),
    now: exact.now as () => number,
    heartbeatIntervalMs: interval,
    leaseTtlMs: ttl,
  }));
}

function parseRequest(value: unknown): LeaseResult<LeaseRequest> {
  const exact = ownRecord(value, ["resourceKind", "resourceId", "ownerId"]);
  if (!exact || !resourceKind(exact.resourceKind) || !text(exact.resourceId) || !text(exact.ownerId)) return rejection("invalid_input", "lease_request_invalid");
  return success(Object.freeze({ resourceKind: exact.resourceKind, resourceId: exact.resourceId, ownerId: exact.ownerId }));
}

function parseCredentials(value: unknown): LeaseResult<LeaseCredentials> {
  const exact = ownRecord(value, ["resourceKind", "resourceId", "ownerId", "leaseId", "fencingToken"], ["issuedAtEpochMs", "heartbeatAtEpochMs", "expiresAtEpochMs", "status", "revokedAtEpochMs"]);
  if (!exact || !resourceKind(exact.resourceKind) || !text(exact.resourceId) || !text(exact.ownerId) || !text(exact.leaseId) || !token(exact.fencingToken)) {
    return rejection("invalid_input", "lease_credentials_invalid");
  }
  return success(Object.freeze({ resourceKind: exact.resourceKind, resourceId: exact.resourceId, ownerId: exact.ownerId, leaseId: exact.leaseId, fencingToken: exact.fencingToken }));
}

function parseClock(clock: () => number): LeaseResult<number> {
  try {
    const value = clock();
    return integer(value, 0) ? success(value) : rejection("clock_invalid", "clock_value_invalid");
  } catch {
    return rejection("clock_invalid", "clock_failed");
  }
}

function recordFromRow(row: unknown): LeaseResult<LeaseRecord> {
  const kind = rowField(row, "resource_kind");
  const resourceId = rowField(row, "resource_id");
  const leaseId = rowField(row, "lease_id");
  const ownerId = rowField(row, "owner_id");
  const fencingToken = rowToken(row, "fencing_token");
  const status = rowField(row, "status");
  const issued = rowInteger(row, "issued_at_ms", 0);
  const heartbeat = rowInteger(row, "heartbeat_at_ms", 0);
  const expires = rowInteger(row, "expires_at_ms", 0);
  const revokedValue = rowField(row, "revoked_at_ms");
  const revoked = revokedValue === null || revokedValue === undefined ? undefined : rowInteger(row, "revoked_at_ms", 0);
  if (!resourceKind(kind) || !text(resourceId) || !text(leaseId) || !text(ownerId) || fencingToken === undefined ||
      (status !== "active" && status !== "revoked") || issued === undefined || heartbeat === undefined || expires === undefined ||
      heartbeat < issued || expires <= heartbeat || (status === "active" && revoked !== undefined) || (status === "revoked" && revoked === undefined) || (revoked !== undefined && revoked < heartbeat)) {
    return rejection("transaction_failed", "lease_row_invalid");
  }
  return success(Object.freeze({
    resourceKind: kind,
    resourceId,
    leaseId,
    ownerId,
    fencingToken,
    issuedAtEpochMs: issued,
    heartbeatAtEpochMs: heartbeat,
    expiresAtEpochMs: expires,
    status,
    ...(revoked !== undefined ? { revokedAtEpochMs: revoked } : {}),
  }));
}

function leaseId(): LeaseResult<string> {
  try {
    return success(`lease_${randomBytes(16).toString("hex")}`);
  } catch {
    return rejection("transaction_failed", "lease_id_generation_failed");
  }
}

function withWrite<T>(
  internal: RuntimeDatabaseInternal,
  action: (connection: NativeSqliteConnection, lock: MigrationLock) => LeaseResult<T>,
): LeaseResult<T> {
  if (internal.publicHandle.status.mode === "read-only" || !internal.publicHandle.status.writable) return rejection("read_only", "runtime_is_read_only");
  const acquired = acquireMigrationLock(internal.connection);
  if (!acquired.ok) return rejection("transaction_failed", acquired.rejection.diagnostic);
  const lock = acquired.value;
  try {
    const result = action(internal.connection, lock);
    if (!result.ok) {
      lock.rollback();
      return result;
    }
    const committed = lock.commit();
    if (!committed.ok) {
      lock.rollback();
      return rejection("transaction_failed", committed.rejection.diagnostic);
    }
    return result;
  } catch (error) {
    lock.rollback();
    return rejection("transaction_failed", safeDiagnostic(error, "lease_transaction_failed"));
  }
}

function withRead<T>(internal: RuntimeDatabaseInternal, action: (connection: NativeSqliteConnection) => LeaseResult<T>): LeaseResult<T> {
  try {
    return action(internal.connection);
  } catch (error) {
    return rejection("transaction_failed", safeDiagnostic(error, "lease_read_failed"));
  }
}

function rowFor(connection: NativeSqliteConnection, request: Pick<LeaseRequest, "resourceKind" | "resourceId">): unknown {
  return connection.prepare("SELECT resource_kind, resource_id, lease_id, owner_id, fencing_token, status, issued_at_ms, heartbeat_at_ms, expires_at_ms, revoked_at_ms FROM workflow_runtime_lease WHERE resource_kind = $resourceKind AND resource_id = $resourceId").get({ $resourceKind: request.resourceKind, $resourceId: request.resourceId });
}

function currentLease(
  row: unknown,
  credentials: LeaseCredentials,
  now: number,
): LeaseResult<LeaseRecord> {
  if (row === undefined) return rejection("lease_not_found", "lease_resource_not_found");
  const parsed = recordFromRow(row);
  if (!parsed.ok) return parsed;
  const record = parsed.value;
  const matches = record.resourceKind === credentials.resourceKind && record.resourceId === credentials.resourceId &&
    record.leaseId === credentials.leaseId && record.ownerId === credentials.ownerId && record.fencingToken === credentials.fencingToken;
  if (!matches) return rejection("lease_fenced", "lease_credentials_stale");
  if (record.status === "revoked") return rejection("lease_revoked", "lease_revoked");
  if (now < record.heartbeatAtEpochMs) return rejection("clock_invalid", "clock_moved_backwards");
  if (now >= record.expiresAtEpochMs) return rejection("lease_expired", "lease_expired");
  return parsed;
}

/**
 * Internal transaction seam for later Runtime writers.  The caller must
 * already hold the E04 BEGIN IMMEDIATE lock; no public package export exposes
 * the connection or accepts an arbitrary mutation callback.
 */
export function assertCurrentLeaseInTransaction(
  connection: NativeSqliteConnection,
  credentialsInput: unknown,
  nowEpochMs: unknown,
): LeaseResult<LeaseProof> {
  const credentials = parseCredentials(credentialsInput);
  if (!credentials.ok) return credentials;
  const now = parseExplicitClockInternal(nowEpochMs);
  if (!now.ok) return now;
  return withReadOnlyCurrent(connection, credentials.value, now.value);
}

function parseExplicitClockInternal(value: unknown): LeaseResult<number> {
  return integer(value, 0) ? success(value) : rejection("clock_invalid", "clock_value_invalid");
}

function withReadOnlyCurrent(
  connection: NativeSqliteConnection,
  credentials: LeaseCredentials,
  now: number,
): LeaseResult<LeaseProof> {
  const current = currentLease(rowFor(connection, credentials), credentials, now);
  return current.ok ? success(Object.freeze({ record: current.value, checkedAtEpochMs: now })) : current;
}

function nonNegativeSafe(value: unknown): number | undefined {
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function validateLeaseRows(internal: RuntimeDatabaseInternal): LeaseResult<true> {
  try {
    const rows = internal.connection.prepare("SELECT resource_kind, resource_id, lease_id, owner_id, fencing_token, status, issued_at_ms, heartbeat_at_ms, expires_at_ms, revoked_at_ms FROM workflow_runtime_lease ORDER BY resource_kind, resource_id").all() as readonly unknown[];
    for (const row of rows) {
      const parsed = recordFromRow(row);
      if (!parsed.ok) return rejection("schema_corrupt", parsed.rejection.diagnostic);
    }
    return success(true);
  } catch {
    return rejection("schema_corrupt", "lease_rows_invalid");
  }
}

function buildInspection(internal: RuntimeDatabaseInternal, interval: number, ttl: number, now: number): LeaseResult<LeaseInspection> {
  try {
    const count = (sql: string, params?: Record<string, unknown>): number => {
      const row = (params === undefined ? internal.connection.prepare(sql).get() : internal.connection.prepare(sql).get(params)) as Record<string, unknown>;
      return rowInteger(row, "count", 0) ?? 0;
    };
    const highestRow = internal.connection.prepare("SELECT COALESCE(MAX(fencing_token), 0) AS token FROM workflow_runtime_lease").get() as Record<string, unknown>;
    const highestFencingToken = nonNegativeSafe(rowField(highestRow, "token"));
    if (highestFencingToken === undefined) return rejection("schema_corrupt", "lease_token_invalid");
    return success(Object.freeze({
      status: internal.publicHandle.status.mode,
      schemaVersion: internal.publicHandle.status.currentVersion,
      leaseCount: count("SELECT COUNT(*) AS count FROM workflow_runtime_lease"),
      activeCount: count("SELECT COUNT(*) AS count FROM workflow_runtime_lease WHERE status = 'active' AND expires_at_ms > $now", { $now: now }),
      highestFencingToken,
      heartbeatIntervalMs: interval,
      leaseTtlMs: ttl,
    }));
  } catch {
    return rejection("schema_corrupt", "lease_inspection_failed");
  }
}

export function openLeaseStore(optionsInput: unknown): LeaseOpenResult {
  const options = parseOptions(optionsInput);
  if (!options.ok) return options;
  const migrations = Object.freeze([
    ...createBootstrapRuntimeMigrations(),
    E05_RUNTIME_MIGRATION,
    E08_RUNTIME_MIGRATION,
  ]);
  const runtimeOptions = {
    runtimeRoot: options.value.runtimeRoot,
    databasePath: options.value.databasePath,
    ...(options.value.backupDirectory ? { backupDirectory: options.value.backupDirectory } : {}),
    ...(options.value.mode ? { mode: options.value.mode } : {}),
    migrations,
  };
  let opened = openRuntimeDatabaseInternal(runtimeOptions, [E05_RUNTIME_EXTENSION, E08_RUNTIME_EXTENSION]);
  // E10 extends the same local Runtime database to version 4.  Keep the E08
  // public opener backward-compatible on a fresh/v3 database while allowing
  // a restarted process to reopen a v4 database without taking ownership of
  // E10 tables or exposing them through the lease API.
  const needsFutureSchema = !opened.ok || (opened.ok && opened.value.publicHandle.status.currentVersion < E08_RUNTIME_MIGRATION.version);
  if (needsFutureSchema && opened.ok) opened.value.publicHandle.close();
  if (needsFutureSchema) {
    const futureMigrations = Object.freeze([...migrations, E10_RUNTIME_MIGRATION]);
    const futureOpened = openRuntimeDatabaseInternal({ ...runtimeOptions, migrations: futureMigrations }, [E05_RUNTIME_EXTENSION, E08_RUNTIME_EXTENSION, E10_RUNTIME_EXTENSION]);
    if (futureOpened.ok) opened = futureOpened;
  }
  if (!opened.ok) {
    const code: LeaseRejectionCode = opened.rejection.code === "read_only" ? "read_only" : opened.rejection.code === "schema_corrupt" ? "schema_corrupt" : "migration_failed";
    return rejection(code, opened.rejection.diagnostic);
  }
  const internal = opened.value;
  if (internal.publicHandle.status.currentVersion < E08_RUNTIME_MIGRATION.version) {
    internal.publicHandle.close();
    return rejection("schema_corrupt", "lease_schema_not_initialized");
  }

  const rows = validateLeaseRows(internal);
  if (!rows.ok) {
    internal.publicHandle.close();
    return rows;
  }
  let closed = false;
  const controllers = new Set<() => void>();
  const clock = (): LeaseResult<number> => closed ? rejection("store_closed", "lease_store_closed") : parseClock(options.value.now);
  const writable = (): LeaseResult<true> => closed ? rejection("store_closed", "lease_store_closed") : internal.publicHandle.status.mode === "read-only" ? rejection("read_only", "runtime_is_read_only") : success(true);
  const inspect = (): LeaseResult<LeaseInspection> => {
    if (closed) return rejection("store_closed", "lease_store_closed");
    const now = clock();
    if (!now.ok) return now;
    return buildInspection(internal, options.value.heartbeatIntervalMs!, options.value.leaseTtlMs!, now.value);
  };

  const acquire = (requestInput: unknown): LeaseResult<LeaseRecord> => {
    const request = parseRequest(requestInput);
    if (!request.ok) return request;
    const canWrite = writable();
    if (!canWrite.ok) return canWrite;
    const result = withWrite(internal, (connection) => {
      const now = clock();
      if (!now.ok) return now;
      const existingRow = rowFor(connection, request.value);
      if (existingRow !== undefined) {
        const existing = recordFromRow(existingRow);
        if (!existing.ok) return existing;
        if (existing.value.status === "active" && now.value < existing.value.expiresAtEpochMs) return rejection("lease_held", "lease_resource_held");
        if (now.value < existing.value.heartbeatAtEpochMs || (existing.value.revokedAtEpochMs !== undefined && now.value < existing.value.revokedAtEpochMs)) return rejection("clock_invalid", "clock_moved_backwards");
        if (existing.value.fencingToken >= Number.MAX_SAFE_INTEGER) return rejection("transaction_failed", "fencing_token_exhausted");
        const generated = leaseId();
        if (!generated.ok) return generated;
        const expires = now.value + options.value.leaseTtlMs!;
        if (!integer(expires, 0)) return rejection("clock_invalid", "lease_expiry_overflow");
        const token = existing.value.fencingToken + 1;
        connection.prepare("UPDATE workflow_runtime_lease SET lease_id = $leaseId, owner_id = $ownerId, fencing_token = $token, status = 'active', issued_at_ms = $issued, heartbeat_at_ms = $heartbeat, expires_at_ms = $expires, revoked_at_ms = NULL WHERE resource_kind = $resourceKind AND resource_id = $resourceId").run({ $leaseId: generated.value, $ownerId: request.value.ownerId, $token: token, $issued: now.value, $heartbeat: now.value, $expires: expires, $resourceKind: request.value.resourceKind, $resourceId: request.value.resourceId });
        return success(Object.freeze({ ...request.value, leaseId: generated.value, fencingToken: token, issuedAtEpochMs: now.value, heartbeatAtEpochMs: now.value, expiresAtEpochMs: expires, status: "active" as const }));
      }
      const generated = leaseId();
      if (!generated.ok) return generated;
      const expires = now.value + options.value.leaseTtlMs!;
      if (!integer(expires, 0)) return rejection("clock_invalid", "lease_expiry_overflow");
      connection.prepare("INSERT INTO workflow_runtime_lease (resource_kind, resource_id, lease_id, owner_id, fencing_token, status, issued_at_ms, heartbeat_at_ms, expires_at_ms, revoked_at_ms) VALUES ($resourceKind, $resourceId, $leaseId, $ownerId, 1, 'active', $issued, $heartbeat, $expires, NULL)").run({ $resourceKind: request.value.resourceKind, $resourceId: request.value.resourceId, $leaseId: generated.value, $ownerId: request.value.ownerId, $issued: now.value, $heartbeat: now.value, $expires: expires });
      return success(Object.freeze({ ...request.value, leaseId: generated.value, fencingToken: 1, issuedAtEpochMs: now.value, heartbeatAtEpochMs: now.value, expiresAtEpochMs: expires, status: "active" as const }));
    });
    return result;
  };

  const renew = (credentialsInput: unknown): LeaseResult<LeaseRecord> => {
    const credentials = parseCredentials(credentialsInput);
    if (!credentials.ok) return credentials;
    const canWrite = writable();
    if (!canWrite.ok) return canWrite;
    const result = withWrite(internal, (connection) => {
      const now = clock();
      if (!now.ok) return now;
      const expires = now.value + options.value.leaseTtlMs!;
      if (!integer(expires, 0)) return rejection("clock_invalid", "lease_expiry_overflow");
      const current = currentLease(rowFor(connection, credentials.value), credentials.value, now.value);
      if (!current.ok) return current;
      connection.prepare("UPDATE workflow_runtime_lease SET heartbeat_at_ms = $heartbeat, expires_at_ms = $expires WHERE resource_kind = $resourceKind AND resource_id = $resourceId AND lease_id = $leaseId AND owner_id = $ownerId AND fencing_token = $token AND status = 'active'").run({ $heartbeat: now.value, $expires: expires, $resourceKind: credentials.value.resourceKind, $resourceId: credentials.value.resourceId, $leaseId: credentials.value.leaseId, $ownerId: credentials.value.ownerId, $token: credentials.value.fencingToken });
      return success(Object.freeze({ ...current.value, heartbeatAtEpochMs: now.value, expiresAtEpochMs: expires }));
    });
    return result;
  };

  const heartbeat = (credentials: unknown): LeaseResult<LeaseRecord> => renew(credentials);

  const revoke = (credentialsInput: unknown): LeaseResult<LeaseRecord> => {
    const credentials = parseCredentials(credentialsInput);
    if (!credentials.ok) return credentials;
    const canWrite = writable();
    if (!canWrite.ok) return canWrite;
    const result = withWrite(internal, (connection) => {
      const row = rowFor(connection, credentials.value);
      if (row === undefined) return rejection("lease_not_found", "lease_resource_not_found");
      const parsed = recordFromRow(row);
      if (!parsed.ok) return parsed;
      const matches = parsed.value.leaseId === credentials.value.leaseId && parsed.value.ownerId === credentials.value.ownerId && parsed.value.fencingToken === credentials.value.fencingToken;
      if (!matches) return rejection("lease_fenced", "lease_credentials_stale");
      if (parsed.value.status === "revoked") return success(parsed.value);
      const now = clock();
      if (!now.ok) return now;
      const current = currentLease(row, credentials.value, now.value);
      if (!current.ok) return current;
      connection.prepare("UPDATE workflow_runtime_lease SET status = 'revoked', revoked_at_ms = $revoked WHERE resource_kind = $resourceKind AND resource_id = $resourceId AND lease_id = $leaseId AND owner_id = $ownerId AND fencing_token = $token AND status = 'active'").run({ $revoked: now.value, $resourceKind: credentials.value.resourceKind, $resourceId: credentials.value.resourceId, $leaseId: credentials.value.leaseId, $ownerId: credentials.value.ownerId, $token: credentials.value.fencingToken });
      return success(Object.freeze({ ...current.value, status: "revoked" as const, revokedAtEpochMs: now.value }));
    });
    return result;
  };

  const guard = (credentialsInput: unknown): LeaseResult<LeaseProof> => {
    const credentials = parseCredentials(credentialsInput);
    if (!credentials.ok) return credentials;
    if (closed) return rejection("store_closed", "lease_store_closed");
    const now = clock();
    if (!now.ok) return now;
    return withRead(internal, (connection) => withReadOnlyCurrent(connection, credentials.value, now.value));
  };

  const createHeartbeat = (credentialsInput: unknown): LeaseResult<HeartbeatController> => {
    const credentials = parseCredentials(credentialsInput);
    if (!credentials.ok) return credentials;
    if (closed) return rejection("store_closed", "lease_store_closed");
    let state: HeartbeatStatus = "idle";
    let timer: ReturnType<typeof setInterval> | undefined;
    let failure: { readonly code: LeaseRejectionCode; readonly diagnostic: string } | undefined;
    let unregister: () => void = () => undefined;
    const stopTimer = (): void => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      if (state === "running") state = "stopped";
    };
    const beat = (): LeaseResult<LeaseRecord> => {
      if (closed || state === "stopped") return rejection("store_closed", "heartbeat_stopped");
      if (state === "failed" && failure !== undefined) return rejection(failure.code, failure.diagnostic);
      const result = heartbeat(credentials.value);
      if (!result.ok) {
        failure = result.rejection;
        if (timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
        state = "failed";
        unregister();
      }
      return result;
    };
    const start = (): LeaseResult<true> => {
      if (closed || state === "stopped") return rejection("store_closed", "heartbeat_stopped");
      if (state === "failed" && failure !== undefined) return rejection(failure.code, failure.diagnostic);
      if (state === "running") return success(true);
      const first = beat();
      if (!first.ok) return first;
      state = "running";
      timer = setInterval(() => {
        beat();
      }, options.value.heartbeatIntervalMs!);
      const maybeUnref = timer as unknown as { unref?: () => void };
      try { maybeUnref.unref?.(); } catch { /* timer liveness is not authority */ }
      return success(true);
    };
    const stop = (): void => {
      stopTimer();
      if (state === "idle") state = "stopped";
      unregister();
    };
    const controller = Object.freeze({ beat, start, stop, get status(): HeartbeatStatus { return state; }, get failure() { return failure; } });
    unregister = () => { controllers.delete(stop); };
    controllers.add(stop);
    return success(controller);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const stop of [...controllers]) stop();
    controllers.clear();
    internal.publicHandle.close();
  };

  const store: LeaseStore = Object.freeze({
    acquire,
    renew,
    heartbeat,
    revoke,
    guard,
    createHeartbeat,
    inspect,
    close,
  });
  return success(store);
}
