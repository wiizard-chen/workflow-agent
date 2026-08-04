import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  canonicalizeJson,
  type JsonValue,
} from "@pi-workflow/v2-domain";

import {
  acquireMigrationLock,
  type MigrationLock,
} from "../persistence/migration-lock.js";
import { createBootstrapRuntimeMigrations } from "../persistence/migrations.js";
import { openRuntimeDatabaseInternal, type RuntimeDatabaseInternal } from "../persistence/factory.js";
import type { NativeSqliteConnection } from "../persistence/native-sqlite.js";
import { E07_RUNTIME_EXTENSION, E07_RUNTIME_MIGRATION } from "./schema-extension.js";
import type {
  ArtifactMetadata,
  ArtifactOpenResult,
  ArtifactRecord,
  ArtifactRejection,
  ArtifactResult,
  ArtifactScan,
  ArtifactStore,
  ArtifactStoreOptions,
  ArtifactRetentionClass,
  ArtifactRedactionStatus,
} from "./types.js";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_STRING_BYTES = 256;
const MAX_PATH_BYTES = 4096;
const DIGEST = /^[0-9a-f]{64}$/;
const NO_FOLLOW = Number(constants.O_NOFOLLOW ?? 0);
const DIRECTORY_FLAG = Number(constants.O_DIRECTORY ?? 0);
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const UID = typeof process.getuid === "function" ? process.getuid() : undefined;
const RETENTION = new Set<ArtifactRetentionClass>(["ephemeral", "standard", "governance", "sensitive"]);
const REDACTION = new Set<ArtifactRedactionStatus>(["not-required", "pending", "redacted"]);

type RecordValue = Readonly<Record<string, unknown>>;
type FileIdentity = Readonly<{ readonly dev: number; readonly ino: number }>;
type CanonicalMetadata = Readonly<{
  readonly metadata: ArtifactMetadata;
  readonly text: string;
  readonly hash: string;
}>;
type StoredRecord = ArtifactRecord & Readonly<{
  readonly metadataText: string;
  readonly metadataHash: string;
}>;
type VerifiedObject = Readonly<{
  readonly bytes: Uint8Array;
  readonly identity: FileIdentity;
}>;
type CreatedObject = Readonly<{
  readonly created: boolean;
  readonly identity?: FileIdentity;
}>;

function rejection(code: ArtifactRejection["code"], diagnostic: string): ArtifactRejection {
  return Object.freeze({
    code,
    diagnostic: diagnostic.replaceAll(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 160) || code,
  });
}

function fail<T = never>(code: ArtifactRejection["code"], diagnostic: string): ArtifactResult<T> {
  return Object.freeze({ ok: false as const, rejection: rejection(code, diagnostic) });
}

function success<T>(value: T): ArtifactResult<T> {
  return Object.freeze({ ok: true as const, value });
}

function ownRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): RecordValue | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Object.getOwnPropertyNames(value);
    const allowed = new Set([...required, ...optional]);
    if (Object.getOwnPropertySymbols(value).length > 0 || keys.some((key) => !allowed.has(key))) return undefined;
    for (const key of required) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
    }
    return Object.freeze(Object.fromEntries(keys.map((key) => [key, (Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor).value])));
  } catch {
    return undefined;
  }
}

function boundedString(value: unknown, pattern: RegExp = /^[^\\0]+$/): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_STRING_BYTES && !value.includes("\0") && pattern.test(value);
}

function safeEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathString(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES && !value.includes("\0");
}

function validateOptions(input: unknown): ArtifactResult<Required<ArtifactStoreOptions>> {
  const exact = ownRecord(input, ["artifactRoot", "now"], ["mode"]);
  if (!exact || typeof exact.artifactRoot !== "string" || !isAbsolute(exact.artifactRoot) || !pathString(exact.artifactRoot) ||
      typeof exact.now !== "function" || (exact.mode !== undefined && exact.mode !== "read-only" && exact.mode !== "read-write")) {
    return fail("invalid_options", "artifact_options_invalid");
  }
  const artifactRoot = resolve(exact.artifactRoot);
  if (artifactRoot === sep || artifactRoot.length > MAX_PATH_BYTES) return fail("path_invalid", "artifact_root_invalid");
  return success(Object.freeze({
    artifactRoot,
    now: exact.now as () => number,
    mode: (exact.mode ?? "read-write") as "read-only" | "read-write",
  }));
}

