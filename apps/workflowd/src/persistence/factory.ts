import {
  configureNativePragmas,
  loadNativeSqlite,
  readNativePragmas,
  type NativeSqliteConnection,
} from "./native-sqlite.js";
import { reject, rejection, safeDiagnostic } from "./errors.js";
import {
  acquireMigrationLock,
  runMigrationTransaction,
} from "./migration-lock.js";
import {
  validateRuntimeMigrations,
  type RuntimeMigrationManifest,
  type ValidatedRuntimeMigration,
} from "./migrations.js";
import {
  inspectRuntimeSchema,
  type RuntimeSchemaSnapshot,
} from "./schema-inspector.js";
import { createConsistentBackup } from "./backup.js";
import {
  hardenCreatedSidecars,
  prepareRuntimePaths,
  verifyDatabaseIdentity,
  type FileIdentity,
  type PreparedRuntimePaths,
} from "./path-policy.js";
import type {
  RuntimeDatabase,
  RuntimeDatabaseOptions,
  RuntimeOpenResult,
  RuntimePersistenceRejection,
  RuntimeSchemaStatus,
  RuntimeSchemaExtension,
} from "./types.js";

/** Internal handle used by the migration/backup tasks, never package-exported. */
export type RuntimeDatabaseInternal = Readonly<{
  readonly publicHandle: RuntimeDatabase;
  readonly connection: NativeSqliteConnection;
  readonly databasePath: string;
  readonly runtimeRoot: string;
  readonly backupDirectory: string;
  readonly databaseIdentity: FileIdentity;
  readonly sidecars: PreparedRuntimePaths["sidecars"];
  readonly setStatus: (status: RuntimeSchemaStatus) => void;
}>;

function freezeStatus(status: RuntimeSchemaStatus): RuntimeSchemaStatus {
  return Object.freeze({
    mode: status.mode,
    currentVersion: status.currentVersion,
    targetVersion: status.targetVersion,
    manifestSha256: status.manifestSha256,
    journalMode: status.journalMode,
    synchronous: status.synchronous,
    foreignKeys: status.foreignKeys,
    busyTimeout: status.busyTimeout,
    writable: status.writable,
  });
}

function initialStatus(options: RuntimeDatabaseOptions, mode: "read-only" | "read-write", pragmas: ReturnType<typeof readNativePragmas>): RuntimeSchemaStatus {
  let targetVersion: number | null = null;
  try {
    const migrations = options.migrations;
    if (Array.isArray(migrations) && migrations.length > 0) {
      const last = migrations[migrations.length - 1];
      if (last && typeof last.version === "number" && Number.isSafeInteger(last.version)) targetVersion = last.version;
    }
  } catch {
    // T2 performs authoritative manifest validation.  T1 does not trust an
    // accessor/proxy while producing diagnostics.
  }
  return freezeStatus({
    mode,
    currentVersion: 0,
    targetVersion,
    manifestSha256: null,
    journalMode: pragmas.journalMode,
    synchronous: pragmas.synchronous,
    foreignKeys: pragmas.foreignKeys,
    busyTimeout: pragmas.busyTimeout,
    writable: mode !== "read-only",
  });
}

function pathFailure<T>(result: RuntimeOpenResult<T>): RuntimeOpenResult<RuntimeDatabaseInternal> {
  if (result.ok) return result as unknown as RuntimeOpenResult<RuntimeDatabaseInternal>;
  return result;
}

function closeQuietly(connection: NativeSqliteConnection): void {
  try { connection.close(); } catch { /* preserve the original rejection */ }
}

function validateSchemaExtensions(extensions: readonly RuntimeSchemaExtension[]): string | undefined {
  const seenIds = new Set<string>();
  const seenTables = new Set(["workflow_schema_meta", "workflow_migration_history"]);
  let previousVersion = 1;
  for (const extension of extensions) {
    if (extension === null || typeof extension !== "object" || typeof extension.id !== "string" || extension.id.length === 0 || seenIds.has(extension.id)) return "schema_extension_identity_invalid";
    if (!Number.isSafeInteger(extension.migration.version) || extension.migration.version <= previousVersion) return "schema_extension_order_invalid";
    previousVersion = extension.migration.version;
    seenIds.add(extension.id);
    if (!Array.isArray(extension.tables) || extension.tables.length !== extension.migration.statements.length || extension.tables.length === 0) return "schema_extension_manifest_mismatch";
    for (let index = 0; index < extension.tables.length; index += 1) {
      const table = extension.tables[index];
      const statement = extension.migration.statements[index];
      if (!table || typeof table.name !== "string" || !/^[a-z_][a-z0-9_]{0,127}$/.test(table.name) || seenTables.has(table.name) || statement !== table.createSql) return "schema_extension_manifest_mismatch";
      seenTables.add(table.name);
    }
  }
  return undefined;
}

