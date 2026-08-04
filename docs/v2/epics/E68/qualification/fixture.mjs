import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  FIXTURE_VERSION,
  MANIFEST_SCHEMA_VERSION,
  RUNTIME_IDENTITY,
  createDefaultCandidateManifest,
} from "./manifest.mjs";

export { FIXTURE_VERSION };

/**
 * E68's native-only qualification fixture.
 *
 * Importing this module opens no database and creates no path.  A caller must
 * explicitly provide a temporary root to createNativeStepLedgerFixture().
 * The fixture uses the built-in node:sqlite driver and a deliberately narrow
 * metadata/Step Ledger schema; it is not a production workflowd store.
 */

export const FIXTURE_SCHEMA_VERSION = MANIFEST_SCHEMA_VERSION;
export const DATABASE_FILENAME = "step-ledger.sqlite";
export const DATABASE_RELATIVE_PATH = DATABASE_FILENAME;
export const DATABASE_MODE = 0o600;
export const ROOT_MODE = 0o700;
export const SQLITE_BUSY_TIMEOUT_MS = 5000;
export const NATIVE_CANDIDATE_ID = "native-sqlite-step-ledger";

export const OBSERVATION_NAMES = Object.freeze([
  "checkpoint-replay",
  "timer-wakeup",
  "retry",
  "cancellation",
  "duplicate-idempotency",
  "stale-fencing",
  "schema-drift",
  "unknown-effect",
  "artifact-integrity",
]);

