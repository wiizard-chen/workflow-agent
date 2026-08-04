import { createHash } from "node:crypto";

import {
  canonicalizeJson,
  type JsonValue,
  type StepAttemptId,
} from "@pi-workflow/v2-domain";

import {
  acquireMigrationLock,
  type MigrationLock,
} from "../persistence/migration-lock.js";
import { createBootstrapRuntimeMigrations } from "../persistence/migrations.js";
import { openRuntimeDatabaseInternal, type RuntimeDatabaseInternal } from "../persistence/factory.js";
import { safeDiagnostic } from "../persistence/errors.js";
import { E05_RUNTIME_EXTENSION, E05_RUNTIME_MIGRATION } from "../persistence/e05-schema.js";
import { assertCurrentLeaseInTransaction } from "../leases/store.js";
import { E08_RUNTIME_EXTENSION, E08_RUNTIME_MIGRATION } from "../leases/schema.js";
import type { NativeSqliteConnection } from "../persistence/native-sqlite.js";
import type { LeaseCredentials } from "../leases/index.js";

import { E10_RUNTIME_EXTENSION, E10_RUNTIME_MIGRATION } from "./schema.js";
import type {
  RecoveryAction,
  RecoveryCase,
  RecoveryReport,
  StepAdoptInput,
  StepAttemptRecord,
  StepEffect,
  StepLedger,
  StepLedgerOptions,
  StepPlanInput,
  StepPrepareInput,
  StepRecord,
  StepRejection,
  StepRejectionCode,
  StepResult,
  StepRetryInput,
  StepState,
  StepTransitionInput,
  StepValidation,
} from "./types.js";

const DIGEST = /^[0-9a-f]{64}$/;
const MAX_TEXT_BYTES = 512;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_JSON_BYTES = 1024 * 1024;
const STEP_STATES: readonly StepState[] = [
  "planned", "prepared", "executing", "effect-observed", "validated", "completed",
  "failed", "aborted", "superseded", "unknown",
];
const RECOVERY_ACTIONS: readonly RecoveryAction[] = ["adopt", "retry", "supersede", "manual-recovery"];

type Row = Readonly<Record<string, unknown>>;
type LeaseProof = Readonly<{ readonly leaseId: string; readonly fencingToken: number }>;
type Canonical = Readonly<{ readonly value: JsonValue; readonly text: string; readonly hash: string }>;

function rejection<T = never>(code: StepRejectionCode, diagnostic: string): StepResult<T> {
  return Object.freeze({ ok: false as const, rejection: Object.freeze({ code, diagnostic }) });
}

function success<T>(value: T): StepResult<T> {
  return Object.freeze({ ok: true as const, value });
}

function objectLike(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Check a required callable through its own data descriptor, never a getter. */
function callableOwn(value: unknown, key: string): boolean {
  if (!objectLike(value)) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "function";
  } catch {
    return false;
  }
}

/** Read a plain data-only record without invoking accessors or proxy getters. */
function ownRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Readonly<Record<string, unknown>> | undefined {
  if (!objectLike(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    const allowed = new Set([...required, ...optional]);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      result[key] = descriptor.value;
    }
    for (const key of required) if (!Object.prototype.hasOwnProperty.call(result, key)) return undefined;
    return Object.freeze(result);
  } catch {
    return undefined;
  }
}

function row(value: unknown): Row | undefined {
  if (!objectLike(value)) return undefined;
  try {
    return Object.freeze(Object.fromEntries(Object.keys(value).map((key) => [key, (value as Record<string, unknown>)[key]])));
  } catch {
    return undefined;
  }
}

function rowField(value: Row, key: string): unknown {
  return value[key];
}

function integer(value: unknown, minimum = 0): value is number {
  if (typeof value === "bigint") return value >= BigInt(minimum) && value <= BigInt(Number.MAX_SAFE_INTEGER);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= Number.MAX_SAFE_INTEGER;
}

function numberValue(value: unknown, minimum = 0): number | undefined {
  if (typeof value === "bigint" && value >= BigInt(minimum) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}

function text(value: unknown, maxBytes = MAX_TEXT_BYTES): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function epoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_MS;
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): StepResult<Canonical> {
  try {
    const result = canonicalizeJson(value as JsonValue);
    if (!result.ok || Buffer.byteLength(result.text, "utf8") > MAX_JSON_BYTES) return rejection("invalid_input", "canonical_json_invalid");
    return success(Object.freeze({ value: result.value as JsonValue, text: result.text, hash: digestText(result.text) }));
  } catch {
    return rejection("invalid_input", "canonical_json_invalid");
  }
}

function parseStoredJson(value: unknown): StepResult<JsonValue | undefined> {
  if (value === null || value === undefined) return success(undefined);
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_JSON_BYTES) return rejection("schema_corrupt", "stored_json_invalid");
  try {
    const parsed: unknown = JSON.parse(value);
    const normalized = canonical(parsed);
    if (!normalized.ok || normalized.value.text !== value) return rejection("schema_corrupt", "stored_json_noncanonical");
    return success(normalized.value.value);
  } catch {
    return rejection("schema_corrupt", "stored_json_parse_failed");
  }
}

function mapLeaseCode(code: unknown): StepRejectionCode {
  if (code === "lease_expired" || code === "lease_revoked" || code === "lease_not_found" || code === "store_closed" || code === "clock_invalid") return "lease_lost";
  if (code === "lease_fenced") return "lease_fenced";
  return "lease_required";
}

function parseResultShape(value: unknown): Readonly<{ readonly ok: boolean; readonly value?: unknown; readonly rejection?: Readonly<Record<string, unknown>> }> | undefined {
  if (!objectLike(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "ok");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "boolean") return undefined;
    if (descriptor.value) {
      const valueDescriptor = Object.getOwnPropertyDescriptor(value, "value");
      return Object.freeze({ ok: true, ...(valueDescriptor && "value" in valueDescriptor ? { value: valueDescriptor.value } : {}) });
    }
    const rejectionDescriptor = Object.getOwnPropertyDescriptor(value, "rejection");
    if (!rejectionDescriptor || !("value" in rejectionDescriptor)) return Object.freeze({ ok: false });
    const rejectionRecord = ownRecord(rejectionDescriptor.value, ["code", "diagnostic"]);
    return Object.freeze({ ok: false, ...(rejectionRecord ? { rejection: rejectionRecord } : {}) });
  } catch {
    return undefined;
  }
}

function parseLeaseProof(value: unknown): StepResult<LeaseProof> {
  const exact = ownRecord(value, ["record", "checkedAtEpochMs"]);
  if (!exact || !epoch(exact.checkedAtEpochMs)) return rejection("lease_required", "lease_proof_invalid");
  const record = ownRecord(exact.record, ["resourceKind", "resourceId", "leaseId", "ownerId", "fencingToken", "issuedAtEpochMs", "heartbeatAtEpochMs", "expiresAtEpochMs", "status"], ["revokedAtEpochMs"]);
  if (!record || !text(record.leaseId) || !integer(record.fencingToken, 1) || !text(record.resourceKind) || !text(record.resourceId) || !text(record.ownerId) ||
      !epoch(record.issuedAtEpochMs) || !epoch(record.heartbeatAtEpochMs) || !epoch(record.expiresAtEpochMs) || record.status !== "active") {
    return rejection("lease_required", "lease_proof_invalid");
  }
  return success(Object.freeze({ leaseId: record.leaseId, fencingToken: record.fencingToken }));
}

function parseLeaseInput(value: unknown): StepResult<LeaseCredentials> {
  const exact = ownRecord(value, ["resourceKind", "resourceId", "ownerId", "leaseId", "fencingToken"], ["issuedAtEpochMs", "heartbeatAtEpochMs", "expiresAtEpochMs", "status", "revokedAtEpochMs"]);
  if (!exact || !text(exact.resourceKind) || !text(exact.resourceId) || !text(exact.ownerId) || !text(exact.leaseId) || !integer(exact.fencingToken, 1)) {
    return rejection("lease_required", "lease_credentials_invalid");
  }
  return success(Object.freeze({ resourceKind: exact.resourceKind, resourceId: exact.resourceId, ownerId: exact.ownerId, leaseId: exact.leaseId, fencingToken: exact.fencingToken } as LeaseCredentials));
}

function parseNow(now: () => number): StepResult<number> {
  try {
    const value = now();
    return epoch(value) ? success(value) : rejection("invalid_input", "clock_invalid");
  } catch {
    return rejection("invalid_input", "clock_failed");
  }
}

function parseState(value: unknown): value is StepState {
  return typeof value === "string" && (STEP_STATES as readonly string[]).includes(value);
}