function validateMetadata(input: unknown): ArtifactResult<CanonicalMetadata> {
  const exact = ownRecord(input, ["mediaType", "authority", "retentionClass"], ["redaction"]);
  if (!exact || !boundedString(exact.mediaType, /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/) ||
      !boundedString(exact.authority, /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/) ||
      typeof exact.retentionClass !== "string" || !RETENTION.has(exact.retentionClass as ArtifactRetentionClass)) {
    return fail("invalid_input", "artifact_metadata_invalid");
  }
  let redaction: ArtifactMetadata["redaction"];
  if (exact.redaction !== undefined) {
    const redactionRecord = ownRecord(exact.redaction, ["status"], ["policyId"]);
    if (!redactionRecord || typeof redactionRecord.status !== "string" || !REDACTION.has(redactionRecord.status as ArtifactRedactionStatus) ||
        (redactionRecord.policyId !== undefined && !boundedString(redactionRecord.policyId, /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/))) {
      return fail("invalid_input", "artifact_redaction_invalid");
    }
    redaction = Object.freeze({
      status: redactionRecord.status as ArtifactRedactionStatus,
      ...(redactionRecord.policyId === undefined ? {} : { policyId: redactionRecord.policyId }),
    });
  }
  const metadata = Object.freeze({
    mediaType: exact.mediaType,
    authority: exact.authority,
    retentionClass: exact.retentionClass as ArtifactRetentionClass,
    ...(redaction === undefined ? {} : { redaction }),
  });
  const canonical = canonicalizeJson(metadata as unknown as JsonValue);
  if (!canonical.ok) return fail("invalid_input", "artifact_metadata_noncanonical");
  return success(Object.freeze({
    metadata: canonical.value as unknown as ArtifactMetadata,
    text: canonical.text,
    hash: digestOf(Buffer.from(canonical.text, "utf8")),
  }));
}

function copyBytes(input: unknown): ArtifactResult<Uint8Array> {
  try {
    if (!(input instanceof Uint8Array)) return fail("invalid_input", "artifact_bytes_required");
    const length = input.byteLength;
    if (!Number.isSafeInteger(length) || length > MAX_BYTES) return fail("invalid_input", "artifact_bytes_too_large");
    const copied = Uint8Array.prototype.slice.call(input) as Uint8Array;
    if (copied.byteLength !== length) return fail("invalid_input", "artifact_bytes_copy_failed");
    return success(copied);
  } catch {
    return fail("invalid_input", "artifact_bytes_invalid");
  }
}

function artifactId(digest: string): string {
  return "sha256:" + digest;
}

function relativeObjectPath(digest: string): string {
  return join("objects", digest.slice(0, 2), digest);
}

function objectPath(root: string, digest: string): string {
  return join(root, "objects", digest.slice(0, 2), digest);
}