export const FIXTURE_REJECTION_CODES = Object.freeze([
  "invalid_root",
  "driver_unavailable",
  "fixture_closed",
  "invalid_input",
  "unknown_field",
  "not_found",
  "duplicate_conflict",
  "idempotency_conflict",
  "stale_fencing",
  "fencing_mismatch",
  "schema_drift",
  "checkpoint_missing_step",
  "unknown_effect",
  "sqlite_error",
]);

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SAFE_KEY = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
const SAFE_STATE = new Set(["prepared", "completed", "retry", "cancelled"]);
const SAFE_EFFECT_OUTCOME = new Set(["confirmed", "rejected"]);
const MAX_ITEMS = 4096;
const MAX_DEPTH = 64;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fixture_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS task_attempt (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL UNIQUE,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'completed')),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  revision INTEGER NOT NULL CHECK (revision >= 0)
);
CREATE TABLE IF NOT EXISTS step_attempt (
  step_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'completed', 'retry', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64),
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  PRIMARY KEY (step_id, sequence),
  FOREIGN KEY (attempt_id) REFERENCES task_attempt(attempt_id)
);
CREATE TABLE IF NOT EXISTS checkpoint (
  step_id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'completed', 'retry', 'cancelled')),
  payload_json TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64),
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  FOREIGN KEY (attempt_id) REFERENCES task_attempt(attempt_id)
);
CREATE TABLE IF NOT EXISTS timer (
  step_id TEXT PRIMARY KEY NOT NULL,
  due_tick INTEGER NOT NULL CHECK (due_tick >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'woken', 'cancelled'))
);
CREATE TABLE IF NOT EXISTS external_effect (
  effect_key TEXT PRIMARY KEY NOT NULL,
  step_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('unknown', 'reconciled')),
  result_json TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64),
  FOREIGN KEY (attempt_id) REFERENCES task_attempt(attempt_id)
);
`;

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value && typeof value === "object") {
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Object.keys(value)) deepFreeze(value[key], seen);
    Object.freeze(value);
  }
  return value;
}

function ok(value) {
  return deepFreeze({ ok: true, value });
}

function fail(code, path = "[root]", detail = "invalid_value") {
  return deepFreeze({ ok: false, rejection: { code, path, detail } });
}

function isPlainObject(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownKeys(value) {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.every((key) => typeof key === "string") ? keys : null;
  } catch {
    return null;
  }
}

function descriptor(value, key) {
  try {
    const result = Object.getOwnPropertyDescriptor(value, key);
    if (!result || !("value" in result) || result.get || result.set) return null;
    return result;
  } catch {
    return null;
  }
}

/** A getter/proxy/cycle-safe immutable JSON snapshot. */
function snapshot(value, path = "[root]", active = new WeakSet(), depth = 0) {
  if (depth > MAX_DEPTH) return fail("invalid_input", path, "maximum_depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return ok(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail("invalid_input", path, "non_finite_number");
    return ok(Object.is(value, -0) ? 0 : value);
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return fail("invalid_input", path, "non_serializable");
  }
  if (typeof value !== "object") return fail("invalid_input", path, "unsupported_type");
  try {
    if (active.has(value)) return fail("invalid_input", path, "cycle");
    active.add(value);
    if (Array.isArray(value)) {
      const length = descriptor(value, "length")?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ITEMS) return fail("invalid_input", path, "invalid_array");
      const keys = ownKeys(value);
      if (!keys || keys.length !== length + 1 || !keys.includes("length")) return fail("invalid_input", path, "sparse_array");
      const result = [];
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        if (!keys.includes(key)) return fail("invalid_input", `${path}[${index}]`, "sparse_array");
        const child = snapshot(descriptor(value, key)?.value, `${path}[${index}]`, active, depth + 1);
        if (!child.ok) return child;
        result.push(child.value);
      }
      return ok(result);
    }
    if (!isPlainObject(value)) return fail("invalid_input", path, "non_plain_object");
    const keys = ownKeys(value);
    if (!keys || keys.length > MAX_ITEMS) return fail("invalid_input", path, "invalid_object");
    const result = {};
    for (const key of keys.sort()) {
      const childDescriptor = descriptor(value, key);
      if (!childDescriptor) return fail("invalid_input", `${path}.${key}`, "accessor");
      const child = snapshot(childDescriptor.value, `${path}.${key}`, active, depth + 1);
      if (!child.ok) return child;
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: child.value,
      });
    }
    return ok(result);
  } catch {
    return fail("invalid_input", path, "unreadable_value");
  } finally {
    active.delete(value);
  }
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) throw new Error("not canonical JSON");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function canonicalValue(value, path = "payload") {
  const copied = snapshot(value, path);
  if (!copied.ok) return copied;
  try {
    return ok({ value: copied.value, json: canonicalJson(copied.value), sha256: sha256(canonicalJson(copied.value)) });
  } catch {
    return fail("invalid_input", path, "canonicalization_failed");
  }
}

function exactObject(value, required, optional = []) {
  try {
    if (!isPlainObject(value)) return fail("invalid_input", "[root]", "plain_object_required");
    const keys = ownKeys(value);
    if (!keys) return fail("invalid_input", "[root]", "unreadable_object");
    const allowed = new Set([...required, ...optional]);
    for (const key of keys) {
      if (!allowed.has(key)) return fail("unknown_field", key, "unknown_field");
      if (!descriptor(value, key)) return fail("invalid_input", key, "accessor");
    }
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return fail("invalid_input", key, "missing_field");
    }
    const result = {};
    for (const key of keys) result[key] = descriptor(value, key).value;
    return ok(result);
  } catch {
    return fail("invalid_input", "[root]", "unreadable_object");
  }
}

function validId(value, pattern = SAFE_ID) {
  return typeof value === "string" && pattern.test(value) && value.length <= 160;
}

function validPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeHash(value) {
  return typeof value === "string" && HASH.test(value);
}

function safePathRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root) || root.length > 1024) return fail("invalid_root", "root", "absolute_path_required");
  const normalized = resolve(root);
  if (normalized !== root || normalized === sep || normalized === resolve(process.cwd())) {
    return fail("invalid_root", "root", "temporary_root_required");
  }
  let tempRoot;
  try {
    tempRoot = resolve(tmpdir());
  } catch {
    return fail("invalid_root", "root", "temporary_root_unavailable");
  }
  const relativeToTemp = relative(tempRoot, normalized);
  if (relativeToTemp.startsWith(`..${sep}`) || relativeToTemp === ".." || isAbsolute(relativeToTemp)) {
    return fail("invalid_root", "root", "root_outside_temp_directory");
  }
  if (normalized === resolve(process.env.HOME ?? "")) return fail("invalid_root", "root", "home_root_forbidden");
  return ok(normalized);
}

function prepareRoot(root) {
  const checked = safePathRoot(root);
  if (!checked.ok) return checked;
  try {
    if (existsSync(checked.value)) {
      const stat = lstatSync(checked.value);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return fail("invalid_root", "root", "directory_required");
    } else {
      mkdirSync(checked.value, { recursive: true, mode: ROOT_MODE });
    }
    chmodSync(checked.value, ROOT_MODE);
    const stat = lstatSync(checked.value);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== ROOT_MODE) {
      return fail("invalid_root", "root", "unsafe_permissions");
    }
    return ok(checked.value);
  } catch {
    return fail("invalid_root", "root", "root_unavailable");
  }
}

function safeDbPath(root) {
  const dbPath = join(root, DATABASE_FILENAME);
  if (resolve(dirname(dbPath)) !== root || basename(dbPath) !== DATABASE_FILENAME) return fail("invalid_root", "root", "path_escape");
  try {
    if (existsSync(dbPath)) {
      const stat = lstatSync(dbPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return fail("invalid_root", "database", "regular_file_required");
      if ((stat.mode & 0o777) !== DATABASE_MODE) chmodSync(dbPath, DATABASE_MODE);
    }
  } catch {
    return fail("invalid_root", "database", "database_path_unavailable");
  }
  return ok(dbPath);
}

function rollback(db) {
  try { db.exec("ROLLBACK"); } catch { /* no-op: original failure is reported */ }
}

function transaction(db, callback) {
  try {
    db.exec("BEGIN IMMEDIATE");
    const result = callback();
    if (!result.ok) {
      rollback(db);
      return result;
    }
    db.exec("COMMIT");
    return result;
  } catch {
    rollback(db);
    return fail("sqlite_error", "database", "transaction_failed");
  }
}

function rowToObject(row) {
  if (!row || typeof row !== "object") return null;
  const result = {};
  for (const key of Object.keys(row)) result[key] = row[key];
  return result;
}

function readCount(db, table) {
  const row = db.prepare(`SELECT count(*) AS count FROM ${table}`).get();
  return Number(row?.count ?? 0);
}

function createDatabase(dbPath) {
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${FIXTURE_SCHEMA_VERSION}`);
    db.prepare("INSERT OR IGNORE INTO fixture_meta(key, value) VALUES ($key, $value)").run({
      $key: "fixtureVersion", $value: FIXTURE_VERSION,
    });
    db.prepare("INSERT OR IGNORE INTO fixture_meta(key, value) VALUES ($key, $value)").run({
      $key: "schemaVersion", $value: String(FIXTURE_SCHEMA_VERSION),
    });
    chmodSync(dbPath, DATABASE_MODE);
    return ok(db);
  } catch {
    try { db?.close(); } catch { /* no-op */ }
    return fail("driver_unavailable", "database", "native_sqlite_unavailable");
  }
}

function readPragmas(db) {
  try {
    const journal = rowToObject(db.prepare("PRAGMA journal_mode").get());
    const synchronous = rowToObject(db.prepare("PRAGMA synchronous").get());
    const foreignKeys = rowToObject(db.prepare("PRAGMA foreign_keys").get());
    const busyTimeout = rowToObject(db.prepare("PRAGMA busy_timeout").get());
    return ok({
      journalMode: String(journal?.journal_mode ?? ""),
      synchronous: Number(synchronous?.synchronous ?? -1),
      foreignKeys: Number(foreignKeys?.foreign_keys ?? -1),
      busyTimeout: Number(busyTimeout?.timeout ?? -1),
    });
  } catch {
    return fail("sqlite_error", "database", "pragma_read_failed");
  }
}

