import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { reject, rejection, safeDiagnostic } from "./errors.js";
import type {
  RuntimeDatabaseOptions,
  RuntimeOpenMode,
  RuntimeOpenResult,
  RuntimePersistenceRejection,
} from "./types.js";

const ROOT_MODE = 0o700;
const DATABASE_MODE = 0o600;
const NO_FOLLOW = Number(constants.O_NOFOLLOW ?? 0);
const CURRENT_UID = typeof process.getuid === "function" ? process.getuid() : undefined;

export type FileIdentity = Readonly<{
  readonly dev: number;
  readonly ino: number;
}>;

export type PreparedRuntimePaths = Readonly<{
  readonly runtimeRoot: string;
  readonly databasePath: string;
  readonly backupDirectory: string;
  readonly mode: RuntimeOpenMode;
  readonly databaseIdentity: FileIdentity;
  readonly sidecars: readonly Readonly<{ readonly path: string; readonly identity: FileIdentity | null }>[];
}>;

type PathStat = Readonly<{
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
  readonly mode: number;
  readonly uid: number;
  readonly nlink: number;
  readonly dev: number;
  readonly ino: number;
}>;

function stat(path: string): PathStat {
  const value = lstatSync(path, { bigint: false });
  return Object.freeze({
    isDirectory: value.isDirectory(),
    isFile: value.isFile(),
    isSymbolicLink: value.isSymbolicLink(),
    mode: value.mode & 0o7777,
    uid: value.uid,
    nlink: value.nlink,
    dev: value.dev,
    ino: value.ino,
  });
}

function identity(value: PathStat): FileIdentity {
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ownerIsCurrent(value: PathStat): boolean {
  return CURRENT_UID === undefined || value.uid === CURRENT_UID;
}

function secureMode(value: PathStat, expected: number, requireOwnerReadWrite: boolean): boolean {
  if ((value.mode & 0o077) !== 0) return false;
  if (requireOwnerReadWrite && (value.mode & 0o600) !== 0o600) return false;
  // A sticky/set-id component is not part of the policy even if it happens to
  // leave group/other bits clear.
  if ((value.mode & 0o7000) !== 0) return false;
  // Newly created components are exact; existing components may retain owner
  // read/write/execute bits, but must remain at least as restrictive.
  return expected === ROOT_MODE
    ? (value.mode & 0o077) === 0 && (value.mode & 0o700) === 0o700
    : (value.mode & 0o077) === 0 && (value.mode & 0o600) === 0o600;
}

function isInside(child: string, parent: string, allowEqual: boolean): boolean {
  const childRelative = relative(parent, child);
  return (allowEqual && childRelative === "") ||
    (childRelative !== "" && childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative));
}

function invalidPath<T>(diagnostic: string): RuntimeOpenResult<T> {
  return reject("invalid_path", diagnostic);
}

function permissionDenied<T>(diagnostic: string): RuntimeOpenResult<T> {
  return reject("permission_denied", diagnostic);
}

function normalizeExplicitPath(value: unknown, field: string): RuntimeOpenResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    return invalidPath(`${field}_must_be_absolute`);
  }
  try {
    return Object.freeze({ ok: true as const, value: resolve(value) });
  } catch (error) {
    return invalidPath(`${field}_invalid:${safeDiagnostic(error, "path")}`);
  }
}

function readMode(value: unknown): RuntimeOpenResult<RuntimeOpenMode> {
  if (value === undefined || value === "read-write") return Object.freeze({ ok: true as const, value: "read-write" });
  if (value === "read-only") return Object.freeze({ ok: true as const, value: "read-only" });
  return reject("invalid_options", "mode_invalid");
}

function componentPaths(path: string): readonly string[] {
  const resolved = resolve(path);
  const root = resolve(sep);
  const parts = resolved.slice(root.length).split(sep).filter((part) => part.length > 0);
  const values: string[] = [root];
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    values.push(current);
  }
  return values;
}

/** Check all existing ancestors without following a symlink. */
function verifyAncestors(path: string, allowMissingTail: boolean): RuntimeOpenResult<void> {
  const components = componentPaths(path);
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    if (component === undefined) continue;
    try {
      const current = stat(component);
      if (current.isSymbolicLink) return invalidPath("symlink_path_component");
      if (!current.isDirectory) return invalidPath("non_directory_path_component");
    } catch (error) {
      if (allowMissingTail && (error as NodeJS.ErrnoException).code === "ENOENT") {
        // Missing components may be created only by ensureDirectory below;
        // ancestors before the missing tail were already checked.
        return Object.freeze({ ok: true as const, value: undefined });
      }
      return permissionDenied(`path_parent_unavailable:${safeDiagnostic(error, "lstat")}`);
    }
  }
  return Object.freeze({ ok: true as const, value: undefined });
}

