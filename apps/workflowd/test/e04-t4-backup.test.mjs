import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createConsistentBackup } from "../dist/persistence/backup.js";
import { configureNativePragmas, loadNativeSqlite } from "../dist/persistence/native-sqlite.js";
import {
  E04_BOOTSTRAP_SCHEMA_SQL,
  createBootstrapRuntimeMigrations,
  validateRuntimeMigrations,
} from "../dist/persistence/migrations.js";
import { inspectRuntimeSchema } from "../dist/persistence/schema-inspector.js";

function root() { return mkdtempSync(join(tmpdir(), "workflowd-e04-t4-")); }
function remove(path) { rmSync(path, { recursive: true, force: true }); }
function mode(path) { return lstatSync(path).mode & 0o777; }

function fixture() {
  const directory = root();
  const backupDirectory = join(directory, "backups");
  mkdirSync(backupDirectory, { mode: 0o700 });
  const databasePath = join(directory, "workflow.db");
  const loaded = loadNativeSqlite();
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("node:sqlite unavailable");
  const connection = loaded.driver.open(databasePath, false);
  const configured = configureNativePragmas(connection);
  assert.equal(configured.ok, true);
  const manifestResult = validateRuntimeMigrations(createBootstrapRuntimeMigrations());
  assert.equal(manifestResult.ok, true);
  if (!manifestResult.ok) throw new Error("manifest unavailable");
  for (const statement of E04_BOOTSTRAP_SCHEMA_SQL) connection.exec(statement);
  const migration = manifestResult.value.migrations[0];
  connection.prepare("INSERT INTO workflow_schema_meta (singleton_id, schema_version, manifest_sha256) VALUES (1, ?, ?)").run(1, manifestResult.value.sha256);
  connection.prepare("INSERT INTO workflow_migration_history (version, migration_id, migration_sha256) VALUES (?, ?, ?)").run(migration.version, migration.id, migration.migrationSha256);
  connection.exec("PRAGMA user_version = 1");
  const inspected = inspectRuntimeSchema(connection);
  assert.equal(inspected.ok, true);
  if (!inspected.ok) throw new Error("fixture schema unavailable");
  chmodSync(databasePath, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${databasePath}${suffix}`)) chmodSync(`${databasePath}${suffix}`, 0o600);
  }
  return { directory, backupDirectory, databasePath, connection, driver: loaded.driver, manifest: manifestResult.value, schema: inspected.value };
}

function identity(fixtureValue) {
  return {
    sourceVersion: fixtureValue.schema.schemaVersion,
    sourceManifestSha256: fixtureValue.schema.manifestSha256,
    sourceSchemaSha256: fixtureValue.schema.schemaDigest,
    targetManifestSha256: "f".repeat(64),
  };
}

test("VACUUM INTO backup preserves WAL-committed state and four-part identity", () => {
  const value = fixture();
  try {
    // Leave the source connection open so the row remains in the WAL while
    // the independent backup source reads the committed snapshot.
    value.connection.prepare("CREATE TABLE workflow_backup_probe (value TEXT)").run();
    // The E04 inspector intentionally rejects non-bootstrap tables; this
    // probe is rolled back before obtaining the expected source digest.
    value.connection.exec("DROP TABLE workflow_backup_probe");
    const result = createConsistentBackup({
      databasePath: value.databasePath,
      backupDirectory: value.backupDirectory,
      identity: identity(value),
      driver: value.driver,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.reused, false);
    assert.equal(mode(result.value.path), 0o600);
    assert.deepEqual(readdirSync(value.backupDirectory).filter((name) => name.endsWith(".tmp")), []);
    const backup = value.driver.open(result.value.path, true);
    const inspected = inspectRuntimeSchema(backup);
    assert.equal(inspected.ok, true);
    if (inspected.ok) {
      assert.equal(inspected.value.schemaVersion, value.schema.schemaVersion);
      assert.equal(inspected.value.manifestSha256, value.schema.manifestSha256);
      assert.equal(inspected.value.schemaDigest, value.schema.schemaDigest);
    }
    const row = backup.prepare("SELECT schema_version, manifest_sha256 FROM workflow_schema_meta WHERE singleton_id = 1").get();
    assert.equal(row.schema_version, 1);
    assert.equal(row.manifest_sha256, value.schema.manifestSha256);
    backup.close();
  } finally {
    value.connection.close();
    remove(value.directory);
  }
});

test("same identity reopens and reuses an already validated backup", () => {
  const value = fixture();
  try {
    const options = {
      databasePath: value.databasePath,
      backupDirectory: value.backupDirectory,
      identity: identity(value),
      driver: value.driver,
    };
    const first = createConsistentBackup(options);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = createConsistentBackup(options);
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.value.reused, true);
      assert.equal(second.value.path, first.value.path);
    }
  } finally {
    value.connection.close();
    remove(value.directory);
  }
});

test("stale staging files are cleaned only after no-follow checks", () => {
  const value = fixture();
  try {
    const stale = join(value.backupDirectory, ".workflow-backup-stale.tmp");
    writeFileSync(stale, "interrupted", { mode: 0o600 });
    const result = createConsistentBackup({
      databasePath: value.databasePath,
      backupDirectory: value.backupDirectory,
      identity: identity(value),
      driver: value.driver,
    });
    assert.equal(result.ok, true);
    assert.equal(existsSync(stale), false);
  } finally {
    value.connection.close();
    remove(value.directory);
  }
});

test("a conflicting final backup fails closed instead of replacing it", () => {
  const value = fixture();
  try {
    const expected = identity(value);
    const final = join(value.backupDirectory, `workflow-v${expected.sourceVersion}-sm${expected.sourceManifestSha256}-ss${expected.sourceSchemaSha256}-tm${expected.targetManifestSha256}.db`);
    writeFileSync(final, "tampered", { mode: 0o600 });
    const result = createConsistentBackup({
      databasePath: value.databasePath,
      backupDirectory: value.backupDirectory,
      identity: expected,
      driver: value.driver,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "backup_failed");
    assert.equal(mode(final), 0o600);
  } finally {
    value.connection.close();
    remove(value.directory);
  }
});

test("unsafe WAL/SHM sidecars fail closed before a backup is published", () => {
  const value = fixture();
  try {
    const sidecar = `${value.databasePath}-wal`;
    if (!existsSync(sidecar)) return;
    chmodSync(sidecar, 0o644);
    const result = createConsistentBackup({
      databasePath: value.databasePath,
      backupDirectory: value.backupDirectory,
      identity: identity(value),
      driver: value.driver,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "backup_failed");
    assert.deepEqual(readdirSync(value.backupDirectory), []);
  } finally {
    value.connection.close();
    remove(value.directory);
  }
});
