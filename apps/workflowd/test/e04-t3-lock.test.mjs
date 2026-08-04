import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireMigrationLock,
  runMigrationTransaction,
  validateMigrationSql,
} from "../dist/persistence/migration-lock.js";

function fakeConnection({ readOnly = false, failOn = undefined } = {}) {
  const calls = [];
  const connection = {
    path: ":memory:",
    readOnly,
    calls,
    exec(sql) {
      calls.push(sql);
      if (failOn && sql === failOn) throw failOn === "BEGIN IMMEDIATE"
        ? Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
        : new Error("statement failed");
    },
    prepare(sql) {
      return {
        get() {
          if (sql === "PRAGMA journal_mode") return { journal_mode: "wal" };
          if (sql === "PRAGMA synchronous") return { synchronous: 2 };
          if (sql === "PRAGMA foreign_keys") return { foreign_keys: 1 };
          if (sql === "PRAGMA busy_timeout") return { timeout: 5000 };
          return {};
        },
        all() { return []; },
        run() { return {}; },
      };
    },
    close() {},
  };
  return connection;
}

test("migration SQL denies transaction, pragma, attach, and extension effects", () => {
  for (const sql of [
    "PRAGMA user_version",
    "ATTACH DATABASE 'outside.db' AS outside",
    "BEGIN IMMEDIATE",
    "SELECT load_extension('evil')",
    "/* comment */ SAVEPOINT nested",
  ]) {
    assert.equal(validateMigrationSql(sql)?.code, "invalid_migration_manifest");
  }
  assert.equal(validateMigrationSql("CREATE TABLE workflow_schema_meta (singleton_id INTEGER)"), undefined);
  assert.equal(validateMigrationSql("INSERT INTO workflow_schema_meta VALUES (1) -- ATTACH is data"), undefined);
  assert.equal(validateMigrationSql("CREATE TABLE pragmatic (value TEXT)"), undefined);
});
test("BEGIN IMMEDIATE lock maps SQLite busy to typed migration_locked", () => {
  const connection = fakeConnection({ failOn: "BEGIN IMMEDIATE" });
  const result = acquireMigrationLock(connection);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.rejection, {
    code: "migration_locked",
    diagnostic: "migration_lock_busy",
  });
  assert.deepEqual(connection.calls, ["BEGIN IMMEDIATE"]);
});

test("read-only connections cannot acquire a migration lock", () => {
  const connection = fakeConnection({ readOnly: true });
  const result = acquireMigrationLock(connection);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.rejection.code, "read_only");
  assert.deepEqual(connection.calls, []);
});

test("migration statements run in order and rollback on failure", () => {
  const connection = fakeConnection({ failOn: "SELECT fail" });
  const result = runMigrationTransaction(connection, [
    { version: 1, id: "one", statements: ["CREATE TABLE workflow_schema_meta (singleton_id INTEGER)", "SELECT fail"] },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.rejection.code, "migration_failed");
  assert.deepEqual(connection.calls, [
    "BEGIN IMMEDIATE",
    "CREATE TABLE workflow_schema_meta (singleton_id INTEGER)",
    "SELECT fail",
    "ROLLBACK",
  ]);
});

test("migration lock commits only after the ordered transaction succeeds", () => {
  const connection = fakeConnection();
  const result = runMigrationTransaction(connection, [
    { version: 1, id: "one", statements: ["CREATE TABLE workflow_schema_meta (singleton_id INTEGER)"] },
    { version: 2, id: "two", statements: ["INSERT INTO workflow_schema_meta VALUES (1)"] },
  ], {
    reread: () => undefined,
    validate: () => undefined,
  });
  assert.deepEqual(result, { ok: true, value: true });
  assert.deepEqual(connection.calls, [
    "BEGIN IMMEDIATE",
    "CREATE TABLE workflow_schema_meta (singleton_id INTEGER)",
    "INSERT INTO workflow_schema_meta VALUES (1)",
    "COMMIT",
  ]);
});
