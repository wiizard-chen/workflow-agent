import type {
  JsonValue,
} from "@pi-workflow/v2-domain";
import type {
  SchemaId,
  SchemaVersion,
  ServerPrincipalContext,
} from "@pi-workflow/v2-protocol";

export type JournalRejectionCode =
  | "invalid_input"
  | "read_only"
  | "idempotency_collision"
  | "expected_revision_mismatch"
  | "event_conflict"
  | "projection_conflict"
  | "outbox_conflict"
  | "outbox_fenced"
  | "schema_corrupt"
  | "migration_failed"
  | "transaction_failed";

export type JournalRejection = Readonly<{
  readonly code: JournalRejectionCode;
  readonly diagnostic: string;
}>;

export type JournalResult<T> =
  | Readonly<{ readonly ok: true; readonly value: T }>
  | Readonly<{ readonly ok: false; readonly rejection: JournalRejection }>;

export type JournalOptions = Readonly<{
  readonly runtimeRoot: string;
  readonly databasePath: string;
  readonly backupDirectory?: string;
  readonly mode?: "read-only" | "read-write";
  /** Open the composite E04 + E05 + E08 runtime manifest for shared use. */
  readonly includeLeaseSchema?: boolean;
  readonly now: () => number;
}>;

export type PendingEvent = Readonly<{
  readonly eventId: string;
  readonly schemaId: SchemaId;
  readonly schemaVersion: SchemaVersion;
  readonly payload: JsonValue;
}>;

export type ProjectionWrite = Readonly<{
  readonly projectionName: string;
  readonly projectionKey: string;
  readonly sourceEventId: string;
  readonly sourceAggregateRevision: number;
  readonly value: JsonValue;
}>;

export type OutboxIntent = Readonly<{
  readonly eventId: string;
  readonly intentKind: string;
  readonly payload: JsonValue;
  readonly availableAtEpochMs?: number;
}>;

export type CommandCommitInput = Readonly<{
  readonly accepted: unknown;
  readonly result: JsonValue;
  readonly events: readonly PendingEvent[];
  readonly projections?: readonly ProjectionWrite[];
  readonly outbox: readonly OutboxIntent[];
}>;

export type CommandCommitValue = Readonly<{
  readonly commandId: string;
  readonly replayed: boolean;
  readonly result: JsonValue;
  readonly revision: number;
  readonly eventIds: readonly string[];
  readonly outboxIds: readonly string[];
}>;

export type JournalEvent = Readonly<{
  readonly eventId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly globalCursor: number;
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly payload: JsonValue;
  readonly principal: ServerPrincipalContext;
  readonly correlationId: string;
  readonly causationId: string;
  readonly occurredAt: string;
}>;

export type EventReadOptions = Readonly<{
  readonly afterGlobalCursor?: number;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly limit?: number;
}>;

export type OutboxStatus = "pending" | "leased" | "acked";

export type OutboxRecord = Readonly<{
  readonly outboxId: string;
  readonly eventId: string;
  readonly intentKind: string;
  readonly operationKey: string;
  readonly payload: JsonValue;
  readonly payloadHash: string;
  readonly status: OutboxStatus;
  readonly availableAtEpochMs: number;
  readonly attempt: number;
  readonly owner?: string;
  readonly generation?: number;
  readonly leaseUntilEpochMs?: number;
  readonly ackHash?: string;
  readonly ack?: JsonValue;
  readonly lastError?: string;
}>;

export type OutboxReadOptions = Readonly<{
  readonly status?: OutboxStatus;
  readonly limit?: number;
  readonly nowEpochMs?: number;
}>;

export type OutboxClaim = Readonly<{
  readonly outboxId: string;
  readonly owner: string;
  readonly generation: number;
}>;

export type OutboxLeaseInput = Readonly<{
  readonly outboxId: string;
  readonly owner: string;
  readonly generation: number;
}>;

export type OutboxAckInput = OutboxLeaseInput & Readonly<{ readonly acknowledgement: JsonValue }>;
export type OutboxRetryInput = OutboxLeaseInput & Readonly<{ readonly availableAtEpochMs: number; readonly error?: string }>;

export type JournalInspection = Readonly<{
  readonly status: "read-only" | "read-write";
  readonly schemaVersion: number;
  readonly commandCount: number;
  readonly aggregateCount: number;
  readonly eventCount: number;
  readonly projectionCount: number;
  readonly outboxCount: number;
  readonly highestGlobalCursor: number;
}>;

export type CommandJournal = Readonly<{
  readonly status: JournalInspection;
  readonly commit: (input: unknown) => JournalResult<CommandCommitValue>;
  readonly readEvents: (options?: unknown) => JournalResult<readonly JournalEvent[]>;
  readonly readOutbox: (options?: unknown) => JournalResult<readonly OutboxRecord[]>;
  readonly claimOutbox: (owner: unknown, nowEpochMs: unknown, limit?: unknown) => JournalResult<readonly OutboxClaim[]>;
  readonly ackOutbox: (input: unknown) => JournalResult<true>;
  readonly retryOutbox: (input: unknown) => JournalResult<true>;
  readonly inspect: () => JournalInspection;
  readonly close: () => void;
}>;
