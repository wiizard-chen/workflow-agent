import { rejection, safeDiagnostic } from "./errors.js";
import {
  readNativePragmas,
  type NativePragmaStatus,
  type NativeSqliteConnection,
} from "./native-sqlite.js";
import type {
  RuntimeMigration,
  RuntimeOpenResult,
  RuntimePersistenceRejection,
} from "./types.js";

/**
 * Internal transaction state.  The native adapter deliberately does not expose
 * a transaction API to callers; keeping the state here prevents a migration
 * helper from accidentally committing a transaction which it did not acquire.
 */
const transactions = new WeakMap<NativeSqliteConnection, { active: boolean }>();

export type MigrationLock = Readonly<{
  /** Commit the migration transaction.  A failed commit is reported safely. */
  readonly commit: () => RuntimeOpenResult<true>;
  /** Roll back the migration transaction, ignoring a secondary rollback error. */
  readonly rollback: () => void;
  /** Whether this handle still owns the SQLite write reservation. */
  readonly active: () => boolean;
}>;

export type MigrationLockResult = RuntimeOpenResult<MigrationLock>;

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  if (error === null || typeof error !== "object") return undefined;
  return error as Record<string, unknown>;
}
function sqliteErrorCode(error: unknown): string {
  const record = errorRecord(error);
  const code = record?.code;
  if (typeof code === "string") return code.toUpperCase();
  return "";
}

function sqliteErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  const record = errorRecord(error);
  const message = record?.message;
  return typeof message === "string" ? message.toLowerCase() : "";
}

function isBusyOrLocked(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  if (code.includes("BUSY") || code.includes("LOCKED")) return true;
  const message = sqliteErrorMessage(error);
  return message.includes("database is locked") ||
    message.includes("database table is locked") ||
    message.includes("database busy") ||
    message.includes("busy timeout");
}

function isReadonlyError(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  if (code.includes("READONLY")) return true;
  const message = sqliteErrorMessage(error);
  return message.includes("readonly") || message.includes("read-only") || message.includes("read only");
}

function isRejection(value: unknown): value is RuntimePersistenceRejection {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.code === "string" && typeof record.diagnostic === "string";
}

function stepFailure(error: unknown, fallback: string): RuntimePersistenceRejection {
  if (isRejection(error)) return error;
  if (isBusyOrLocked(error)) return rejection("migration_locked", "migration_lock_busy");
  return rejection("migration_failed", safeDiagnostic(error, fallback));
}

function normalizeToken(value: string): string {
  return value.toUpperCase();
}

/**
 * Return lexical SQL tokens while ignoring comments and quoted literals.  The
 * migration boundary is intentionally conservative: the deny list is checked
 * on tokens, rather than with a substring search, so a column called
 * `pragmatic` or a string containing `ATTACH` is not rejected by accident.
 */
function sqlTokens(sql: string): string[] | undefined {
  const tokens: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const character = sql[i]!;
    if (/\s/.test(character)) {
      i += 1;
      continue;
    }
    if (character === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i += 1;
      continue;
    }
    if (character === "/" && sql[i + 1] === "*") {
      i += 2;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          i += 2;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      i += 1;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === quote) {
          // SQL escapes a quote by doubling it.
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return undefined;
      continue;
    }
    if (character === "[") {
      i += 1;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "]") {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return undefined;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const start = i;
      i += 1;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i]!)) i += 1;
      tokens.push(normalizeToken(sql.slice(start, i)));
      continue;
    }
    // Punctuation and numeric literals cannot contain a denied keyword.
    i += 1;
  }
  return tokens;
}

const DENIED_SQL_TOKENS = new Set([
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "LOAD_EXTENSION",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "END",
]);

/**
 * Validate one migration statement before a write transaction starts.
 *
 * This is an internal defence-in-depth check.  T2's manifest validator owns
 * the canonical migration shape and table allowlist; this function owns SQL
 * effects which could escape the migration transaction or nest transactions.
 */
export function validateMigrationSql(sql: unknown): RuntimePersistenceRejection | undefined {
  if (typeof sql !== "string" || sql.trim().length === 0 || sql.includes("\0")) {
    return rejection("invalid_migration_manifest", "migration_sql_invalid");
  }
  const tokens = sqlTokens(sql);
  if (tokens === undefined) return rejection("invalid_migration_manifest", "migration_sql_unterminated_literal");
  for (const token of tokens) {
    if (DENIED_SQL_TOKENS.has(token)) {
      return rejection("invalid_migration_manifest", "migration_sql_forbidden_statement");
    }
  }
  return undefined;
}

/** Validate all migration statements in caller-provided order. */
export function validateMigrationStatements(
  migrations: readonly RuntimeMigration[],
): RuntimePersistenceRejection | undefined {
  if (!Array.isArray(migrations)) return rejection("invalid_migration_manifest", "migrations_not_array");
  for (const migration of migrations) {
    if (migration === null || typeof migration !== "object" || !Array.isArray(migration.statements)) {
      return rejection("invalid_migration_manifest", "migration_statements_invalid");
    }
    for (const statement of migration.statements) {
      const invalid = validateMigrationSql(statement);
      if (invalid) return invalid;
    }
  }
  return undefined;
}

/**
 * Read-only preflight for a migration attempt.  It performs no write PRAGMA,
 * transaction, directory, or schema operation.  The factory uses this before
 * BEGIN IMMEDIATE, and callers can use the returned values in diagnostics.
 */