function validatePragmas(db) {
  const result = readPragmas(db);
  if (!result.ok) return result;
  const value = result.value;
  if (value.journalMode !== "wal" || value.synchronous !== 2 || value.foreignKeys !== 1 || value.busyTimeout !== SQLITE_BUSY_TIMEOUT_MS) {
    return fail("sqlite_error", "database", "pragma_contract_failed");
  }
  return result;
}

function normalizeAttempt(input) {
  const exact = exactObject(input, ["taskId", "attemptId", "fencingToken"], ["schemaVersion"]);
  if (!exact.ok) return exact;
  const value = exact.value;
  if (!validId(value.taskId) || !validId(value.attemptId)) return fail("invalid_input", "taskId", "invalid_identifier");
  if (!validPositiveInteger(value.fencingToken)) return fail("invalid_input", "fencingToken", "positive_integer_required");
  if (value.schemaVersion !== undefined && !validPositiveInteger(value.schemaVersion)) return fail("invalid_input", "schemaVersion", "positive_integer_required");
  return ok({ taskId: value.taskId, attemptId: value.attemptId, fencingToken: value.fencingToken, schemaVersion: value.schemaVersion ?? FIXTURE_SCHEMA_VERSION });
}

function normalizeStep(input) {
  const exact = exactObject(input, ["taskId", "attemptId", "stepId", "idempotencyKey", "fencingToken", "state", "payload"]);
  if (!exact.ok) return exact;
  const value = exact.value;
  if (![value.taskId, value.attemptId, value.stepId].every((entry) => validId(entry))) return fail("invalid_input", "stepId", "invalid_identifier");
  if (!validId(value.idempotencyKey, SAFE_KEY)) return fail("invalid_input", "idempotencyKey", "invalid_identifier");
  if (!validPositiveInteger(value.fencingToken)) return fail("invalid_input", "fencingToken", "positive_integer_required");
  if (typeof value.state !== "string" || !SAFE_STATE.has(value.state)) return fail("invalid_input", "state", "invalid_step_state");
  const payload = canonicalValue(value.payload);
  if (!payload.ok) return payload;
  return ok({
    taskId: value.taskId,
    attemptId: value.attemptId,
    stepId: value.stepId,
    idempotencyKey: value.idempotencyKey,
    fencingToken: value.fencingToken,
    state: value.state,
    payloadJson: payload.value.json,
    artifactSha256: payload.value.sha256,
  });
}

function normalizeCheckpoint(input) {
  const exact = exactObject(input, ["taskId", "attemptId", "stepId", "sequence", "fencingToken", "state", "payload"]);
  if (!exact.ok) return exact;
  const value = exact.value;
  if (![value.taskId, value.attemptId, value.stepId].every((entry) => validId(entry))) return fail("invalid_input", "stepId", "invalid_identifier");
  if (!validPositiveInteger(value.sequence)) return fail("invalid_input", "sequence", "positive_integer_required");
  if (!validPositiveInteger(value.fencingToken)) return fail("invalid_input", "fencingToken", "positive_integer_required");
  if (typeof value.state !== "string" || !SAFE_STATE.has(value.state)) return fail("invalid_input", "state", "invalid_step_state");
  const payload = canonicalValue(value.payload);
  if (!payload.ok) return payload;
  return ok({
    taskId: value.taskId,
    attemptId: value.attemptId,
    stepId: value.stepId,
    sequence: value.sequence,
    fencingToken: value.fencingToken,
    state: value.state,
    payloadJson: payload.value.json,
    artifactSha256: payload.value.sha256,
  });
}

function normalizeTimer(input) {
  const exact = exactObject(input, ["stepId", "dueTick"]);
  if (!exact.ok) return exact;
  if (!validId(exact.value.stepId) || !validNonNegativeInteger(exact.value.dueTick)) return fail("invalid_input", "timer", "invalid_timer");
  return ok({ stepId: exact.value.stepId, dueTick: exact.value.dueTick });
}

function normalizeUnknownEffect(input) {
  const exact = exactObject(input, ["effectKey", "taskId", "attemptId", "stepId", "idempotencyKey", "fencingToken"]);
  if (!exact.ok) return exact;
  const value = exact.value;
  if (![value.effectKey, value.taskId, value.attemptId, value.stepId].every((entry) => validId(entry))) return fail("invalid_input", "effectKey", "invalid_identifier");
  if (!validId(value.idempotencyKey, SAFE_KEY)) return fail("invalid_input", "idempotencyKey", "invalid_identifier");
  if (!validPositiveInteger(value.fencingToken)) return fail("invalid_input", "fencingToken", "positive_integer_required");
  return ok({ ...value });
}

function observation(name, input, outcome, expected, detail) {
  const inputValue = canonicalValue(input);
  if (!inputValue.ok) return fail("invalid_input", "observation", "input_not_canonical");
  const output = outcome.ok ? outcome.value : outcome.rejection;
  const outputValue = canonicalValue(output);
  if (!outputValue.ok) return fail("invalid_input", "observation", "output_not_canonical");
  return ok({
    name,
    status: expected(outcome) ? "pass" : "fail",
    inputSha256: inputValue.value.sha256,
    outputSha256: outputValue.value.sha256,
    safeDetail: detail,
  });
}

function deterministicDetail(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,159}$/.test(value)
    ? value
    : "fixture_observation";
}

