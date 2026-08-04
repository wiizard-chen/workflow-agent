import { createHash } from "node:crypto";

import {
  canonicalizeJson,
  type JsonValue,
} from "@pi-workflow/v2-domain";
import {
  createSyntheticE11Registry,
  validateAcceptedCommandEnvelope,
  type AcceptedCommandEnvelope,
  type SchemaRegistry,
  type ServerPrincipalContext,
} from "@pi-workflow/v2-protocol";

import {
  openRuntimeDatabaseInternal,
  type RuntimeDatabaseInternal,
} from "../persistence/factory.js";
import {
  acquireMigrationLock,
  type MigrationLock,
} from "../persistence/migration-lock.js";
import { createBootstrapRuntimeMigrations } from "../persistence/migrations.js";
import { E05_RUNTIME_EXTENSION, E05_RUNTIME_MIGRATION } from "../persistence/e05-schema.js";
import { E08_RUNTIME_EXTENSION, E08_RUNTIME_MIGRATION } from "../leases/schema.js";
import type { NativeSqliteConnection } from "../persistence/native-sqlite.js";
import type {
  CommandCommitInput,
  CommandCommitValue,
  CommandJournal,
  JournalEvent,
  JournalInspection,
  JournalOptions,
  JournalRejection,
  JournalResult,
  OutboxAckInput,
  OutboxClaim,
  OutboxLeaseInput,
  OutboxRecord,
  OutboxRetryInput,
  OutboxStatus,
  PendingEvent,
  ProjectionWrite,
} from "./types.js";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_BATCH = 128;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_DATE_MS = 8_640_000_000_000_000;
const LEASE_MS = 5_000;
const DIGEST = /^[0-9a-f]{64}$/;

function rejection(code: JournalRejection["code"], diagnostic: string): JournalResult<never> {
  return Object.freeze({ ok: false as const, rejection: Object.freeze({ code, diagnostic }) });
}

function success<T>(value: T): JournalResult<T> {
  return Object.freeze({ ok: true as const, value });
}

function ownRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Readonly<Record<string, unknown>> | undefined {
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
    return Object.freeze(Object.fromEntries(keys.map((key) => [key, (Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor).value])));
  } catch {
    return undefined;
  }
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= MAX_IDENTIFIER_BYTES && !value.includes("\0");
}

function boundedInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= MAX_DATE_MS;
}

function depth(value: JsonValue, level = 0): number {
  if (level > 64) return level;
  if (Array.isArray(value)) return Math.max(level, ...value.map((item) => depth(item, level + 1)));
  if (value !== null && typeof value === "object") return Math.max(level, ...Object.values(value).map((item) => depth(item, level + 1)));
  return level;
}

function canonical(value: unknown): JournalResult<Readonly<{ value: JsonValue; text: string; hash: string }>> {
  try {
    const result = canonicalizeJson(value as JsonValue);
    if (!result.ok || Buffer.byteLength(result.text, "utf8") > MAX_JSON_BYTES || depth(result.value) > 64) return rejection("invalid_input", "canonical_json_bounds");
    return success(Object.freeze({ value: result.value as JsonValue, text: result.text, hash: createHash("sha256").update(result.text, "utf8").digest("hex") }));
  } catch {
    return rejection("invalid_input", "canonical_json_failed");
  }
}

function parseJson(value: unknown): JournalResult<JsonValue> {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_JSON_BYTES) return rejection("transaction_failed", "stored_json_invalid");
  try {
    const parsed = JSON.parse(value) as JsonValue;
    const copy = canonical(parsed);
    return copy.ok && copy.value.text === value ? success(copy.value.value) : rejection("transaction_failed", "stored_json_noncanonical");
  } catch {
    return rejection("transaction_failed", "stored_json_parse_failed");
  }
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && !value.includes("\0") ? value : undefined;
}

function rowField(row: unknown, key: string): unknown {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return undefined;
  return (row as Record<string, unknown>)[key];
}

function rows(connection: NativeSqliteConnection, sql: string, params?: unknown): readonly Record<string, unknown>[] {
  const values = (params === undefined ? connection.prepare(sql).all() : connection.prepare(sql).all(params)) as readonly unknown[];
  return values.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("row_invalid");
    return value as Record<string, unknown>;
  });
}

function principalJson(principal: ServerPrincipalContext): JournalResult<Readonly<{ value: JsonValue; text: string; hash: string }>> {
  return canonical(principal);
}

function commandIdentity(accepted: AcceptedCommandEnvelope): JournalResult<Readonly<{ text: string; hash: string }>> {
  const stablePrincipal = {
    kind: accepted.principal.kind,
    principalId: accepted.principal.principalId,
  };
  const grant = accepted.humanPresenceGrant === undefined ? undefined : {
    ref: accepted.humanPresenceGrant.ref,
    nonce: accepted.humanPresenceGrant.nonce,
  };
  const value = {
    kind: accepted.kind,
    protocolVersion: accepted.protocolVersion,
    commandId: accepted.commandId,
    schemaId: accepted.schemaId,
    schemaVersion: accepted.schemaVersion,
    payload: accepted.payload,
    correlationId: accepted.correlationId,
    ...(accepted.aggregate ? { aggregate: accepted.aggregate } : {}),
    principal: stablePrincipal,
    ...(grant ? { humanPresenceGrant: grant } : {}),
  };
  const result = canonical(value);
  return result.ok ? success(Object.freeze({ text: result.value.text, hash: result.value.hash })) : result;
}

