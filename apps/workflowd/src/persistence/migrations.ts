import { createHash } from "node:crypto";

import { rejection } from "./errors.js";
import type { RuntimeMigration, RuntimePersistenceRejection } from "./types.js";

/** The only persistent objects owned by E04.  Later Epics register an
 * extension rather than smuggling their tables through this manifest. */
export const E04_BOOTSTRAP_TABLES = Object.freeze([
  "workflow_schema_meta",
  "workflow_migration_history",
] as const);

export const E04_BOOTSTRAP_SCHEMA_SQL = Object.freeze([
  "CREATE TABLE workflow_schema_meta (singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), schema_version INTEGER NOT NULL, manifest_sha256 TEXT NOT NULL)",
  "CREATE TABLE workflow_migration_history (version INTEGER PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, migration_sha256 TEXT NOT NULL)",
] as const);

const ALLOWED_TABLES = new Set<string>(E04_BOOTSTRAP_TABLES);
const MAX_MIGRATIONS = 1024;
const MAX_STATEMENTS = 4096;
const MAX_SQL_LENGTH = 1_000_000;
const MAX_ID_LENGTH = 256;

export type ValidatedRuntimeMigration = Readonly<{
  readonly version: number;
  readonly id: string;
  readonly statements: readonly string[];
  readonly migrationSha256: string;
}>;

export type RuntimeMigrationManifest = Readonly<{
  readonly migrations: readonly ValidatedRuntimeMigration[];
  /** UTF-8 canonical JSON bytes represented as a string. */
  readonly canonical: string;
  readonly sha256: string;
  readonly targetVersion: number;
}>;

export type MigrationValidationResult =
  | Readonly<{ readonly ok: true; readonly value: RuntimeMigrationManifest }>
  | Readonly<{ readonly ok: false; readonly rejection: RuntimePersistenceRejection }>;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fail(diagnostic: string): MigrationValidationResult {
  return Object.freeze({ ok: false as const, rejection: rejection("invalid_migration_manifest", diagnostic) });
}

function isRecord(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownKeys(value: object): readonly (string | symbol)[] | undefined {
  try {
    return Reflect.ownKeys(value);
  } catch {
    return undefined;
  }
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new Error("accessor_property");
  return descriptor.value;
}

function readArray(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("array_required");
  const length = value.length;
  if (!Number.isSafeInteger(length) || length > max) throw new Error("array_length_invalid");
  const keys = ownKeys(value);
  if (!keys) throw new Error("array_keys_unavailable");
  for (const key of keys) {
    if (typeof key === "symbol") throw new Error("symbol_key");
    if (key === "length") continue;
    if (!/^\d+$/.test(key) || Number(key) >= length) throw new Error("array_key_invalid");
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index))) throw new Error("sparse_array");
    result.push(value[index]);
  }
  return result;
}

type SqlToken = Readonly<{ readonly kind: "word" | "quoted" | "string" | "punct"; readonly value: string }>;

/**
 * Small, deliberately conservative SQL lexer.  It is not a SQL parser: its
 * job is to reject dangerous statements and identify table/object names before
 * SQLite gets a chance to mutate anything.  Quoted strings and comments are
 * skipped so words in data literals cannot bypass or trigger policy checks.
 */
function tokenize(sql: string): readonly SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index] ?? "";
    if (/\s/.test(character)) { index += 1; continue; }
    if (character === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index += 1;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) throw new Error("unterminated_comment");
      index = end + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      const kind = quote === "'" ? "string" : "quoted";
      let value = "";
      index += 1;
      let closed = false;
      while (index < sql.length) {
        const next = sql[index] ?? "";
        if (next === quote) {
          if (sql[index + 1] === quote) { value += quote; index += 2; continue; }
          index += 1;
          closed = true;
          break;
        }
        value += next;
        index += 1;
      }
      if (!closed) throw new Error("unterminated_quote");
      tokens.push(Object.freeze({ kind, value }));
      continue;
    }
    if (character === "[") {
      const end = sql.indexOf("]", index + 1);
      if (end < 0) throw new Error("unterminated_identifier");
      tokens.push(Object.freeze({ kind: "quoted", value: sql.slice(index + 1, end) }));
      index = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index] ?? "")) index += 1;
      tokens.push(Object.freeze({ kind: "word", value: sql.slice(start, index) }));
      continue;
    }
    tokens.push(Object.freeze({ kind: "punct", value: character }));
    index += 1;
  }
  return Object.freeze(tokens);
}