function parseAction(value: unknown): value is RecoveryAction {
  return typeof value === "string" && (RECOVERY_ACTIONS as readonly string[]).includes(value);
}

function parseStepId(value: unknown): value is string {
  return text(value, 256) && !value.includes("/") && !value.includes("\\");
}

function parseDigestOrIdentifier(value: unknown): value is string {
  return text(value, 256);
}

function parseEffect(value: unknown): StepResult<StepEffect> {
  const exact = ownRecord(value, ["effectKey", "outcome"], ["artifactId", "artifactSha256"]);
  if (!exact || !text(exact.effectKey) || !["confirmed", "rejected", "unknown"].includes(exact.outcome as string)) return rejection("invalid_input", "effect_invalid");
  if (exact.artifactId !== undefined && !text(exact.artifactId)) return rejection("invalid_input", "effect_artifact_invalid");
  if (exact.artifactSha256 !== undefined && !digest(exact.artifactSha256)) return rejection("invalid_input", "effect_digest_invalid");
  if (exact.artifactId === undefined && exact.artifactSha256 !== undefined) return rejection("invalid_input", "effect_artifact_binding_invalid");
  return success(Object.freeze({
    effectKey: exact.effectKey,
    outcome: exact.outcome as StepEffect["outcome"],
    ...(exact.artifactId === undefined ? {} : { artifactId: exact.artifactId }),
    ...(exact.artifactSha256 === undefined ? {} : { artifactSha256: exact.artifactSha256 }),
  }));
}

function parseValidation(value: unknown): StepResult<StepValidation> {
  const exact = ownRecord(value, ["artifactId", "artifactSha256", "validatedAtEpochMs"]);
  if (!exact || !text(exact.artifactId) || !digest(exact.artifactSha256) || !epoch(exact.validatedAtEpochMs)) return rejection("invalid_input", "validation_invalid");
  return success(Object.freeze({ artifactId: exact.artifactId, artifactSha256: exact.artifactSha256, validatedAtEpochMs: exact.validatedAtEpochMs }));
}

function parseStoredRecord(connection: NativeSqliteConnection, value: unknown): StepResult<StepRecord> {
  const raw = row(value);
  if (!raw) return rejection("schema_corrupt", "step_row_invalid");
  const stepId = rowField(raw, "step_id");
  const state = rowField(raw, "state");
  const revision = numberValue(rowField(raw, "revision"));
  const updated = numberValue(rowField(raw, "updated_at_ms"));
  const attemptId = rowField(raw, "step_attempt_id");
  const input = parseStoredJson(rowField(raw, "input_json"));
  const inputSha256 = rowField(raw, "input_sha256");
  const expectedHead = rowField(raw, "expected_head");
  const expectedHeadSha256 = rowField(raw, "expected_head_sha256");
  const policySha256 = rowField(raw, "policy_sha256");
  const role = rowField(raw, "role");
  const model = rowField(raw, "model");
  const outputLocation = rowField(raw, "output_location");
  const workerGeneration = numberValue(rowField(raw, "worker_generation"));
  const leaseId = rowField(raw, "lease_id");
  const fencingToken = numberValue(rowField(raw, "fencing_token"), 1);
  const created = numberValue(rowField(raw, "created_at_ms"));
  const effect = parseStoredJson(rowField(raw, "effect_json"));
  const validation = parseStoredJson(rowField(raw, "validation_json"));
  if (!parseStepId(stepId) || !parseState(state) || revision === undefined || updated === undefined || created === undefined || updated < created ||
      !input.ok || input.value === undefined || !digest(inputSha256) || digestText(jsonText(input.value)) !== inputSha256 ||
      (expectedHead !== null && expectedHead !== undefined && !text(expectedHead)) || (expectedHeadSha256 !== null && expectedHeadSha256 !== undefined && !digest(expectedHeadSha256)) ||
      (expectedHead === null && expectedHeadSha256 !== null) || (expectedHead !== null && expectedHead !== undefined && expectedHeadSha256 !== digestText(expectedHead)) ||
      !digest(policySha256) || !text(role) || !text(model) || !text(outputLocation) || workerGeneration === undefined || !text(leaseId) || fencingToken === undefined ||
      (attemptId !== null && attemptId !== undefined && !text(attemptId)) || !effect.ok || !validation.ok) {
    return rejection("schema_corrupt", "step_row_invalid");
  }
  if (effect.value !== undefined) {
    const parsedEffect = parseEffect(effect.value);
    if (!parsedEffect.ok) return rejection("schema_corrupt", "step_effect_invalid");
  }
  if (validation.value !== undefined) {
    const parsedValidation = parseValidation(validation.value);
    if (!parsedValidation.ok) return rejection("schema_corrupt", "step_validation_invalid");
  }
  if (state === "completed" && validation.value === undefined) return rejection("schema_corrupt", "completed_step_without_validation");
  // Verify the referenced attempt and projection hashes whenever a step is read.
  if (attemptId !== null && attemptId !== undefined) {
    const countRow = row(connection.prepare("SELECT COUNT(*) AS count FROM workflow_step_attempt WHERE step_attempt_id = $id").get({ $id: attemptId }));
    const count = numberValue(countRow === undefined ? undefined : rowField(countRow, "count"));
    if (count !== 1) return rejection("schema_corrupt", "step_attempt_reference_invalid");
  }
  const projected = Object.freeze({
    stepId,
    state,
    revision,
    ...(attemptId === null || attemptId === undefined ? {} : { stepAttemptId: attemptId as StepAttemptId }),
    ...(effect.value === undefined ? {} : { effect: effect.value }),
    ...(validation.value === undefined ? {} : { validation: validation.value }),
    updatedAtEpochMs: updated,
  });
  return success(projected);
}

function parseStoredAttempt(value: unknown): StepResult<StepAttemptRecord> {
  const raw = row(value);
  if (!raw) return rejection("schema_corrupt", "attempt_row_invalid");
  const input = parseStoredJson(rowField(raw, "input_json"));
  const stepAttemptId = rowField(raw, "step_attempt_id");
  const stepId = rowField(raw, "step_id");
  const sequence = numberValue(rowField(raw, "sequence"), 1);
  const idempotencyKey = rowField(raw, "idempotency_key");
  const inputSha256 = rowField(raw, "input_sha256");
  const expectedHead = rowField(raw, "expected_head");
  const expectedHeadSha256 = rowField(raw, "expected_head_sha256");
  const policySha256 = rowField(raw, "policy_sha256");
  const role = rowField(raw, "role");
  const model = rowField(raw, "model");
  const outputLocation = rowField(raw, "output_location");
  const workerGeneration = numberValue(rowField(raw, "worker_generation"));
  const leaseId = rowField(raw, "lease_id");
  const fencingToken = numberValue(rowField(raw, "fencing_token"), 1);
  const preparedAt = numberValue(rowField(raw, "prepared_at_ms"));
  if (!input.ok || input.value === undefined || !text(stepAttemptId) || !parseStepId(stepId) || sequence === undefined || !text(idempotencyKey) || !digest(inputSha256) ||
      (expectedHead !== null && expectedHead !== undefined && !text(expectedHead)) || (expectedHeadSha256 !== null && expectedHeadSha256 !== undefined && !digest(expectedHeadSha256)) ||
      !digest(policySha256) || !text(role) || !text(model) || !text(outputLocation) || workerGeneration === undefined || !text(leaseId) || fencingToken === undefined || preparedAt === undefined) {
    return rejection("schema_corrupt", "attempt_row_invalid");
  }
  if (expectedHead === null && expectedHeadSha256 !== null) return rejection("schema_corrupt", "attempt_head_binding_invalid");
  if (expectedHead !== null && expectedHead !== undefined && expectedHeadSha256 !== digestText(expectedHead)) return rejection("schema_corrupt", "attempt_head_binding_invalid");
  if (input.value !== undefined && digestText(jsonText(input.value)) !== inputSha256) return rejection("schema_corrupt", "attempt_input_hash_mismatch");
  return success(Object.freeze({
    stepAttemptId: stepAttemptId as StepAttemptId,
    stepId,
    sequence,
    idempotencyKey,
    inputJson: input.value,
    inputSha256,
    ...(expectedHead === null || expectedHead === undefined ? {} : { expectedHead }),
    policySha256,
    role,
    model,
    outputLocation,
    workerGeneration,
    leaseId,
    fencingToken,
    preparedAtEpochMs: preparedAt,
  }));
}

function operationHash(method: string, value: unknown): StepResult<Readonly<{ readonly hash: string; readonly text: string }>> {
  const normalized = canonical({ method, value });
  return normalized.ok ? success(Object.freeze({ hash: normalized.value.hash, text: normalized.value.text })) : normalized;
}

