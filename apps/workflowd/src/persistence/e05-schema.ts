import type {
  RuntimeMigration,
  RuntimeSchemaExtension,
  RuntimeSchemaForeignKey,
  RuntimeSchemaIndex,
  RuntimeSchemaTable,
} from "./types.js";

const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);

function table(
  name: string,
  createSql: string,
  columns: readonly { name: string; type: string; notnull: 0 | 1; pk: number }[],
  indexes: readonly RuntimeSchemaIndex[],
  foreignKeys: readonly RuntimeSchemaForeignKey[] = [],
): RuntimeSchemaTable {
  return freeze({
    name,
    createSql,
    columns: freeze(columns.map((column) => freeze({ ...column }))),
    indexes: freeze(indexes.map((index) => freeze({ ...index, columns: freeze([...index.columns]) }))),
    foreignKeys: freeze(foreignKeys.map((key) => freeze({ ...key, from: freeze([...key.from]), to: freeze([...key.to]) }))),
  });
}

const aggregateHead = table(
  "workflow_aggregate_head",
  "CREATE TABLE workflow_aggregate_head (aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 0), updated_event_id TEXT REFERENCES workflow_event_log(event_id), PRIMARY KEY (aggregate_type, aggregate_id))",
  [
    { name: "aggregate_type", type: "TEXT", notnull: 1, pk: 1 },
    { name: "aggregate_id", type: "TEXT", notnull: 1, pk: 2 },
    { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "updated_event_id", type: "TEXT", notnull: 0, pk: 0 },
  ],
  [{ unique: true, columns: ["aggregate_type", "aggregate_id"], origin: "pk" }],
  [{ from: ["updated_event_id"], table: "workflow_event_log", to: ["event_id"] }],
);