function tokenName(token: SqlToken | undefined): string | undefined {
  if (!token || (token.kind !== "word" && token.kind !== "quoted")) return undefined;
  return token.value.toLowerCase();
}

function enforceSqlPolicy(sql: string, allowedTables: ReadonlySet<string> = ALLOWED_TABLES): void {
  if (sql.length === 0 || sql.length > MAX_SQL_LENGTH || sql.includes("\0")) throw new Error("sql_invalid");
  const tokens = tokenize(sql);
  if (tokens.length === 0) throw new Error("sql_empty");
  const firstWord = tokenName(tokens[0]);
  // E04 migrations are schema/data statements only.  A query, arbitrary
  // expression, or transaction-control fragment is not a migration even if
  // it happens not to contain a denied keyword.
  if (firstWord !== "create" && firstWord !== "insert" && firstWord !== "update" && firstWord !== "delete") {
    throw new Error("migration_statement_type_invalid");
  }
  if (firstWord === "create" && tokenName(tokens[1]) !== "table") throw new Error("migration_statement_type_invalid");
  if (firstWord === "insert" && tokenName(tokens[1]) !== "into") throw new Error("migration_statement_type_invalid");
  if (firstWord === "update" && tokenName(tokens[1]) === undefined) throw new Error("migration_statement_type_invalid");
  if (firstWord === "delete" && tokenName(tokens[1]) !== "from") throw new Error("migration_statement_type_invalid");
  let parenthesisDepth = 0;
  let sawOpenParenthesis = false;
  let semicolonCount = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.value === ";") {
      semicolonCount += 1;
      if (semicolonCount > 1 || index !== tokens.length - 1) throw new Error("multiple_sql_statements");
      continue;
    }
    if (token.value === "(") { parenthesisDepth += 1; sawOpenParenthesis = true; }
    if (token.value === ")") { parenthesisDepth -= 1; if (parenthesisDepth < 0) throw new Error("sql_parentheses_invalid"); }
    if (token.kind !== "word") continue;
    const word = token.value.toLowerCase();
    if (new Set(["attach", "detach", "pragma", "vacuum", "begin", "commit", "rollback", "savepoint", "release", "end", "reindex", "load_extension"]).has(word)) {
      throw new Error(`forbidden_sql_${word}`);
    }
    // Function-style extension loading can be written with unusual casing or
    // whitespace; token policy above catches the identifier itself.
    if (word === "load_extension") throw new Error("forbidden_sql_load_extension");
  }
  if (parenthesisDepth !== 0 || (firstWord === "create" && !sawOpenParenthesis)) throw new Error("sql_shape_invalid");

  // Resolve every table/object operand of common DDL/DML clauses.  A schema
  // qualifier (main.foo) is deliberately rejected as an unknown object.
  const tableOperandKeywords = new Set(["table", "into", "update", "from", "join", "references", "on"]);
  for (let index = 0; index < tokens.length; index += 1) {
    const word = tokenName(tokens[index]);
    if (!word || !tableOperandKeywords.has(word)) continue;
    let cursor = index + 1;
    while (tokenName(tokens[cursor]) === "if" || tokenName(tokens[cursor]) === "not" || tokenName(tokens[cursor]) === "exists") cursor += 1;
    const candidate = tokens[cursor];
    const name = tokenName(candidate);
    if (!name) continue;
    if (tokens[cursor + 1]?.value === ".") throw new Error("unknown_sql_object");
    if (!allowedTables.has(name)) throw new Error("unknown_sql_object");
  }
  // Explicit object declarations beyond E04's two tables are never accepted.
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const first = tokenName(tokens[index]);
    const second = tokenName(tokens[index + 1]);
    if ((first === "create" || first === "alter" || first === "drop") && second !== undefined && ["index", "view", "trigger", "virtual"].includes(second)) {
      throw new Error("unknown_sql_object");
    }
  }
}

