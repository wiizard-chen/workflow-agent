import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { rejection, safeDiagnostic } from "./errors.js";
import { inspectRuntimeSchema } from "./schema-inspector.js";
import {
  loadNativeSqlite,
  type NativeSqliteConnection,
  type NativeSqliteDriver,
} from "./native-sqlite.js";
import type { FileIdentity } from "./path-policy.js";
import type { RuntimePersistenceRejection, RuntimeOpenResult, RuntimeSchemaExtension } from "./types.js";

const BACKUP_MODE = 0o600;
const BACKUP_DIRECTORY_MODE = 0o700;
const NO_FOLLOW = Number(constants.O_NOFOLLOW ?? 0);
const DIRECTORY = Number(constants.O_DIRECTORY ?? 0);
const CURRENT_UID = typeof process.getuid === "function" ? process.getuid() : undefined;
const DIGEST = /^[0-9a-f]{64}$/;
const TEMP_MARKER = ".workflow-backup-";

/** The four values are deliberately all part of the destination identity. */
export type RuntimeBackupIdentity = Readonly<{
  readonly sourceVersion: number;
  readonly sourceManifestSha256: string;
  readonly sourceSchemaSha256: string;
  readonly targetManifestSha256: string;
}>;

export type RuntimeBackupOptions = Readonly<{
  readonly databasePath: string;
  readonly backupDirectory: string;
  readonly identity: RuntimeBackupIdentity;
  /** Optional identity captured by the path preflight. */
  readonly databaseIdentity?: FileIdentity;
  /** Tests may provide a strict fake driver; production uses node:sqlite. */
  readonly driver?: NativeSqliteDriver;
  readonly schemaExtensions?: readonly RuntimeSchemaExtension[];
}>;

export type RuntimeBackup = Readonly<{
  readonly path: string;
  readonly identity: RuntimeBackupIdentity;
  readonly reused: boolean;
}>;

export type RuntimeBackupResult =
  | Readonly<{ readonly ok: true; readonly value: RuntimeBackup }>
  | Readonly<{ readonly ok: false; readonly rejection: RuntimePersistenceRejection }>;

type Stat = Readonly<{
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly mode: number;
  readonly uid: number;
  readonly nlink: number;
  readonly dev: number;
  readonly ino: number;
}>;

function fail(diagnostic: string): RuntimeBackupResult {
  return Object.freeze({ ok: false as const, rejection: rejection("backup_failed", diagnostic) });
}

function pathFail<T>(diagnostic: string): RuntimeOpenResult<T> {
  return Object.freeze({ ok: false as const, rejection: rejection("backup_failed", diagnostic) });
}