function eventDrafts(
  registry: SchemaRegistry,
  accepted: AcceptedCommandEnvelope,
  drafts: readonly PendingEvent[],
): JournalResult<readonly PendingEvent[]> {
  if (!Array.isArray(drafts) || drafts.length > MAX_BATCH) return rejection("invalid_input", "event_batch_bounds");
  const seen = new Set<string>();
  const normalized: PendingEvent[] = [];
  for (const draft of drafts) {
    const exact = ownRecord(draft, ["eventId", "schemaId", "schemaVersion", "payload"]);
    if (!exact || !identifier(exact.eventId) || seen.has(exact.eventId) || typeof exact.schemaId !== "string" ||
        !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(exact.schemaId) || !boundedInteger(exact.schemaVersion, 1)) {
      return rejection("invalid_input", "event_draft_invalid");
    }
    const payload = registry.validatePayload("event", exact.schemaId, exact.schemaVersion, exact.payload);
    if (!payload.ok) return rejection("invalid_input", `event_payload_${payload.rejection.code}`);
    const copied = canonical(payload.value);
    if (!copied.ok) return copied;
    seen.add(exact.eventId);
    normalized.push(Object.freeze({ eventId: exact.eventId, schemaId: exact.schemaId as PendingEvent["schemaId"], schemaVersion: exact.schemaVersion as PendingEvent["schemaVersion"], payload: copied.value.value }));
  }
  if (accepted.aggregate && normalized.length === 0) return rejection("invalid_input", "aggregate_requires_event");
  if (!accepted.aggregate && normalized.length > 0) return rejection("invalid_input", "event_requires_aggregate");
  return success(Object.freeze(normalized));
}

function projectionDrafts(input: unknown, eventIds: ReadonlySet<string>, eventSequences: ReadonlyMap<string, number>): JournalResult<readonly ProjectionWrite[]> {
  if (input === undefined) return success(Object.freeze([]));
  if (!Array.isArray(input) || input.length > MAX_BATCH) return rejection("invalid_input", "projection_batch_bounds");
  const normalized: ProjectionWrite[] = [];
  for (const draft of input) {
    const exact = ownRecord(draft, ["projectionName", "projectionKey", "sourceEventId", "sourceAggregateRevision", "value"]);
    if (!exact || !identifier(exact.projectionName) || !identifier(exact.projectionKey) || !identifier(exact.sourceEventId) ||
        !eventIds.has(exact.sourceEventId) || !boundedInteger(exact.sourceAggregateRevision, 1) ||
        eventSequences.get(exact.sourceEventId) !== exact.sourceAggregateRevision) return rejection("projection_conflict", "projection_source_invalid");
    const value = canonical(exact.value);
    if (!value.ok) return value;
    normalized.push(Object.freeze({ projectionName: exact.projectionName, projectionKey: exact.projectionKey, sourceEventId: exact.sourceEventId, sourceAggregateRevision: exact.sourceAggregateRevision, value: value.value.value }));
  }
  return success(Object.freeze(normalized));
}

function outboxDrafts(input: unknown, eventIds: ReadonlySet<string>, now: number): JournalResult<readonly Readonly<{ eventId: string; intentKind: string; payload: JsonValue; availableAt: number; operationKey: string; outboxId: string; payloadHash: string; payloadText: string }>[]> {
  if (!Array.isArray(input) || input.length > MAX_BATCH) return rejection("invalid_input", "outbox_batch_bounds");
  const seen = new Set<string>();
  const normalized: Array<{ eventId: string; intentKind: string; payload: JsonValue; availableAt: number; operationKey: string; outboxId: string; payloadHash: string; payloadText: string }> = [];
  for (const draft of input) {
    const exact = ownRecord(draft, ["eventId", "intentKind", "payload"], ["availableAtEpochMs"]);
    if (!exact || !identifier(exact.eventId) || !eventIds.has(exact.eventId) || !identifier(exact.intentKind)) return rejection("outbox_conflict", "outbox_intent_invalid");
    const payload = canonical(exact.payload);
    if (!payload.ok) return payload;
    const keyResult = canonical({ eventId: exact.eventId, intentKind: exact.intentKind });
    if (!keyResult.ok) return keyResult;
    const operationKey = keyResult.value.hash;
    if (seen.has(operationKey)) return rejection("outbox_conflict", "duplicate_operation_key");
    seen.add(operationKey);
    const availableAt = exact.availableAtEpochMs === undefined ? now : exact.availableAtEpochMs;
    if (!boundedInteger(availableAt, 0)) return rejection("invalid_input", "outbox_time_invalid");
    normalized.push({ eventId: exact.eventId, intentKind: exact.intentKind, payload: payload.value.value, availableAt, operationKey, outboxId: `obx_${operationKey}`, payloadHash: payload.value.hash, payloadText: payload.value.text });
  }
  return success(Object.freeze(normalized.map((item) => Object.freeze(item))));
}

function readStoredResult(row: Record<string, unknown>): JournalResult<CommandCommitValue> {
  const commandId = stringValue(row.command_id);
  const commandHash = stringValue(row.command_hash);
  const input = parseJson(row.input_json);
  const result = parseJson(row.result_json);
  const eventIds = parseJson(row.event_ids_json);
  const outboxIds = parseJson(row.outbox_ids_json);
  const resultHash = stringValue(row.result_hash);
  const revision = numberValue(row.revision);
  if (!commandId || !commandHash || !DIGEST.test(commandHash) || !input.ok || !result.ok || !eventIds.ok || !outboxIds.ok || !resultHash || !DIGEST.test(resultHash) || revision === undefined || revision < 0 || !Array.isArray(eventIds.value) || !Array.isArray(outboxIds.value) || !eventIds.value.every(identifier) || !outboxIds.value.every(identifier)) return rejection("transaction_failed", "journal_row_invalid");
  const storedInput = canonical(input.value);
  const storedResult = canonical(result.value);
  if (!storedInput.ok || !storedResult.ok || storedInput.value.hash !== commandHash || storedResult.value.hash !== resultHash) return rejection("transaction_failed", "journal_row_hash_mismatch");
  if (row.outcome !== "committed" && row.outcome !== "rejected") return rejection("transaction_failed", "journal_outcome_invalid");
  if (row.outcome === "rejected") {
    const diagnostic = result.value !== null && typeof result.value === "object" && !Array.isArray(result.value) ? stringValue((result.value as Record<string, unknown>).diagnostic) : undefined;
    const code = result.value !== null && typeof result.value === "object" && !Array.isArray(result.value) ? stringValue((result.value as Record<string, unknown>).code) : undefined;
    const allowed: readonly JournalRejection["code"][] = ["expected_revision_mismatch", "event_conflict", "projection_conflict", "outbox_conflict", "invalid_input"];
    return rejection(allowed.includes(code as JournalRejection["code"]) ? code as JournalRejection["code"] : "transaction_failed", diagnostic ?? "journaled_rejection");
  }
  return success(Object.freeze({ commandId, replayed: true, result: result.value, revision, eventIds: Object.freeze([...eventIds.value] as string[]), outboxIds: Object.freeze([...outboxIds.value] as string[]) }));
}

