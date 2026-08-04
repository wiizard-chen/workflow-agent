/**
 * The persistence contract intentionally contains no SQLite types.  The
 * native adapter is kept behind the factory so callers cannot obtain a live
 * DatabaseSync object or use the package as an arbitrary SQL executor.
 */

export type RuntimeOpenMode = "read-only" | "read-write";

export type RuntimeMigration = Readonly<{
  readonly version: number;
  readonly id: string;
  readonly statements: readonly string[];
}>;

export type RuntimeSchemaIndex = Readonly<{
  readonly unique: boolean;
  readonly columns: readonly string[];
  readonly origin: "pk" | "u";
}>;

export type RuntimeSchemaForeignKey = Readonly<{
  readonly from: readonly string[];
  readonly table: string;
  readonly to: readonly string[];
}>;

export type RuntimeSchemaColumn = Readonly<{
  readonly name: string;
  readonly type: string;
  readonly notnull: 0 | 1;
  readonly pk: number;
}>;

/** Internal, statically registered schema ownership; never accepted from the public factory. */
export type RuntimeSchemaTable = Readonly<{
  readonly name: string;
  readonly createSql: string;
  readonly columns: readonly RuntimeSchemaColumn[];
  readonly indexes: readonly RuntimeSchemaIndex[];
  readonly foreignKeys?: readonly RuntimeSchemaForeignKey[];
}>;

export type RuntimeSchemaExtension = Readonly<{
  readonly id: string;
  readonly migration: RuntimeMigration;
  readonly tables: readonly RuntimeSchemaTable[];
}>;

export type RuntimeDatabaseOptions = Readonly<{
  readonly databasePath: string;
  readonly runtimeRoot: string;
  readonly backupDirectory?: string;
  readonly mode?: RuntimeOpenMode;
  readonly migrations?: readonly RuntimeMigration[];
}>;

export type RuntimePersistenceRejectionCode =
  | "invalid_options"
  | "invalid_path"
  | "permission_denied"
  | "driver_unavailable"
  | "invalid_migration_manifest"
  | "schema_corrupt"
  | "schema_unknown"
  | "migration_locked"
  | "backup_failed"
  | "migration_failed"
  | "read_only"
  | "pragma_failed";

export type RuntimePersistenceRejection = Readonly<{
  readonly code: RuntimePersistenceRejectionCode;
  /** A stable, secret-free diagnostic suitable for logs and tests. */
  readonly diagnostic: string;
}>;

export type RuntimeSchemaStatus = Readonly<{
  readonly mode: RuntimeOpenMode;
  readonly currentVersion: number;
  readonly targetVersion: number | null;
  readonly manifestSha256: string | null;
  readonly journalMode: "wal" | "unknown";
  readonly synchronous: 2 | "unknown";
  readonly foreignKeys: 1 | "unknown";
  readonly busyTimeout: 5000 | "unknown";
  readonly writable: boolean;
}>;

export type RuntimeDatabase = Readonly<{
  readonly status: RuntimeSchemaStatus;
  readonly close: () => void;
  readonly inspect: () => RuntimeSchemaStatus;
}>;

export type RuntimeOpenResult<T = RuntimeDatabase> =
  | Readonly<{ readonly ok: true; readonly value: T }>
  | Readonly<{ readonly ok: false; readonly rejection: RuntimePersistenceRejection }>;