function stat(path: string): Stat {
  const value = lstatSync(path, { bigint: false });
  return Object.freeze({
    isFile: value.isFile(),
    isDirectory: value.isDirectory(),
    isSymbolicLink: value.isSymbolicLink(),
    mode: value.mode & 0o7777,
    uid: value.uid,
    nlink: value.nlink,
    dev: value.dev,
    ino: value.ino,
  });
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function identity(value: Stat): FileIdentity {
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

function owner(value: Stat): boolean {
  return CURRENT_UID === undefined || value.uid === CURRENT_UID;
}

function secureFile(path: string, expected?: FileIdentity, allowLinked = false): RuntimeOpenResult<FileIdentity> {
  try {
    const value = stat(path);
    if (!value.isFile || value.isSymbolicLink || (value.nlink !== 1 && !(allowLinked && value.nlink === 2)) || !owner(value)) return pathFail("backup_file_identity_rejected");
    if ((value.mode & 0o077) !== 0 || (value.mode & 0o7000) !== 0 || (value.mode & 0o600) !== 0o600) return pathFail("backup_file_permissions_too_broad");
    const current = identity(value);
    if (expected !== undefined && !sameIdentity(current, expected)) return pathFail("backup_file_identity_changed");
    return Object.freeze({ ok: true as const, value: current });
  } catch (error) {
    return pathFail(`backup_file_unavailable:${safeDiagnostic(error, "lstat")}`);
  }
}

function secureDirectory(path: string, expected?: FileIdentity): RuntimeOpenResult<FileIdentity> {
  try {
    const value = stat(path);
    if (!value.isDirectory || value.isSymbolicLink || !owner(value)) return pathFail("backup_directory_identity_rejected");
    if ((value.mode & 0o077) !== 0 || (value.mode & 0o7000) !== 0 || (value.mode & 0o700) !== 0o700) return pathFail("backup_directory_permissions_too_broad");
    const current = identity(value);
    if (expected !== undefined && !sameIdentity(current, expected)) return pathFail("backup_directory_identity_changed");
    return Object.freeze({ ok: true as const, value: current });
  } catch (error) {
    return pathFail(`backup_directory_unavailable:${safeDiagnostic(error, "lstat")}`);
  }
}

function secureSourceSidecars(path: string): RuntimePersistenceRejection | undefined {
  for (const suffix of ["-wal", "-shm"] as const) {
    const sidecar = `${path}${suffix}`;
    try {
      const value = stat(sidecar);
      if (!value.isFile || value.isSymbolicLink || value.nlink !== 1 || !owner(value)) return rejection("backup_failed", "backup_sidecar_identity_rejected");
      if ((value.mode & 0o077) !== 0 || (value.mode & 0o7000) !== 0 || (value.mode & 0o600) !== 0o600) return rejection("backup_failed", "backup_sidecar_permissions_too_broad");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return rejection("backup_failed", safeDiagnostic(error, "backup_sidecar_unavailable"));
    }
  }
  return undefined;
}

function inside(child: string, parent: string): boolean {
  const value = relative(parent, child);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function validIdentity(value: unknown): value is RuntimeBackupIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Number.isSafeInteger(record.sourceVersion) && (record.sourceVersion as number) > 0 &&
    typeof record.sourceManifestSha256 === "string" && DIGEST.test(record.sourceManifestSha256) &&
    typeof record.sourceSchemaSha256 === "string" && DIGEST.test(record.sourceSchemaSha256) &&
    typeof record.targetManifestSha256 === "string" && DIGEST.test(record.targetManifestSha256);
}

function finalName(value: RuntimeBackupIdentity): string {
  return `workflow-v${value.sourceVersion}-sm${value.sourceManifestSha256}-ss${value.sourceSchemaSha256}-tm${value.targetManifestSha256}.db`;
}

function createTempName(directory: string): string {
  // The final name is deterministic; only the untrusted/interrupted staging
  // name is random.  A random name avoids two concurrent writers sharing a
  // temporary file while preserving deterministic recovery identity.
  return join(directory, `${TEMP_MARKER}${randomBytes(12).toString("hex")}.tmp`);
}

function close(connection: NativeSqliteConnection | undefined): void {
  try { connection?.close(); } catch { /* preserve the primary rejection */ }
}

function rowField(row: unknown, field: string): unknown {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return undefined;
  return (row as Record<string, unknown>)[field];
}

function queryOnly(connection: NativeSqliteConnection): RuntimePersistenceRejection | undefined {
  try {
    // This is a connection-local setting.  It never changes the source
    // database and makes the preflight connection incapable of DML/DDL.
    connection.exec("PRAGMA query_only = ON");
    const value = rowField(connection.prepare("PRAGMA query_only").get(), "query_only");
    if (!(value === 1 || value === 1n)) return rejection("backup_failed", "backup_query_only_readback_mismatch");
    return undefined;
  } catch (error) {
    return rejection("backup_failed", safeDiagnostic(error, "backup_query_only_failed"));
  }
}

function validateContents(connection: NativeSqliteConnection, expected: RuntimeBackupIdentity, extensions: readonly RuntimeSchemaExtension[] = []): RuntimePersistenceRejection | undefined {
  const inspected = inspectRuntimeSchema(connection, extensions);
  if (!inspected.ok) return rejection("backup_failed", `backup_schema_${inspected.rejection.diagnostic}`);
  const snapshot = inspected.value;
  if (!snapshot.initialized || snapshot.schemaVersion !== expected.sourceVersion ||
      snapshot.manifestSha256 !== expected.sourceManifestSha256 ||
      snapshot.schemaDigest !== expected.sourceSchemaSha256) {
    return rejection("backup_failed", "backup_identity_mismatch");
  }
  return undefined;
}

function openAndValidate(path: string, expected: RuntimeBackupIdentity, driver: NativeSqliteDriver, extensions: readonly RuntimeSchemaExtension[] = []): RuntimePersistenceRejection | undefined {
  let connection: NativeSqliteConnection | undefined;
  try {
    connection = driver.open(path, true);
    const queryFailure = queryOnly(connection);
    if (queryFailure) return queryFailure;
    return validateContents(connection, expected, extensions);
  } catch (error) {
    return rejection("backup_failed", safeDiagnostic(error, "backup_reopen_failed"));
  } finally {
    close(connection);
  }
}

function sourcePreflight(path: string, expected: RuntimeBackupIdentity, expectedIdentity: FileIdentity | undefined, driver: NativeSqliteDriver, extensions: readonly RuntimeSchemaExtension[] = []): RuntimePersistenceRejection | undefined {
  const checked = secureFile(path, expectedIdentity);
  if (!checked.ok) return checked.rejection;
  const sidecarFailure = secureSourceSidecars(path);
  if (sidecarFailure) return sidecarFailure;
  let connection: NativeSqliteConnection | undefined;
  try {
    connection = driver.open(path, true);
    const queryFailure = queryOnly(connection);
    if (queryFailure) return queryFailure;
    const schemaFailure = validateContents(connection, expected, extensions);
    if (schemaFailure) return schemaFailure;
    const after = secureFile(path, checked.value);
    if (!after.ok) return after.rejection;
    return secureSourceSidecars(path);
  } catch (error) {
    return rejection("backup_failed", safeDiagnostic(error, "backup_source_read_failed"));
  } finally {
    close(connection);
  }
}

function fsyncFile(path: string): RuntimePersistenceRejection | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    fchmodSync(descriptor, BACKUP_MODE);
    fsyncSync(descriptor);
    return undefined;
  } catch (error) {
    return rejection("backup_failed", safeDiagnostic(error, "backup_file_fsync_failed"));
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* primary failure wins */ }
    }
  }
}