function operationId(hash: string): string {
  return `step_evt_${hash}`;
}

function attemptId(hash: string): StepAttemptId {
  return `step_attempt_${hash}` as StepAttemptId;
}

function legalTransition(from: StepState, to: StepState): boolean {
  const table: Readonly<Record<StepState, readonly StepState[]>> = {
    planned: ["aborted", "failed"],
    prepared: ["executing", "aborted", "failed", "unknown"],
    executing: ["effect-observed", "failed", "aborted", "unknown"],
    "effect-observed": ["validated", "failed", "aborted", "unknown"],
    validated: ["completed", "failed", "aborted"],
    completed: [],
    failed: ["aborted", "superseded"],
    aborted: ["superseded"],
    superseded: [],
    unknown: ["superseded"],
  };
  return table[from].includes(to);
}

function mapRuntimeFailure(code: unknown, diagnostic: unknown): StepRejection {
  const textDiagnostic = typeof diagnostic === "string" ? diagnostic : "runtime_failure";
  if (code === "read_only") return Object.freeze({ code: "read_only", diagnostic: textDiagnostic });
  if (code === "schema_corrupt" || code === "schema_unknown") return Object.freeze({ code: "schema_corrupt", diagnostic: textDiagnostic });
  return Object.freeze({ code: "transaction_failed", diagnostic: textDiagnostic });
}

export type StepStoreOpenResult = StepResult<StepLedger>;

function readStep(connection: NativeSqliteConnection, stepId: string): StepResult<StepRecord | undefined> {
  try {
    const value = connection.prepare("SELECT step_id, state, revision, step_attempt_id, input_json, input_sha256, expected_head, expected_head_sha256, policy_sha256, role, model, output_location, worker_generation, lease_id, fencing_token, effect_json, validation_json, created_at_ms, updated_at_ms FROM workflow_step WHERE step_id = $stepId").get({ $stepId: stepId });
    if (value === undefined) return success(undefined);
    return parseStoredRecord(connection, value);
  } catch (error) {
    return rejection("schema_corrupt", safeDiagnostic(error, "step_read_failed"));
  }
}

function readAttempt(connection: NativeSqliteConnection, stepAttemptId: string): StepResult<StepAttemptRecord | undefined> {
  try {
    const value = connection.prepare("SELECT step_attempt_id, step_id, sequence, idempotency_key, input_json, input_sha256, expected_head, expected_head_sha256, policy_sha256, role, model, output_location, worker_generation, lease_id, fencing_token, prepared_at_ms FROM workflow_step_attempt WHERE step_attempt_id = $stepAttemptId").get({ $stepAttemptId: stepAttemptId });
    if (value === undefined) return success(undefined);
    return parseStoredAttempt(value);
  } catch (error) {
    return rejection("schema_corrupt", safeDiagnostic(error, "attempt_read_failed"));
  }
}

function readAttemptForStep(connection: NativeSqliteConnection, stepId: string, stepAttemptId: string): StepResult<StepAttemptRecord | undefined> {
  const result = readAttempt(connection, stepAttemptId);
  if (!result.ok || result.value === undefined) return result;
  return result.value.stepId === stepId ? result : rejection("schema_corrupt", "attempt_step_binding_invalid");
}

function parseStoredOperation(value: unknown): StepResult<Readonly<{ readonly operationHash: string; readonly eventId: string; readonly toState: StepState; readonly afterRevision: number }>> {
  const raw = row(value);
  if (!raw || !text(rowField(raw, "event_id")) || !digest(rowField(raw, "operation_hash")) || !parseState(rowField(raw, "to_state")) ||
      !integer(rowField(raw, "after_revision"), 0)) return rejection("schema_corrupt", "event_row_invalid");
  return success(Object.freeze({
    operationHash: rowField(raw, "operation_hash") as string,
    eventId: rowField(raw, "event_id") as string,
    toState: rowField(raw, "to_state") as StepState,
    afterRevision: rowField(raw, "after_revision") as number,
  }));
}

function replayOperation(connection: NativeSqliteConnection, stepId: string, operationKey: string, operation: Readonly<{ readonly hash: string }>): StepResult<StepRecord | undefined> {
  try {
    const event = connection.prepare("SELECT event_id, operation_hash, to_state, after_revision FROM workflow_step_event WHERE operation_key = $operationKey").get({ $operationKey: operationKey });
    if (event === undefined) return success(undefined);
    const parsed = parseStoredOperation(event);
    if (!parsed.ok) return parsed;
    if (parsed.value.operationHash !== operation.hash) return rejection("idempotency_conflict", "operation_key_hash_collision");
    return readStep(connection, stepId);
  } catch (error) {
    return rejection("schema_corrupt", safeDiagnostic(error, "operation_read_failed"));
  }
}

function parseRuntimeResult(value: unknown): StepResult<unknown> {
  const shape = parseResultShape(value);
  if (!shape) return rejection("lease_required", "lease_result_invalid");
  if (!shape.ok) {
    const code = shape.rejection?.code;
    const diagnostic = shape.rejection?.diagnostic;
    return rejection(mapLeaseCode(code), typeof diagnostic === "string" ? diagnostic : "lease_rejected");
  }
  return success(shape.value);
}

function preflightLease(options: StepLedgerOptions, credentialsInput: unknown): StepResult<true> {
  const parsedCredentials = parseLeaseInput(credentialsInput);
  if (!parsedCredentials.ok) return parsedCredentials;
  try {
    const runtimeResult = parseRuntimeResult(options.leaseStore.guard(parsedCredentials.value));
    if (!runtimeResult.ok) return runtimeResult;
    const proof = parseLeaseProof(runtimeResult.value);
    if (!proof.ok) return proof;
    return success(true);
  } catch {
    return rejection("lease_required", "lease_guard_failed");
  }
}

function inTransactionLease(connection: NativeSqliteConnection, credentialsInput: unknown, now: number): StepResult<LeaseProof> {
  try {
    const result = assertCurrentLeaseInTransaction(connection, credentialsInput, now);
    const shape = parseRuntimeResult(result);
    if (!shape.ok) return shape as StepResult<LeaseProof>;
    return parseLeaseProof(shape.value);
  } catch {
    return rejection("lease_required", "lease_guard_failed");
  }
}

function withWrite<T>(
  internal: RuntimeDatabaseInternal,
  options: StepLedgerOptions,
  credentialsInput: unknown,
  action: (connection: NativeSqliteConnection, lease: LeaseProof, now: number) => StepResult<T>,
): StepResult<T> {
  if (internal.publicHandle.status.mode === "read-only" || !internal.publicHandle.status.writable) return rejection("read_only", "step_ledger_is_read_only");
  const preflight = preflightLease(options, credentialsInput);
  if (!preflight.ok) return preflight as StepResult<T>;
  const clock = parseNow(options.now);
  if (!clock.ok) return clock as StepResult<T>;
  let lock: MigrationLock | undefined;
  try {
    const acquired = acquireMigrationLock(internal.connection);
    if (!acquired.ok) return rejection("transaction_failed", acquired.rejection.diagnostic);
    lock = acquired.value;
    const lease = inTransactionLease(internal.connection, credentialsInput, clock.value);
    if (!lease.ok) {
      lock.rollback();
      return lease as StepResult<T>;
    }
    const result = action(internal.connection, lease.value, clock.value);
    if (!result.ok) {
      lock.rollback();
      return result;
    }
    const committed = lock.commit();
    if (!committed.ok) {
      lock.rollback();
      return rejection("transaction_failed", committed.rejection.diagnostic);
    }
    return result;
  } catch (error) {
    lock?.rollback();
    return rejection("transaction_failed", safeDiagnostic(error, "step_transaction_failed"));
  }
}

function jsonText(value: JsonValue): string {
  const result = canonical(value);
  if (!result.ok) throw new Error("canonical_json_invalid");
  return result.value.text;
}

function artifactVerification(options: StepLedgerOptions, artifactId: string, artifactSha256: string): StepResult<true> {
  if (options.artifactStore === undefined) return rejection("artifact_unavailable", "artifact_verifier_unavailable");
  try {
    const shape = parseResultShape(options.artifactStore.verify(artifactId));
    if (!shape) return rejection("artifact_corrupt", "artifact_result_invalid");
    if (!shape.ok) {
      const code = shape.rejection?.code;
      if (code === "not_found") return rejection("artifact_missing", "artifact_not_registered");
      if (code === "corrupt" || code === "registry_corrupt") return rejection("artifact_corrupt", "artifact_integrity_failed");
      return rejection("artifact_unavailable", typeof shape.rejection?.diagnostic === "string" ? shape.rejection.diagnostic : "artifact_verification_failed");
    }
    const record = ownRecord(shape.value, ["artifactId", "sha256", "relativePath", "byteSize", "createdAtEpochMs", "mediaType", "authority", "retentionClass"], ["redaction"]);
    if (!record || record.artifactId !== artifactId || record.sha256 !== artifactSha256 || !digest(record.sha256) || !text(record.relativePath) || !integer(record.byteSize, 0) || !epoch(record.createdAtEpochMs)) return rejection("artifact_corrupt", "artifact_binding_mismatch");
    return success(true);
  } catch {
    return rejection("artifact_unavailable", "artifact_verification_failed");
  }
}

