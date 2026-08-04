import type {
  RuntimeMigration,
  RuntimeSchemaExtension,
  RuntimeSchemaIndex,
  RuntimeSchemaTable,
} from "../persistence/types.js";

const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);

const table: RuntimeSchemaTable = freeze({
  name: "workflow_artifact_registry",
  createSql: "CREATE TABLE workflow_artifact_registry (artifact_id TEXT NOT NULL PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, relative_path TEXT NOT NULL UNIQUE, byte_size INTEGER NOT NULL CHECK (byte_size >= 0), metadata_json TEXT NOT NULL, metadata_hash TEXT NOT NULL, created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0))",
  columns: freeze([
    { name: "artifact_id", type: "TEXT", notnull: 1 as const, pk: 1 },
    { name: "sha256", type: "TEXT", notnull: 1 as const, pk: 0 },
    { name: "relative_path", type: "TEXT", notnull: 1 as const, pk: 0 },
    { name: "byte_size", type: "INTEGER", notnull: 1 as const, pk: 0 },
    { name: "metadata_json", type: "TEXT", notnull: 1 as const, pk: 0 },
    { name: "metadata_hash", type: "TEXT", notnull: 1 as const, pk: 0 },
    { name: "created_at_ms", type: "INTEGER", notnull: 1 as const, pk: 0 },
  ].map((column) => freeze(column))),
  indexes: freeze([
    freeze({ unique: true, columns: ["artifact_id"], origin: "pk" as const }),
    freeze({ unique: true, columns: ["sha256"], origin: "u" as const }),
    freeze({ unique: true, columns: ["relative_path"], origin: "u" as const }),
  ] as readonly RuntimeSchemaIndex[]),
});

const migration: RuntimeMigration = freeze({
  version: 2,
  id: "e07.artifact-registry.1",
  statements: freeze([table.createSql]),
});

/** Static extension consumed only by the E07 artifact facade. */
export const E07_RUNTIME_EXTENSION: RuntimeSchemaExtension = freeze({
  id: "e07-artifact-registry-v1",
  migration,
  tables: freeze([table]),
});

export const E07_RUNTIME_MIGRATION: RuntimeMigration = migration;