function fsyncDirectory(path: string): RuntimePersistenceRejection | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | DIRECTORY | NO_FOLLOW);
    fsyncSync(descriptor);
    return undefined;
  } catch (error) {
    return rejection("backup_failed", safeDiagnostic(error, "backup_directory_fsync_failed"));
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* primary failure wins */ }
    }
  }
}

function removeTempFiles(directory: string): RuntimePersistenceRejection | undefined {
  let names: readonly string[];
  try { names = readdirSync(directory); } catch (error) {
    return rejection("backup_failed", safeDiagnostic(error, "backup_temp_scan_failed"));
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_MARKER) || !name.endsWith(".tmp")) continue;
    const path = join(directory, name);
    try {
      const value = stat(path);
      // Interrupted files are never authoritative.  They may only be removed
      // after no-follow identity/ownership checks, so a swapped symlink is not
      // followed and a foreign file is not touched.
      if (!value.isFile || value.isSymbolicLink || value.nlink !== 1 || !owner(value) ||
          (value.mode & 0o077) !== 0 || (value.mode & 0o7000) !== 0) {
        return rejection("backup_failed", "backup_temp_identity_rejected");
      }
      unlinkSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return rejection("backup_failed", safeDiagnostic(error, "backup_temp_cleanup_failed"));
    }
  }
  return undefined;
}

