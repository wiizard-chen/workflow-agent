export const LEASE_RESOURCE_KINDS = Object.freeze([
  "epic",
  "delivery-unit",
  "integration",
  "release",
  "product-session",
  "repository",
] as const);

export type LeaseResourceKind = (typeof LEASE_RESOURCE_KINDS)[number];
export type LeaseStatus = "active" | "revoked";

export type LeaseRejectionCode =
  | "invalid_input"
  | "read_only"
  | "store_closed"
  | "lease_held"
  | "lease_not_found"
  | "lease_expired"
  | "lease_revoked"
  | "lease_fenced"
  | "transaction_failed"
  | "schema_corrupt"
  | "migration_failed"
  | "clock_invalid";

export type LeaseRejection = Readonly<{
  readonly code: LeaseRejectionCode;
  readonly diagnostic: string;
}>;

export type LeaseResult<T> =
  | Readonly<{ readonly ok: true; readonly value: T }>
  | Readonly<{ readonly ok: false; readonly rejection: LeaseRejection }>;

export type LeaseOptions = Readonly<{
  readonly runtimeRoot: string;
  readonly databasePath: string;
  readonly backupDirectory?: string;
  readonly mode?: "read-only" | "read-write";
  readonly now: () => number;
  readonly heartbeatIntervalMs?: number;
  readonly leaseTtlMs?: number;
}>;

export type LeaseRequest = Readonly<{
  readonly resourceKind: LeaseResourceKind;
  readonly resourceId: string;
  readonly ownerId: string;
}>;

export type LeaseCredentials = Readonly<LeaseRequest & {
  readonly leaseId: string;
  readonly fencingToken: number;
}>;

export type LeaseRecord = Readonly<LeaseCredentials & {
  readonly issuedAtEpochMs: number;
  readonly heartbeatAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly status: LeaseStatus;
  readonly revokedAtEpochMs?: number;
}>;

export type LeaseProof = Readonly<{
  readonly record: LeaseRecord;
  readonly checkedAtEpochMs: number;
}>;

export type HeartbeatStatus = "idle" | "running" | "stopped" | "failed";

export type HeartbeatController = Readonly<{
  readonly beat: () => LeaseResult<LeaseRecord>;
  readonly start: () => LeaseResult<true>;
  readonly stop: () => void;
  readonly status: HeartbeatStatus;
  readonly failure: LeaseRejection | undefined;
}>;

export type LeaseInspection = Readonly<{
  readonly status: "read-only" | "read-write";
  readonly schemaVersion: number;
  readonly leaseCount: number;
  readonly activeCount: number;
  readonly highestFencingToken: number;
  readonly heartbeatIntervalMs: number;
  readonly leaseTtlMs: number;
}>;

export type LeaseStore = Readonly<{
  readonly acquire: (request: unknown) => LeaseResult<LeaseRecord>;
  readonly renew: (credentials: unknown) => LeaseResult<LeaseRecord>;
  readonly heartbeat: (credentials: unknown) => LeaseResult<LeaseRecord>;
  readonly revoke: (credentials: unknown) => LeaseResult<LeaseRecord>;
      /** Diagnostic proof using the store-owned clock; callers cannot supply time. */
      readonly guard: (credentials: unknown) => LeaseResult<LeaseProof>;
  readonly createHeartbeat: (credentials: unknown) => LeaseResult<HeartbeatController>;
  readonly inspect: () => LeaseResult<LeaseInspection>;
  readonly close: () => void;
}>;

export type LeaseOpenResult = LeaseResult<LeaseStore>;