function parsePlanInput(value: unknown): StepResult<StepPlanInput> {
  const exact = ownRecord(value, ["stepId", "policyHash", "role", "model", "outputLocation", "workerGeneration"]);
  if (!exact || !parseStepId(exact.stepId) || !text(exact.policyHash) || !text(exact.role) || !text(exact.model) || !text(exact.outputLocation) || !integer(exact.workerGeneration, 0)) return rejection("invalid_input", "plan_input_invalid");
  return success(exact as unknown as StepPlanInput);
}

function parsePrepareInput(value: unknown): StepResult<StepPrepareInput> {
  const exact = ownRecord(value, ["stepId", "idempotencyKey", "inputJson", "policySha256", "role", "model", "outputLocation", "workerGeneration"], ["expectedHead"]);
  if (!exact || !parseStepId(exact.stepId) || !text(exact.idempotencyKey) || !text(exact.policySha256) || !text(exact.role) || !text(exact.model) || !text(exact.outputLocation) || !integer(exact.workerGeneration, 0) || (exact.expectedHead !== undefined && !text(exact.expectedHead))) return rejection("invalid_input", "prepare_input_invalid");
  const input = canonical(exact.inputJson);
  if (!input.ok) return input as StepResult<StepPrepareInput>;
  return success(Object.freeze({
    stepId: exact.stepId,
    idempotencyKey: exact.idempotencyKey,
    inputJson: input.value.value,
    ...(exact.expectedHead === undefined ? {} : { expectedHead: exact.expectedHead }),
    policySha256: exact.policySha256,
    role: exact.role,
    model: exact.model,
    outputLocation: exact.outputLocation,
    workerGeneration: exact.workerGeneration,
  }));
}

function parseTransitionInput(value: unknown): StepResult<StepTransitionInput> {
  const exact = ownRecord(value, ["stepId", "expectedRevision", "operationKey", "toState"], ["effect", "validation"]);
  if (!exact || !parseStepId(exact.stepId) || !integer(exact.expectedRevision, 0) || !text(exact.operationKey) || !parseState(exact.toState)) return rejection("invalid_input", "transition_input_invalid");
  let effect: StepEffect | undefined;
  let validation: StepValidation | undefined;
  if (exact.effect !== undefined) {
    const parsed = parseEffect(exact.effect);
    if (!parsed.ok) return parsed;
    effect = parsed.value;
  }
  if (exact.validation !== undefined) {
    const parsed = parseValidation(exact.validation);
    if (!parsed.ok) return parsed;
    validation = parsed.value;
  }
  return success(Object.freeze({ stepId: exact.stepId, expectedRevision: exact.expectedRevision, operationKey: exact.operationKey, toState: exact.toState, ...(effect === undefined ? {} : { effect }), ...(validation === undefined ? {} : { validation }) }));
}

function parseRetryInput(value: unknown): StepResult<StepRetryInput> {
  const exact = ownRecord(value, ["stepId", "expectedRevision", "idempotencyKey", "inputJson", "policySha256", "role", "model", "outputLocation", "workerGeneration"], ["expectedHead"]);
  if (!exact) return rejection("invalid_input", "retry_input_invalid");
  const prepared = parsePrepareInput({
    stepId: exact.stepId,
    idempotencyKey: exact.idempotencyKey,
    inputJson: exact.inputJson,
    ...(exact.expectedHead === undefined ? {} : { expectedHead: exact.expectedHead }),
    policySha256: exact.policySha256,
    role: exact.role,
    model: exact.model,
    outputLocation: exact.outputLocation,
    workerGeneration: exact.workerGeneration,
  });
  if (!prepared.ok || !integer(exact.expectedRevision, 0)) return prepared.ok ? rejection("invalid_input", "retry_revision_invalid") : prepared as StepResult<StepRetryInput>;
  return success(Object.freeze({ ...prepared.value, expectedRevision: exact.expectedRevision }));
}

function parseAdoptInput(value: unknown): StepResult<StepAdoptInput> {
  const exact = ownRecord(value, ["stepId", "expectedRevision", "operationKey", "effectKey", "artifactId", "artifactSha256"]);
  if (!exact || !parseStepId(exact.stepId) || !integer(exact.expectedRevision, 0) || !text(exact.operationKey) || !text(exact.effectKey) || !text(exact.artifactId) || !digest(exact.artifactSha256)) return rejection("invalid_input", "adopt_input_invalid");
  return success(exact as unknown as StepAdoptInput);
}

type RecoveryInput = Readonly<{
  readonly stepId: string;
  readonly expectedRevision: number;
  readonly operationKey: string;
  readonly action: RecoveryAction;
  readonly evidence?: JsonValue;
}>;

function parseRecoveryInput(value: unknown): StepResult<RecoveryInput> {
  const exact = ownRecord(value, ["stepId", "expectedRevision", "operationKey", "action"], ["evidence"]);
  if (!exact || !parseStepId(exact.stepId) || !integer(exact.expectedRevision, 0) || !text(exact.operationKey) || !parseAction(exact.action)) return rejection("invalid_input", "recovery_input_invalid");
  let evidence: JsonValue | undefined;
  if (exact.evidence !== undefined) {
    const normalized = canonical(exact.evidence);
    if (!normalized.ok) return normalized;
    evidence = normalized.value.value;
  }
  return success(Object.freeze({ stepId: exact.stepId, expectedRevision: exact.expectedRevision, operationKey: exact.operationKey, action: exact.action, ...(evidence === undefined ? {} : { evidence }) }));
}

function normalizedPolicy(value: string): string {
  return digest(value) ? value : digestText(value);
}

function expectedHeadDigest(value: string | undefined): string | null {
  return value === undefined ? null : digestText(value);
}

function stepRowValues(input: Readonly<{
  readonly stepId: string;
  readonly state: StepState;
  readonly revision: number;
  readonly stepAttemptId?: string;
  readonly inputText: string;
  readonly inputHash: string;
  readonly expectedHead?: string;
  readonly policySha256: string;
  readonly role: string;
  readonly model: string;
  readonly outputLocation: string;
  readonly workerGeneration: number;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly effectText?: string;
  readonly validationText?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    $stepId: input.stepId,
    $state: input.state,
    $revision: input.revision,
    $stepAttemptId: input.stepAttemptId ?? null,
    $inputJson: input.inputText,
    $inputSha256: input.inputHash,
    $expectedHead: input.expectedHead ?? null,
    $expectedHeadSha256: expectedHeadDigest(input.expectedHead),
    $policySha256: input.policySha256,
    $role: input.role,
    $model: input.model,
    $outputLocation: input.outputLocation,
    $workerGeneration: input.workerGeneration,
    $leaseId: input.leaseId,
    $fencingToken: input.fencingToken,
    $effectJson: input.effectText ?? null,
    $validationJson: input.validationText ?? null,
    $createdAt: input.createdAt,
    $updatedAt: input.updatedAt,
  });
}

function appendEvent(
  connection: NativeSqliteConnection,
  input: Readonly<{
    readonly stepId: string;
    readonly stepAttemptId?: string;
    readonly operationKey: string;
    readonly operationHash: string;
    readonly fromState?: StepState;
    readonly toState: StepState;
    readonly beforeRevision: number;
    readonly afterRevision: number;
    readonly effectText?: string;
    readonly validationText?: string;
    readonly recoveryAction?: RecoveryAction;
    readonly evidenceText?: string;
    readonly occurredAt: number;
  }>,
): void {
  connection.prepare("INSERT INTO workflow_step_event(event_id, step_id, step_attempt_id, operation_key, operation_hash, from_state, to_state, before_revision, after_revision, effect_json, validation_json, recovery_action, evidence_json, occurred_at_ms) VALUES ($eventId, $stepId, $stepAttemptId, $operationKey, $operationHash, $fromState, $toState, $beforeRevision, $afterRevision, $effectJson, $validationJson, $recoveryAction, $evidenceJson, $occurredAt)").run({
    $eventId: operationId(input.operationHash),
    $stepId: input.stepId,
    $stepAttemptId: input.stepAttemptId ?? null,
    $operationKey: input.operationKey,
    $operationHash: input.operationHash,
    $fromState: input.fromState ?? null,
    $toState: input.toState,
    $beforeRevision: input.beforeRevision,
    $afterRevision: input.afterRevision,
    $effectJson: input.effectText ?? null,
    $validationJson: input.validationText ?? null,
    $recoveryAction: input.recoveryAction ?? null,
    $evidenceJson: input.evidenceText ?? null,
    $occurredAt: input.occurredAt,
  });
}

