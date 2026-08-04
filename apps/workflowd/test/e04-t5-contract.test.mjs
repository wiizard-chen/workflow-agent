import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { openRuntimeDatabase } from "@pi-workflow/workflowd";
import { loadNativeSqlite } from "../dist/persistence/native-sqlite.js";

const BOOTSTRAP_STATEMENTS = Object.freeze([
  "CREATE TABLE workflow_schema_meta (singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), schema_version INTEGER NOT NULL, manifest_sha256 TEXT NOT NULL)",
  "CREATE TABLE workflow_migration_history (version INTEGER PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, migration_sha256 TEXT NOT NULL)",
]);

const V1 = Object.freeze([Object.freeze({
  version: 1,
  id: "e04.bootstrap.1",
  statements: BOOTSTRAP_STATEMENTS,
})]);

const V2 = Object.freeze([
  ...V1,
  Object.freeze({
    version: 2,
    id: "e04.bootstrap.2",
    statements: Object.freeze(["UPDATE workflow_schema_meta SET schema_version = schema_version"]),
  }),
]);

const BAD_V2 = Object.freeze([
  ...V1,
  Object.freeze({
    version: 2,
    id: "e04.bad.2",
    statements: Object.freeze(["UPDATE workflow_schema_meta SET missing_column = 1"]),
  }),
]);

function root(prefix = "workflowd-e04-t5-") {
  return mkdtempSync(join(realpathSync(tmpdir()), prefix));
}

function close(result) {
  if (result.ok) result.value.close();
}

function open(rootPath, migrations, mode = undefined) {
  return openRuntimeDatabase({
    runtimeRoot: rootPath,
    databasePath: join(rootPath, "workflow.db"),
    migrations,
    ...(mode === undefined ? {} : { mode }),
  });
}

test("fresh bootstrap and current reopen are idempotent and side-effect bounded", () => {
  const rootPath = root();
  try {
    const first = open(rootPath, V1);
    assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.rejection));
    if (!first.ok) return;
    assert.equal(first.value.status.currentVersion, 1);
    first.value.close();
    assert.deepEqual(readdirSync(join(rootPath, "backups")), []);

    const second = open(rootPath, V1);
    assert.equal(second.ok, true, second.ok ? "" : JSON.stringify(second.rejection));
    if (!second.ok) return;
    assert.equal(second.value.status.manifestSha256, first.value?.status?.manifestSha256 ?? second.value.status.manifestSha256);
    second.value.close();
    assert.deepEqual(readdirSync(join(rootPath, "backups")), []);
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
  }
});

test("schema upgrade creates one four-part, read-only reopenable backup", () => {
  const rootPath = root();
  try {
    close(open(rootPath, V1));
    const upgraded = open(rootPath, V2);
    assert.equal(upgraded.ok, true, upgraded.ok ? "" : JSON.stringify(upgraded.rejection));
    if (!upgraded.ok) return;
    assert.equal(upgraded.value.status.currentVersion, 2);
    upgraded.value.close();
    const backups = readdirSync(join(rootPath, "backups"));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^workflow-v1-sm[0-9a-f]{64}-ss[0-9a-f]{64}-tm[0-9a-f]{64}\.db$/);
    assert.equal(lstatSync(join(rootPath, "backups", backups[0])).mode & 0o777, 0o600);

    const loaded = loadNativeSqlite();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const backup = loaded.driver.open(join(rootPath, "backups", backups[0]), true);
    assert.equal(Number(backup.prepare("PRAGMA user_version").get().user_version), 1);
    assert.equal(Number(backup.prepare("SELECT count(*) AS count FROM workflow_migration_history").get().count), 1);
    backup.close();
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
  }
});

test("runtime migration failure rolls back and preserves the prior version", () => {
  const rootPath = root();
  try {
    close(open(rootPath, V1));
    const failed = open(rootPath, BAD_V2);
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.rejection.code, "migration_failed");
    const retry = open(rootPath, V1);
    assert.equal(retry.ok, true, retry.ok ? "" : JSON.stringify(retry.rejection));
    if (retry.ok) {
      assert.equal(retry.value.status.currentVersion, 1);
      retry.value.close();
    }
    assert.equal(readdirSync(join(rootPath, "backups")).length, 1);
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
  }
});

test("read-only diagnostics do not create backups or acquire a migration lock", () => {
  const rootPath = root();
  try {
    close(open(rootPath, V1));
    rmSync(join(rootPath, "backups"), { recursive: true, force: true });
    const diagnostic = open(rootPath, undefined, "read-only");
    assert.equal(diagnostic.ok, true, diagnostic.ok ? "" : JSON.stringify(diagnostic.rejection));
    if (!diagnostic.ok) return;
    assert.equal(diagnostic.value.status.mode, "read-only");
    assert.equal(diagnostic.value.status.writable, false);
    assert.equal(existsSync(join(rootPath, "backups")), false);
    diagnostic.value.close();
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
  }
});

test("public workflowd runtime surface exposes no native handle or deep export", async () => {
  const entry = await import("@pi-workflow/workflowd");
  assert.deepEqual(Object.keys(entry), ["LEASE_RESOURCE_KINDS", "createWorkflowClient", "createWorkflowDaemon", "openArtifactStore", "openCommandJournal", "openLeaseStore", "openRuntimeDatabase", "openStepLedger"]);
  assert.equal("DatabaseSync" in entry, false);
  assert.equal("connection" in entry, false);
  const entrypoint = new URL("../dist/index.js", import.meta.url).pathname;
  assert.equal(dirname(entrypoint).endsWith("/dist"), true);
});