/**
 * Create or reuse a crash-safe, digest-addressed backup.
 *
 * The preflight source connection is genuinely read-only and query-only.  A
 * second short-lived connection performs only SQLite's `VACUUM INTO`: Node's
 * DatabaseSync does not expose sqlite3_backup, and SQLite rejects VACUUM INTO
 * on a read-only/query-only connection.  No mutation pragma or arbitrary SQL
 * is issued on that connection; the migration lock held by the caller keeps
 * the committed source snapshot stable while VACUUM copies it.
 */
export function createConsistentBackup(options: RuntimeBackupOptions): RuntimeBackupResult {
  if (options === null || typeof options !== "object" || !validIdentity(options.identity)) return fail("backup_options_invalid");
  if (typeof options.databasePath !== "string" || !isAbsolute(options.databasePath) ||
      typeof options.backupDirectory !== "string" || !isAbsolute(options.backupDirectory)) return fail("backup_path_invalid");
  const source = resolve(options.databasePath);
  const directory = resolve(options.backupDirectory);
  if (source === directory) return fail("backup_path_invalid");
  if (inside(source, directory)) return fail("backup_path_invalid");
  const directoryCheck = secureDirectory(directory);
  if (!directoryCheck.ok) return directoryCheck as RuntimeBackupResult;
  const finalPath = join(directory, finalName(options.identity));
  const finalParent = dirname(finalPath);
  if (finalParent !== directory || !inside(finalPath, directory)) return fail("backup_path_invalid");

  const loaded = options.driver === undefined ? loadNativeSqlite() : Object.freeze({ ok: true as const, driver: options.driver });
  if (!loaded.ok) return loaded;
  const driver = loaded.driver;

  // An already installed file is reusable only after full read-only schema
  // validation, never based on its filename alone.
  try {
    const existing = stat(finalPath);
    if (existing.isSymbolicLink || !existing.isFile || existing.nlink !== 1 || !owner(existing) ||
        (existing.mode & 0o077) !== 0 || (existing.mode & 0o7000) !== 0 || (existing.mode & 0o600) !== 0o600) {
      return fail("backup_conflicting_file");
    }
    const valid = openAndValidate(finalPath, options.identity, driver, options.schemaExtensions);
    if (valid) return Object.freeze({ ok: false as const, rejection: valid });
    return Object.freeze({ ok: true as const, value: Object.freeze({ path: finalPath, identity: options.identity, reused: true }) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail(`backup_final_probe_failed:${safeDiagnostic(error, "lstat")}`);
  }

  const sourceFailure = sourcePreflight(source, options.identity, options.databaseIdentity, driver, options.schemaExtensions);
  if (sourceFailure) return Object.freeze({ ok: false as const, rejection: sourceFailure });
  const beforeDirectory = secureDirectory(directory, directoryCheck.value);
  if (!beforeDirectory.ok) return beforeDirectory as RuntimeBackupResult;
  const cleanupFailure = removeTempFiles(directory);
  if (cleanupFailure) return Object.freeze({ ok: false as const, rejection: cleanupFailure });

  const tempPath = createTempName(directory);
  let tempDescriptor: number | undefined;
  try {
    // VACUUM INTO accepts an existing empty destination.  O_EXCL prevents an
    // attacker or another worker from selecting the staging inode for us.
    tempDescriptor = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NO_FOLLOW, BACKUP_MODE);
    fchmodSync(tempDescriptor, BACKUP_MODE);
    fsyncSync(tempDescriptor);
    closeSync(tempDescriptor);
    tempDescriptor = undefined;
  } catch (error) {
    if (tempDescriptor !== undefined) {
      try { closeSync(tempDescriptor); } catch { /* preserve primary */ }
    }
    try { unlinkSync(tempPath); } catch { /* no secondary error */ }
    return fail(`backup_temp_create_failed:${safeDiagnostic(error, "open")}`);
  }

  let vacuumConnection: NativeSqliteConnection | undefined;
  try {
    const sourceIdentity = secureFile(source, options.databaseIdentity);
    if (!sourceIdentity.ok) return sourceIdentity as RuntimeBackupResult;
    const sidecarBeforeVacuum = secureSourceSidecars(source);
    if (sidecarBeforeVacuum) return Object.freeze({ ok: false as const, rejection: sidecarBeforeVacuum });
    // See the function comment above: this connection is used solely for the
    // driver-native consistent copy operation.  It never enables pragmas or
    // executes caller SQL.
    vacuumConnection = driver.open(source, false);
    const escaped = tempPath.replaceAll("'", "''");
    vacuumConnection.exec(`VACUUM INTO '${escaped}'`);
  } catch (error) {
    return fail(`backup_vacuum_failed:${safeDiagnostic(error, "vacuum_into")}`);
  } finally {
    close(vacuumConnection);
  }

  try {
    const tempIdentity = secureFile(tempPath);
    if (!tempIdentity.ok) return tempIdentity as RuntimeBackupResult;
    const sourceAfter = secureFile(source, options.databaseIdentity);
    if (!sourceAfter.ok) return sourceAfter as RuntimeBackupResult;
    const sidecarAfterVacuum = secureSourceSidecars(source);
    if (sidecarAfterVacuum) return Object.freeze({ ok: false as const, rejection: sidecarAfterVacuum });
    const fileSyncFailure = fsyncFile(tempPath);
    if (fileSyncFailure) return Object.freeze({ ok: false as const, rejection: fileSyncFailure });

    // link(2) is used instead of rename(2) because Node's rename replaces an
    // existing destination.  A same-directory hard-link publishes the fully
    // fsynced inode atomically and fails with EEXIST without replacement.
    try {
      linkSync(tempPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const final = secureFile(finalPath);
        if (!final.ok) return final as RuntimeBackupResult;
        const valid = openAndValidate(finalPath, options.identity, driver, options.schemaExtensions);
        if (valid) return Object.freeze({ ok: false as const, rejection: valid });
        try { unlinkSync(tempPath); } catch { /* final is already authoritative */ }
        return Object.freeze({ ok: true as const, value: Object.freeze({ path: finalPath, identity: options.identity, reused: true }) });
      }
      return fail(`backup_publish_failed:${safeDiagnostic(error, "link")}`);
    }
    const finalIdentity = secureFile(finalPath, undefined, true);
    if (!finalIdentity.ok || !sameIdentity(finalIdentity.value, tempIdentity.value)) return fail("backup_publish_identity_changed");
    const finalSyncFailure = fsyncFile(finalPath);
    if (finalSyncFailure) return Object.freeze({ ok: false as const, rejection: finalSyncFailure });
    const directoryAfterLink = secureDirectory(directory, directoryCheck.value);
    if (!directoryAfterLink.ok) return directoryAfterLink as RuntimeBackupResult;
    const directorySyncFailure = fsyncDirectory(directory);
    if (directorySyncFailure) return Object.freeze({ ok: false as const, rejection: directorySyncFailure });
    try { unlinkSync(tempPath); } catch (error) {
      return fail(`backup_temp_unlink_failed:${safeDiagnostic(error, "unlink")}`);
    }
    const directorySyncAfterCleanup = fsyncDirectory(directory);
    if (directorySyncAfterCleanup) return Object.freeze({ ok: false as const, rejection: directorySyncAfterCleanup });
    const valid = openAndValidate(finalPath, options.identity, driver, options.schemaExtensions);
    if (valid) return Object.freeze({ ok: false as const, rejection: valid });
    return Object.freeze({ ok: true as const, value: Object.freeze({ path: finalPath, identity: options.identity, reused: false }) });
  } finally {
    try { unlinkSync(tempPath); } catch { /* already linked/cleaned or absent */ }
  }
}