function schemaRejection(
  snapshot: RuntimeSchemaSnapshot | undefined,
  manifest: RuntimeMigrationManifest,
  extensions: readonly RuntimeSchemaExtension[] = [],
): RuntimePersistenceRejection | undefined {
  if (!snapshot) return rejection("schema_corrupt", "schema_preflight_missing");
  if (!snapshot.initialized) {
    if (snapshot.userVersion !== 0 || snapshot.history.length !== 0) {
      return rejection("schema_corrupt", "schema_fresh_state_invalid");
    }
    return undefined;
  }
  if (snapshot.schemaVersion === null || snapshot.manifestSha256 === null || snapshot.schemaDigest === null) {
    return rejection("schema_corrupt", "schema_metadata_missing");
  }
  if (snapshot.schemaVersion > manifest.targetVersion) {
    return rejection("schema_unknown", "schema_newer_than_supported");
  }
  if (snapshot.schemaVersion === manifest.targetVersion && snapshot.manifestSha256 !== manifest.sha256) {
    return rejection("schema_corrupt", "schema_manifest_mismatch");
  }
  if (snapshot.schemaVersion < manifest.targetVersion) {
    // Revalidate only the public three-field migration shape.  The validated
    // internal records carry `migrationSha256`, which is derived metadata and
    // must not become part of the caller-facing manifest digest.
    const prefix = manifest.migrations.slice(0, snapshot.schemaVersion).map(({ version, id, statements }) => ({
      version,
      id,
      statements,
    }));
    const allowedTables = ["workflow_schema_meta", "workflow_migration_history", ...extensions.flatMap((extension) => extension.tables.map((table) => table.name))];
    const prefixValidation = validateRuntimeMigrations(prefix, allowedTables);
    if (!prefixValidation.ok || prefixValidation.value.sha256 !== snapshot.manifestSha256) {
      return rejection("schema_corrupt", "schema_history_prefix_mismatch");
    }
  }
  return undefined;
}

function writeCommittedMetadata(
  connection: NativeSqliteConnection,
  manifest: RuntimeMigrationManifest,
  tail: readonly ValidatedRuntimeMigration[],
): RuntimePersistenceRejection | undefined {
  try {
    for (const migration of tail) {
      connection.prepare(
        "INSERT INTO workflow_migration_history(version, migration_id, migration_sha256) VALUES ($version, $migrationId, $migrationSha256)",
      ).run({
        $version: migration.version,
        $migrationId: migration.id,
        $migrationSha256: migration.migrationSha256,
      });
    }
    connection.prepare(
      "INSERT INTO workflow_schema_meta(singleton_id, schema_version, manifest_sha256) VALUES (1, $schemaVersion, $manifestSha256) ON CONFLICT(singleton_id) DO UPDATE SET schema_version = excluded.schema_version, manifest_sha256 = excluded.manifest_sha256",
    ).run({ $schemaVersion: manifest.targetVersion, $manifestSha256: manifest.sha256 });
    // This is an internal E04 metadata write, never caller-supplied migration
    // SQL.  It is performed only while the migration lock is held.
    connection.exec(`PRAGMA user_version = ${manifest.targetVersion}`);
    return undefined;
  } catch (error) {
    return rejection("migration_failed", safeDiagnostic(error, "schema_metadata_write_failed"));
  }
}

function updateStatusFromSnapshot(
  internal: RuntimeDatabaseInternal,
  snapshot: RuntimeSchemaSnapshot,
  manifest: RuntimeMigrationManifest,
): void {
  internal.setStatus({
    mode: "read-write",
    currentVersion: snapshot.userVersion,
    targetVersion: manifest.targetVersion,
    manifestSha256: manifest.sha256,
    journalMode: "wal",
    synchronous: 2,
    foreignKeys: 1,
    busyTimeout: 5000,
    writable: true,
  });
}