function withWrite<T>(
  internal: RuntimeDatabaseInternal,
  action: (connection: NativeSqliteConnection, lock: MigrationLock) => JournalResult<T>,
  commitRejectionCodes: readonly JournalRejection["code"][] = [],
): JournalResult<T> {
  if (internal.publicHandle.status.mode === "read-only" || !internal.publicHandle.status.writable) return rejection("read_only", "runtime_is_read_only");
  const acquired = acquireMigrationLock(internal.connection);
  if (!acquired.ok) return rejection(acquired.rejection.code === "migration_locked" ? "transaction_failed" : "read_only", acquired.rejection.diagnostic);
  const lock = acquired.value;
  try {
    const value = action(internal.connection, lock);
    if (!value.ok && !commitRejectionCodes.includes(value.rejection.code)) {
      lock.rollback();
      return value;
    }
    const committed = lock.commit();
    if (!committed.ok) {
      lock.rollback();
      return rejection("transaction_failed", committed.rejection.diagnostic);
    }
    return value;
  } catch (error) {
    lock.rollback();
    return rejection("transaction_failed", error instanceof Error ? error.message.replace(/[^a-z0-9_:-]/gi, "_").slice(0, 120) : "transaction_failed");
  }
}

function parsePrincipal(value: unknown): JournalResult<ServerPrincipalContext> {
  const parsed = parseJson(value);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return rejection("transaction_failed", "stored_principal_invalid");
  const exact = ownRecord(parsed.value, ["kind", "principalId", "connectionId", "connectionGeneration", "daemonEpoch", "capabilityRefs"]);
  const kind = exact?.kind;
  const refs = exact?.capabilityRefs;
  if (!exact || !["human-interactive-client", "product-agent", "engineering-worker", "scheduler", "github-reconciler", "release-adapter", "system-recovery"].includes(kind as string) ||
      !identifier(exact.principalId) || !identifier(exact.connectionId) || !boundedInteger(exact.connectionGeneration, 1) || !identifier(exact.daemonEpoch) ||
      !Array.isArray(refs) || !refs.every(identifier)) return rejection("transaction_failed", "stored_principal_invalid");
  return success(Object.freeze({
    kind: kind as ServerPrincipalContext["kind"],
    principalId: exact.principalId as string,
    connectionId: exact.connectionId as string,
    connectionGeneration: exact.connectionGeneration as number,
    daemonEpoch: exact.daemonEpoch as string,
    capabilityRefs: Object.freeze([...refs] as string[]),
  }));
}

function parseEvent(registry: SchemaRegistry, row: Record<string, unknown>): JournalResult<JournalEvent> {
  const payload = parseJson(row.payload_json);
  const principal = parsePrincipal(row.principal_json);
  const eventId = stringValue(row.event_id); const aggregateType = stringValue(row.aggregate_type); const aggregateId = stringValue(row.aggregate_id);
  const sequence = numberValue(row.aggregate_sequence); const cursor = numberValue(row.global_cursor); const schemaId = stringValue(row.schema_id); const schemaVersion = numberValue(row.schema_version); const correlationId = stringValue(row.correlation_id); const causationId = stringValue(row.causation_id); const occurredAt = stringValue(row.occurred_at);
  if (!payload.ok || !principal.ok || !eventId || !aggregateType || !aggregateId || sequence === undefined || sequence < 1 || cursor === undefined || cursor < 1 || !schemaId || schemaVersion === undefined || schemaVersion < 1 || !correlationId || !causationId || !occurredAt) return rejection("transaction_failed", "event_row_invalid");
  const validated = registry.validatePayload("event", schemaId, schemaVersion, payload.value);
  if (!validated.ok) return rejection("transaction_failed", "event_payload_invalid");
  return success(Object.freeze({ eventId, aggregateType, aggregateId, sequence, globalCursor: cursor, schemaId, schemaVersion, payload: payload.value, principal: principal.value, correlationId, causationId, occurredAt }));
}

function parseOutbox(row: Record<string, unknown>): JournalResult<OutboxRecord> {
  const payload = parseJson(row.payload_json);
  const ack = row.ack_json === null || row.ack_json === undefined ? success<JsonValue | undefined>(undefined) : parseJson(row.ack_json);
  const outboxId = stringValue(row.outbox_id); const eventId = stringValue(row.event_id); const intentKind = stringValue(row.intent_kind); const operationKey = stringValue(row.operation_key); const payloadHash = stringValue(row.payload_hash); const status = stringValue(row.status) as OutboxStatus | undefined; const availableAt = numberValue(row.available_at_ms); const attempt = numberValue(row.attempt);
  if (!payload.ok || !ack.ok || !outboxId || !eventId || !intentKind || !operationKey || !payloadHash || !DIGEST.test(payloadHash) || !DIGEST.test(operationKey) || !status || !["pending", "leased", "acked"].includes(status) || availableAt === undefined || availableAt < 0 || attempt === undefined || attempt < 0) return rejection("transaction_failed", "outbox_row_invalid");
  const payloadCanonical = canonical(payload.value);
  const operationCanonical = canonical({ eventId, intentKind });
  if (!payloadCanonical.ok || !operationCanonical.ok || payloadCanonical.value.hash !== payloadHash || operationCanonical.value.hash !== operationKey || outboxId !== `obx_${operationKey}`) return rejection("transaction_failed", "outbox_row_hash_mismatch");
  const owner = stringValue(row.owner); const generation = numberValue(row.generation); const leaseUntil = numberValue(row.lease_until_ms); const ackHash = stringValue(row.ack_hash); const lastError = stringValue(row.last_error);
  if ((generation !== undefined && generation < 1) || (leaseUntil !== undefined && leaseUntil < 0) || (ackHash !== undefined && !DIGEST.test(ackHash))) return rejection("transaction_failed", "outbox_lease_fields_invalid");
  return success(Object.freeze({ outboxId, eventId, intentKind, operationKey, payload: payload.value, payloadHash, status, availableAtEpochMs: availableAt, attempt, ...(owner ? { owner } : {}), ...(generation !== undefined ? { generation } : {}), ...(leaseUntil !== undefined ? { leaseUntilEpochMs: leaseUntil } : {}), ...(ackHash ? { ackHash } : {}), ...(ack.value !== undefined ? { ack: ack.value } : {}), ...(lastError ? { lastError } : {}) }));
}