function updateStep(
  connection: NativeSqliteConnection,
  input: Readonly<{
    readonly stepId: string;
    readonly fromRevision: number;
    readonly state: StepState;
    readonly revision: number;
    readonly stepAttemptId?: string;
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly effectText?: string | null;
    readonly validationText?: string | null;
    readonly updatedAt: number;
    readonly clearEffect?: boolean;
    readonly clearValidation?: boolean;
  }>,
): void {
  const effectValue = input.clearEffect ? null : input.effectText === undefined ? undefined : input.effectText;
  const validationValue = input.clearValidation ? null : input.validationText === undefined ? undefined : input.validationText;
  const setParts = [
    "state = $state", "revision = $revision", "step_attempt_id = COALESCE($stepAttemptId, step_attempt_id)",
    "lease_id = $leaseId", "fencing_token = $fencingToken", "updated_at_ms = $updatedAt",
  ];
  const parameters: Record<string, unknown> = {
    $state: input.state, $revision: input.revision, $stepAttemptId: input.stepAttemptId ?? null,
    $leaseId: input.leaseId, $fencingToken: input.fencingToken, $updatedAt: input.updatedAt,
    $stepId: input.stepId, $fromRevision: input.fromRevision,
  };
  if (input.clearEffect || input.effectText !== undefined) {
    setParts.push("effect_json = $effectJson");
    parameters.$effectJson = effectValue ?? null;
  }
  if (input.clearValidation || input.validationText !== undefined) {
    setParts.push("validation_json = $validationJson");
    parameters.$validationJson = validationValue ?? null;
  }
  const result = connection.prepare(`UPDATE workflow_step SET ${setParts.join(", ")} WHERE step_id = $stepId AND revision = $fromRevision`).run(parameters);
  const changes = row(result as unknown);
  // node:sqlite exposes changes as a number; tolerate bigint and driver rows.
  const changed = numberValue(changes === undefined ? result : rowField(changes, "changes"));
  if (changed !== undefined && changed !== 1) throw new Error("step_revision_lost");
}

function insertAttempt(
  connection: NativeSqliteConnection,
  input: Readonly<{
    readonly stepAttemptId: StepAttemptId;
    readonly stepId: string;
    readonly sequence: number;
    readonly idempotencyKey: string;
    readonly inputText: string;
    readonly inputHash: string;
    readonly expectedHead?: string;
    readonly policySha256: string;
    readonly role: string;
    readonly model: string;
    readonly outputLocation: string;
    readonly workerGeneration: number;
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly preparedAt: number;
  }>,
): void {
  connection.prepare("INSERT INTO workflow_step_attempt(step_attempt_id, step_id, sequence, idempotency_key, input_json, input_sha256, expected_head, expected_head_sha256, policy_sha256, role, model, output_location, worker_generation, lease_id, fencing_token, prepared_at_ms) VALUES ($stepAttemptId, $stepId, $sequence, $idempotencyKey, $inputJson, $inputSha256, $expectedHead, $expectedHeadSha256, $policySha256, $role, $model, $outputLocation, $workerGeneration, $leaseId, $fencingToken, $preparedAt)").run({
    $stepAttemptId: input.stepAttemptId,
    $stepId: input.stepId,
    $sequence: input.sequence,
    $idempotencyKey: input.idempotencyKey,
    $inputJson: input.inputText,
    $inputSha256: input.inputHash,
    $expectedHead: input.expectedHead ?? null,
    $expectedHeadSha256: expectedHeadDigest(input.expectedHead),
    $policySha256: input.policySha256,
    $role: input.role,
    $model: input.model,
    $outputLocation: input.outputLocation,
    $workerGeneration: input.workerGeneration,
    $leaseId: input.leaseId,
    $fencingToken: input.fencingToken,
    $preparedAt: input.preparedAt,
  });
}