function mapRuntimeFailure(value: { readonly code: string; readonly diagnostic: string }): ArtifactRejection {
  if (value.code === "read_only") return rejection("read_only", value.diagnostic);
  if (value.code === "driver_unavailable") return rejection("driver_unavailable", value.diagnostic);
  if (value.code === "invalid_path") return rejection("path_invalid", value.diagnostic);
  if (value.code === "permission_denied") return rejection("permission_denied", value.diagnostic);
  return rejection("transaction_failed", value.diagnostic);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function owner(value: Stats): boolean {
  return UID === undefined || value.uid === UID;
}

function safeDirectoryStats(value: Stats): boolean {
  return value.isDirectory() && !value.isSymbolicLink() && owner(value) &&
    (value.mode & 0o077) === 0 && (value.mode & 0o7000) === 0 && (value.mode & 0o700) === 0o700;
}

function safeObjectStats(value: Stats): boolean {
  return value.isFile() && !value.isSymbolicLink() && value.nlink === 1 && owner(value) &&
    (value.mode & 0o7777) === FILE_MODE;
}

function ensureDirectory(path: string, readOnly: boolean): ArtifactResult<boolean> {
  try {
    const current = lstatSync(path);
    if (!safeDirectoryStats(current)) return fail("path_invalid", "artifact_directory_unsafe");
    return success(true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("permission_denied", "artifact_directory_unavailable");
    if (readOnly) return success(false);
    try {
      mkdirSync(path, { mode: DIRECTORY_MODE });
      const created = lstatSync(path);
      if (!safeDirectoryStats(created)) return fail("path_invalid", "artifact_directory_unsafe");
      return success(true);
    } catch {
      return fail("permission_denied", "artifact_directory_create_failed");
    }
  }
}

function fsyncDirectory(path: string): void {
  try {
    const descriptor = openSync(path, constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW);
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  } catch {
    // Directory fsync is not available on every supported local filesystem.
  }
}

function safeObjectFd(path: string): ArtifactResult<Readonly<{ readonly fd: number; readonly identity: FileIdentity; readonly size: number }>> {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const stat = fstatSync(fd);
    if (!safeObjectStats(stat) || !Number.isSafeInteger(stat.size) || stat.size > MAX_BYTES) {
      closeSync(fd);
      return fail("corrupt", "artifact_object_identity_invalid");
    }
    return success(Object.freeze({ fd, identity: Object.freeze({ dev: stat.dev, ino: stat.ino }), size: stat.size }));
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve primary failure */ }
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fail("not_found", "artifact_object_missing");
    if (code === "ELOOP") return fail("corrupt", "artifact_object_symlink");
    return fail("corrupt", "artifact_object_unavailable");
  }
}

function readVerifiedObject(path: string, expectedDigest: string, expectedSize: number): ArtifactResult<VerifiedObject> {
  const opened = safeObjectFd(path);
  if (!opened.ok) return opened;
  try {
    const value = readFileSync(opened.value.fd);
    const bytes = Uint8Array.prototype.slice.call(value) as Uint8Array;
    if (bytes.byteLength !== expectedSize || digestOf(bytes) !== expectedDigest) {
      return fail("corrupt", "artifact_object_digest_mismatch");
    }
    return success(Object.freeze({
      bytes,
      identity: opened.value.identity,
    }));
  } catch {
    return fail("corrupt", "artifact_object_read_failed");
  } finally {
    try { closeSync(opened.value.fd); } catch { /* preserve original result */ }
  }
}

function readRow(connection: NativeSqliteConnection, artifactIdValue: string): unknown {
  return connection.prepare(
    "SELECT artifact_id, sha256, relative_path, byte_size, metadata_json, metadata_hash, created_at_ms FROM workflow_artifact_registry WHERE artifact_id = $artifactId",
  ).get({ $artifactId: artifactIdValue });
}

function allRows(connection: NativeSqliteConnection): readonly unknown[] {
  return connection.prepare(
    "SELECT artifact_id, sha256, relative_path, byte_size, metadata_json, metadata_hash, created_at_ms FROM workflow_artifact_registry ORDER BY sha256 ASC",
  ).all();
}

function rowValue(row: unknown, key: string): unknown {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return undefined;
  return (row as Record<string, unknown>)[key];
}