export function readOnlyMigrationPreflight(
  connection: NativeSqliteConnection,
): RuntimeOpenResult<NativePragmaStatus> {
  try {
    return Object.freeze({ ok: true as const, value: readNativePragmas(connection) });
  } catch (error) {
    return Object.freeze({
      ok: false as const,
      rejection: rejection("schema_corrupt", safeDiagnostic(error, "sqlite_preflight_failed")),
    });
  }
}

function closeTransactionState(connection: NativeSqliteConnection): void {
  const state = transactions.get(connection);
  if (state) state.active = false;
}

/**
 * Acquire SQLite's bounded write reservation.  SQLite's busy timeout (set by
 * the T1 adapter to exactly 5000ms) is the only lock authority; no sidecar
 * lock file is created.  SQLITE_BUSY/SQLITE_LOCKED is normalized to the typed
 * `migration_locked` rejection.
 */
export function acquireMigrationLock(connection: NativeSqliteConnection): MigrationLockResult {
  if (connection.readOnly) {
    return Object.freeze({
      ok: false as const,
      rejection: rejection("read_only", "migration_lock_requires_read_write"),
    });
  }
  const existing = transactions.get(connection);
  if (existing?.active) {
    return Object.freeze({
      ok: false as const,
      rejection: rejection("migration_failed", "migration_transaction_already_active"),
    });
  }
  const preflight = readOnlyMigrationPreflight(connection);
  if (!preflight.ok) return preflight;
  const pragmas = preflight.value;
  if (pragmas.journalMode !== "wal" || pragmas.synchronous !== 2 ||
      pragmas.foreignKeys !== 1 || pragmas.busyTimeout !== 5000) {
    return Object.freeze({
      ok: false as const,
      rejection: rejection("pragma_failed", "sqlite_policy_readback_mismatch"),
    });
  }
  try {
    // This is intentionally a single statement.  It reserves the write lock
    // before any locked schema reread, backup, or migration SQL is attempted.
    connection.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (isBusyOrLocked(error)) {
      return Object.freeze({
        ok: false as const,
        rejection: rejection("migration_locked", "migration_lock_busy"),
      });
    }
    if (isReadonlyError(error)) {
      return Object.freeze({
        ok: false as const,
        rejection: rejection("read_only", "migration_lock_requires_read_write"),
      });
    }
    return Object.freeze({
      ok: false as const,
      rejection: rejection("migration_failed", safeDiagnostic(error, "migration_lock_begin_failed")),
    });
  }
  const state = { active: true };
  transactions.set(connection, state);
  let active = true;
  const rollback = (): void => {
    if (!active) return;
    active = false;
    state.active = false;
    try { connection.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
  };
  const commit = (): RuntimeOpenResult<true> => {
    if (!active) {
      return Object.freeze({
        ok: false as const,
        rejection: rejection("migration_failed", "migration_transaction_inactive"),
      });
    }
    try {
      connection.exec("COMMIT");
      active = false;
      state.active = false;
      return Object.freeze({ ok: true as const, value: true as const });
    } catch (error) {
      // The caller must still be able to attempt rollback if SQLite kept the
      // transaction open.  Keep the state active until rollback is called.
      return Object.freeze({
        ok: false as const,
        rejection: stepFailure(error, "migration_lock_commit_failed"),
      });
    }
  };
  const lock: MigrationLock = Object.freeze({
    commit,
    rollback,
    active: () => active,
  });
  return Object.freeze({ ok: true as const, value: lock });
}

/** Begin-lock alias used by migration/schema code. */
export const beginImmediateMigration = acquireMigrationLock;

/** Roll back any transaction acquired by this module; safe to call repeatedly. */
export function rollbackMigration(connection: NativeSqliteConnection): void {
  const state = transactions.get(connection);
  if (!state?.active) return;
  state.active = false;
  try { connection.exec("ROLLBACK"); } catch { /* no secondary error escapes */ }
}

/**
 * Apply ordered SQL under one BEGIN IMMEDIATE transaction.  `reread` executes
 * after the lock is acquired (closing the preflight TOCTOU window), and
 * `validate` executes after all statements but before COMMIT.  Hook failures
 * may return a typed rejection or throw; every failure rolls the transaction
 * back before being returned.
 */
export function runMigrationTransaction(
  connection: NativeSqliteConnection,
  migrations: readonly RuntimeMigration[],
  hooks: Readonly<{
    readonly reread?: () => RuntimePersistenceRejection | undefined;
    readonly validate?: () => RuntimePersistenceRejection | undefined;
  }> = {},
): RuntimeOpenResult<true> {
  const invalid = validateMigrationStatements(migrations);
  if (invalid) return Object.freeze({ ok: false as const, rejection: invalid });
  const acquired = acquireMigrationLock(connection);
  if (!acquired.ok) return acquired;
  const lock = acquired.value;
  const fail = (error: unknown, fallback: string): RuntimeOpenResult<true> => {
    lock.rollback();
    return Object.freeze({ ok: false as const, rejection: stepFailure(error, fallback) });
  };
  try {
    const rereadFailure = hooks.reread?.();
    if (rereadFailure) return fail(rereadFailure, "migration_locked_schema_reread_failed");
    for (const migration of migrations) {
      // Preserve migration-array and statement order exactly; do not sort or
      // combine statements because ordering is part of the manifest digest.
      for (const statement of migration.statements) connection.exec(statement);
    }
    const validationFailure = hooks.validate?.();
    if (validationFailure) return fail(validationFailure, "migration_schema_validation_failed");
    const committed = lock.commit();
    if (!committed.ok) {
      lock.rollback();
      return committed;
    }
    return committed;
  } catch (error) {
    return fail(error, "migration_statement_failed");
  }
}
