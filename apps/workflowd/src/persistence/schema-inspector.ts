import { createHash } from "node:crypto";

import { rejection } from "./errors.js";
import {
  E04_BOOTSTRAP_TABLES,
  type RuntimeMigrationManifest,
  type ValidatedRuntimeMigration,
} from "./migrations.js";
import type { NativeSqliteConnection } from "./native-sqlite.js";
import type {
  RuntimePersistenceRejection,
  RuntimeSchemaExtension,
  RuntimeSchemaTable,
} from "./types.js";

const META_TABLE = "workflow_schema_meta";
const HISTORY_TABLE = "workflow_migration_history";

type Row = Readonly<Record<string, unknown>>;

export type RuntimeMigrationHistoryRecord = Readonly<{
  readonly version: number;
  readonly migrationId: string;
  readonly migrationSha256: string;
}>;

export type RuntimeSchemaSnapshot = Readonly<{
  /** False only for a new zero-byte SQLite database. */
  readonly initialized: boolean;
  readonly userVersion: number;
  readonly schemaVersion: number | null;
  readonly manifestSha256: string | null;
  readonly history: readonly RuntimeMigrationHistoryRecord[];
  readonly highestHistoryVersion: number;
  readonly schemaDigest: string | null;
  readonly tables: readonly string[];
}>;

export type RuntimeSchemaInspection =
  | Readonly<{ readonly ok: true; readonly value: RuntimeSchemaSnapshot }>
  | Readonly<{ readonly ok: false; readonly rejection: RuntimePersistenceRejection }>;

export type SchemaValidationResult =
  | Readonly<{ readonly ok: true; readonly value: RuntimeSchemaSnapshot }>
  | Readonly<{ readonly ok: false; readonly rejection: RuntimePersistenceRejection }>;

function fail(code: "schema_corrupt" | "schema_unknown", diagnostic: string): RuntimeSchemaInspection {
  return Object.freeze({ ok: false as const, rejection: rejection(code, diagnostic) });
}

function row(value: unknown): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("row_invalid");
  return value as Row;
}

function field(value: Row, key: string): unknown {
  return value[key];
}

function integer(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") ? value : undefined;
}

function scalar(connection: NativeSqliteConnection, sql: string, key: string): unknown {
  return field(row(connection.prepare(sql).get()), key);
}