function validateJournalState(internal: RuntimeDatabaseInternal, registry: SchemaRegistry): JournalResult<true> {
  try {
    const commandRows = rows(internal.connection, "SELECT command_id, command_hash, input_json, result_json, result_hash, outcome, revision, event_ids_json, outbox_ids_json FROM workflow_command_journal ORDER BY command_id ASC");
    const commandIds = new Set<string>();
    const commandEvents = new Map<string, readonly string[]>();
    const commandOutboxes = new Map<string, readonly string[]>();
    for (const command of commandRows) {
      const commandId = stringValue(command.command_id);
      const eventIds = parseJson(command.event_ids_json);
      const outboxIds = parseJson(command.outbox_ids_json);
      if (!commandId || commandIds.has(commandId) || !eventIds.ok || !outboxIds.ok || !Array.isArray(eventIds.value) || !Array.isArray(outboxIds.value) ||
          !eventIds.value.every(identifier) || !outboxIds.value.every(identifier)) return rejection("schema_corrupt", "journal_command_facts_invalid");
      const stored = readStoredResult(command);
      if (command.outcome === "committed") {
        if (!stored.ok) return rejection("schema_corrupt", "journal_committed_row_invalid");
      } else if (command.outcome === "rejected") {
        if (stored.ok || stored.rejection.code !== "expected_revision_mismatch" || eventIds.value.length !== 0 || outboxIds.value.length !== 0) return rejection("schema_corrupt", "journal_rejected_row_invalid");
      } else {
        return rejection("schema_corrupt", "journal_outcome_invalid");
      }
      commandIds.add(commandId);
      commandEvents.set(commandId, Object.freeze([...eventIds.value] as string[]));
      commandOutboxes.set(commandId, Object.freeze([...outboxIds.value] as string[]));
    }

    const eventRows = rows(internal.connection, "SELECT event_id, aggregate_type, aggregate_id, aggregate_sequence, global_cursor, schema_id, schema_version, payload_json, principal_json, correlation_id, causation_id, occurred_at FROM workflow_event_log ORDER BY global_cursor ASC");
    const events = new Map<string, JournalEvent>();
    const aggregateSequences = new Map<string, number>();
    let expectedCursor = 1;
    for (const row of eventRows) {
      const parsed = parseEvent(registry, row);
      if (!parsed.ok) return rejection("schema_corrupt", "journal_event_row_invalid");
      const value = parsed.value;
      if (value.globalCursor !== expectedCursor || events.has(value.eventId) || !commandIds.has(value.causationId)) return rejection("schema_corrupt", "journal_event_cursor_invalid");
      const aggregateKey = `${value.aggregateType}\u0000${value.aggregateId}`;
      const expectedSequence = (aggregateSequences.get(aggregateKey) ?? 0) + 1;
      if (value.sequence !== expectedSequence) return rejection("schema_corrupt", "journal_event_sequence_invalid");
      aggregateSequences.set(aggregateKey, value.sequence);
      events.set(value.eventId, value);
      expectedCursor += 1;
    }

    const outboxRows = rows(internal.connection, "SELECT outbox_id, event_id, intent_kind, operation_key, payload_json, payload_hash, status, available_at_ms, attempt, owner, generation, lease_until_ms, ack_hash, ack_json, last_error FROM workflow_outbox ORDER BY outbox_id ASC");
    const outboxes = new Map<string, OutboxRecord>();
    for (const row of outboxRows) {
      const parsed = parseOutbox(row);
      if (!parsed.ok) return rejection("schema_corrupt", "journal_outbox_row_invalid");
      const value = parsed.value;
      if (outboxes.has(value.outboxId) || !events.has(value.eventId)) return rejection("schema_corrupt", "journal_outbox_binding_invalid");
      outboxes.set(value.outboxId, value);
    }

    const projectionRows = rows(internal.connection, "SELECT projection_name, projection_key, source_event_id, source_aggregate_revision, value_json, value_hash FROM workflow_projection_state ORDER BY projection_name ASC, projection_key ASC");
    for (const row of projectionRows) {
      const projectionName = stringValue(row.projection_name);
      const projectionKey = stringValue(row.projection_key);
      const sourceEventId = stringValue(row.source_event_id);
      const sourceRevision = numberValue(row.source_aggregate_revision);
      const value = parseJson(row.value_json);
      const valueHash = stringValue(row.value_hash);
      const event = sourceEventId ? events.get(sourceEventId) : undefined;
      const canonicalValue = value.ok ? canonical(value.value) : value;
      if (!projectionName || !projectionKey || !sourceEventId || sourceRevision === undefined || sourceRevision < 1 || !value.ok || !valueHash || !DIGEST.test(valueHash) || !canonicalValue.ok || canonicalValue.value.hash !== valueHash || !event || event.sequence !== sourceRevision) return rejection("schema_corrupt", "journal_projection_row_invalid");
    }

    const headRows = rows(internal.connection, "SELECT aggregate_type, aggregate_id, revision, updated_event_id FROM workflow_aggregate_head ORDER BY aggregate_type ASC, aggregate_id ASC");
    const heads = new Map<string, number>();
    for (const row of headRows) {
      const aggregateType = stringValue(row.aggregate_type);
      const aggregateId = stringValue(row.aggregate_id);
      const revision = numberValue(row.revision);
      const updatedEventId = stringValue(row.updated_event_id);
      const updated = updatedEventId ? events.get(updatedEventId) : undefined;
      if (!aggregateType || !aggregateId || revision === undefined || revision < 0 || (revision === 0 && updatedEventId !== undefined) || (revision > 0 && (!updated || updated.aggregateType !== aggregateType || updated.aggregateId !== aggregateId || updated.sequence !== revision))) return rejection("schema_corrupt", "journal_head_row_invalid");
      const key = `${aggregateType}\u0000${aggregateId}`;
      if (heads.has(key)) return rejection("schema_corrupt", "journal_head_duplicate");
      heads.set(key, revision);
    }
    for (const [key, revision] of aggregateSequences) {
      if (heads.get(key) !== revision) return rejection("schema_corrupt", "journal_head_revision_invalid");
    }
    for (const [key, revision] of heads) {
      if (revision > 0 && aggregateSequences.get(key) !== revision) return rejection("schema_corrupt", "journal_head_revision_invalid");
    }

    for (const [commandId, eventIds] of commandEvents) {
      for (const eventId of eventIds) {
        const event = events.get(eventId);
        if (!event || event.causationId !== commandId) return rejection("schema_corrupt", "journal_command_event_binding_invalid");
      }
    }
    for (const [commandId, outboxIds] of commandOutboxes) {
      const eventIds = new Set(commandEvents.get(commandId) ?? []);
      for (const outboxId of outboxIds) {
        const outbox = outboxes.get(outboxId);
        if (!outbox || !eventIds.has(outbox.eventId)) return rejection("schema_corrupt", "journal_command_outbox_binding_invalid");
      }
    }
    return success(true as const);
  } catch {
    return rejection("schema_corrupt", "journal_state_inspection_failed");
  }
}

