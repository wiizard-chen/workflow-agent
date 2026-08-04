import type {
  RuntimeMigration,
  RuntimeSchemaExtension,
  RuntimeSchemaForeignKey,
  RuntimeSchemaIndex,
  RuntimeSchemaTable,
} from "../persistence/types.js";

const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);

function table(
  name: string,
  createSql: string,
  columns: readonly { readonly name: string; readonly type: string; readonly notnull: 0 | 1; readonly pk: number }[],
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

const step = table(
  "workflow_step",
  "CREATE TABLE workflow_step (step_id TEXT NOT NULL PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('planned', 'prepared', 'executing', 'effect-observed', 'validated', 'completed', 'failed', 'aborted', 'superseded', 'unknown')), revision INTEGER NOT NULL CHECK (revision >= 0), step_attempt_id TEXT, input_json TEXT NOT NULL, input_sha256 TEXT NOT NULL, expected_head TEXT, expected_head_sha256 TEXT, policy_sha256 TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, output_location TEXT NOT NULL, worker_generation INTEGER NOT NULL CHECK (worker_generation >= 0), lease_id TEXT NOT NULL, fencing_token INTEGER NOT NULL CHECK (fencing_token > 0), effect_json TEXT, validation_json TEXT, created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0), updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms))",
  [
    { name: "step_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "state", type: "TEXT", notnull: 1, pk: 0 },
    { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "step_attempt_id", type: "TEXT", notnull: 0, pk: 0 },
    { name: "input_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "input_sha256", type: "TEXT", notnull: 1, pk: 0 },
    { name: "expected_head", type: "TEXT", notnull: 0, pk: 0 },
    { name: "expected_head_sha256", type: "TEXT", notnull: 0, pk: 0 },
    { name: "policy_sha256", type: "TEXT", notnull: 1, pk: 0 },
    { name: "role", type: "TEXT", notnull: 1, pk: 0 },
    { name: "model", type: "TEXT", notnull: 1, pk: 0 },
    { name: "output_location", type: "TEXT", notnull: 1, pk: 0 },
    { name: "worker_generation", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "lease_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "fencing_token", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "effect_json", type: "TEXT", notnull: 0, pk: 0 },
    { name: "validation_json", type: "TEXT", notnull: 0, pk: 0 },
    { name: "created_at_ms", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "updated_at_ms", type: "INTEGER", notnull: 1, pk: 0 },
  ],
  [freeze({ unique: true, columns: ["step_id"], origin: "pk" as const })],
);

const attempt = table(
  "workflow_step_attempt",
  "CREATE TABLE workflow_step_attempt (step_attempt_id TEXT NOT NULL PRIMARY KEY, step_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence > 0), idempotency_key TEXT NOT NULL UNIQUE, input_json TEXT NOT NULL, input_sha256 TEXT NOT NULL, expected_head TEXT, expected_head_sha256 TEXT, policy_sha256 TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, output_location TEXT NOT NULL, worker_generation INTEGER NOT NULL CHECK (worker_generation >= 0), lease_id TEXT NOT NULL, fencing_token INTEGER NOT NULL CHECK (fencing_token > 0), prepared_at_ms INTEGER NOT NULL CHECK (prepared_at_ms >= 0), FOREIGN KEY (step_id) REFERENCES workflow_step(step_id))",
  [
    { name: "step_attempt_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "step_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "sequence", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "idempotency_key", type: "TEXT", notnull: 1, pk: 0 },
    { name: "input_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "input_sha256", type: "TEXT", notnull: 1, pk: 0 },
    { name: "expected_head", type: "TEXT", notnull: 0, pk: 0 },
    { name: "expected_head_sha256", type: "TEXT", notnull: 0, pk: 0 },
    { name: "policy_sha256", type: "TEXT", notnull: 1, pk: 0 },
    { name: "role", type: "TEXT", notnull: 1, pk: 0 },
    { name: "model", type: "TEXT", notnull: 1, pk: 0 },
    { name: "output_location", type: "TEXT", notnull: 1, pk: 0 },
    { name: "worker_generation", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "lease_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "fencing_token", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "prepared_at_ms", type: "INTEGER", notnull: 1, pk: 0 },
  ],
  [
    freeze({ unique: true, columns: ["step_attempt_id"], origin: "pk" as const }),
    freeze({ unique: true, columns: ["idempotency_key"], origin: "u" as const }),
  ],
  [freeze({ from: ["step_id"], table: "workflow_step", to: ["step_id"] })],
);

const event = table(
  "workflow_step_event",
  "CREATE TABLE workflow_step_event (event_id TEXT NOT NULL PRIMARY KEY, step_id TEXT NOT NULL, step_attempt_id TEXT, operation_key TEXT NOT NULL UNIQUE, operation_hash TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL CHECK (to_state IN ('planned', 'prepared', 'executing', 'effect-observed', 'validated', 'completed', 'failed', 'aborted', 'superseded', 'unknown')), before_revision INTEGER NOT NULL CHECK (before_revision >= 0), after_revision INTEGER NOT NULL CHECK (after_revision >= before_revision), effect_json TEXT, validation_json TEXT, recovery_action TEXT CHECK (recovery_action IS NULL OR recovery_action IN ('adopt', 'retry', 'supersede', 'manual-recovery')), evidence_json TEXT, occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0), FOREIGN KEY (step_id) REFERENCES workflow_step(step_id), FOREIGN KEY (step_attempt_id) REFERENCES workflow_step_attempt(step_attempt_id))",
  [
    { name: "event_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "step_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "step_attempt_id", type: "TEXT", notnull: 0, pk: 0 },
    { name: "operation_key", type: "TEXT", notnull: 1, pk: 0 },
    { name: "operation_hash", type: "TEXT", notnull: 1, pk: 0 },
    { name: "from_state", type: "TEXT", notnull: 0, pk: 0 },
    { name: "to_state", type: "TEXT", notnull: 1, pk: 0 },
    { name: "before_revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "after_revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "effect_json", type: "TEXT", notnull: 0, pk: 0 },
    { name: "validation_json", type: "TEXT", notnull: 0, pk: 0 },
    { name: "recovery_action", type: "TEXT", notnull: 0, pk: 0 },
    { name: "evidence_json", type: "TEXT", notnull: 0, pk: 0 },
    { name: "occurred_at_ms", type: "INTEGER", notnull: 1, pk: 0 },
  ],
  [
    freeze({ unique: true, columns: ["event_id"], origin: "pk" as const }),
    freeze({ unique: true, columns: ["operation_key"], origin: "u" as const }),
  ],
  [
    freeze({ from: ["step_id"], table: "workflow_step", to: ["step_id"] }),
    freeze({ from: ["step_attempt_id"], table: "workflow_step_attempt", to: ["step_attempt_id"] }),
  ],
);

export const E10_RUNTIME_MIGRATION: RuntimeMigration = freeze({
  version: 4,
  id: "e10.step-ledger.1",
  statements: freeze([step.createSql, attempt.createSql, event.createSql]),
});

export const E10_RUNTIME_EXTENSION: RuntimeSchemaExtension = freeze({
  id: "e10-step-ledger-v1",
  migration: E10_RUNTIME_MIGRATION,
  tables: freeze([step, attempt, event]),
});
