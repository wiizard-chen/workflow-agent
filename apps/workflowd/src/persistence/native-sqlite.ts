import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

import { rejection, safeDiagnostic } from "./errors.js";
import type { RuntimePersistenceRejection } from "./types.js";

/**
 * The smallest surface the persistence implementation needs from SQLite.
 * This interface is intentionally not exported from the package entrypoint.
 */
export interface NativeSqliteStatement {
  readonly get: (...parameters: readonly unknown[]) => unknown;
  readonly all: (...parameters: readonly unknown[]) => readonly unknown[];
  readonly run: (...parameters: readonly unknown[]) => unknown;
}

export interface NativeSqliteConnection {
  readonly path: string;
  readonly readOnly: boolean;
  readonly exec: (sql: string) => void;
  readonly prepare: (sql: string) => NativeSqliteStatement;
  readonly close: () => void;
}

export type NativeSqliteDriver = Readonly<{
  readonly open: (databasePath: string, readOnly: boolean) => NativeSqliteConnection;
}>;

export type NativeSqliteLoadResult =
  | Readonly<{ readonly ok: true; readonly driver: NativeSqliteDriver }>
  | Readonly<{ readonly ok: false; readonly rejection: RuntimePersistenceRejection }>;

type RawStatement = Readonly<{
  readonly get: (...parameters: unknown[]) => unknown;
  readonly all: (...parameters: unknown[]) => readonly unknown[];
  readonly run: (...parameters: unknown[]) => unknown;
}>;

type RawDatabase = Readonly<{
  readonly exec: (sql: string) => void;
  readonly prepare: (sql: string) => RawStatement;
  readonly close: () => void;
}>;

export type NativeBuiltinModuleLoader = () => unknown;

function loadDatabaseSyncConstructor(loadModule?: NativeBuiltinModuleLoader): typeof DatabaseSync | undefined {
  try {
    // Requiring the built-in lazily keeps importing workflowd side-effect free
    // and lets unsupported Node versions return a typed rejection at startup.
    const require = createRequire(import.meta.url);
    const loaded = loadModule === undefined ? require("node:sqlite") : loadModule();
    const module = loaded as Readonly<{ readonly DatabaseSync?: typeof DatabaseSync }>;
    return typeof module.DatabaseSync === "function" ? module.DatabaseSync : undefined;
  } catch {
    return undefined;
  }
}

function wrapDatabase(rawDatabase: DatabaseSync, databasePath: string, readOnly: boolean): NativeSqliteConnection {
  const raw = rawDatabase as unknown as RawDatabase;
  let closed = false;
  return Object.freeze({
    path: databasePath,
    readOnly,
    exec(sql: string): void {
      if (closed) throw new Error("connection_closed");
      raw.exec(sql);
    },
    prepare(sql: string): NativeSqliteStatement {
      if (closed) throw new Error("connection_closed");
      const statement = raw.prepare(sql);
      return Object.freeze({
        get(...parameters: readonly unknown[]): unknown {
          if (closed) throw new Error("connection_closed");
          return statement.get(...parameters);
        },
        all(...parameters: readonly unknown[]): readonly unknown[] {
          if (closed) throw new Error("connection_closed");
          return statement.all(...parameters);
        },
        run(...parameters: readonly unknown[]): unknown {
          if (closed) throw new Error("connection_closed");
          return statement.run(...parameters);
        },
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      raw.close();
    },
  });
}

/** Load the built-in driver without selecting a fallback implementation. */
export function loadNativeSqlite(loadModule?: NativeBuiltinModuleLoader): NativeSqliteLoadResult {
  const DatabaseSyncConstructor = loadDatabaseSyncConstructor(loadModule);
  if (!DatabaseSyncConstructor) {
    return Object.freeze({
      ok: false as const,
      rejection: rejection("driver_unavailable", "node_sqlite_unavailable"),
    });
  }
  const driver: NativeSqliteDriver = Object.freeze({
    open(databasePath: string, readOnly: boolean): NativeSqliteConnection {
      const raw = new DatabaseSyncConstructor(databasePath, {
        readOnly,
        // Do not rely on this option for correctness: supported Node releases
        // differ in when it was introduced.  The adapter sets/reads the
        // explicit PRAGMA below as the policy authority.
        timeout: 0,
      });
      return wrapDatabase(raw, databasePath, readOnly);
    },
  });
  return Object.freeze({ ok: true as const, driver });
}

export type NativePragmaStatus = Readonly<{
  readonly journalMode: "wal" | "unknown";
  readonly synchronous: 2 | "unknown";
  readonly foreignKeys: 1 | "unknown";
  readonly busyTimeout: 5000 | "unknown";
}>;

function scalar(row: unknown, key: string): unknown {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return undefined;
  return (row as Record<string, unknown>)[key];
}

function integerValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  return undefined;
}

/** Read policy pragmas without changing any database state. */
export function readNativePragmas(connection: NativeSqliteConnection): NativePragmaStatus {
  try {
    const journalMode = String(scalar(connection.prepare("PRAGMA journal_mode").get(), "journal_mode") ?? "").toLowerCase();
    const synchronous = integerValue(scalar(connection.prepare("PRAGMA synchronous").get(), "synchronous"));
    const foreignKeys = integerValue(scalar(connection.prepare("PRAGMA foreign_keys").get(), "foreign_keys"));
    const busyTimeout = integerValue(scalar(connection.prepare("PRAGMA busy_timeout").get(), "timeout"));
    return Object.freeze({
      journalMode: journalMode === "wal" ? "wal" : "unknown",
      synchronous: synchronous === 2 ? 2 : "unknown",
      foreignKeys: foreignKeys === 1 ? 1 : "unknown",
      busyTimeout: busyTimeout === 5000 ? 5000 : "unknown",
    });
  } catch {
    return Object.freeze({
      journalMode: "unknown",
      synchronous: "unknown",
      foreignKeys: "unknown",
      busyTimeout: "unknown",
    });
  }
}

/** Configure and verify the writable connection's SQLite policy. */
export function configureNativePragmas(connection: NativeSqliteConnection):
  | Readonly<{ readonly ok: true; readonly status: NativePragmaStatus }>
  | Readonly<{ readonly ok: false; readonly rejection: RuntimePersistenceRejection }> {
  if (connection.readOnly) {
    return Object.freeze({
      ok: false as const,
      rejection: rejection("read_only", "write_pragmas_require_read_write"),
    });
  }
  try {
    // Keep each pragma separate.  journal_mode returns a row and some SQLite
    // wrappers reject a multi-statement exec containing a row-producing PRAGMA.
    connection.exec("PRAGMA journal_mode = WAL");
    connection.exec("PRAGMA synchronous = 2");
    connection.exec("PRAGMA foreign_keys = ON");
    connection.exec("PRAGMA busy_timeout = 5000");
    const status = readNativePragmas(connection);
    if (
      status.journalMode !== "wal" ||
      status.synchronous !== 2 ||
      status.foreignKeys !== 1 ||
      status.busyTimeout !== 5000
    ) {
      return Object.freeze({
        ok: false as const,
        rejection: rejection("pragma_failed", "sqlite_policy_readback_mismatch"),
      });
    }
    return Object.freeze({ ok: true as const, status });
  } catch (error) {
    return Object.freeze({
      ok: false as const,
      rejection: rejection("pragma_failed", safeDiagnostic(error, "sqlite_policy_failed")),
    });
  }
}
