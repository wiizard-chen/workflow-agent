import type {
  RuntimeMigration,
  RuntimeSchemaExtension,
  RuntimeSchemaIndex,
  RuntimeSchemaTable,
} from "../persistence/types.js";

const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);

const leaseTable: RuntimeSchemaTable = freeze({
  name: "workflow_runtime_lease",
  createSql: "CREATE TABLE workflow_runtime_lease (resource_kind TEXT NOT NULL CHECK (resource_kind IN ('epic', 'delivery-unit', 'integration', 'release', 'product-session', 'repository')), resource_id TEXT NOT NULL, lease_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, fencing_token INTEGER NOT NULL CHECK (fencing_token > 0), status TEXT NOT NULL CHECK (status IN ('active', 'revoked')), issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms >= 0), heartbeat_at_ms INTEGER NOT NULL CHECK (heartbeat_at_ms >= 0), expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > heartbeat_at_ms), revoked_at_ms INTEGER, CHECK ((status = 'active' AND revoked_at_ms IS NULL) OR (status = 'revoked' AND revoked_at_ms IS NOT NULL)), PRIMARY KEY (resource_kind, resource_id))",
  columns: freeze([
    freeze({ name: "resource_kind", type: "TEXT", notnull: 1, pk: 1 }),
    freeze({ name: "resource_id", type: "TEXT", notnull: 1, pk: 2 }),
    freeze({ name: "lease_id", type: "TEXT", notnull: 1, pk: 0 }),
    freeze({ name: "owner_id", type: "TEXT", notnull: 1, pk: 0 }),
    freeze({ name: "fencing_token", type: "INTEGER", notnull: 1, pk: 0 }),
    freeze({ name: "status", type: "TEXT", notnull: 1, pk: 0 }),
    freeze({ name: "issued_at_ms", type: "INTEGER", notnull: 1, pk: 0 }),
    freeze({ name: "heartbeat_at_ms", type: "INTEGER", notnull: 1, pk: 0 }),
    freeze({ name: "expires_at_ms", type: "INTEGER", notnull: 1, pk: 0 }),
    freeze({ name: "revoked_at_ms", type: "INTEGER", notnull: 0, pk: 0 }),
  ]),
  indexes: freeze([
    freeze({ unique: true, columns: freeze(["resource_kind", "resource_id"]), origin: "pk" as const }),
    freeze({ unique: true, columns: freeze(["lease_id"]), origin: "u" as const }),
  ]),
});

export const E08_RUNTIME_MIGRATION: RuntimeMigration = freeze({
  version: 3,
  id: "e08.lease-fencing.1",
  statements: freeze([leaseTable.createSql]),
});

export const E08_RUNTIME_EXTENSION: RuntimeSchemaExtension = freeze({
  id: "e08-lease-fencing-v1",
  migration: E08_RUNTIME_MIGRATION,
  tables: freeze([leaseTable]),
});