const commandJournal = table(
  "workflow_command_journal",
  "CREATE TABLE workflow_command_journal (command_id TEXT NOT NULL PRIMARY KEY, command_hash TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT NOT NULL, result_hash TEXT NOT NULL, outcome TEXT NOT NULL CHECK (outcome IN ('committed', 'rejected')), aggregate_type TEXT, aggregate_id TEXT, revision INTEGER NOT NULL CHECK (revision >= 0), event_ids_json TEXT NOT NULL, outbox_ids_json TEXT NOT NULL, principal_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL)",
  [
    { name: "command_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "command_hash", type: "TEXT", notnull: 1, pk: 0 },
    { name: "input_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "result_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "result_hash", type: "TEXT", notnull: 1, pk: 0 },
    { name: "outcome", type: "TEXT", notnull: 1, pk: 0 },
    { name: "aggregate_type", type: "TEXT", notnull: 0, pk: 0 },
    { name: "aggregate_id", type: "TEXT", notnull: 0, pk: 0 },
    { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "event_ids_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "outbox_ids_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "principal_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "created_at_ms", type: "INTEGER", notnull: 1, pk: 0 },
  ],
  [{ unique: true, columns: ["command_id"], origin: "pk" }],
);

const eventLog = table(
  "workflow_event_log",
  "CREATE TABLE workflow_event_log (event_id TEXT NOT NULL UNIQUE, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, aggregate_sequence INTEGER NOT NULL CHECK (aggregate_sequence > 0), global_cursor INTEGER NOT NULL UNIQUE, schema_id TEXT NOT NULL, schema_version INTEGER NOT NULL, payload_json TEXT NOT NULL, principal_json TEXT NOT NULL, correlation_id TEXT NOT NULL, causation_id TEXT NOT NULL REFERENCES workflow_command_journal(command_id), occurred_at TEXT NOT NULL, PRIMARY KEY (aggregate_type, aggregate_id, aggregate_sequence))",
  [
    { name: "event_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "aggregate_type", type: "TEXT", notnull: 1, pk: 1 },
    { name: "aggregate_id", type: "TEXT", notnull: 1, pk: 2 },
    { name: "aggregate_sequence", type: "INTEGER", notnull: 1, pk: 3 },
    { name: "global_cursor", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "schema_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "schema_version", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "payload_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "principal_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "correlation_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "causation_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "occurred_at", type: "TEXT", notnull: 1, pk: 0 },
  ],
  [
    { unique: true, columns: ["event_id"], origin: "u" },
    { unique: true, columns: ["aggregate_type", "aggregate_id", "aggregate_sequence"], origin: "pk" },
    { unique: true, columns: ["global_cursor"], origin: "u" },
  ],
  [{ from: ["causation_id"], table: "workflow_command_journal", to: ["command_id"] }],
);

const outbox = table(
  "workflow_outbox",
  "CREATE TABLE workflow_outbox (outbox_id TEXT NOT NULL PRIMARY KEY, event_id TEXT NOT NULL REFERENCES workflow_event_log(event_id), intent_kind TEXT NOT NULL, operation_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'acked')), available_at_ms INTEGER NOT NULL, attempt INTEGER NOT NULL CHECK (attempt >= 0), owner TEXT, generation INTEGER, lease_until_ms INTEGER, ack_hash TEXT, ack_json TEXT, last_error TEXT)",
  [
    { name: "outbox_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "event_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "intent_kind", type: "TEXT", notnull: 1, pk: 0 },
    { name: "operation_key", type: "TEXT", notnull: 1, pk: 0 },
    { name: "payload_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "payload_hash", type: "TEXT", notnull: 1, pk: 0 },
    { name: "status", type: "TEXT", notnull: 1, pk: 0 },
    { name: "available_at_ms", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "attempt", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "owner", type: "TEXT", notnull: 0, pk: 0 },
    { name: "generation", type: "INTEGER", notnull: 0, pk: 0 },
    { name: "lease_until_ms", type: "INTEGER", notnull: 0, pk: 0 },
    { name: "ack_hash", type: "TEXT", notnull: 0, pk: 0 },
    { name: "ack_json", type: "TEXT", notnull: 0, pk: 0 },
    { name: "last_error", type: "TEXT", notnull: 0, pk: 0 },
  ],
  [
    { unique: true, columns: ["outbox_id"], origin: "pk" },
    { unique: true, columns: ["operation_key"], origin: "u" },
  ],
  [{ from: ["event_id"], table: "workflow_event_log", to: ["event_id"] }],
);

const projection = table(
  "workflow_projection_state",
  "CREATE TABLE workflow_projection_state (projection_name TEXT NOT NULL, projection_key TEXT NOT NULL, source_event_id TEXT NOT NULL REFERENCES workflow_event_log(event_id), source_aggregate_revision INTEGER NOT NULL CHECK (source_aggregate_revision > 0), value_json TEXT NOT NULL, value_hash TEXT NOT NULL, PRIMARY KEY (projection_name, projection_key))",
  [
    { name: "projection_name", type: "TEXT", notnull: 1, pk: 1 },
    { name: "projection_key", type: "TEXT", notnull: 1, pk: 2 },
    { name: "source_event_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "source_aggregate_revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "value_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "value_hash", type: "TEXT", notnull: 1, pk: 0 },
  ],
  [{ unique: true, columns: ["projection_name", "projection_key"], origin: "pk" }],
  [{ from: ["source_event_id"], table: "workflow_event_log", to: ["event_id"] }],
);

const migration: RuntimeMigration = freeze({
  version: 2,
  id: "e05.command-journal.2",
  statements: freeze([aggregateHead.createSql, commandJournal.createSql, eventLog.createSql, projection.createSql, outbox.createSql]),
});

/** Static extension consumed only by the workflowd E05 facade. */
export const E05_RUNTIME_EXTENSION: RuntimeSchemaExtension = freeze({
  id: "e05-command-journal-v1",
  migration,
  tables: freeze([aggregateHead, commandJournal, eventLog, projection, outbox]),
});

export const E05_RUNTIME_MIGRATION: RuntimeMigration = migration;