/**
 * Explicitly create the native fixture under a temporary root.  No provider,
 * network, subprocess, or user checkout is touched.
 */
export function createNativeStepLedgerFixture(options) {
  try {
    const exact = exactObject(options, ["root"]);
    if (!exact.ok) return fail("invalid_root", exact.rejection.path, exact.rejection.detail);
    const root = prepareRoot(exact.value.root);
    if (!root.ok) return root;
    const dbPath = safeDbPath(root.value);
    if (!dbPath.ok) return dbPath;
    const database = createDatabase(dbPath.value);
    if (!database.ok) return database;
    const pragma = validatePragmas(database.value);
    if (!pragma.ok) {
      try { database.value.close(); } catch { /* no-op */ }
      return pragma;
    }
    const manifest = createDefaultCandidateManifest();
    if (!manifest.ok) {
      try { database.value.close(); } catch { /* no-op */ }
      return fail("sqlite_error", "manifest", "native_manifest_unavailable");
    }

    let db = database.value;
    let closed = false;

    function ensureOpen() {
      return closed ? fail("fixture_closed", "fixture", "fixture_closed") : ok(true);
    }

    function close() {
      if (closed) return ok({ closed: true });
      try {
        db.close();
        closed = true;
        return ok({ closed: true });
      } catch {
        return fail("sqlite_error", "database", "close_failed");
      }
    }

    function reopen() {
      const open = ensureOpen();
      if (!open.ok) return open;
      try {
        db.close();
        const reopened = createDatabase(dbPath.value);
        if (!reopened.ok) {
          closed = true;
          return reopened;
        }
        const checked = validatePragmas(reopened.value);
        if (!checked.ok) {
          try { reopened.value.close(); } catch { /* no-op */ }
          closed = true;
          return checked;
        }
        db = reopened.value;
        return ok({ reopened: true });
      } catch {
        closed = true;
        return fail("sqlite_error", "database", "reopen_failed");
      }
    }

    function inspect() {
      const open = ensureOpen();
      if (!open.ok) return open;
      try {
        const pragmas = readPragmas(db);
        if (!pragmas.ok) return pragmas;
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
          .map((row) => String(row.name));
        const meta = db.prepare("SELECT key, value FROM fixture_meta ORDER BY key").all()
          .map((row) => ({ key: String(row.key), value: String(row.value) }));
        const versionRow = db.prepare("PRAGMA user_version").get();
        return ok({
          fixtureVersion: FIXTURE_VERSION,
          schemaVersion: Number(versionRow?.user_version ?? -1),
          tables,
          metadata: meta,
          pragmas: pragmas.value,
          counts: {
            attempts: readCount(db, "task_attempt"),
            steps: readCount(db, "step_attempt"),
            checkpoints: readCount(db, "checkpoint"),
            timers: readCount(db, "timer"),
            effects: readCount(db, "external_effect"),
          },
        });
      } catch {
        return fail("sqlite_error", "database", "inspection_failed");
      }
    }

    function startAttempt(input) {
      const open = ensureOpen();
      if (!open.ok) return open;
      const normalized = normalizeAttempt(input);
      if (!normalized.ok) return normalized;
      const value = normalized.value;
      return transaction(db, () => {
        const existingByTask = rowToObject(db.prepare("SELECT * FROM task_attempt WHERE task_id = $taskId").get({ $taskId: value.taskId }));
        const existingByAttempt = rowToObject(db.prepare("SELECT * FROM task_attempt WHERE attempt_id = $attemptId").get({ $attemptId: value.attemptId }));
        const existing = existingByTask ?? existingByAttempt;
        if (existing) {
          if (existing.task_id !== value.taskId || existing.attempt_id !== value.attemptId ||
              Number(existing.fencing_token) !== value.fencingToken || Number(existing.schema_version) !== value.schemaVersion) {
            return fail("duplicate_conflict", "attempt", "attempt_identity_conflict");
          }
          return ok({ outcome: "duplicate", inserted: false, taskId: value.taskId, attemptId: value.attemptId, fencingToken: value.fencingToken });
        }
        db.prepare("INSERT INTO task_attempt(attempt_id, task_id, fencing_token, status, schema_version, revision) VALUES ($attemptId, $taskId, $fencingToken, 'active', $schemaVersion, 0)").run({
          $attemptId: value.attemptId, $taskId: value.taskId, $fencingToken: value.fencingToken, $schemaVersion: value.schemaVersion,
        });
        return ok({ outcome: "inserted", inserted: true, taskId: value.taskId, attemptId: value.attemptId, fencingToken: value.fencingToken });
      });
    }

    function advanceFence(input) {
      const exact = exactObject(input, ["attemptId", "fencingToken"]);
      if (!exact.ok) return exact;
      const open = ensureOpen();
      if (!open.ok) return open;
      if (!validId(exact.value.attemptId) || !validPositiveInteger(exact.value.fencingToken)) return fail("invalid_input", "fencingToken", "positive_integer_required");
      return transaction(db, () => {
        const row = rowToObject(db.prepare("SELECT * FROM task_attempt WHERE attempt_id = $attemptId").get({ $attemptId: exact.value.attemptId }));
        if (!row) return fail("not_found", "attemptId", "attempt_not_found");
        const current = Number(row.fencing_token);
        if (exact.value.fencingToken <= current) return fail("fencing_mismatch", "fencingToken", "token_must_increase");
        db.prepare("UPDATE task_attempt SET fencing_token = $fencingToken, revision = revision + 1 WHERE attempt_id = $attemptId").run({
          $fencingToken: exact.value.fencingToken, $attemptId: exact.value.attemptId,
        });
        return ok({ outcome: "advanced", attemptId: exact.value.attemptId, previousFencingToken: current, fencingToken: exact.value.fencingToken });
      });
    }

    function currentAttempt(attemptId, taskId) {
      const row = rowToObject(db.prepare("SELECT * FROM task_attempt WHERE attempt_id = $attemptId AND task_id = $taskId").get({ $attemptId: attemptId, $taskId: taskId }));
      return row ? { ...row, fencing_token: Number(row.fencing_token), schema_version: Number(row.schema_version), revision: Number(row.revision) } : null;
    }

    function appendStep(input) {
      const open = ensureOpen();
      if (!open.ok) return open;
      const normalized = normalizeStep(input);
      if (!normalized.ok) return normalized;
      const value = normalized.value;
      return transaction(db, () => {
        const attempt = currentAttempt(value.attemptId, value.taskId);
        if (!attempt) return fail("not_found", "attemptId", "attempt_not_found");
        if (value.fencingToken < attempt.fencing_token) return fail("stale_fencing", "fencingToken", "stale_token_rejected");
        if (value.fencingToken !== attempt.fencing_token) return fail("fencing_mismatch", "fencingToken", "current_token_required");
        const existing = rowToObject(db.prepare("SELECT * FROM step_attempt WHERE idempotency_key = $idempotencyKey").get({ $idempotencyKey: value.idempotencyKey }));
        if (existing) {
          const same = existing.attempt_id === value.attemptId && existing.step_id === value.stepId &&
            existing.payload_json === value.payloadJson && existing.state === value.state && Number(existing.fencing_token) === value.fencingToken;
          if (!same) return fail("idempotency_conflict", "idempotencyKey", "idempotency_binding_mismatch");
          return ok({
            outcome: "duplicate",
            inserted: false,
            stepId: value.stepId,
            sequence: Number(existing.sequence),
            idempotencyKey: value.idempotencyKey,
            artifactSha256: existing.artifact_sha256,
          });
        }
        const sequenceRow = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM step_attempt WHERE step_id = $stepId").get({ $stepId: value.stepId });
        const sequence = Number(sequenceRow?.sequence ?? 0) + 1;
        db.prepare("INSERT INTO step_attempt(step_id, attempt_id, sequence, state, idempotency_key, payload_json, artifact_sha256, fencing_token) VALUES ($stepId, $attemptId, $sequence, $state, $idempotencyKey, $payloadJson, $artifactSha256, $fencingToken)").run({
          $stepId: value.stepId, $attemptId: value.attemptId, $sequence: sequence, $state: value.state,
          $idempotencyKey: value.idempotencyKey, $payloadJson: value.payloadJson, $artifactSha256: value.artifactSha256,
          $fencingToken: value.fencingToken,
        });
        db.prepare("UPDATE task_attempt SET revision = revision + 1 WHERE attempt_id = $attemptId").run({ $attemptId: value.attemptId });
        const record = { stepId: value.stepId, attemptId: value.attemptId, sequence, state: value.state, idempotencyKey: value.idempotencyKey, artifactSha256: value.artifactSha256, fencingToken: value.fencingToken };
        return ok({ outcome: "inserted", inserted: true, ...record, recordSha256: sha256(canonicalJson(record)) });
      });
    }

    function checkpoint(input) {
      const open = ensureOpen();
      if (!open.ok) return open;
      const normalized = normalizeCheckpoint(input);
      if (!normalized.ok) return normalized;
      const value = normalized.value;
      return transaction(db, () => {
        const attempt = currentAttempt(value.attemptId, value.taskId);
        if (!attempt) return fail("not_found", "attemptId", "attempt_not_found");
        if (value.fencingToken < attempt.fencing_token) return fail("stale_fencing", "fencingToken", "stale_token_rejected");
        if (value.fencingToken !== attempt.fencing_token) return fail("fencing_mismatch", "fencingToken", "current_token_required");
        const step = rowToObject(db.prepare("SELECT * FROM step_attempt WHERE step_id = $stepId AND attempt_id = $attemptId AND sequence = $sequence").get({
          $stepId: value.stepId, $attemptId: value.attemptId, $sequence: value.sequence,
        }));
        if (!step) return fail("checkpoint_missing_step", "sequence", "step_record_required");
        const existing = rowToObject(db.prepare("SELECT * FROM checkpoint WHERE step_id = $stepId").get({ $stepId: value.stepId }));
        if (existing) {
          const same = existing.attempt_id === value.attemptId && Number(existing.sequence) === value.sequence && existing.state === value.state && existing.payload_json === value.payloadJson && Number(existing.fencing_token) === value.fencingToken;
          if (!same) return fail("duplicate_conflict", "checkpoint", "checkpoint_conflict");
          return ok({ outcome: "duplicate", inserted: false, stepId: value.stepId, sequence: value.sequence, artifactSha256: existing.artifact_sha256 });
        }
        db.prepare("INSERT INTO checkpoint(step_id, attempt_id, sequence, state, payload_json, artifact_sha256, fencing_token) VALUES ($stepId, $attemptId, $sequence, $state, $payloadJson, $artifactSha256, $fencingToken)").run({
          $stepId: value.stepId, $attemptId: value.attemptId, $sequence: value.sequence, $state: value.state,
          $payloadJson: value.payloadJson, $artifactSha256: value.artifactSha256, $fencingToken: value.fencingToken,
        });
        return ok({ outcome: "inserted", inserted: true, stepId: value.stepId, sequence: value.sequence, artifactSha256: value.artifactSha256 });
      });
    }

    function recover(input) {
      const exact = exactObject(input, ["stepId"]);
      if (!exact.ok) return exact;
      const open = ensureOpen();
      if (!open.ok) return open;
      if (!validId(exact.value.stepId)) return fail("invalid_input", "stepId", "invalid_identifier");
      try {
        const unknown = db.prepare("SELECT effect_key FROM external_effect WHERE step_id = $stepId AND state = 'unknown' ORDER BY effect_key").all({ $stepId: exact.value.stepId }).map((row) => String(row.effect_key));
        if (unknown.length > 0) {
          return ok({ status: "unknown_effect", stepId: exact.value.stepId, recoveryAction: "reconcile_before_retry", unknownEffectKeys: unknown });
        }
        const checkpointRow = rowToObject(db.prepare("SELECT * FROM checkpoint WHERE step_id = $stepId").get({ $stepId: exact.value.stepId }));
        if (!checkpointRow) return ok({ status: "no_checkpoint", stepId: exact.value.stepId, recoveryAction: "start_from_beginning" });
        return ok({
          status: "recovered",
          stepId: exact.value.stepId,
          recoveryAction: "resume_from_checkpoint",
          checkpointSequence: Number(checkpointRow.sequence),
          state: checkpointRow.state,
          artifactSha256: checkpointRow.artifact_sha256,
        });
      } catch {
        return fail("sqlite_error", "recovery", "recovery_read_failed");
      }
    }

    function scheduleTimer(input) {
      const open = ensureOpen();
      if (!open.ok) return open;
      const normalized = normalizeTimer(input);
      if (!normalized.ok) return normalized;
      const value = normalized.value;
      return transaction(db, () => {
        const existing = rowToObject(db.prepare("SELECT * FROM timer WHERE step_id = $stepId").get({ $stepId: value.stepId }));
        if (existing) {
          if (Number(existing.due_tick) !== value.dueTick) return fail("duplicate_conflict", "dueTick", "timer_conflict");
          return ok({ outcome: "duplicate", inserted: false, stepId: value.stepId, dueTick: value.dueTick, state: existing.state });
        }
        db.prepare("INSERT INTO timer(step_id, due_tick, state) VALUES ($stepId, $dueTick, 'pending')").run({ $stepId: value.stepId, $dueTick: value.dueTick });
        return ok({ outcome: "inserted", inserted: true, stepId: value.stepId, dueTick: value.dueTick, state: "pending" });
      });
    }

    function wakeTimers(input) {
      const exact = exactObject(input, ["tick"]);
      if (!exact.ok) return exact;
      const open = ensureOpen();
      if (!open.ok) return open;
      if (!validNonNegativeInteger(exact.value.tick)) return fail("invalid_input", "tick", "non_negative_integer_required");
      return transaction(db, () => {
        const rows = db.prepare("SELECT step_id, due_tick FROM timer WHERE state = 'pending' AND due_tick <= $tick ORDER BY step_id").all({ $tick: exact.value.tick });
        db.prepare("UPDATE timer SET state = 'woken' WHERE state = 'pending' AND due_tick <= $tick").run({ $tick: exact.value.tick });
        return ok({ tick: exact.value.tick, wokenStepIds: rows.map((row) => String(row.step_id)), wokenCount: rows.length });
      });
    }

    function cancelStep(input) {
      const exact = exactObject(input, ["taskId", "attemptId", "stepId", "idempotencyKey", "fencingToken", "payload"]);
      if (!exact.ok) return exact;
      return appendStep({ ...exact.value, state: "cancelled" });
    }

    function retryStep(input) {
      const exact = exactObject(input, ["taskId", "attemptId", "stepId", "idempotencyKey", "fencingToken", "payload"]);
      if (!exact.ok) return exact;
      return appendStep({ ...exact.value, state: "retry" });
    }

    function recordUnknownEffect(input) {
      const open = ensureOpen();
      if (!open.ok) return open;
      const normalized = normalizeUnknownEffect(input);
      if (!normalized.ok) return normalized;
      const value = normalized.value;
      return transaction(db, () => {
        const attempt = currentAttempt(value.attemptId, value.taskId);
        if (!attempt) return fail("not_found", "attemptId", "attempt_not_found");
        if (value.fencingToken < attempt.fencing_token) return fail("stale_fencing", "fencingToken", "stale_token_rejected");
        if (value.fencingToken !== attempt.fencing_token) return fail("fencing_mismatch", "fencingToken", "current_token_required");
        const existing = rowToObject(db.prepare("SELECT * FROM external_effect WHERE idempotency_key = $idempotencyKey").get({ $idempotencyKey: value.idempotencyKey }));
        if (existing) {
          const same = existing.effect_key === value.effectKey && existing.step_id === value.stepId && existing.attempt_id === value.attemptId;
          if (!same) return fail("idempotency_conflict", "idempotencyKey", "effect_idempotency_conflict");
          return ok({ outcome: "duplicate", inserted: false, effectKey: value.effectKey, status: existing.state, recoveryAction: "reconcile_before_retry" });
        }
        const resultJson = "{\"status\":\"unknown\"}";
        const artifactSha256 = sha256(resultJson);
        db.prepare("INSERT INTO external_effect(effect_key, step_id, attempt_id, idempotency_key, state, result_json, artifact_sha256) VALUES ($effectKey, $stepId, $attemptId, $idempotencyKey, 'unknown', $resultJson, $artifactSha256)").run({
          $effectKey: value.effectKey, $stepId: value.stepId, $attemptId: value.attemptId, $idempotencyKey: value.idempotencyKey, $resultJson: resultJson, $artifactSha256: artifactSha256,
        });
        return ok({ outcome: "inserted", inserted: true, effectKey: value.effectKey, status: "unknown", recoveryAction: "reconcile_before_retry", artifactSha256 });
      });
    }

    function reconcileUnknownEffect(input) {
      const exact = exactObject(input, ["effectKey", "outcome"]);
      if (!exact.ok) return exact;
      const open = ensureOpen();
      if (!open.ok) return open;
      if (!validId(exact.value.effectKey) || !SAFE_EFFECT_OUTCOME.has(exact.value.outcome)) return fail("invalid_input", "outcome", "invalid_effect_outcome");
      return transaction(db, () => {
        const existing = rowToObject(db.prepare("SELECT * FROM external_effect WHERE effect_key = $effectKey").get({ $effectKey: exact.value.effectKey }));
        if (!existing) return fail("not_found", "effectKey", "effect_not_found");
        db.prepare("UPDATE external_effect SET state = 'reconciled', result_json = $resultJson WHERE effect_key = $effectKey").run({
          $effectKey: exact.value.effectKey, $resultJson: `{"status":"reconciled","outcome":"${exact.value.outcome}"}`,
        });
        return ok({ effectKey: exact.value.effectKey, status: "reconciled", outcome: exact.value.outcome });
      });
    }

    function inspectSchema(input) {
      const exact = exactObject(input, ["expectedVersion"]);
      if (!exact.ok) return exact;
      const open = ensureOpen();
      if (!open.ok) return open;
      if (!validPositiveInteger(exact.value.expectedVersion)) return fail("invalid_input", "expectedVersion", "positive_integer_required");
      try {
        const row = db.prepare("PRAGMA user_version").get();
        const actualVersion = Number(row?.user_version ?? -1);
        if (actualVersion !== exact.value.expectedVersion) {
          return ok({ status: "schema_drift", actualVersion, expectedVersion: exact.value.expectedVersion, recoveryAction: "block_until_migrated" });
        }
        return ok({ status: "schema_current", actualVersion, expectedVersion: exact.value.expectedVersion });
      } catch {
        return fail("sqlite_error", "schema", "schema_read_failed");
      }
    }

    function artifactSha256(value) {
      const canonical = canonicalValue(value);
      if (!canonical.ok) return canonical;
      return ok({ sha256: canonical.value.sha256 });
    }

    function countSteps(stepId) {
      try {
        const row = db.prepare("SELECT count(*) AS count FROM step_attempt WHERE step_id = $stepId").get({ $stepId: stepId });
        return Number(row?.count ?? 0);
      } catch {
        return -1;
      }
    }

    function runMatrix() {
      const open = ensureOpen();
      if (!open.ok) return open;
      const observations = [];
      const add = (name, input, outcome, expected, detail) => {
        const result = observation(name, input, outcome, expected, deterministicDetail(detail));
        if (!result.ok) throw new Error("observation_failed");
        observations.push(result.value);
      };
      try {
        const restartAttempt = { taskId: "matrix-restart-task", attemptId: "matrix-restart-attempt", fencingToken: 1 };
        const restartStep = { taskId: restartAttempt.taskId, attemptId: restartAttempt.attemptId, stepId: "matrix-restart-step", idempotencyKey: "matrix-restart-append", fencingToken: 1, state: "completed", payload: { checkpoint: "boundary", ordinal: 1 } };
        startAttempt(restartAttempt);
        const append = appendStep(restartStep);
        const saved = checkpoint({
          taskId: restartStep.taskId,
          attemptId: restartStep.attemptId,
          stepId: restartStep.stepId,
          sequence: append.ok ? append.value.sequence : 1,
          fencingToken: restartStep.fencingToken,
          state: restartStep.state,
          payload: restartStep.payload,
        });
        reopen();
        const recovered = recover({ stepId: restartStep.stepId });
        add("checkpoint-replay", { operation: "restart", stepId: restartStep.stepId }, recovered, (result) => result.ok && result.value.status === "recovered" && result.value.recoveryAction === "resume_from_checkpoint", "checkpoint_replay recovered_from_checkpoint");

        const timer = scheduleTimer({ stepId: "matrix-timer-step", dueTick: 7 });
        const woken = wakeTimers({ tick: 7 });
        const timerStable = timer.ok && woken.ok &&
          (timer.value.state === "woken" || woken.value.wokenStepIds.includes("matrix-timer-step"))
          ? ok({ status: "woken", stepId: "matrix-timer-step", dueTick: 7 })
          : fail("sqlite_error", "timer", "timer_not_woken");
        add("timer-wakeup", { dueTick: 7, stepId: "matrix-timer-step" }, timerStable, (result) => result.ok && result.value.status === "woken", "timer_wakeup deterministic_tick");

        const retryAttempt = { taskId: "matrix-retry-task", attemptId: "matrix-retry-attempt", fencingToken: 1 };
        startAttempt(retryAttempt);
        const firstRetry = appendStep({ ...retryAttempt, stepId: "matrix-retry-step", idempotencyKey: "matrix-retry-initial", state: "prepared", payload: { attempt: 1 } });
        const retry = retryStep({ ...retryAttempt, stepId: "matrix-retry-step", idempotencyKey: "matrix-retry-next", payload: { attempt: 2 } });
        const retryStable = retry.ok && Number(retry.value.sequence) === 2
          ? ok({ state: "retry", stepId: "matrix-retry-step", sequence: 2 })
          : retry;
        add("retry", { stepId: "matrix-retry-step", attempts: 2 }, retryStable, (result) => result.ok && result.value.state === "retry" && Number(result.value.sequence) === 2, "retry appended_next_sequence");

        const cancelAttempt = { taskId: "matrix-cancel-task", attemptId: "matrix-cancel-attempt", fencingToken: 1 };
        startAttempt(cancelAttempt);
        const cancelled = cancelStep({ ...cancelAttempt, stepId: "matrix-cancel-step", idempotencyKey: "matrix-cancel-request", payload: { reason: "probe" } });
        const cancellationStable = cancelled.ok && Number(cancelled.value.sequence) === 1
          ? ok({ state: "cancelled", stepId: "matrix-cancel-step", sequence: 1 })
          : cancelled;
        add("cancellation", { stepId: "matrix-cancel-step" }, cancellationStable, (result) => result.ok && result.value.state === "cancelled", "cancellation persisted");

        const duplicateAttempt = { taskId: "matrix-duplicate-task", attemptId: "matrix-duplicate-attempt", fencingToken: 1 };
        startAttempt(duplicateAttempt);
        const duplicateInput = { ...duplicateAttempt, stepId: "matrix-duplicate-step", idempotencyKey: "matrix-duplicate-key", state: "completed", payload: { logical: "one" } };
        const first = appendStep(duplicateInput);
        const second = appendStep(duplicateInput);
        add("duplicate-idempotency", { stepId: duplicateInput.stepId, idempotencyKey: duplicateInput.idempotencyKey }, second, (result) => result.ok && result.value.outcome === "duplicate" && countSteps(duplicateInput.stepId) === 1, "duplicate_key_one_logical_append");

        const fenceAttempt = { taskId: "matrix-fence-task", attemptId: "matrix-fence-attempt", fencingToken: 1 };
        startAttempt(fenceAttempt);
        advanceFence({ attemptId: fenceAttempt.attemptId, fencingToken: 2 });
        const stale = appendStep({ ...fenceAttempt, stepId: "matrix-fence-step", idempotencyKey: "matrix-fence-stale", state: "completed", payload: { stale: true } });
        add("stale-fencing", { attemptId: fenceAttempt.attemptId, fencingToken: 1 }, stale, (result) => !result.ok && result.rejection.code === "stale_fencing", "stale_fencing_rejected");

        const drift = inspectSchema({ expectedVersion: FIXTURE_SCHEMA_VERSION + 1 });
        add("schema-drift", { expectedVersion: FIXTURE_SCHEMA_VERSION + 1 }, drift, (result) => result.ok && result.value.status === "schema_drift" && result.value.recoveryAction === "block_until_migrated", "schema_drift_blocked");

        const unknownAttempt = { taskId: "matrix-unknown-task", attemptId: "matrix-unknown-attempt", fencingToken: 1 };
        startAttempt(unknownAttempt);
        const unknownInput = { ...unknownAttempt, effectKey: "matrix-unknown-effect", stepId: "matrix-unknown-step", idempotencyKey: "matrix-unknown-key" };
        recordUnknownEffect(unknownInput);
        const unknown = recover({ stepId: unknownInput.stepId });
        add("unknown-effect", { effectKey: unknownInput.effectKey, stepId: unknownInput.stepId }, unknown, (result) => result.ok && result.value.status === "unknown_effect" && result.value.recoveryAction === "reconcile_before_retry", "unknown_effect reconcile_before_retry");

        const artifactInput = { fixtureVersion: FIXTURE_VERSION, candidateId: NATIVE_CANDIDATE_ID, payload: { stable: true, ordinal: 9 } };
        const artifactA = artifactSha256(artifactInput);
        const artifactB = artifactSha256({ payload: { ordinal: 9, stable: true }, candidateId: NATIVE_CANDIDATE_ID, fixtureVersion: FIXTURE_VERSION });
        add("artifact-integrity", artifactInput, artifactB, (result) => result.ok && artifactA.ok && result.value.sha256 === artifactA.value.sha256 && safeHash(result.value.sha256), "artifact_hash_deterministic");
      } catch {
        return fail("sqlite_error", "matrix", "matrix_execution_failed");
      }
      const manifestSha256 = manifest.value.manifestSha256;
      const body = {
        schemaVersion: FIXTURE_SCHEMA_VERSION,
        fixtureVersion: FIXTURE_VERSION,
        candidateId: NATIVE_CANDIDATE_ID,
        runtime: RUNTIME_IDENTITY,
        manifestSha256,
        database: DATABASE_RELATIVE_PATH,
        observations: observations.sort((left, right) => OBSERVATION_NAMES.indexOf(left.name) - OBSERVATION_NAMES.indexOf(right.name)),
      };
      return ok({ ...body, matrixSha256: sha256(canonicalJson(body)) });
    }

    const fixture = {
      candidateId: NATIVE_CANDIDATE_ID,
      fixtureVersion: FIXTURE_VERSION,
      runtime: RUNTIME_IDENTITY,
      databaseRelativePath: DATABASE_RELATIVE_PATH,
      manifestSha256: manifest.value.manifestSha256,
      inspect,
      startAttempt,
      advanceFence,
      appendStep,
      checkpoint,
      recover,
      scheduleTimer,
      wakeTimers,
      retryStep,
      cancelStep,
      recordUnknownEffect,
      reconcileUnknownEffect,
      inspectSchema,
      artifactSha256,
      runMatrix,
      reopen,
      close,
      get root() { return root.value; },
    };
    return ok(Object.freeze(fixture));
  } catch {
    return fail("sqlite_error", "fixture", "fixture_initialization_failed");
  }
}

export const createNativeFixture = createNativeStepLedgerFixture;

/** Run the matrix and close the handle while retaining only immutable facts. */
export function runNativeQualificationFixture(options) {
  const created = createNativeStepLedgerFixture(options);
  if (!created.ok) return created;
  const matrix = created.value.runMatrix();
  const closed = created.value.close();
  if (!matrix.ok) return matrix;
  if (!closed.ok) return closed;
  return matrix;
}

export const runFixture = runNativeQualificationFixture;

/** Best-effort cleanup helper for test-owned roots only. */
export function removeFixtureRoot(root) {
  const checked = safePathRoot(root);
  if (!checked.ok) return checked;
  try {
    if (existsSync(checked.value)) rmSync(checked.value, { recursive: true, force: true });
    return ok({ removed: true });
  } catch {
    return fail("invalid_root", "root", "cleanup_failed");
  }
}
