import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  E04_BOOTSTRAP_SCHEMA_SQL,
  createBootstrapRuntimeMigrations,
  validateRuntimeMigrations,
} from "../dist/persistence/migrations.js";
import {
  inspectRuntimeSchema,
  validateRuntimeSchema,
} from "../dist/persistence/schema-inspector.js";
import { loadNativeSqlite } from "../dist/persistence/native-sqlite.js";

function root() { return mkdtempSync(join(tmpdir(), "workflowd-e04-t2-")); }
function openDatabase(path, readOnly = false) {
  const loaded = loadNativeSqlite();
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("node:sqlite unavailable");
  return loaded.driver.open(path, readOnly);
}
function remove(path) { rmSync(path, { recursive: true, force: true }); }

test("migration validation is canonical, deeply frozen, and key-order independent", () => {
  const first = [{ id: "one", statements: ["CREATE TABLE workflow_schema_meta (singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), schema_version INTEGER NOT NULL, manifest_sha256 TEXT NOT NULL)"], version: 1 }];
  const second = [{ version: 1, statements: [...first[0].statements], id: "one" }];
  const a = validateRuntimeMigrations(first);
  const b = validateRuntimeMigrations(second);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.value.canonical, b.value.canonical);
  assert.equal(a.value.sha256, b.value.sha256);
  assert.equal(Object.isFrozen(a.value), true);
  assert.equal(Object.isFrozen(a.value.migrations), true);
  assert.equal(Object.isFrozen(a.value.migrations[0]), true);
  assert.equal(Object.isFrozen(a.value.migrations[0].statements), true);
  assert.notEqual(a.value.migrations[0], first[0]);
});
test("migration validation rejects ordering, malformed SQL, unknown objects, and transaction controls", () => {
  const cases = [
    [{ version: 2, id: "two", statements: ["SELECT 1"] }],
    [{ version: 1, id: "one", statements: [] }],
    [{ version: 1, id: "one", statements: ["PRAGMA user_version = 1"] }],
    [{ version: 1, id: "one", statements: ["CREATE TABLE e05_commands (id TEXT)"] }],
    [{ version: 1, id: "one", statements: ["BEGIN"] }],
    [{ version: 1, id: "one", statements: ["ATTACH DATABASE 'x' AS other"] }],
    [{ version: 1, id: "one", statements: ["CREATE TABLE workflow_schema_meta (x TEXT); INSERT INTO workflow_schema_meta VALUES ('x')"] }],
  ];
  for (const input of cases) {
    const result = validateRuntimeMigrations(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "invalid_migration_manifest");
  }
});

test("bootstrap helper contains only the exact E04 metadata SQL", () => {
  const manifest = validateRuntimeMigrations(createBootstrapRuntimeMigrations());
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  assert.deepEqual(manifest.value.migrations[0].statements, E04_BOOTSTRAP_SCHEMA_SQL);
  assert.equal(manifest.value.targetVersion, 1);
});

test("schema inspector validates metadata, history, constraints, and digest", () => {
  const directory = root();
  const path = join(directory, "runtime.db");
  const connection = openDatabase(path);
  const manifestResult = validateRuntimeMigrations(createBootstrapRuntimeMigrations());
  assert.equal(manifestResult.ok, true);
  if (!manifestResult.ok) return;
  connection.exec("PRAGMA journal_mode = WAL");
  for (const statement of E04_BOOTSTRAP_SCHEMA_SQL) connection.exec(statement);
  const migration = manifestResult.value.migrations[0];
  connection.prepare("INSERT INTO workflow_schema_meta (singleton_id, schema_version, manifest_sha256) VALUES (1, ?, ?)").run(1, manifestResult.value.sha256);
  connection.prepare("INSERT INTO workflow_migration_history (version, migration_id, migration_sha256) VALUES (?, ?, ?)").run(migration.version, migration.id, migration.migrationSha256);
  connection.exec("PRAGMA user_version = 1");
  const inspected = inspectRuntimeSchema(connection);
  assert.equal(inspected.ok, true);
  if (inspected.ok) {
    assert.equal(inspected.value.initialized, true);
    assert.equal(inspected.value.userVersion, 1);
    assert.equal(inspected.value.schemaVersion, 1);
    assert.equal(inspected.value.manifestSha256, manifestResult.value.sha256);
    assert.equal(inspected.value.history[0].migrationId, migration.id);
    assert.equal(inspected.value.schemaDigest?.length, 64);
  }
  const validated = validateRuntimeSchema(connection, manifestResult.value);
  assert.equal(validated.ok, true);
  connection.close();
  remove(directory);
});

test("schema inspector distinguishes fresh, unknown, and corrupt state", () => {
  const directory = root();
  const freshPath = join(directory, "fresh.db");
  const fresh = openDatabase(freshPath);
  const freshResult = inspectRuntimeSchema(fresh);
  assert.equal(freshResult.ok, true);
  if (freshResult.ok) assert.equal(freshResult.value.initialized, false);
  fresh.close();

  const unknownPath = join(directory, "unknown.db");
  const unknown = openDatabase(unknownPath);
  unknown.exec("CREATE TABLE e05_commands (id TEXT)");
  const unknownResult = inspectRuntimeSchema(unknown);
  assert.equal(unknownResult.ok, false);
  if (!unknownResult.ok) assert.equal(unknownResult.rejection.code, "schema_unknown");
  unknown.close();

  const corruptPath = join(directory, "corrupt.db");
  const corrupt = openDatabase(corruptPath);
  corrupt.exec("CREATE TABLE workflow_schema_meta (singleton_id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, manifest_sha256 TEXT NOT NULL)");
  corrupt.exec("CREATE TABLE workflow_migration_history (version INTEGER PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, migration_sha256 TEXT NOT NULL)");
  corrupt.exec("PRAGMA user_version = 1");
  const corruptResult = inspectRuntimeSchema(corrupt);
  assert.equal(corruptResult.ok, false);
  if (!corruptResult.ok) assert.equal(corruptResult.rejection.code, "schema_corrupt");
  corrupt.close();
  remove(directory);
});