function validateOptions(options: unknown): JournalResult<JournalOptions> {
  const exact = ownRecord(options, ["runtimeRoot", "databasePath", "now"], ["backupDirectory", "mode", "includeLeaseSchema"]);
  if (!exact || typeof exact.runtimeRoot !== "string" || typeof exact.databasePath !== "string" || typeof exact.now !== "function" || (exact.mode !== undefined && exact.mode !== "read-only" && exact.mode !== "read-write") || (exact.backupDirectory !== undefined && typeof exact.backupDirectory !== "string") || (exact.includeLeaseSchema !== undefined && typeof exact.includeLeaseSchema !== "boolean")) return rejection("invalid_input", "journal_options_invalid");
  return success(Object.freeze({ runtimeRoot: exact.runtimeRoot, databasePath: exact.databasePath, ...(exact.backupDirectory ? { backupDirectory: exact.backupDirectory } : {}), ...(exact.mode ? { mode: exact.mode } : {}), ...(exact.includeLeaseSchema ? { includeLeaseSchema: true } : {}), now: exact.now as () => number }));
}

function buildInspection(internal: RuntimeDatabaseInternal): JournalInspection {
  const connection = internal.connection;
  const count = (table: string): number => numberValue(rowField(connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), "count")) ?? 0;
  const highest = numberValue(rowField(connection.prepare("SELECT COALESCE(MAX(global_cursor), 0) AS cursor FROM workflow_event_log").get(), "cursor")) ?? 0;
  return Object.freeze({ status: internal.publicHandle.status.mode, schemaVersion: internal.publicHandle.status.currentVersion, commandCount: count("workflow_command_journal"), aggregateCount: count("workflow_aggregate_head"), eventCount: count("workflow_event_log"), projectionCount: count("workflow_projection_state"), outboxCount: count("workflow_outbox"), highestGlobalCursor: highest });
}

