import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, linkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { openRuntimeDatabase } from "@pi-workflow/workflowd";
import { loadNativeSqlite } from "../dist/persistence/native-sqlite.js";

function temporaryRoot(prefix = "workflowd-e04-t1-") {
  return mkdtempSync(join(realpathSync(tmpdir()), prefix));
}

function mode(path) {
  return lstatSync(path).mode & 0o777;
}

function remove(path) {
  rmSync(path, { recursive: true, force: true });
}

const BOOTSTRAP_MIGRATIONS = Object.freeze([Object.freeze({
  version: 1,
  id: "e04.bootstrap.1",
  statements: Object.freeze([
    "CREATE TABLE workflow_schema_meta (singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), schema_version INTEGER NOT NULL, manifest_sha256 TEXT NOT NULL)",
    "CREATE TABLE workflow_migration_history (version INTEGER PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, migration_sha256 TEXT NOT NULL)",
  ]),
})]);

test("importing workflowd has no filesystem side effect", () => {
  const root = temporaryRoot();
  try {
    const before = readdirSync(root);
    const entrypoint = new URL("../dist/index.js", import.meta.url).pathname;
    const source = `import ${JSON.stringify(entrypoint)}; import { readdirSync } from "node:fs"; console.log(JSON.stringify(readdirSync(${JSON.stringify(root)})));`;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(output.trim()), before);
  } finally {
    remove(root);
  }
});

test("fresh explicit root creates only secure runtime paths", () => {
  const root = temporaryRoot();
  try {
    const databasePath = join(root, "workflow.db");
    const result = openRuntimeDatabase({ runtimeRoot: root, databasePath, migrations: BOOTSTRAP_MIGRATIONS });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(readdirSync(root).sort(), ["backups", "workflow.db", "workflow.db-shm", "workflow.db-wal"]);
    assert.equal(mode(root), 0o700);
    assert.equal(mode(join(root, "backups")), 0o700);
    assert.equal(mode(databasePath), 0o600);
    assert.equal(mode(`${databasePath}-wal`), 0o600);
    assert.equal(mode(`${databasePath}-shm`), 0o600);
    assert.equal(result.value.status.journalMode, "wal");
    assert.equal(result.value.status.synchronous, 2);
    assert.equal(result.value.status.foreignKeys, 1);
    assert.equal(result.value.status.busyTimeout, 5000);
    result.value.close();
    result.value.close();
  } finally {
    remove(root);
  }
});

test("symlink and hardlink paths fail closed", () => {
  const root = temporaryRoot();
  const outside = temporaryRoot("workflowd-e04-t1-outside-");
  try {
    const outsideDb = join(outside, "outside.db");
    writeFileSync(outsideDb, "not a database", { mode: 0o600 });
    const linked = join(root, "linked.db");
    linkSync(outsideDb, linked);
    const hardlink = openRuntimeDatabase({ runtimeRoot: root, databasePath: linked, migrations: BOOTSTRAP_MIGRATIONS });
    assert.equal(hardlink.ok, false);
    if (!hardlink.ok) assert.equal(hardlink.rejection.code, "permission_denied");

    const symlink = join(root, "symlink.db");
    symlinkSync(outsideDb, symlink);
    const symbolic = openRuntimeDatabase({ runtimeRoot: root, databasePath: symlink, migrations: BOOTSTRAP_MIGRATIONS });
    assert.equal(symbolic.ok, false);
    if (!symbolic.ok) assert.ok(["invalid_path", "permission_denied"].includes(symbolic.rejection.code));
  } finally {
    remove(root);
    remove(outside);
  }
});

test("read-only opens never create the backup directory", () => {
  const root = temporaryRoot();
  try {
    const databasePath = join(root, "workflow.db");
    const writable = openRuntimeDatabase({ runtimeRoot: root, databasePath, migrations: BOOTSTRAP_MIGRATIONS });
    assert.equal(writable.ok, true);
    if (writable.ok) writable.value.close();
    const backup = join(root, "backups");
    remove(backup);
    const diagnostic = openRuntimeDatabase({ runtimeRoot: root, databasePath, mode: "read-only" });
    assert.equal(diagnostic.ok, true);
    if (!diagnostic.ok) return;
    assert.equal(diagnostic.value.status.mode, "read-only");
    assert.equal(diagnostic.value.status.writable, false);
    assert.equal(existsSync(backup), false);
    diagnostic.value.close();
  } finally {
    remove(root);
  }
});

test("invalid mode and path escape are typed rejections", () => {
  const root = temporaryRoot();
  try {
    const invalidMode = openRuntimeDatabase({ runtimeRoot: root, databasePath: join(root, "db"), mode: "write", migrations: BOOTSTRAP_MIGRATIONS });
    assert.equal(invalidMode.ok, false);
    if (!invalidMode.ok) assert.equal(invalidMode.rejection.code, "invalid_options");
    const escaped = openRuntimeDatabase({ runtimeRoot: root, databasePath: join(dirname(root), "outside.db"), migrations: BOOTSTRAP_MIGRATIONS });
    assert.equal(escaped.ok, false);
    if (!escaped.ok) assert.equal(escaped.rejection.code, "invalid_path");
  } finally {
    remove(root);
  }
});

test("a missing native driver is a typed rejection", () => {
  const result = loadNativeSqlite(() => ({}));
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.rejection, {
    code: "driver_unavailable",
    diagnostic: "node_sqlite_unavailable",
  });
});