function ensureDirectory(path: string, mode: number, readOnly: boolean): RuntimeOpenResult<void> {
  const components = componentPaths(path);
  for (const component of components) {
    if (component === sep) continue;
    let current: PathStat | undefined;
    try {
      current = stat(component);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" || readOnly) {
        return permissionDenied(`directory_unavailable:${safeDiagnostic(error, "lstat")}`);
      }
      try {
        mkdirSync(component, { mode });
        current = stat(component);
      } catch (createError) {
        // Another process may have created it; inspect rather than trusting the
        // mkdir result.  A symlink/non-directory still fails closed below.
        try {
          current = stat(component);
        } catch {
          return permissionDenied(`directory_create_failed:${safeDiagnostic(createError, "mkdir")}`);
        }
      }
    }
    if (!current || current.isSymbolicLink || !current.isDirectory) return invalidPath("directory_component_not_safe");
  }

  let value: PathStat;
  try {
    value = stat(path);
  } catch (error) {
    return permissionDenied(`directory_missing:${safeDiagnostic(error, "lstat")}`);
  }
  if (value.isSymbolicLink || !value.isDirectory || !ownerIsCurrent(value)) return permissionDenied("directory_owner_or_type");
  if (!secureMode(value, mode, false)) return permissionDenied("directory_permissions_too_broad");
  return Object.freeze({ ok: true as const, value: undefined });
}

function ensureDatabaseFile(path: string, mode: RuntimeOpenMode): RuntimeOpenResult<Readonly<{ identity: FileIdentity }>> {
  const readOnly = mode === "read-only";
  let current: PathStat | undefined;
  try {
    current = stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" || readOnly) return permissionDenied(`database_unavailable:${safeDiagnostic(error, "lstat")}`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NO_FOLLOW, DATABASE_MODE);
      // Sync the new directory entry before handing the path to SQLite.  A
      // failed fsync is a permission failure, not a reason to proceed.
      fsyncSync(descriptor);
      fchmodSync(descriptor, DATABASE_MODE);
    } catch (createError) {
      return permissionDenied(`database_create_failed:${safeDiagnostic(createError, "open")}`);
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* the original failure is authoritative */ }
      }
    }
    try {
      current = stat(path);
    } catch (createdError) {
      return permissionDenied(`database_create_unverified:${safeDiagnostic(createdError, "lstat")}`);
    }
  }
  if (!current || current.isSymbolicLink || !current.isFile || !ownerIsCurrent(current)) return permissionDenied("database_owner_or_type");
  if (current.nlink !== 1) return permissionDenied("database_hardlink_rejected");
  if (!secureMode(current, DATABASE_MODE, true)) return permissionDenied("database_permissions_too_broad");
  return Object.freeze({ ok: true as const, value: Object.freeze({ identity: identity(current) }) });
}

function verifySidecar(path: string): RuntimeOpenResult<void> {
  let value: PathStat;
  try {
    value = stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ ok: true as const, value: undefined });
    return permissionDenied(`sidecar_unavailable:${safeDiagnostic(error, "lstat")}`);
  }
  if (value.isSymbolicLink || !value.isFile || value.nlink !== 1 || !ownerIsCurrent(value)) return permissionDenied("sidecar_identity_rejected");
  if (!secureMode(value, DATABASE_MODE, true)) return permissionDenied("sidecar_permissions_too_broad");
  return Object.freeze({ ok: true as const, value: undefined });
}

function sidecarIdentity(path: string): RuntimeOpenResult<FileIdentity | null> {
  try {
    const value = stat(path);
    if (value.isSymbolicLink || !value.isFile || value.nlink !== 1 || !ownerIsCurrent(value)) return permissionDenied("sidecar_identity_rejected");
    if (!secureMode(value, DATABASE_MODE, true)) return permissionDenied("sidecar_permissions_too_broad");
    return Object.freeze({ ok: true as const, value: identity(value) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ ok: true as const, value: null });
    return permissionDenied(`sidecar_unavailable:${safeDiagnostic(error, "lstat")}`);
  }
}