export function openCommandJournal(optionsInput: unknown): JournalResult<CommandJournal> {
  const options = validateOptions(optionsInput);
  if (!options.ok) return options;
  const registryResult = createSyntheticE11Registry();
  if (!registryResult.ok) return rejection("schema_corrupt", "synthetic_registry_unavailable");
  const includeLeaseSchema = options.value.includeLeaseSchema === true;
  const migrations = Object.freeze([...createBootstrapRuntimeMigrations(), E05_RUNTIME_MIGRATION, ...(includeLeaseSchema ? [E08_RUNTIME_MIGRATION] : [])]);
  const extensions = includeLeaseSchema ? [E05_RUNTIME_EXTENSION, E08_RUNTIME_EXTENSION] as const : E05_RUNTIME_EXTENSION;
  const opened = openRuntimeDatabaseInternal({ runtimeRoot: options.value.runtimeRoot, databasePath: options.value.databasePath, ...(options.value.backupDirectory ? { backupDirectory: options.value.backupDirectory } : {}), ...(options.value.mode ? { mode: options.value.mode } : {}), migrations }, extensions);
  if (!opened.ok) return rejection(opened.rejection.code === "read_only" ? "read_only" : opened.rejection.code === "schema_corrupt" ? "schema_corrupt" : "migration_failed", opened.rejection.diagnostic);
  const internal = opened.value;
  const registry = registryResult.value;
  const state = validateJournalState(internal, registry);
  if (!state.ok) {
    internal.publicHandle.close();
    return rejection("schema_corrupt", state.rejection.diagnostic);
  }
  const now = (): JournalResult<number> => {
    try {
      const value = options.value.now();
      return boundedInteger(value, 0) && value <= MAX_DATE_MS ? success(value) : rejection("invalid_input", "clock_invalid");
    } catch {
      return rejection("invalid_input", "clock_failed");
    }
  };
  const close = (): void => internal.publicHandle.close();

  const commit = (input: unknown): JournalResult<CommandCommitValue> => {
    const exact = ownRecord(input, ["accepted", "result", "events", "outbox"], ["projections"]);
    if (!exact || !Array.isArray(exact.events) || !Array.isArray(exact.outbox)) return rejection("invalid_input", "command_input_invalid");
    const acceptedResult = validateAcceptedCommandEnvelope(registry, exact.accepted);
    if (!acceptedResult.ok) return rejection("invalid_input", "accepted_envelope_untrusted");
    const accepted = acceptedResult.value;
    const commandHash = commandIdentity(accepted);
    if (!commandHash.ok) return commandHash;
    const transaction = withWrite(internal, (connection) => {
      const existing = connection.prepare("SELECT command_id, command_hash, input_json, result_json, result_hash, outcome, revision, event_ids_json, outbox_ids_json FROM workflow_command_journal WHERE command_id = $commandId").get({ $commandId: accepted.commandId }) as Record<string, unknown> | undefined;
      if (existing) {
        if (existing.command_hash !== commandHash.value.hash) return rejection("idempotency_collision", "command_hash_mismatch");
        return readStoredResult(existing);
      }
      const result = canonical(exact.result);
      if (!result.ok) return result;
      const principal = principalJson(accepted.principal);
      if (!principal.ok) return principal;
      const clock = now();
      if (!clock.ok) return clock;
      const events = eventDrafts(registry, accepted, exact.events as readonly PendingEvent[]);
      if (!events.ok) return events;
      const eventIds = new Set(events.value.map((event) => event.eventId));
      const outboxes = outboxDrafts(exact.outbox, eventIds, clock.value);
      if (!outboxes.ok) return outboxes;
      const eventSequences = new Map<string, number>();
      const projectionsInput = exact.projections;
      if (projectionsInput !== undefined && !Array.isArray(projectionsInput)) return rejection("invalid_input", "projection_batch_invalid");
      const preProjections: readonly unknown[] = projectionsInput === undefined ? [] : projectionsInput;
      if (preProjections.length > MAX_BATCH) return rejection("invalid_input", "projection_batch_bounds");
      if (accepted.aggregate === undefined && (events.value.length > 0 || preProjections.length > 0 || outboxes.value.length > 0)) return rejection("invalid_input", "aggregate_required_for_facts");
      let oldRevision = 0;
      if (accepted.aggregate) {
        const head = connection.prepare("SELECT revision FROM workflow_aggregate_head WHERE aggregate_type = $type AND aggregate_id = $id").get({ $type: accepted.aggregate.type, $id: accepted.aggregate.id }) as Record<string, unknown> | undefined;
        oldRevision = head ? numberValue(head.revision) ?? -1 : 0;
        if (oldRevision < 0) return rejection("transaction_failed", "aggregate_head_invalid");
        if (oldRevision !== accepted.aggregate.expectedRevision) {
          const terminal = canonical({ code: "expected_revision_mismatch", diagnostic: `expected_${accepted.aggregate.expectedRevision}_actual_${oldRevision}` });
          if (!terminal.ok) return terminal;
          connection.prepare("INSERT INTO workflow_command_journal (command_id, command_hash, input_json, result_json, result_hash, outcome, aggregate_type, aggregate_id, revision, event_ids_json, outbox_ids_json, principal_json, created_at_ms) VALUES ($commandId, $commandHash, $inputJson, $resultJson, $resultHash, 'rejected', $aggregateType, $aggregateId, $revision, '[]', '[]', $principalJson, $createdAt)").run({ $commandId: accepted.commandId, $commandHash: commandHash.value.hash, $inputJson: commandHash.value.text, $resultJson: terminal.value.text, $resultHash: terminal.value.hash, $aggregateType: accepted.aggregate.type, $aggregateId: accepted.aggregate.id, $revision: oldRevision, $principalJson: principal.value.text, $createdAt: clock.value });
          const terminalValue = terminal.value.value;
          const diagnostic = terminalValue !== null && typeof terminalValue === "object" && !Array.isArray(terminalValue)
            ? stringValue((terminalValue as Readonly<Record<string, JsonValue>>).diagnostic)
            : undefined;
          return rejection("expected_revision_mismatch", diagnostic ?? "expected_revision_mismatch");
        }
      }
      const newRevision = oldRevision + events.value.length;
      const expectedSequence = oldRevision;
      for (let index = 0; index < events.value.length; index += 1) eventSequences.set(events.value[index]!.eventId, expectedSequence + index + 1);
      const projections = projectionDrafts(preProjections, eventIds, eventSequences);
      if (!projections.ok) return projections;
      for (const event of events.value) {
        const prior = connection.prepare("SELECT event_id FROM workflow_event_log WHERE event_id = $eventId").get({ $eventId: event.eventId }) as Record<string, unknown> | undefined;
        if (prior) return rejection("event_conflict", "event_id_already_exists");
      }
      for (const outbox of outboxes.value) {
        const prior = connection.prepare("SELECT outbox_id FROM workflow_outbox WHERE operation_key = $operationKey").get({ $operationKey: outbox.operationKey }) as Record<string, unknown> | undefined;
        if (prior) return rejection("outbox_conflict", "operation_key_already_exists");
      }
      const eventIdsJson = canonical(events.value.map((event) => event.eventId));
      const outboxIdsJson = canonical(outboxes.value.map((item) => item.outboxId));
      if (!eventIdsJson.ok || !outboxIdsJson.ok) return rejection("invalid_input", "ids_canonicalization_failed");
      connection.prepare("INSERT INTO workflow_command_journal (command_id, command_hash, input_json, result_json, result_hash, outcome, aggregate_type, aggregate_id, revision, event_ids_json, outbox_ids_json, principal_json, created_at_ms) VALUES ($commandId, $commandHash, $inputJson, $resultJson, $resultHash, 'committed', $aggregateType, $aggregateId, $revision, $eventIdsJson, $outboxIdsJson, $principalJson, $createdAt)").run({ $commandId: accepted.commandId, $commandHash: commandHash.value.hash, $inputJson: commandHash.value.text, $resultJson: result.value.text, $resultHash: result.value.hash, $aggregateType: accepted.aggregate?.type ?? null, $aggregateId: accepted.aggregate?.id ?? null, $revision: newRevision, $eventIdsJson: eventIdsJson.value.text, $outboxIdsJson: outboxIdsJson.value.text, $principalJson: principal.value.text, $createdAt: clock.value });
      const maxCursor = numberValue(rowField(connection.prepare("SELECT COALESCE(MAX(global_cursor), 0) AS cursor FROM workflow_event_log").get(), "cursor")) ?? 0;
      for (let index = 0; index < events.value.length; index += 1) {
        const event = events.value[index]!;
        const sequence = eventSequences.get(event.eventId)!;
        const occurredAt = new Date(clock.value).toISOString();
        const eventPayload = canonical(event.payload);
        if (!eventPayload.ok) return eventPayload;
        connection.prepare("INSERT INTO workflow_event_log (event_id, aggregate_type, aggregate_id, aggregate_sequence, global_cursor, schema_id, schema_version, payload_json, principal_json, correlation_id, causation_id, occurred_at) VALUES ($eventId, $aggregateType, $aggregateId, $sequence, $cursor, $schemaId, $schemaVersion, $payloadJson, $principalJson, $correlationId, $causationId, $occurredAt)").run({ $eventId: event.eventId, $aggregateType: accepted.aggregate!.type, $aggregateId: accepted.aggregate!.id, $sequence: sequence, $cursor: maxCursor + index + 1, $schemaId: event.schemaId, $schemaVersion: event.schemaVersion, $payloadJson: eventPayload.value.text, $principalJson: principal.value.text, $correlationId: accepted.correlationId, $causationId: accepted.commandId, $occurredAt: occurredAt });
      }
      if (accepted.aggregate) {
        connection.prepare("INSERT INTO workflow_aggregate_head (aggregate_type, aggregate_id, revision, updated_event_id) VALUES ($type, $id, $revision, $eventId) ON CONFLICT(aggregate_type, aggregate_id) DO UPDATE SET revision = excluded.revision, updated_event_id = excluded.updated_event_id").run({ $type: accepted.aggregate.type, $id: accepted.aggregate.id, $revision: newRevision, $eventId: events.value.at(-1)!.eventId });
      }
      for (const projection of projections.value) {
        const value = canonical(projection.value);
        if (!value.ok) return value;
        const prior = connection.prepare("SELECT source_aggregate_revision, source_event_id, value_hash FROM workflow_projection_state WHERE projection_name = $name AND projection_key = $key").get({ $name: projection.projectionName, $key: projection.projectionKey }) as Record<string, unknown> | undefined;
        if (prior) {
          const priorRevision = numberValue(prior.source_aggregate_revision) ?? -1;
          if (priorRevision > projection.sourceAggregateRevision) return rejection("projection_conflict", "stale_projection");
          if (priorRevision === projection.sourceAggregateRevision && (prior.value_hash !== value.value.hash || prior.source_event_id !== projection.sourceEventId)) return rejection("projection_conflict", "projection_same_revision_conflict");
          if (priorRevision === projection.sourceAggregateRevision) continue;
          connection.prepare("UPDATE workflow_projection_state SET source_event_id = $eventId, source_aggregate_revision = $revision, value_json = $valueJson, value_hash = $valueHash WHERE projection_name = $name AND projection_key = $key").run({ $eventId: projection.sourceEventId, $revision: projection.sourceAggregateRevision, $valueJson: value.value.text, $valueHash: value.value.hash, $name: projection.projectionName, $key: projection.projectionKey });
        } else {
          connection.prepare("INSERT INTO workflow_projection_state (projection_name, projection_key, source_event_id, source_aggregate_revision, value_json, value_hash) VALUES ($name, $key, $eventId, $revision, $valueJson, $valueHash)").run({ $name: projection.projectionName, $key: projection.projectionKey, $eventId: projection.sourceEventId, $revision: projection.sourceAggregateRevision, $valueJson: value.value.text, $valueHash: value.value.hash });
        }
      }
      for (const outbox of outboxes.value) {
        connection.prepare("INSERT INTO workflow_outbox (outbox_id, event_id, intent_kind, operation_key, payload_json, payload_hash, status, available_at_ms, attempt) VALUES ($outboxId, $eventId, $intentKind, $operationKey, $payloadJson, $payloadHash, 'pending', $availableAt, 0)").run({ $outboxId: outbox.outboxId, $eventId: outbox.eventId, $intentKind: outbox.intentKind, $operationKey: outbox.operationKey, $payloadJson: outbox.payloadText, $payloadHash: outbox.payloadHash, $availableAt: outbox.availableAt });
      }
      return success(Object.freeze({ commandId: accepted.commandId, replayed: false, result: result.value.value, revision: newRevision, eventIds: Object.freeze(events.value.map((event) => event.eventId)), outboxIds: Object.freeze(outboxes.value.map((item) => item.outboxId)) }));
    }, ["expected_revision_mismatch"]);
    return transaction;
  };

  const readEvents = (input?: unknown): JournalResult<readonly JournalEvent[]> => {
    const exact: Readonly<Record<string, unknown>> | undefined = input === undefined ? Object.freeze({}) : ownRecord(input, [], ["afterGlobalCursor", "aggregateType", "aggregateId", "limit"]);
    if (!exact || (exact.afterGlobalCursor !== undefined && !boundedInteger(exact.afterGlobalCursor, 0)) || (exact.aggregateType !== undefined && !identifier(exact.aggregateType)) || (exact.aggregateId !== undefined && !identifier(exact.aggregateId)) || (exact.limit !== undefined && (!boundedInteger(exact.limit, 1) || exact.limit > MAX_BATCH))) return rejection("invalid_input", "event_read_options_invalid");
    const limit = exact.limit ?? MAX_BATCH; const cursor = exact.afterGlobalCursor ?? 0;
    try {
      const values = rows(internal.connection, "SELECT event_id, aggregate_type, aggregate_id, aggregate_sequence, global_cursor, schema_id, schema_version, payload_json, principal_json, correlation_id, causation_id, occurred_at FROM workflow_event_log WHERE global_cursor > $cursor AND ($type IS NULL OR aggregate_type = $type) AND ($id IS NULL OR aggregate_id = $id) ORDER BY global_cursor ASC LIMIT $limit", { $cursor: cursor, $type: exact.aggregateType ?? null, $id: exact.aggregateId ?? null, $limit: limit });
      const parsed = values.map((value) => parseEvent(registry, value)); const bad = parsed.find((value) => !value.ok); return bad && !bad.ok ? bad : success(Object.freeze(parsed.map((value) => (value as { ok: true; value: JournalEvent }).value)));
    } catch { return rejection("transaction_failed", "event_read_failed"); }
  };

  const readOutbox = (input?: unknown): JournalResult<readonly OutboxRecord[]> => {
    const exact: Readonly<Record<string, unknown>> | undefined = input === undefined ? Object.freeze({}) : ownRecord(input, [], ["status", "limit", "nowEpochMs"]);
    if (!exact || (exact.status !== undefined && !["pending", "leased", "acked"].includes(exact.status as string)) || (exact.limit !== undefined && (!boundedInteger(exact.limit, 1) || exact.limit > MAX_BATCH)) || (exact.nowEpochMs !== undefined && !boundedInteger(exact.nowEpochMs, 0))) return rejection("invalid_input", "outbox_read_options_invalid");
    try {
      const values = rows(internal.connection, "SELECT outbox_id, event_id, intent_kind, operation_key, payload_json, payload_hash, status, available_at_ms, attempt, owner, generation, lease_until_ms, ack_hash, ack_json, last_error FROM workflow_outbox WHERE ($status IS NULL OR status = $status) ORDER BY available_at_ms ASC, outbox_id ASC LIMIT $limit", { $status: exact.status ?? null, $limit: exact.limit ?? MAX_BATCH });
      const parsed = values.map(parseOutbox); const bad = parsed.find((value) => !value.ok); return bad && !bad.ok ? bad : success(Object.freeze(parsed.map((value) => (value as { ok: true; value: OutboxRecord }).value)));
    } catch { return rejection("transaction_failed", "outbox_read_failed"); }
  };

  const claimOutbox = (ownerInput: unknown, nowInput: unknown, limitInput?: unknown): JournalResult<readonly OutboxClaim[]> => {
    if (!identifier(ownerInput) || !boundedInteger(nowInput, 0) || (limitInput !== undefined && (!boundedInteger(limitInput, 1) || limitInput > MAX_BATCH))) return rejection("invalid_input", "outbox_claim_options_invalid");
    const limit = limitInput === undefined ? MAX_BATCH : limitInput;
    return withWrite(internal, (connection) => {
      const candidates = rows(connection, "SELECT outbox_id, status, generation, attempt FROM workflow_outbox WHERE (status = 'pending' AND available_at_ms <= $now) OR (status = 'leased' AND lease_until_ms IS NOT NULL AND lease_until_ms <= $now) ORDER BY available_at_ms ASC, outbox_id ASC LIMIT $limit", { $now: nowInput, $limit: limit });
      const claims: OutboxClaim[] = [];
      for (const candidate of candidates) {
        const outboxId = stringValue(candidate.outbox_id); const oldGeneration = numberValue(candidate.generation) ?? 0; const attempt = numberValue(candidate.attempt) ?? 0;
        if (!outboxId) return rejection("transaction_failed", "outbox_candidate_invalid");
        const generation = oldGeneration + 1;
        connection.prepare("UPDATE workflow_outbox SET status = 'leased', owner = $owner, generation = $generation, lease_until_ms = $leaseUntil, attempt = $attempt WHERE outbox_id = $outboxId AND (status = 'pending' OR (status = 'leased' AND lease_until_ms IS NOT NULL AND lease_until_ms <= $now))").run({ $owner: ownerInput, $generation: generation, $leaseUntil: (nowInput as number) + LEASE_MS, $attempt: attempt + 1, $outboxId: outboxId, $now: nowInput });
        claims.push(Object.freeze({ outboxId, owner: ownerInput, generation }));
      }
      return success(Object.freeze(claims));
    });
  };

  const ackOutbox = (input: unknown): JournalResult<true> => {
    const exact = ownRecord(input, ["outboxId", "owner", "generation", "acknowledgement"]);
    if (!exact || !identifier(exact.outboxId) || !identifier(exact.owner) || !boundedInteger(exact.generation, 1)) return rejection("invalid_input", "outbox_ack_invalid");
    const ack = canonical(exact.acknowledgement); if (!ack.ok) return ack;
    return withWrite(internal, (connection) => {
      const row = connection.prepare("SELECT status, owner, generation, ack_hash FROM workflow_outbox WHERE outbox_id = $outboxId").get({ $outboxId: exact.outboxId }) as Record<string, unknown> | undefined;
      if (!row) return rejection("outbox_fenced", "outbox_not_found");
      if (row.status === "acked") return row.ack_hash === ack.value.hash ? success(true as const) : rejection("outbox_conflict", "ack_hash_conflict");
      if (row.status !== "leased" || row.owner !== exact.owner || row.generation !== exact.generation) return rejection("outbox_fenced", "lease_token_mismatch");
      const updated = connection.prepare("UPDATE workflow_outbox SET status = 'acked', ack_hash = $ackHash, ack_json = $ackJson, owner = NULL, lease_until_ms = NULL WHERE outbox_id = $outboxId AND status = 'leased' AND owner = $owner AND generation = $generation").run({ $ackHash: ack.value.hash, $ackJson: ack.value.text, $outboxId: exact.outboxId, $owner: exact.owner, $generation: exact.generation });
      void updated;
      return success(true as const);
    });
  };

  const retryOutbox = (input: unknown): JournalResult<true> => {
    const exact = ownRecord(input, ["outboxId", "owner", "generation", "availableAtEpochMs"], ["error"]);
    if (!exact || !identifier(exact.outboxId) || !identifier(exact.owner) || !boundedInteger(exact.generation, 1) || !boundedInteger(exact.availableAtEpochMs, 0) || (exact.error !== undefined && (typeof exact.error !== "string" || exact.error.length > 256))) return rejection("invalid_input", "outbox_retry_invalid");
    const clock = now(); if (!clock.ok) return clock;
    if (exact.availableAtEpochMs < clock.value) return rejection("invalid_input", "retry_time_before_now");
    return withWrite(internal, (connection) => {
      const row = connection.prepare("SELECT status, owner, generation, lease_until_ms FROM workflow_outbox WHERE outbox_id = $outboxId").get({ $outboxId: exact.outboxId }) as Record<string, unknown> | undefined;
      if (!row || row.status !== "leased" || row.owner !== exact.owner || row.generation !== exact.generation || (numberValue(row.lease_until_ms) ?? 0) <= clock.value) return rejection("outbox_fenced", "lease_token_mismatch");
      connection.prepare("UPDATE workflow_outbox SET status = 'pending', owner = NULL, lease_until_ms = NULL, available_at_ms = $availableAt, last_error = $error WHERE outbox_id = $outboxId AND status = 'leased' AND owner = $owner AND generation = $generation").run({ $availableAt: exact.availableAtEpochMs, $error: exact.error ?? null, $outboxId: exact.outboxId, $owner: exact.owner, $generation: exact.generation });
      return success(true as const);
    });
  };

  const inspect = (): JournalInspection => buildInspection(internal);
  const journal: CommandJournal = Object.freeze({ status: inspect(), commit, readEvents, readOutbox, claimOutbox, ackOutbox, retryOutbox, inspect, close });
  return success(journal);
}

export type {
  CommandCommitInput,
  CommandCommitValue,
  CommandJournal,
  JournalEvent,
  JournalInspection,
  JournalOptions,
  JournalRejection,
  JournalResult,
  OutboxAckInput,
  OutboxClaim,
  OutboxLeaseInput,
  OutboxRecord,
  OutboxRetryInput,
  PendingEvent,
  ProjectionWrite,
} from "./types.js";