function parseStoredRow(row: unknown): ArtifactResult<StoredRecord> {
  if (row === undefined || row === null || typeof row !== "object" || Array.isArray(row)) return fail("registry_corrupt", "artifact_registry_row_missing");
  const artifactIdValue = rowValue(row, "artifact_id");
  const digest = rowValue(row, "sha256");
  const relativePath = rowValue(row, "relative_path");
  const size = rowValue(row, "byte_size");
  const metadataJson = rowValue(row, "metadata_json");
  const metadataHash = rowValue(row, "metadata_hash");
  const createdAt = rowValue(row, "created_at_ms");
  if (typeof artifactIdValue !== "string" || typeof digest !== "string" || !DIGEST.test(digest) ||
      artifactIdValue !== artifactId(digest) || typeof relativePath !== "string" ||
      relativePath !== relativeObjectPath(digest) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES ||
      typeof metadataJson !== "string" || typeof metadataHash !== "string" || !DIGEST.test(metadataHash) || !safeEpoch(createdAt)) {
    return fail("registry_corrupt", "artifact_registry_row_invalid");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(metadataJson); } catch { return fail("registry_corrupt", "artifact_metadata_json_invalid"); }
  const canonical = canonicalizeJson(parsed as JsonValue);
  if (!canonical.ok || canonical.text !== metadataJson) return fail("registry_corrupt", "artifact_metadata_json_noncanonical");
  const metadata = validateMetadata(canonical.value);
  if (!metadata.ok || metadata.value.text !== metadataJson || metadata.value.hash !== metadataHash) return fail("registry_corrupt", "artifact_metadata_hash_mismatch");
  return success(Object.freeze({
    artifactId: artifactIdValue,
    sha256: digest,
    relativePath,
    byteSize: size,
    createdAtEpochMs: createdAt,
    ...metadata.value.metadata,
    metadataText: metadataJson,
    metadataHash,
  }));
}

function registryRows(connection: NativeSqliteConnection): ArtifactResult<readonly StoredRecord[]> {
  try {
    const parsed = allRows(connection).map((row) => parseStoredRow(row));
    const bad = parsed.find((item) => !item.ok);
    if (bad && !bad.ok) return bad;
    return success(Object.freeze(parsed.map((item) => (item as { readonly ok: true; readonly value: StoredRecord }).value)));
  } catch {
    return fail("registry_corrupt", "artifact_registry_read_failed");
  }
}

function metadataMatches(row: StoredRecord, metadata: CanonicalMetadata): boolean {
  return row.metadataHash === metadata.hash && row.metadataText === metadata.text;
}

function publicRecord(row: StoredRecord): ArtifactRecord {
  return Object.freeze({
    artifactId: row.artifactId,
    sha256: row.sha256,
    relativePath: row.relativePath,
    byteSize: row.byteSize,
    createdAtEpochMs: row.createdAtEpochMs,
    mediaType: row.mediaType,
    authority: row.authority,
    retentionClass: row.retentionClass,
    ...(row.redaction === undefined ? {} : { redaction: row.redaction }),
  });
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (!Number.isSafeInteger(written) || written <= 0) throw new Error("artifact_write_short");
    offset += written;
  }
}

function writeObject(root: string, stagingRoot: string, bytes: Uint8Array, digest: string): ArtifactResult<CreatedObject> {
  const finalPath = objectPath(root, digest);
  try {
    const existing = lstatSync(finalPath);
    const verified = readVerifiedObject(finalPath, digest, bytes.byteLength);
    if (!verified.ok) return verified;
    return success(Object.freeze({ created: false, identity: verified.value.identity }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("corrupt", "artifact_object_preflight_failed");
  }
  const prefix = join(root, "objects", digest.slice(0, 2));
  const objects = ensureDirectory(join(root, "objects"), false);
  if (!objects.ok || !objects.value) return objects.ok ? fail("path_invalid", "artifact_objects_unavailable") : objects;
  const prefixResult = ensureDirectory(prefix, false);
  if (!prefixResult.ok || !prefixResult.value) return prefixResult.ok ? fail("path_invalid", "artifact_prefix_unavailable") : prefixResult;
  const stagingDir = ensureDirectory(stagingRoot, false);
  if (!stagingDir.ok || !stagingDir.value) return stagingDir.ok ? fail("path_invalid", "artifact_staging_unavailable") : stagingDir;
  const temporary = join(stagingRoot, ".artifact-" + randomBytes(16).toString("hex"));
  let fd: number | undefined;
  let linked = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, FILE_MODE);
    writeAll(fd, bytes);
    fsyncSync(fd);
    fchmodSync(fd, FILE_MODE);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temporary, finalPath);
      linked = true;
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        try { unlinkSync(temporary); } catch { /* best effort staging cleanup */ }
        const verified = readVerifiedObject(finalPath, digest, bytes.byteLength);
        if (!verified.ok) return verified;
        return success(Object.freeze({ created: false, identity: verified.value.identity }));
      }
      throw error;
    }
    fsyncDirectory(prefix);
    const finalStat = lstatSync(finalPath);
    if (!safeObjectStats(finalStat)) return fail("corrupt", "artifact_object_postflight_failed");
    return success(Object.freeze({ created: true, identity: Object.freeze({ dev: finalStat.dev, ino: finalStat.ino }) }));
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve primary failure */ }
    }
    if (!linked) {
      try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    }
    return fail("permission_denied", "artifact_object_write_failed");
  }
}