function migrateWritable(
  internal: RuntimeDatabaseInternal,
  manifest: RuntimeMigrationManifest,
  initialSnapshot: RuntimeSchemaSnapshot,
  extensions: readonly RuntimeSchemaExtension[] = [],
): RuntimePersistenceRejection | undefined {
  const initialFailure = schemaRejection(initialSnapshot, manifest, extensions);
  if (initialFailure) return initialFailure;

  const initialVersion = initialSnapshot.initialized ? initialSnapshot.userVersion : 0;
  const initialTail = manifest.migrations.slice(initialVersion);
  let lockedSnapshot: RuntimeSchemaSnapshot | undefined;
  let backupAttempted = false;

  const transaction = runMigrationTransaction(internal.connection, initialTail, {
    reread: (): RuntimePersistenceRejection | undefined => {
      const inspected = inspectRuntimeSchema(internal.connection, extensions);
      if (!inspected.ok) return inspected.rejection;
      lockedSnapshot = inspected.value;
      const failure = schemaRejection(lockedSnapshot, manifest, extensions);
      if (failure) return failure;
      const lockedVersion = lockedSnapshot.initialized ? lockedSnapshot.userVersion : 0;
      if (lockedVersion !== initialVersion) return rejection("migration_failed", "schema_changed_during_startup");
      const tail = manifest.migrations.slice(lockedVersion);
      if (tail.length === 0 || !lockedSnapshot.initialized) return undefined;
      if (backupAttempted) return rejection("backup_failed", "backup_repeated");
      backupAttempted = true;
      const sourceManifestSha256 = lockedSnapshot.manifestSha256;
      const sourceSchemaSha256 = lockedSnapshot.schemaDigest;
      if (sourceManifestSha256 === null || sourceSchemaSha256 === null) {
        return rejection("backup_failed", "backup_source_identity_missing");
      }
      const backup = createConsistentBackup({
        databasePath: internal.databasePath,
        backupDirectory: internal.backupDirectory,
        databaseIdentity: internal.databaseIdentity,
        driver: {
          open: (path, readOnly) => {
            const opened = loadNativeSqlite();
            if (!opened.ok) throw new Error(opened.rejection.code);
            return opened.driver.open(path, readOnly);
          },
        },
        identity: {
          sourceVersion: lockedVersion,
          sourceManifestSha256,
          sourceSchemaSha256,
          targetManifestSha256: manifest.sha256,
        },
        schemaExtensions: extensions,
      });
      return backup.ok ? undefined : backup.rejection;
    },
    validate: (): RuntimePersistenceRejection | undefined => {
      const tail = manifest.migrations.slice(initialVersion);
      const metadataFailure = writeCommittedMetadata(internal.connection, manifest, tail);
      if (metadataFailure) return metadataFailure;
      const inspected = inspectRuntimeSchema(internal.connection, extensions);
      if (!inspected.ok) return inspected.rejection;
      if (!inspected.value.initialized || inspected.value.userVersion !== manifest.targetVersion ||
          inspected.value.manifestSha256 !== manifest.sha256 ||
          inspected.value.history.length !== manifest.migrations.length) {
        return rejection("schema_corrupt", "schema_post_migration_mismatch");
      }
      for (let index = 0; index < manifest.migrations.length; index += 1) {
        const migration = manifest.migrations[index];
        const history = inspected.value.history[index];
        if (!migration || !history || migration.version !== history.version ||
            migration.id !== history.migrationId || migration.migrationSha256 !== history.migrationSha256) {
          return rejection("schema_corrupt", "schema_post_migration_history_mismatch");
        }
      }
      return undefined;
    },
  });
  if (!transaction.ok) return transaction.rejection;
  const final = inspectRuntimeSchema(internal.connection, extensions);
  if (!final.ok) return final.rejection;
  const finalFailure = schemaRejection(final.value, manifest, extensions);
  if (finalFailure || final.value.userVersion !== manifest.targetVersion || final.value.manifestSha256 !== manifest.sha256) {
    return finalFailure ?? rejection("schema_corrupt", "schema_final_mismatch");
  }
  updateStatusFromSnapshot(internal, final.value, manifest);
  return undefined;
}

/**
 * Open the local native SQLite connection after secure path preparation.
 * Later E04 tasks layer migration/schema policy around this internal helper;
 * callers outside this workspace receive only the narrow public handle.
 */