function currentSequence(connection: NativeSqliteConnection, stepId: string): number {
  const value = row(connection.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM workflow_step_attempt WHERE step_id = $stepId").get({ $stepId: stepId }));
  const sequence = numberValue(value === undefined ? undefined : rowField(value, "sequence"), 0);
  if (sequence === undefined) throw new Error("attempt_sequence_invalid");
  return sequence + 1;
}

function prepareValue(connection: NativeSqliteConnection, step: StepRecord): StepResult<Readonly<{ readonly attempt: StepAttemptRecord; readonly step: StepRecord }>> {
  if (step.stepAttemptId === undefined) return rejection("schema_corrupt", "prepared_step_attempt_missing");
  const attempt = readAttemptForStep(connection, step.stepId, step.stepAttemptId);
  if (!attempt.ok || attempt.value === undefined) return attempt.ok ? rejection("schema_corrupt", "prepared_attempt_missing") : attempt as StepResult<Readonly<{ readonly attempt: StepAttemptRecord; readonly step: StepRecord }>>;
  return success(Object.freeze({ attempt: attempt.value, step }));
}

function resultFromSqliteError(error: unknown, fallback: string): StepResult<never> {
  const diagnostic = safeDiagnostic(error, fallback);
  const lower = diagnostic.toLowerCase();
  if (lower.includes("unique") || lower.includes("constraint")) return rejection("attempt_conflict", "immutable_attempt_conflict");
  return rejection("transaction_failed", diagnostic);
}

function makePlan(
  internal: RuntimeDatabaseInternal,
  options: StepLedgerOptions,
  input: StepPlanInput,
  credentials: unknown,
): StepResult<StepRecord> {
  const operation = operationHash("plan", input);
  if (!operation.ok) return operation as StepResult<StepRecord>;
  return withWrite(internal, options, credentials, (connection, lease, now) => {
    const existing = readStep(connection, input.stepId);
    if (!existing.ok) return existing as StepResult<StepRecord>;
    if (existing.value !== undefined) {
      const replay = replayOperation(connection, input.stepId, `plan:${input.stepId}`, operation.value);
      if (!replay.ok) return replay as StepResult<StepRecord>;
      if (replay.value !== undefined) return success(replay.value);
      return rejection("idempotency_conflict", "step_already_exists");
    }
    const nullInput = canonical(null);
    if (!nullInput.ok) return nullInput as StepResult<StepRecord>;
    const policySha256 = normalizedPolicy(input.policyHash);
    try {
      connection.prepare("INSERT INTO workflow_step(step_id, state, revision, step_attempt_id, input_json, input_sha256, expected_head, expected_head_sha256, policy_sha256, role, model, output_location, worker_generation, lease_id, fencing_token, effect_json, validation_json, created_at_ms, updated_at_ms) VALUES ($stepId, 'planned', 0, NULL, $inputJson, $inputSha256, NULL, NULL, $policySha256, $role, $model, $outputLocation, $workerGeneration, $leaseId, $fencingToken, NULL, NULL, $createdAt, $updatedAt)").run({
        $stepId: input.stepId,
        $inputJson: nullInput.value.text,
        $inputSha256: nullInput.value.hash,
        $policySha256: policySha256,
        $role: input.role,
        $model: input.model,
        $outputLocation: input.outputLocation,
        $workerGeneration: input.workerGeneration,
        $leaseId: lease.leaseId,
        $fencingToken: lease.fencingToken,
        $createdAt: now,
        $updatedAt: now,
      });
      appendEvent(connection, {
        stepId: input.stepId,
        operationKey: `plan:${input.stepId}`,
        operationHash: operation.value.hash,
        toState: "planned",
        beforeRevision: 0,
        afterRevision: 0,
        occurredAt: now,
      });
      const result = readStep(connection, input.stepId);
      return result.ok && result.value !== undefined ? success(result.value) : result.ok ? rejection("schema_corrupt", "planned_step_missing") : result;
    } catch (error) {
      return resultFromSqliteError(error, "plan_write_failed");
    }
  });
}

function makePrepare(
  internal: RuntimeDatabaseInternal,
  options: StepLedgerOptions,
  input: StepPrepareInput,
  credentials: unknown,
  retry: boolean,
  expectedRevision?: number,
): StepResult<Readonly<{ readonly attempt: StepAttemptRecord; readonly step: StepRecord }>> {
  const operationKey = `${retry ? "retry" : "prepare"}:${input.idempotencyKey}`;
  const operation = operationHash(retry ? "retry" : "prepare", input);
  if (!operation.ok) return operation as StepResult<Readonly<{ readonly attempt: StepAttemptRecord; readonly step: StepRecord }>>;
  return withWrite(internal, options, credentials, (connection, lease, now) => {
    const existing = readStep(connection, input.stepId);
    if (!existing.ok) return existing as StepResult<Readonly<{ readonly attempt: StepAttemptRecord; readonly step: StepRecord }>>;
    if (existing.value === undefined) return rejection("not_found", "step_not_found");
    const replay = replayOperation(connection, input.stepId, operationKey, operation.value);
    if (!replay.ok) return replay as StepResult<Readonly<{ readonly attempt: StepAttemptRecord; readonly step: StepRecord }>>;
    if (replay.value !== undefined) return prepareValue(connection, replay.value);
    if (expectedRevision !== undefined && existing.value.revision !== expectedRevision) return rejection("expected_revision_mismatch", "step_revision_stale");
    const expectedState: readonly StepState[] = retry ? ["failed", "aborted"] : ["planned"];
    if (!expectedState.includes(existing.value.state)) return rejection("invalid_transition", retry ? "retry_requires_failed_or_aborted" : "prepare_requires_planned");
    const inputValue = canonical(input.inputJson);
    if (!inputValue.ok) return inputValue as StepResult<Readonly<{ readonly attempt: StepAttemptRecord; readonly step: StepRecord }>>;
    const attemptIdValue = attemptId(operation.value.hash);
    const sequence = currentSequence(connection, input.stepId);
    const policySha256 = normalizedPolicy(input.policySha256);
    try {
      const previousAttempt = connection.prepare("SELECT step_attempt_id FROM workflow_step_attempt WHERE idempotency_key = $idempotencyKey").get({ $idempotencyKey: input.idempotencyKey });
      if (previousAttempt !== undefined) return rejection("attempt_conflict", "idempotency_key_reused");
      insertAttempt(connection, {
        stepAttemptId: attemptIdValue,
        stepId: input.stepId,
        sequence,
        idempotencyKey: input.idempotencyKey,
        inputText: inputValue.value.text,
        inputHash: inputValue.value.hash,
        ...(input.expectedHead === undefined ? {} : { expectedHead: input.expectedHead }),
        policySha256,
        role: input.role,
        model: input.model,
        outputLocation: input.outputLocation,
        workerGeneration: input.workerGeneration,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        preparedAt: now,
      });
      const afterRevision = existing.value.revision + 1;
      updateStep(connection, {
        stepId: input.stepId,
        fromRevision: existing.value.revision,
        state: "prepared",
        revision: afterRevision,
        stepAttemptId: attemptIdValue,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        updatedAt: now,
        clearEffect: true,
        clearValidation: true,
      });
      appendEvent(connection, {
        stepId: input.stepId,
        stepAttemptId: attemptIdValue,
        operationKey,
        operationHash: operation.value.hash,
        fromState: existing.value.state,
        toState: "prepared",
        beforeRevision: existing.value.revision,
        afterRevision,
        ...(retry ? { recoveryAction: "retry" as const } : {}),
        occurredAt: now,
      });
      const next = readStep(connection, input.stepId);
      if (!next.ok || next.value === undefined) return next.ok ? rejection("schema_corrupt", "prepared_step_missing") : next as StepResult<Readonly<{ readonly attempt: StepAttemptRecord; readonly step: StepRecord }>>;
      return prepareValue(connection, next.value);
    } catch (error) {
      return resultFromSqliteError(error, "prepare_write_failed") as StepResult<Readonly<{ readonly attempt: StepAttemptRecord; readonly step: StepRecord }>>;
    }
  });
}

function makeTransition(
  internal: RuntimeDatabaseInternal,
  options: StepLedgerOptions,
  input: StepTransitionInput,
  credentials: unknown,
): StepResult<StepRecord> {
  const operation = operationHash("transition", input);
  if (!operation.ok) return operation as StepResult<StepRecord>;
  return withWrite(internal, options, credentials, (connection, lease, now) => {
    const existing = readStep(connection, input.stepId);
    if (!existing.ok) return existing;
    if (existing.value === undefined) return rejection("not_found", "step_not_found");
    const replay = replayOperation(connection, input.stepId, input.operationKey, operation.value);
    if (!replay.ok) return replay as StepResult<StepRecord>;
    if (replay.value !== undefined) return success(replay.value);
    if (existing.value.revision !== input.expectedRevision) return rejection("expected_revision_mismatch", "step_revision_stale");
    if (!legalTransition(existing.value.state, input.toState)) return rejection("invalid_transition", `${existing.value.state}_to_${input.toState}_not_allowed`);
    if (input.toState === "effect-observed" && input.effect === undefined) return rejection("invalid_input", "effect_evidence_required");
    if (input.toState === "validated" && input.validation === undefined) return rejection("invalid_input", "validation_evidence_required");
    if (input.toState === "completed" && existing.value.validation === undefined) return rejection("invalid_transition", "completion_requires_validation");
    if (["executing", "effect-observed", "validated", "completed"].includes(input.toState) && existing.value.stepAttemptId === undefined) return rejection("invalid_transition", "transition_requires_attempt");
    const effect = input.effect;
    const validation = input.validation;
    const effectResult = effect === undefined ? success(undefined) : canonical(effect);
    if (!effectResult.ok) return effectResult as StepResult<StepRecord>;
    const validationResult = validation === undefined ? success(undefined) : canonical(validation);
    if (!validationResult.ok) return validationResult as StepResult<StepRecord>;
    if (validation !== undefined) {
      const artifact = artifactVerification(options, validation.artifactId, validation.artifactSha256);
      if (!artifact.ok) return artifact;
      if (effect !== undefined && effect.artifactSha256 !== undefined && (effect.artifactId !== validation.artifactId || effect.artifactSha256 !== validation.artifactSha256)) return rejection("artifact_corrupt", "effect_validation_binding_mismatch");
    }
    if (input.toState === "completed") {
      const currentValidation = existing.value.validation;
      const parsed = currentValidation === undefined ? rejection("invalid_transition", "completion_requires_validation") : parseValidation(currentValidation);
      if (!parsed.ok) return parsed as StepResult<StepRecord>;
      const artifact = artifactVerification(options, parsed.value.artifactId, parsed.value.artifactSha256);
      if (!artifact.ok) return artifact;
    }
    const nextRevision = existing.value.revision + 1;
    try {
      updateStep(connection, {
        stepId: input.stepId,
        fromRevision: existing.value.revision,
        state: input.toState,
        revision: nextRevision,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        ...(effectResult.value === undefined ? {} : { effectText: effectResult.value.text }),
        ...(validationResult.value === undefined ? {} : { validationText: validationResult.value.text }),
        updatedAt: now,
      });
      appendEvent(connection, {
        stepId: input.stepId,
        ...(existing.value.stepAttemptId === undefined ? {} : { stepAttemptId: existing.value.stepAttemptId }),
        operationKey: input.operationKey,
        operationHash: operation.value.hash,
        fromState: existing.value.state,
        toState: input.toState,
        beforeRevision: existing.value.revision,
        afterRevision: nextRevision,
        ...(effectResult.value === undefined ? {} : { effectText: effectResult.value.text }),
        ...(validationResult.value === undefined ? {} : { validationText: validationResult.value.text }),
        occurredAt: now,
      });
      const next = readStep(connection, input.stepId);
      return next.ok && next.value !== undefined ? success(next.value) : next.ok ? rejection("schema_corrupt", "transition_step_missing") : next;
    } catch (error) {
      return resultFromSqliteError(error, "transition_write_failed");
    }
  });
}

function makeAdopt(
  internal: RuntimeDatabaseInternal,
  options: StepLedgerOptions,
  input: StepAdoptInput,
  credentials: unknown,
): StepResult<StepRecord> {
  const operation = operationHash("adopt", input);
  if (!operation.ok) return operation as StepResult<StepRecord>;
  return withWrite(internal, options, credentials, (connection, lease, now) => {
    const existing = readStep(connection, input.stepId);
    if (!existing.ok) return existing;
    if (existing.value === undefined) return rejection("not_found", "step_not_found");
    const replay = replayOperation(connection, input.stepId, input.operationKey, operation.value);
    if (!replay.ok) return replay as StepResult<StepRecord>;
    if (replay.value !== undefined) return success(replay.value);
    if (existing.value.revision !== input.expectedRevision) return rejection("expected_revision_mismatch", "step_revision_stale");
    if (!["unknown", "effect-observed", "executing"].includes(existing.value.state)) return rejection("invalid_transition", "adopt_requires_uncertain_effect");
    // Verify again after the fencing proof and expected-revision check, at the
    // mutation boundary. E07 owns the artifact database, so this read-only
    // verifier call is deliberately repeated rather than trusting a
    // preflight result from before the transaction.
    const artifact = artifactVerification(options, input.artifactId, input.artifactSha256);
    if (!artifact.ok) return artifact;
    const effect: StepEffect = Object.freeze({ effectKey: input.effectKey, outcome: "confirmed", artifactId: input.artifactId, artifactSha256: input.artifactSha256 });
    const effectTextResult = canonical(effect);
    if (!effectTextResult.ok) return effectTextResult as StepResult<StepRecord>;
    const nextRevision = existing.value.revision + 1;
    try {
      updateStep(connection, {
        stepId: input.stepId,
        fromRevision: existing.value.revision,
        state: "effect-observed",
        revision: nextRevision,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        effectText: effectTextResult.value.text,
        updatedAt: now,
      });
      appendEvent(connection, {
        stepId: input.stepId,
        ...(existing.value.stepAttemptId === undefined ? {} : { stepAttemptId: existing.value.stepAttemptId }),
        operationKey: input.operationKey,
        operationHash: operation.value.hash,
        fromState: existing.value.state,
        toState: "effect-observed",
        beforeRevision: existing.value.revision,
        afterRevision: nextRevision,
        effectText: effectTextResult.value.text,
        recoveryAction: "adopt",
        occurredAt: now,
      });
      const next = readStep(connection, input.stepId);
      return next.ok && next.value !== undefined ? success(next.value) : next.ok ? rejection("schema_corrupt", "adopted_step_missing") : next;
    } catch (error) {
      return resultFromSqliteError(error, "adopt_write_failed");
    }
  });
}

function makeRecoveryDecision(
  internal: RuntimeDatabaseInternal,
  options: StepLedgerOptions,
  input: RecoveryInput,
  credentials: unknown,
): StepResult<true> {
  const operation = operationHash("recovery-decision", input);
  if (!operation.ok) return operation as StepResult<true>;
  return withWrite(internal, options, credentials, (connection, lease, now) => {
    const existing = readStep(connection, input.stepId);
    if (!existing.ok) return existing as StepResult<true>;
    if (existing.value === undefined) return rejection("not_found", "step_not_found");
    const replay = replayOperation(connection, input.stepId, input.operationKey, operation.value);
    if (!replay.ok) return replay as StepResult<true>;
    if (replay.value !== undefined) return success(true);
    if (existing.value.revision !== input.expectedRevision) return rejection("expected_revision_mismatch", "step_revision_stale");
    if (existing.value.state === "completed" || existing.value.state === "superseded") return rejection("invalid_transition", "terminal_step_recovery_forbidden");
    if (input.action === "retry") return rejection("invalid_transition", "retry_requires_new_attempt");
    if (input.action === "adopt") {
      if (input.evidence === undefined) return rejection("invalid_input", "adopt_evidence_required");
      const evidenceBinding = ownRecord(input.evidence, ["artifactId", "artifactSha256"], ["effectKey"]);
      if (!evidenceBinding || !text(evidenceBinding.artifactId) || !digest(evidenceBinding.artifactSha256)) return rejection("invalid_input", "adopt_evidence_binding_invalid");
      if (!["unknown", "effect-observed", "executing"].includes(existing.value.state)) return rejection("invalid_transition", "adopt_requires_uncertain_effect");
      const artifact = artifactVerification(options, evidenceBinding.artifactId, evidenceBinding.artifactSha256);
      if (!artifact.ok) return artifact;
      const evidence = canonical(input.evidence);
      if (!evidence.ok) return evidence as StepResult<true>;
      try {
        appendEvent(connection, {
          stepId: input.stepId,
          ...(existing.value.stepAttemptId === undefined ? {} : { stepAttemptId: existing.value.stepAttemptId }),
          operationKey: input.operationKey,
          operationHash: operation.value.hash,
          fromState: existing.value.state,
          toState: existing.value.state,
          beforeRevision: existing.value.revision,
          afterRevision: existing.value.revision,
          recoveryAction: input.action,
          evidenceText: evidence.value.text,
          occurredAt: now,
        });
        return success(true);
      } catch (error) {
        return resultFromSqliteError(error, "recovery_decision_failed");
      }
    }
    if (input.action === "manual-recovery") {
      if (input.evidence === undefined) return rejection("invalid_input", "manual_recovery_evidence_required");
    }
    const evidence = input.evidence === undefined ? undefined : canonical(input.evidence);
    if (evidence !== undefined && !evidence.ok) return evidence as StepResult<true>;
    const nextState = input.action === "supersede" ? "superseded" : existing.value.state;
    const nextRevision = nextState === existing.value.state ? existing.value.revision : existing.value.revision + 1;
    try {
      if (nextRevision !== existing.value.revision) {
        updateStep(connection, {
          stepId: input.stepId,
          fromRevision: existing.value.revision,
          state: nextState,
          revision: nextRevision,
          leaseId: lease.leaseId,
          fencingToken: lease.fencingToken,
          updatedAt: now,
        });
      }
      const eventInput = {
        stepId: input.stepId,
        ...(existing.value.stepAttemptId === undefined ? {} : { stepAttemptId: existing.value.stepAttemptId }),
        operationKey: input.operationKey,
        operationHash: operation.value.hash,
        fromState: existing.value.state,
        toState: nextState,
        beforeRevision: existing.value.revision,
        afterRevision: nextRevision,
        recoveryAction: input.action,
        ...(evidence === undefined ? {} : { evidenceText: evidence.value.text }),
        occurredAt: now,
      } as const;
      appendEvent(connection, eventInput);
      return success(true);
    } catch (error) {
      return resultFromSqliteError(error, "recovery_decision_failed");
    }
  });
}

function makeScan(internal: RuntimeDatabaseInternal, options: StepLedgerOptions): StepResult<RecoveryReport> {
  const clock = parseNow(options.now);
  if (!clock.ok) return clock as StepResult<RecoveryReport>;
  if (internal.publicHandle.status.mode === "read-only" || internal.publicHandle.status.writable) {
    // Both modes are safe for a scanner; this branch is intentionally a
    // no-op guard that documents that scan never acquires a write lock.
  }
  try {
    const values = internal.connection.prepare("SELECT step_id, state, revision, step_attempt_id, input_json, input_sha256, expected_head, expected_head_sha256, policy_sha256, role, model, output_location, worker_generation, lease_id, fencing_token, effect_json, validation_json, created_at_ms, updated_at_ms FROM workflow_step ORDER BY step_id ASC, revision ASC, COALESCE(step_attempt_id, '') ASC").all() as readonly unknown[];
    const cases: RecoveryCase[] = [];
    for (const value of values) {
      const parsed = parseStoredRecord(internal.connection, value);
      if (!parsed.ok) return parsed as StepResult<RecoveryReport>;
      if (parsed.value === undefined) continue;
      const step = parsed.value;
      let action: RecoveryAction | undefined;
      let reason = "";
      let evidenceRequired = false;
      if (step.state === "executing") { action = "manual-recovery"; reason = "executing_interrupted_requires_effect_reconciliation"; evidenceRequired = true; }
      else if (step.state === "effect-observed") { action = "adopt"; reason = "effect_requires_explicit_validation"; evidenceRequired = true; }
      else if (step.state === "unknown") { action = "manual-recovery"; reason = "effect_boundary_unknown"; evidenceRequired = true; }
      else if (step.state === "failed" || step.state === "aborted") { action = "retry"; reason = "prior_attempt_failed_or_aborted"; evidenceRequired = false; }
      else if (step.state === "validated") { action = "manual-recovery"; reason = "validated_step_not_completed"; evidenceRequired = true; }
      if (action !== undefined) {
        cases.push(Object.freeze({ stepId: step.stepId, ...(step.stepAttemptId === undefined ? {} : { stepAttemptId: step.stepAttemptId }), state: step.state, revision: step.revision, action, reason, evidenceRequired }));
      }
    }
    cases.sort((left, right) => left.stepId.localeCompare(right.stepId) || left.revision - right.revision || (left.stepAttemptId ?? "").localeCompare(right.stepAttemptId ?? ""));
    const bare = Object.freeze({ scannedAtEpochMs: clock.value, status: cases.length === 0 ? "clean" as const : "needs-recovery" as const, cases: Object.freeze(cases) });
    const report = canonical(bare);
    if (!report.ok) return report as StepResult<RecoveryReport>;
    return success(Object.freeze({ ...bare, ...("reportSha256" in bare ? {} : {}), reportSha256: report.value.hash } as RecoveryReport & Readonly<{ readonly reportSha256: string }>));
  } catch (error) {
    return rejection("schema_corrupt", safeDiagnostic(error, "recovery_scan_failed"));
  }
}

function validateOptions(value: unknown): StepResult<StepLedgerOptions> {
  const exact = ownRecord(value, ["runtimeRoot", "databasePath", "now", "leaseStore"], ["backupDirectory", "mode", "artifactStore"]);
  if (!exact || !text(exact.runtimeRoot, 4096) || !text(exact.databasePath, 4096) || typeof exact.now !== "function" ||
      (exact.mode !== undefined && exact.mode !== "read-only" && exact.mode !== "read-write") ||
      !callableOwn(exact.leaseStore, "guard") ||
      (exact.backupDirectory !== undefined && !text(exact.backupDirectory, 4096)) ||
      (exact.artifactStore !== undefined && !callableOwn(exact.artifactStore, "verify"))) {
    return rejection("invalid_input", "step_ledger_options_invalid");
  }
  return success(Object.freeze({
    runtimeRoot: exact.runtimeRoot,
    databasePath: exact.databasePath,
    ...(exact.backupDirectory === undefined ? {} : { backupDirectory: exact.backupDirectory }),
    ...(exact.mode === undefined ? {} : { mode: exact.mode }),
    now: exact.now as () => number,
    leaseStore: exact.leaseStore as StepLedgerOptions["leaseStore"],
    ...(exact.artifactStore === undefined ? {} : { artifactStore: exact.artifactStore }),
  }) as unknown as StepLedgerOptions);
}

function publicRecoveryInput(input: unknown, action: RecoveryAction): StepResult<RecoveryInput> {
  const exact = ownRecord(input, ["stepId", "expectedRevision", "operationKey"], ["evidence"]);
  if (!exact) return rejection("invalid_input", "recovery_input_invalid");
  return parseRecoveryInput({ ...exact, action });
}

/** Open E10's bounded, typed Step Ledger over the composite Runtime schema. */
export function openStepLedger(optionsInput: unknown): StepStoreOpenResult {
  const parsed = validateOptions(optionsInput);
  if (!parsed.ok) return parsed;
  const options = parsed.value;
  const migrations = Object.freeze([
    ...createBootstrapRuntimeMigrations(),
    E05_RUNTIME_MIGRATION,
    E08_RUNTIME_MIGRATION,
    E10_RUNTIME_MIGRATION,
  ]);
  const opened = openRuntimeDatabaseInternal({
    runtimeRoot: options.runtimeRoot,
    databasePath: options.databasePath,
    ...(options.backupDirectory === undefined ? {} : { backupDirectory: options.backupDirectory }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    migrations,
  }, [E05_RUNTIME_EXTENSION, E08_RUNTIME_EXTENSION, E10_RUNTIME_EXTENSION]);
  if (!opened.ok) return Object.freeze({ ok: false as const, rejection: mapRuntimeFailure(opened.rejection.code, opened.rejection.diagnostic) });
  const internal = opened.value;
  if (internal.publicHandle.status.currentVersion !== 4) {
    internal.publicHandle.close();
    return rejection("schema_corrupt", "step_schema_version_invalid");
  }
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    internal.publicHandle.close();
  };
  const ensureOpen = <T>(): StepResult<true> => closed ? rejection("store_closed", "step_ledger_closed") : success(true);
  const plan = (input: unknown, lease: unknown): StepResult<StepRecord> => {
    const open = ensureOpen<StepRecord>(); if (!open.ok) return open;
    const parsedInput = parsePlanInput(input); if (!parsedInput.ok) return parsedInput;
    return makePlan(internal, options, parsedInput.value, lease);
  };
  const prepare = (input: unknown, lease: unknown): StepResult<Readonly<{ readonly attempt: StepAttemptRecord; readonly step: StepRecord }>> => {
    const open = ensureOpen<StepRecord>(); if (!open.ok) return open;
    const parsedInput = parsePrepareInput(input); if (!parsedInput.ok) return parsedInput;
    return makePrepare(internal, options, parsedInput.value, lease, false);
  };
  const retry = (input: unknown, lease: unknown): StepResult<Readonly<{ readonly attempt: StepAttemptRecord; readonly step: StepRecord }>> => {
    const open = ensureOpen<StepRecord>(); if (!open.ok) return open;
    const parsedInput = parseRetryInput(input); if (!parsedInput.ok) return parsedInput;
    return makePrepare(internal, options, parsedInput.value, lease, true, parsedInput.value.expectedRevision);
  };
  const transition = (input: unknown, lease: unknown): StepResult<StepRecord> => {
    const open = ensureOpen<StepRecord>(); if (!open.ok) return open;
    const parsedInput = parseTransitionInput(input); if (!parsedInput.ok) return parsedInput;
    return makeTransition(internal, options, parsedInput.value, lease);
  };
  const adopt = (input: unknown, lease: unknown): StepResult<StepRecord> => {
    const open = ensureOpen<StepRecord>(); if (!open.ok) return open;
    const parsedInput = parseAdoptInput(input); if (!parsedInput.ok) return parsedInput;
    return makeAdopt(internal, options, parsedInput.value, lease);
  };
  const recordRecoveryDecision = (input: unknown, lease: unknown): StepResult<true> => {
    const open = ensureOpen<true>(); if (!open.ok) return open;
    const parsedInput = parseRecoveryInput(input); if (!parsedInput.ok) return parsedInput;
    return makeRecoveryDecision(internal, options, parsedInput.value, lease);
  };
  const supersede = (input: unknown, lease: unknown): StepResult<true> => {
    const parsedInput = publicRecoveryInput(input, "supersede"); if (!parsedInput.ok) return parsedInput;
    return makeRecoveryDecision(internal, options, parsedInput.value, lease);
  };
  const manualRecovery = (input: unknown, lease: unknown): StepResult<true> => {
    const parsedInput = publicRecoveryInput(input, "manual-recovery"); if (!parsedInput.ok) return parsedInput;
    return makeRecoveryDecision(internal, options, parsedInput.value, lease);
  };
  const get = (stepIdInput: unknown): StepResult<StepRecord | undefined> => {
    const open = ensureOpen<true>(); if (!open.ok) return open as StepResult<StepRecord | undefined>;
    if (!parseStepId(stepIdInput)) return rejection("invalid_input", "step_id_invalid");
    return readStep(internal.connection, stepIdInput);
  };
  const scan = (): StepResult<RecoveryReport> => {
    const open = ensureOpen<true>(); if (!open.ok) return open as StepResult<RecoveryReport>;
    return makeScan(internal, options);
  };
  const observeEffect = (input: unknown, lease: unknown): StepResult<StepRecord> => {
    const parsed = parseTransitionInput({ ...(objectLike(input) ? input : {}), toState: "effect-observed" });
    if (!parsed.ok) return parsed;
    return makeTransition(internal, options, parsed.value, lease);
  };
  const validate = (input: unknown, lease: unknown): StepResult<StepRecord> => {
    const parsed = parseTransitionInput({ ...(objectLike(input) ? input : {}), toState: "validated" });
    if (!parsed.ok) return parsed;
    return makeTransition(internal, options, parsed.value, lease);
  };
  const complete = (input: unknown, lease: unknown): StepResult<StepRecord> => {
    const parsedInput = ownRecord(input, ["stepId", "expectedRevision", "operationKey"]);
    if (!parsedInput) return rejection("invalid_input", "complete_input_invalid");
    const current = get(parsedInput.stepId);
    if (!current.ok || current.value === undefined) return current.ok ? rejection("not_found", "step_not_found") : current;
    if (current.value.validation === undefined) return rejection("invalid_transition", "completion_requires_validation");
    const parsed = parseTransitionInput({ ...parsedInput, toState: "completed" });
    if (!parsed.ok) return parsed;
    return makeTransition(internal, options, parsed.value, lease);
  };
  const inspect = (): Readonly<{ readonly schemaVersion: number; readonly mode: "read-only" | "read-write"; readonly writable: boolean }> => Object.freeze({ schemaVersion: internal.publicHandle.status.currentVersion, mode: internal.publicHandle.status.mode, writable: internal.publicHandle.status.writable });
  const ledger = Object.freeze({ plan, prepare, transition, retry, adopt, supersede, manualRecovery, recordRecoveryDecision, get, scan, observeEffect, validate, complete, inspect, close });
  return success(ledger as unknown as StepLedger);
}