export function hardenCreatedSidecars(
  sidecars: readonly Readonly<{ readonly path: string; readonly identity: FileIdentity | null }>[],
): RuntimeOpenResult<void> {
  for (const sidecar of sidecars) {
    let value: PathStat;
    try {
      value = stat(sidecar.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return permissionDenied(`sidecar_unavailable:${safeDiagnostic(error, "lstat")}`);
    }
    if (value.isSymbolicLink || !value.isFile || value.nlink !== 1 || !ownerIsCurrent(value)) return permissionDenied("sidecar_identity_rejected");
    const currentIdentity = identity(value);
    if (sidecar.identity !== null && !sameIdentity(sidecar.identity, currentIdentity)) return permissionDenied("sidecar_identity_changed");
    try {
      // A sidecar created by SQLite after the initial no-follow preflight is
      // tightened to 0600.  An existing sidecar was already required to be
      // restrictive and is never silently repaired.
      if (sidecar.identity === null) {
        const descriptor = openSync(sidecar.path, constants.O_WRONLY | NO_FOLLOW);
        try {
          fchmodSync(descriptor, DATABASE_MODE);
        } finally {
          closeSync(descriptor);
        }
      }
    } catch (error) {
      return permissionDenied(`sidecar_permissions_failed:${safeDiagnostic(error, "chmod")}`);
    }
    // Re-open/lstat after chmod and reject any replacement or remaining broad
    // permissions.  A descriptor opened above is closed by the helper below.
    try {
      const finalValue = stat(sidecar.path);
      if (!finalValue.isFile || finalValue.isSymbolicLink || finalValue.nlink !== 1 || !ownerIsCurrent(finalValue) || !secureMode(finalValue, DATABASE_MODE, true)) {
        return permissionDenied("sidecar_permissions_too_broad");
      }
      if (!sameIdentity(currentIdentity, identity(finalValue))) return permissionDenied("sidecar_identity_changed");
    } catch (error) {
      return permissionDenied(`sidecar_recheck_failed:${safeDiagnostic(error, "lstat")}`);
    }
  }
  return Object.freeze({ ok: true as const, value: undefined });
}

function prepareOptions(options: RuntimeDatabaseOptions): RuntimeOpenResult<Readonly<{ runtimeRoot: string; databasePath: string; backupDirectory: string; mode: RuntimeOpenMode }>> {
  let runtimeRootValue: unknown;
  let databasePathValue: unknown;
  let backupDirectoryValue: unknown;
  let modeValue: unknown;
  try {
    if (options === null || typeof options !== "object") return reject("invalid_options", "options_object_required");
    runtimeRootValue = (options as RuntimeDatabaseOptions).runtimeRoot;
    databasePathValue = (options as RuntimeDatabaseOptions).databasePath;
    backupDirectoryValue = (options as RuntimeDatabaseOptions).backupDirectory;
    modeValue = (options as RuntimeDatabaseOptions).mode;
  } catch {
    return reject("invalid_options", "options_accessor_failed");
  }
  const runtimeRoot = normalizeExplicitPath(runtimeRootValue, "runtime_root");
  if (!runtimeRoot.ok) return runtimeRoot;
  const databasePath = normalizeExplicitPath(databasePathValue, "database_path");
  if (!databasePath.ok) return databasePath;
  const modeResult = readMode(modeValue);
  if (!modeResult.ok) return modeResult;
  const mode = modeResult.value;
  const backupDirectory = backupDirectoryValue === undefined
    ? Object.freeze({ ok: true as const, value: join(runtimeRoot.value, "backups") })
    : normalizeExplicitPath(backupDirectoryValue, "backup_directory");
  if (!backupDirectory.ok) return backupDirectory;
  if (!isInside(databasePath.value, runtimeRoot.value, false)) return invalidPath("database_path_escapes_runtime_root");
  if (!isInside(backupDirectory.value, runtimeRoot.value, false)) return invalidPath("backup_directory_escapes_runtime_root");
  return Object.freeze({ ok: true as const, value: Object.freeze({ runtimeRoot: runtimeRoot.value, databasePath: databasePath.value, backupDirectory: backupDirectory.value, mode }) });
}

function verifySecureConfiguredDirectory(path: string, mode: RuntimeOpenMode, isBackup: boolean): RuntimeOpenResult<void> {
  // Read-only diagnostics must not create directories, including the default
  // backup directory.  Its existence is not required in read-only mode.
  if (mode === "read-only" && isBackup) {
    try {
      const value = stat(path);
      if (value.isSymbolicLink || !value.isDirectory || !ownerIsCurrent(value)) return permissionDenied("backup_directory_owner_or_type");
      if (!secureMode(value, 0o700, false)) return permissionDenied("backup_directory_permissions_too_broad");
      return Object.freeze({ ok: true as const, value: undefined });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ ok: true as const, value: undefined });
      return permissionDenied(`backup_directory_unavailable:${safeDiagnostic(error, "lstat")}`);
    }
  }
  const result = ensureDirectory(path, isBackup ? 0o700 : ROOT_MODE, mode === "read-only");
  if (!result.ok) return result;
  return result;
}