function removeCreatedObject(path: string, identity: FileIdentity | undefined): void {
  if (!identity) return;
  try {
    const current = lstatSync(path);
    if (sameIdentity(current, identity) && current.nlink === 1) unlinkSync(path);
  } catch {
    // Cleanup is best effort and never masks the primary transaction result.
  }
}

function withWrite<T>(
  internal: RuntimeDatabaseInternal,
  action: (connection: NativeSqliteConnection) => ArtifactResult<T>,
  cleanup: () => void,
): ArtifactResult<T> {
  if (internal.publicHandle.status.mode === "read-only" || !internal.publicHandle.status.writable) return fail("read_only", "artifact_store_read_only");
  const acquired = acquireMigrationLock(internal.connection);
  if (!acquired.ok) return fail(acquired.rejection.code === "read_only" ? "read_only" : "transaction_failed", acquired.rejection.diagnostic);
  const lock: MigrationLock = acquired.value;
  try {
    const result = action(internal.connection);
    if (!result.ok) {
      lock.rollback();
      cleanup();
      return result;
    }
    const committed = lock.commit();
    if (!committed.ok) {
      lock.rollback();
      cleanup();
      return fail("transaction_failed", "artifact_registry_commit_failed");
    }
    return result;
  } catch {
    lock.rollback();
    cleanup();
    return fail("transaction_failed", "artifact_registry_transaction_failed");
  }
}

function registeredPath(root: string, relativePath: string): string {
  return join(root, relativePath);
}

function scanObjectTree(root: string, registered: ReadonlySet<string>): Readonly<{ readonly orphans: readonly string[]; readonly corrupt: readonly string[] }> {
  const orphans: string[] = [];
  const corrupt: string[] = [];
  const objectsRoot = join(root, "objects");
  let objectsStat: Stats;
  try {
    objectsStat = lstatSync(objectsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ orphans: Object.freeze([]), corrupt: Object.freeze([]) });
    return Object.freeze({ orphans: Object.freeze([]), corrupt: Object.freeze(["objects-root-unavailable"]) });
  }
  if (!safeDirectoryStats(objectsStat)) return Object.freeze({ orphans: Object.freeze([]), corrupt: Object.freeze(["objects-root-unsafe"]) });
  let prefixes: readonly Dirent[];
  try { prefixes = readdirSync(objectsRoot, { withFileTypes: true }); } catch { return Object.freeze({ orphans: Object.freeze([]), corrupt: Object.freeze(["objects-root-unreadable"]) }); }
  for (const prefixEntry of prefixes) {
    const prefix = prefixEntry.name;
    const prefixRelative = join("objects", prefix);
    if (!/^[0-9a-f]{2}$/.test(prefix)) {
      corrupt.push("unsafe:" + prefixRelative);
      continue;
    }
    const prefixPath = join(objectsRoot, prefix);
    let prefixStat: Stats;
    try { prefixStat = lstatSync(prefixPath); } catch { corrupt.push("unsafe:" + prefixRelative); continue; }
    if (!safeDirectoryStats(prefixStat)) {
      corrupt.push("unsafe:" + prefixRelative);
      continue;
    }
    let entries: readonly Dirent[];
    try { entries = readdirSync(prefixPath, { withFileTypes: true }); } catch { corrupt.push("unsafe:" + prefixRelative); continue; }
    for (const entry of entries) {
      const digest = entry.name;
      const relativePath = join(prefixRelative, digest);
      if (!DIGEST.test(digest)) {
        corrupt.push("unsafe:" + relativePath);
        continue;
      }
      let stat: Stats;
      try { stat = lstatSync(join(prefixPath, digest)); } catch { corrupt.push("unsafe:" + relativePath); continue; }
      if (!safeObjectStats(stat)) {
        corrupt.push("unsafe:" + relativePath);
        continue;
      }
      if (!registered.has(relativePath)) orphans.push(relativePath);
    }
  }
  return Object.freeze({ orphans: Object.freeze(orphans.sort()), corrupt: Object.freeze(corrupt.sort()) });
}