function normalizeSql(sql: string): string {
  return sql
    .replaceAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g, "$1")
    .replaceAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g, "$1")
    .replaceAll(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, "$1")
    .replaceAll(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function readSqliteObjects(connection: NativeSqliteConnection): readonly Row[] {
  return Object.freeze(connection.prepare(
    "SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all().map((value) => row(value)));
}

function bootstrapTable(table: string): RuntimeSchemaTable {
  if (table === META_TABLE) return Object.freeze({
    name: META_TABLE,
    createSql: expectedCreateSql(table),
    columns: Object.freeze([
      Object.freeze({ name: "singleton_id", type: "INTEGER", notnull: 0, pk: 1 }),
      Object.freeze({ name: "schema_version", type: "INTEGER", notnull: 1, pk: 0 }),
      Object.freeze({ name: "manifest_sha256", type: "TEXT", notnull: 1, pk: 0 }),
    ]),
    indexes: Object.freeze([]),
  });
  return Object.freeze({
    name: HISTORY_TABLE,
    createSql: expectedCreateSql(table),
    columns: Object.freeze([
      Object.freeze({ name: "version", type: "INTEGER", notnull: 0, pk: 1 }),
      Object.freeze({ name: "migration_id", type: "TEXT", notnull: 1, pk: 0 }),
      Object.freeze({ name: "migration_sha256", type: "TEXT", notnull: 1, pk: 0 }),
    ]),
    indexes: Object.freeze([{ unique: true, columns: Object.freeze(["migration_id"]), origin: "u" as const }]),
  });
}

function expectedCreateSql(table: string): string {
  if (table === META_TABLE) return "create table workflow_schema_meta (singleton_id integer primary key check (singleton_id = 1), schema_version integer not null, manifest_sha256 text not null)";
  return "create table workflow_migration_history (version integer primary key, migration_id text not null unique, migration_sha256 text not null)";
}

function expectedTable(table: string, extensions: readonly RuntimeSchemaExtension[]): RuntimeSchemaTable | undefined {
  if (table === META_TABLE || table === HISTORY_TABLE) return bootstrapTable(table);
  for (const extension of extensions) for (const descriptor of extension.tables) if (descriptor.name === table) return descriptor;
  return undefined;
}

function activeExtensions(extensions: readonly RuntimeSchemaExtension[], userVersion: number): readonly RuntimeSchemaExtension[] {
  return extensions.filter((extension) => extension.migration.version <= userVersion);
}

function inspectColumns(connection: NativeSqliteConnection, descriptor: RuntimeSchemaTable): void {
  const table = descriptor.name;
  const rows = connection.prepare(`PRAGMA table_info('${table}')`).all().map((value) => row(value));
  const expected = descriptor.columns;
  if (rows.length !== expected.length) throw new Error("schema_columns_mismatch");
  rows.forEach((value, index) => {
    const wanted = expected[index];
    if (!wanted) throw new Error("schema_columns_mismatch");
    const name = text(field(value, "name"));
    const type = text(field(value, "type"));
    const notnull = integer(field(value, "notnull"));
    const pk = integer(field(value, "pk"));
    if (name !== wanted.name || type?.toUpperCase() !== wanted.type || notnull !== wanted.notnull || pk !== wanted.pk) {
      throw new Error("schema_columns_mismatch");
    }
    // A NOT NULL column with a generated/default value is not the E04 exact
    // schema.  Defaults would permit metadata that was never committed by the
    // migration runner.
    if (field(value, "dflt_value") !== null && field(value, "dflt_value") !== undefined) throw new Error("schema_default_mismatch");
  });
}

function inspectIndexes(connection: NativeSqliteConnection, descriptor: RuntimeSchemaTable): void {
  const table = descriptor.name;
  const rows = connection.prepare(`PRAGMA index_list('${table}')`).all().map((value) => row(value));
  const actual = rows.map((index) => {
    const name = text(field(index, "name"));
    if (!name) throw new Error("schema_index_mismatch");
    const columns = connection.prepare(`PRAGMA index_info('${name.replaceAll("'", "''")}')`).all().map((value) => row(value));
    return { unique: integer(field(index, "unique")) === 1, origin: text(field(index, "origin")), columns: columns.map((value) => text(field(value, "name")) ?? "") };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const expected = descriptor.indexes.map((index) => ({ unique: index.unique, origin: index.origin, columns: [...index.columns] })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("schema_index_mismatch");
}

function inspectForeignKeys(connection: NativeSqliteConnection, descriptor: RuntimeSchemaTable): void {
  const rows = connection.prepare(`PRAGMA foreign_key_list('${descriptor.name}')`).all().map((value) => row(value));
  const actual = rows.map((value) => ({ from: [text(field(value, "from")) ?? ""], table: text(field(value, "table")) ?? "", to: [text(field(value, "to")) ?? ""] })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const expected = (descriptor.foreignKeys ?? []).map((value) => ({ from: [...value.from], table: value.table, to: [...value.to] })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("schema_foreign_key_mismatch");
}

function canonicalSchema(
  userVersion: number,
  schemaVersion: number,
  manifestSha256: string,
  history: readonly RuntimeMigrationHistoryRecord[],
  extensions: readonly RuntimeSchemaExtension[],
): string {
  const baseTables = [
      { name: META_TABLE, columns: [
        { name: "singleton_id", type: "INTEGER", notnull: 0, pk: 1 },
        { name: "schema_version", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "manifest_sha256", type: "TEXT", notnull: 1, pk: 0 },
      ], constraints: ["singleton_id = 1"] },
      { name: HISTORY_TABLE, columns: [
        { name: "version", type: "INTEGER", notnull: 0, pk: 1 },
        { name: "migration_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "migration_sha256", type: "TEXT", notnull: 1, pk: 0 },
      ], constraints: ["migration_id unique"] },
    ];
  const extensionTables = extensions.flatMap((extension) => extension.tables.map((table) => ({
    name: table.name,
    createSql: normalizeSql(table.createSql),
    columns: table.columns,
    indexes: table.indexes,
    foreignKeys: table.foreignKeys ?? [],
  })));
  return JSON.stringify({
    tables: extensions.length === 0 ? baseTables : [...baseTables, ...extensionTables],
    userVersion,
    schemaVersion,
    manifestSha256,
    history,
  });
}

function readHistory(connection: NativeSqliteConnection): readonly RuntimeMigrationHistoryRecord[] {
  const rows = connection.prepare("SELECT version, migration_id, migration_sha256 FROM workflow_migration_history ORDER BY version ASC").all().map((value) => row(value));
  const result: RuntimeMigrationHistoryRecord[] = [];
  let expected = 1;
  const ids = new Set<string>();
  for (const value of rows) {
    const version = integer(field(value, "version"));
    const migrationId = text(field(value, "migration_id"));
    const migrationSha256 = text(field(value, "migration_sha256"));
    if (version !== expected || !migrationId || migrationSha256 === undefined || !/^[0-9a-f]{64}$/.test(migrationSha256) || ids.has(migrationId)) throw new Error("schema_history_mismatch");
    ids.add(migrationId);
    result.push(Object.freeze({ version, migrationId, migrationSha256 }));
    expected += 1;
  }
  return Object.freeze(result);
}

/**
 * Read and validate the complete E04 metadata schema without writing a PRAGMA
 * or acquiring a transaction.  This is safe for a read-only diagnostic handle.
 */
export function inspectRuntimeSchema(
  connection: NativeSqliteConnection,
  extensions: readonly RuntimeSchemaExtension[] = [],
): RuntimeSchemaInspection {
  try {
    const userVersion = integer(scalar(connection, "PRAGMA user_version", "user_version"));
    if (userVersion === undefined || userVersion < 0) return fail("schema_corrupt", "user_version_invalid");
    const active = activeExtensions(extensions, userVersion);
    const objects = readSqliteObjects(connection);
    const tables = objects.filter((value) => field(value, "type") === "table").map((value) => text(field(value, "name"))).filter((value): value is string => value !== undefined);
    const nonTables = objects.filter((value) => field(value, "type") !== "table");
    if (nonTables.length > 0) return fail("schema_unknown", "unknown_schema_object");
    if (tables.length === 0 && userVersion === 0) {
      return Object.freeze({ ok: true as const, value: Object.freeze({
        initialized: false,
        userVersion: 0,
        schemaVersion: null,
        manifestSha256: null,
        history: Object.freeze([]),
        highestHistoryVersion: 0,
        schemaDigest: null,
        tables: Object.freeze([]),
      }) });
    }
    const sortedTables = [...tables].sort();
    const expectedNames = [...E04_BOOTSTRAP_TABLES, ...active.flatMap((extension) => extension.tables.map((table) => table.name))].sort();
    if (new Set(expectedNames).size !== expectedNames.length || sortedTables.length !== expectedNames.length || sortedTables.some((table, index) => table !== expectedNames[index])) {
      return fail("schema_unknown", "unknown_schema_table");
    }
    for (const table of sortedTables) {
      const object = objects.find((value) => field(value, "name") === table);
      const sql = text(field(object ?? {}, "sql"));
      const descriptor = expectedTable(table, active);
      if (!descriptor || !sql || normalizeSql(sql) !== normalizeSql(descriptor.createSql)) return fail("schema_corrupt", "schema_definition_mismatch");
      inspectColumns(connection, descriptor);
      inspectIndexes(connection, descriptor);
      inspectForeignKeys(connection, descriptor);
    }
    const meta = row(connection.prepare("SELECT singleton_id, schema_version, manifest_sha256 FROM workflow_schema_meta WHERE singleton_id = 1").get());
    const singleton = integer(field(meta, "singleton_id"));
    const schemaVersion = integer(field(meta, "schema_version"));
    const manifestSha256 = text(field(meta, "manifest_sha256"));
    if (singleton !== 1 || schemaVersion === undefined || schemaVersion < 1 || manifestSha256 === undefined || !/^[0-9a-f]{64}$/.test(manifestSha256)) return fail("schema_corrupt", "schema_metadata_invalid");
    const metaCount = row(connection.prepare("SELECT COUNT(*) AS count FROM workflow_schema_meta").get());
    const extraMeta = integer(field(metaCount, "count"));
    if (extraMeta !== 1) return fail("schema_corrupt", "schema_metadata_cardinality");
    const history = readHistory(connection);
    if (userVersion !== schemaVersion || history.length === 0 || history[history.length - 1]!.version !== schemaVersion) return fail("schema_corrupt", "schema_version_mismatch");
    const canonical = canonicalSchema(userVersion, schemaVersion, manifestSha256, history, active);
    return Object.freeze({ ok: true as const, value: Object.freeze({
      initialized: true,
      userVersion,
      schemaVersion,
      manifestSha256,
      history,
      highestHistoryVersion: history[history.length - 1]!.version,
      schemaDigest: createHash("sha256").update(canonical, "utf8").digest("hex"),
      tables: Object.freeze(sortedTables),
    }) });
  } catch (error) {
    const diagnostic = error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message) ? error.message : "schema_inspection_failed";
    return fail("schema_corrupt", diagnostic);
  }
}

/** Compare committed metadata/history to a validated target manifest. */
export function validateRuntimeSchema(
  connection: NativeSqliteConnection,
  manifest: RuntimeMigrationManifest,
  extensions: readonly RuntimeSchemaExtension[] = [],
): SchemaValidationResult {
  const inspected = inspectRuntimeSchema(connection, extensions);
  if (!inspected.ok) return inspected;
  const snapshot = inspected.value;
  if (!snapshot.initialized) return Object.freeze({ ok: true as const, value: snapshot });
  if (snapshot.schemaVersion !== manifest.targetVersion || snapshot.manifestSha256 !== manifest.sha256) {
    return fail("schema_corrupt", "schema_manifest_mismatch");
  }
  if (snapshot.history.length !== manifest.migrations.length) return fail("schema_corrupt", "schema_history_length_mismatch");
  for (let index = 0; index < manifest.migrations.length; index += 1) {
    const expected: ValidatedRuntimeMigration | undefined = manifest.migrations[index];
    const actual = snapshot.history[index];
    if (!expected || !actual || expected.version !== actual.version || expected.id !== actual.migrationId || expected.migrationSha256 !== actual.migrationSha256) return fail("schema_corrupt", "schema_history_digest_mismatch");
  }
  return Object.freeze({ ok: true as const, value: snapshot });
}