function canonicalMigration(version: number, id: string, statements: readonly string[]): string {
  return JSON.stringify({ version, id, statements });
}

/** Validate and copy an immutable migration list, deriving all digests. */
export function validateRuntimeMigrations(
  input: unknown,
  allowedTables: readonly string[] = E04_BOOTSTRAP_TABLES,
): MigrationValidationResult {
  try {
    const tableAllowlist = new Set(allowedTables.map((table) => table.toLowerCase()));
    if (tableAllowlist.size === 0 || [...tableAllowlist].some((table) => !/^[a-z_][a-z0-9_]{0,127}$/.test(table))) throw new Error("table_allowlist_invalid");
    const values = readArray(input, MAX_MIGRATIONS);
    const migrations: ValidatedRuntimeMigration[] = [];
    const ids = new Set<string>();
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (!isRecord(value)) throw new Error("migration_object_required");
      const keys = ownKeys(value);
      if (!keys || keys.some((key) => typeof key !== "string") || keys.length !== 3 || !["version", "id", "statements"].every((key) => keys.includes(key))) {
        throw new Error("migration_keys_invalid");
      }
      const version = dataProperty(value, "version");
      const id = dataProperty(value, "id");
      const statementsValue = dataProperty(value, "statements");
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version !== index + 1) throw new Error("migration_versions_not_contiguous");
      if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH || id.trim() !== id || id.includes("\0") || ids.has(id)) throw new Error("migration_id_invalid");
      ids.add(id);
      const statementValues = readArray(statementsValue, MAX_STATEMENTS);
      if (statementValues.length === 0) throw new Error("migration_statements_empty");
      const statements: string[] = [];
      for (const statement of statementValues) {
        if (typeof statement !== "string" || statement.trim() !== statement || statement.trim().length === 0) throw new Error("migration_sql_invalid");
        enforceSqlPolicy(statement, tableAllowlist);
        statements.push(statement);
      }
      const canonical = canonicalMigration(version, id, statements);
      migrations.push(Object.freeze({ version, id, statements: Object.freeze(statements), migrationSha256: digest(canonical) }));
    }
    const frozenMigrations = Object.freeze(migrations);
    const canonical = JSON.stringify({ migrations: frozenMigrations.map(({ version, id, statements }) => ({ version, id, statements })) });
    return Object.freeze({
      ok: true as const,
      value: Object.freeze({
        migrations: frozenMigrations,
        canonical,
        sha256: digest(canonical),
        targetVersion: migrations.length === 0 ? 0 : migrations[migrations.length - 1]!.version,
      }),
    });
  } catch (error) {
    const diagnostic = error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message) ? error.message : "manifest_validation_failed";
    return fail(diagnostic);
  }
}

/**
 * The canonical E04 bootstrap manifest.  Kept as a helper so callers cannot
 * accidentally hand the factory a mutable shared array.
 */
export function createBootstrapRuntimeMigrations(): readonly RuntimeMigration[] {
  return Object.freeze([Object.freeze({
    version: 1,
    id: "e04.bootstrap.1",
    statements: E04_BOOTSTRAP_SCHEMA_SQL,
  })]);
}

export function canonicalRuntimeManifest(input: unknown): MigrationValidationResult {
  return validateRuntimeMigrations(input);
}

export function isAllowedRuntimeTable(name: string): boolean {
  return ALLOWED_TABLES.has(name.toLowerCase());
}