function nowValue(now: () => number): ArtifactResult<number> {
  try {
    const value = now();
    return safeEpoch(value) ? success(value) : fail("invalid_input", "artifact_time_invalid");
  } catch {
    return fail("invalid_input", "artifact_time_invalid");
  }
}

export function openArtifactStore(optionsInput: unknown): ArtifactOpenResult {
  const options = validateOptions(optionsInput);
  if (!options.ok) return options;
  const metadataDatabase = join(options.value.artifactRoot, "artifact-meta.db");
  const migrations = Object.freeze([...createBootstrapRuntimeMigrations(), E07_RUNTIME_MIGRATION]);
  const opened = openRuntimeDatabaseInternal({
    runtimeRoot: options.value.artifactRoot,
    databasePath: metadataDatabase,
    mode: options.value.mode,
    migrations,
  }, E07_RUNTIME_EXTENSION);
  if (!opened.ok) return fail(mapRuntimeFailure(opened.rejection).code, mapRuntimeFailure(opened.rejection).diagnostic);
  const internal = opened.value;
  const objects = ensureDirectory(join(options.value.artifactRoot, "objects"), options.value.mode === "read-only");
  const staging = ensureDirectory(join(options.value.artifactRoot, "tmp"), options.value.mode === "read-only");
  if (!objects.ok || !staging.ok || (options.value.mode === "read-write" && (!objects.value || !staging.value))) {
    internal.publicHandle.close();
    const failure = !objects.ok ? objects : staging;
    return failure.ok ? fail("path_invalid", "artifact_child_directory_unavailable") : failure;
  }
  let closed = false;
  const guard = <T>(action: () => ArtifactResult<T>): ArtifactResult<T> => {
    if (closed) return fail("store_closed", "artifact_store_closed");
    return action();
  };
  const verifyById = (idInput: unknown): ArtifactResult<StoredRecord> => {
    if (typeof idInput !== "string" || !/^sha256:[0-9a-f]{64}$/.test(idInput)) return fail("invalid_input", "artifact_id_invalid");
    let row: unknown;
    try { row = readRow(internal.connection, idInput); } catch { return fail("registry_corrupt", "artifact_registry_read_failed"); }
    return parseStoredRow(row);
  };
  const verifyRecord = (row: StoredRecord): ArtifactResult<ArtifactRecord> => {
    const verified = readVerifiedObject(registeredPath(options.value.artifactRoot, row.relativePath), row.sha256, row.byteSize);
    if (!verified.ok) return verified;
    return success(publicRecord(row));
  };
  const verify = (idInput: unknown): ArtifactResult<ArtifactRecord> => guard(() => {
    const row = verifyById(idInput);
    if (!row.ok) return row;
    return verifyRecord(row.value);
  });
  const read = (idInput: unknown): ArtifactResult<Uint8Array> => guard(() => {
    const row = verifyById(idInput);
    if (!row.ok) return row;
    const verified = readVerifiedObject(registeredPath(options.value.artifactRoot, row.value.relativePath), row.value.sha256, row.value.byteSize);
    return verified.ok ? success(verified.value.bytes) : verified;
  });
  const manifest = (): ArtifactResult<readonly ArtifactRecord[]> => guard(() => {
    const rows = registryRows(internal.connection);
    if (!rows.ok) return rows;
    return success(Object.freeze(rows.value.map((row) => publicRecord(row))));
  });
  const scan = (): ArtifactResult<ArtifactScan> => guard(() => {
    const rows = registryRows(internal.connection);
    if (!rows.ok) return rows;
    const missing: string[] = [];
    const corrupt: string[] = [];
    const registered = new Set<string>();
    for (const row of rows.value) {
      registered.add(row.relativePath);
      const verified = readVerifiedObject(registeredPath(options.value.artifactRoot, row.relativePath), row.sha256, row.byteSize);
      if (!verified.ok) {
        if (verified.rejection.code === "not_found") missing.push(row.artifactId);
        else corrupt.push(row.artifactId);
      }
    }
    const tree = scanObjectTree(options.value.artifactRoot, registered);
    corrupt.push(...tree.corrupt);
    const sortedMissing = Object.freeze(missing.sort());
    const sortedCorrupt = Object.freeze([...new Set(corrupt)].sort());
    const sortedOrphans = tree.orphans;
    return success(Object.freeze({
      status: sortedMissing.length === 0 && sortedCorrupt.length === 0 && sortedOrphans.length === 0 ? "clean" : "issues",
      registered: rows.value.length,
      missing: sortedMissing,
      corrupt: sortedCorrupt,
      orphans: sortedOrphans,
    }));
  });
  const put = (bytesInput: Uint8Array, metadataInput: unknown): ArtifactResult<ArtifactRecord> => guard(() => {
    const bytes = copyBytes(bytesInput);
    if (!bytes.ok) return bytes;
    const metadata = validateMetadata(metadataInput);
    if (!metadata.ok) return metadata;
    const digest = digestOf(bytes.value);
    const id = artifactId(digest);
    const relativePath = relativeObjectPath(digest);
    const createdAt = nowValue(options.value.now);
    if (!createdAt.ok) return createdAt;
    let createdPath: string | undefined;
    let createdIdentity: FileIdentity | undefined;
    const result = withWrite(internal, (connection) => {
      let row: unknown;
      try { row = readRow(connection, id); } catch { return fail("registry_corrupt", "artifact_registry_read_failed"); }
      if (row !== undefined && row !== null) {
        const existing = parseStoredRow(row);
        if (!existing.ok) return existing;
        if (!metadataMatches(existing.value, metadata.value)) return fail("collision", "artifact_digest_metadata_collision");
        const current = readVerifiedObject(
          registeredPath(options.value.artifactRoot, existing.value.relativePath),
          existing.value.sha256,
          existing.value.byteSize,
        );
        if (current.ok) return success(publicRecord(existing.value));
        if (current.rejection.code !== "not_found") return current;
        const object = writeObject(options.value.artifactRoot, join(options.value.artifactRoot, "tmp"), bytes.value, digest);
        if (!object.ok) return object;
        if (object.value.created) {
          createdPath = objectPath(options.value.artifactRoot, digest);
          createdIdentity = object.value.identity;
        }
        return success(publicRecord(existing.value));
      }
      const object = writeObject(options.value.artifactRoot, join(options.value.artifactRoot, "tmp"), bytes.value, digest);
      if (!object.ok) return object;
      if (object.value.created) {
        createdPath = objectPath(options.value.artifactRoot, digest);
        createdIdentity = object.value.identity;
      }
      try {
        connection.prepare(
          "INSERT INTO workflow_artifact_registry (artifact_id, sha256, relative_path, byte_size, metadata_json, metadata_hash, created_at_ms) VALUES ($artifactId, $sha256, $relativePath, $byteSize, $metadataJson, $metadataHash, $createdAt)",
        ).run({
          $artifactId: id,
          $sha256: digest,
          $relativePath: relativePath,
          $byteSize: bytes.value.byteLength,
          $metadataJson: metadata.value.text,
          $metadataHash: metadata.value.hash,
          $createdAt: createdAt.value,
        });
        const inserted = parseStoredRow(readRow(connection, id));
        return inserted.ok ? success(publicRecord(inserted.value)) : inserted;
      } catch {
        return fail("transaction_failed", "artifact_registry_insert_failed");
      }
    }, () => {
      removeCreatedObject(createdPath ?? "", createdIdentity);
    });
    return result;
  });
  const close = (): void => {
    if (closed) return;
    closed = true;
    internal.publicHandle.close();
  };
  const store: ArtifactStore = Object.freeze({ put, read, verify, manifest, scan, close });
  return success(store);
}