/**
 * Validate and, for read-write opens, create the explicit local path set.
 * No realpath or path component is followed implicitly: every component is
 * lstat'ed and symlinks/hardlinks are rejected before SQLite sees the path.
 */
export function prepareRuntimePaths(options: RuntimeDatabaseOptions): RuntimeOpenResult<PreparedRuntimePaths> {
  const parsed = prepareOptions(options);
  if (!parsed.ok) return parsed;
  const { runtimeRoot, databasePath, backupDirectory, mode } = parsed.value;
  const readOnly = mode === "read-only";

  // Existing ancestors are checked before any mkdir.  This catches a parent
  // symlink even when the final configured component does not exist yet.
  const rootAncestors = verifyAncestors(runtimeRoot, !readOnly);
  if (!rootAncestors.ok) return rootAncestors;
  const root = verifySecureConfiguredDirectory(runtimeRoot, mode, false);
  if (!root.ok) return root;
  // A read-only diagnostic may point at a database whose configured backup
  // directory has never been created.  Existing ancestors are still checked;
  // a missing final tail is deliberately not created or treated as an error.
  const backupAncestors = verifyAncestors(backupDirectory, true);
  if (!backupAncestors.ok) return backupAncestors;
  const backup = verifySecureConfiguredDirectory(backupDirectory, mode, true);
  if (!backup.ok) return backup;

  const databaseParent = dirname(databasePath);
  const databaseParentAncestors = verifyAncestors(databaseParent, !readOnly);
  if (!databaseParentAncestors.ok) return databaseParentAncestors;
  const parent = verifySecureConfiguredDirectory(databaseParent, mode, false);
  if (!parent.ok) return parent;
  const file = ensureDatabaseFile(databasePath, mode);
  if (!file.ok) return file;
  const databaseIdentity = file.value.identity;

  const sidecars: Array<Readonly<{ readonly path: string; readonly identity: FileIdentity | null }>> = [];
  for (const suffix of ["-wal", "-shm"] as const) {
    const sidecarPath = `${databasePath}${suffix}`;
    const sidecar = sidecarIdentity(sidecarPath);
    if (!sidecar.ok) return sidecar;
    sidecars.push(Object.freeze({ path: sidecarPath, identity: sidecar.value }));
  }

  // Re-lstat the database after all other validation.  The factory performs a
  // second check immediately after SQLite opens it to catch replacement races.
  let finalIdentity: FileIdentity;
  try {
    const value = stat(databasePath);
    if (!value.isFile || value.isSymbolicLink || value.nlink !== 1 || !ownerIsCurrent(value) || !secureMode(value, DATABASE_MODE, true)) {
      return permissionDenied("database_identity_changed");
    }
    finalIdentity = identity(value);
  } catch (error) {
    return permissionDenied(`database_recheck_failed:${safeDiagnostic(error, "lstat")}`);
  }
  if (!sameIdentity(databaseIdentity, finalIdentity)) return permissionDenied("database_identity_changed");
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({ runtimeRoot, databasePath, backupDirectory, mode, databaseIdentity: finalIdentity, sidecars: Object.freeze(sidecars) }),
  });
}

export function verifyDatabaseIdentity(path: string, expected: FileIdentity): RuntimePersistenceRejection | undefined {
  try {
    const value = stat(path);
    if (value.isSymbolicLink || !value.isFile || value.nlink !== 1 || !ownerIsCurrent(value) || !secureMode(value, DATABASE_MODE, true)) {
      return rejection("permission_denied", "database_identity_changed");
    }
    if (!sameIdentity(expected, identity(value))) return rejection("permission_denied", "database_identity_changed");
    return undefined;
  } catch (error) {
    return rejection("permission_denied", `database_recheck_failed:${safeDiagnostic(error, "lstat")}`);
  }
}