export function openRuntimeDatabaseInternal(
  options: RuntimeDatabaseOptions,
  extension?: RuntimeSchemaExtension | readonly RuntimeSchemaExtension[],
): RuntimeOpenResult<RuntimeDatabaseInternal> {
  const extensions = (extension === undefined
    ? []
    : Array.isArray(extension)
      ? [...(extension as readonly RuntimeSchemaExtension[])]
      : [extension]) as readonly RuntimeSchemaExtension[];
  const extensionFailure = validateSchemaExtensions(extensions);
  if (extensionFailure) return reject("invalid_migration_manifest", extensionFailure);
  const allowedTables = ["workflow_schema_meta", "workflow_migration_history", ...extensions.flatMap((value) => value.tables.map((table) => table.name))];
  const requestedMode = options?.mode === "read-only" ? "read-only" : "read-write";
  let validatedManifest: RuntimeMigrationManifest | undefined;
  if (requestedMode !== "read-only") {
    const validated = validateRuntimeMigrations(options?.migrations, allowedTables);
    if (!validated.ok || validated.value.targetVersion < 1) {
      return reject("invalid_migration_manifest", validated.ok ? "migration_manifest_empty" : validated.rejection.diagnostic);
    }
    validatedManifest = validated.value;
  }
  const paths = prepareRuntimePaths(options);
  if (!paths.ok) return pathFailure(paths);

  const loaded = loadNativeSqlite();
  if (!loaded.ok) return loaded;
  const readOnly = paths.value.mode === "read-only";
  let connection: NativeSqliteConnection;
  try {
    connection = loaded.driver.open(paths.value.databasePath, readOnly);
  } catch (error) {
    return reject("permission_denied", `sqlite_open_failed:${safeDiagnostic(error, "open")}`);
  }

  const changed = verifyDatabaseIdentity(paths.value.databasePath, paths.value.databaseIdentity);
  if (changed) {
    closeQuietly(connection);
    return Object.freeze({ ok: false as const, rejection: changed });
  }

  let pragmas = readNativePragmas(connection);
  if (!readOnly) {
    const configured = configureNativePragmas(connection);
    if (!configured.ok) {
      closeQuietly(connection);
      return configured;
    }
    pragmas = configured.status;
    const hardened = hardenCreatedSidecars(paths.value.sidecars);
    if (!hardened.ok) {
      closeQuietly(connection);
      return hardened;
    }
    const postSidecarRace = verifyDatabaseIdentity(paths.value.databasePath, paths.value.databaseIdentity);
    if (postSidecarRace) {
      closeQuietly(connection);
      return Object.freeze({ ok: false as const, rejection: postSidecarRace });
    }
  }

  let status = initialStatus(options, paths.value.mode, pragmas);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    closeQuietly(connection);
  };
  const inspect = (): RuntimeSchemaStatus => status;
  const setStatus = (nextStatus: RuntimeSchemaStatus): void => {
    if (closed) return;
    status = freezeStatus(nextStatus);
  };
  const publicHandle: RuntimeDatabase = Object.freeze({
    get status(): RuntimeSchemaStatus { return status; },
    close,
    inspect,
  });
  const internal: RuntimeDatabaseInternal = Object.freeze({
    publicHandle,
    connection,
    databasePath: paths.value.databasePath,
    runtimeRoot: paths.value.runtimeRoot,
    backupDirectory: paths.value.backupDirectory,
    databaseIdentity: paths.value.databaseIdentity,
    sidecars: paths.value.sidecars,
    setStatus,
  });
  const initial = inspectRuntimeSchema(connection, extensions);
  if (!initial.ok) {
    if (readOnly) {
      // Read-only diagnostics remain usable even for unknown/corrupt schemas;
      // the rejection is exposed through the bounded status fields only.
      return Object.freeze({ ok: true as const, value: internal });
    }
    closeQuietly(connection);
    return initial;
  }
  if (!readOnly && validatedManifest !== undefined) {
    const migrationFailure = migrateWritable(internal, validatedManifest, initial.value, extensions);
    if (migrationFailure) {
      closeQuietly(connection);
      return Object.freeze({ ok: false as const, rejection: migrationFailure });
    }
  } else if (readOnly) {
    internal.setStatus({
      ...status,
      currentVersion: initial.value.userVersion,
      targetVersion: options?.migrations === undefined ? null : status.targetVersion,
      manifestSha256: initial.value.manifestSha256,
    });
  }
  return Object.freeze({ ok: true as const, value: internal });
}

/** Public factory.  The live native connection remains private to the closure. */
export function openRuntimeDatabase(options: RuntimeDatabaseOptions): RuntimeOpenResult<RuntimeDatabase> {
  const opened = openRuntimeDatabaseInternal(options);
  if (!opened.ok) return opened;
  return Object.freeze({ ok: true as const, value: opened.value.publicHandle });
}
