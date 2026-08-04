import type { JsonValue, StepAttemptId } from "@pi-workflow/v2-domain";
import type { ArtifactStore } from "../artifacts/index.js";
import type { LeaseCredentials, LeaseStore } from "../leases/index.js";

export type StepState =
  | "planned"
  | "prepared"
  | "executing"
  | "effect-observed"
  | "validated"
  | "completed"
  | "failed"
  | "aborted"
  | "superseded"
  | "unknown";

/** Explicit recovery actions; `manual-recovery` is never an implicit retry. */
export type RecoveryAction = "adopt" | "retry" | "supersede" | "manual-recovery";

export type StepEffect = Readonly<{
  readonly effectKey: string;
  readonly outcome: "confirmed" | "rejected" | "unknown";
  readonly artifactId?: string;
  readonly artifactSha256?: string;
}>;

export type StepValidation = Readonly<{
  readonly artifactId: string;
  readonly artifactSha256: string;
  readonly validatedAtEpochMs: number;
}>;

export type StepAttemptRecord = Readonly<{
  readonly stepAttemptId: StepAttemptId;
  readonly stepId: string;
  /** One causal sequence number; retries allocate a new immutable row. */
  readonly sequence: number;
  readonly idempotencyKey: string;
  readonly inputJson: JsonValue;
  readonly inputSha256: string;
  readonly expectedHead?: string;
  readonly policySha256: string;
  readonly role: string;
  readonly model: string;
  readonly outputLocation: string;
  readonly workerGeneration: number;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly preparedAtEpochMs: number;
}>;

export type StepRecord = Readonly<{
  readonly stepId: string;
  readonly state: StepState;
  readonly revision: number;
  readonly stepAttemptId?: StepAttemptId;
  readonly effect?: JsonValue;
  readonly validation?: JsonValue;
  /** Current projection timestamp; attempt-bound fields live in the immutable attempt row. */
  readonly updatedAtEpochMs: number;
}>;

export type StepTransitionInput = Readonly<{
  readonly stepId: string;
  readonly expectedRevision: number;
  readonly operationKey: string;
  readonly toState: StepState;
  readonly effect?: StepEffect;
  readonly validation?: StepValidation;
}>;

export type StepPrepareInput = Readonly<{
  readonly stepId: string;
  readonly idempotencyKey: string;
  readonly inputJson: JsonValue;
  readonly expectedHead?: string;
  readonly policySha256: string;
  readonly role: string;
  readonly model: string;
  readonly outputLocation: string;
  readonly workerGeneration: number;
}>;

export type StepPlanInput = Readonly<{
  readonly stepId: string;
  readonly policyHash: string;
  readonly role: string;
  readonly model: string;
  readonly outputLocation: string;
  readonly workerGeneration: number;
}>;

export type StepRetryInput = StepPrepareInput & Readonly<{ readonly expectedRevision: number }>;

export type StepAdoptInput = Readonly<{
  readonly stepId: string;
  readonly expectedRevision: number;
  readonly operationKey: string;
  readonly effectKey: string;
  readonly artifactId: string;
  readonly artifactSha256: string;
}>;

export type RecoveryCase = Readonly<{
  readonly stepId: string;
  readonly stepAttemptId?: StepAttemptId;
  readonly state: StepState;
  readonly revision: number;
  readonly action: RecoveryAction;
  readonly reason: string;
  readonly evidenceRequired: boolean;
}>;

export type RecoveryReport = Readonly<{
  readonly scannedAtEpochMs: number;
  readonly status: "clean" | "needs-recovery";
  readonly cases: readonly RecoveryCase[];
  readonly reportSha256: string;
}>;

export type StepRejectionCode =
  | "invalid_input"
  | "read_only"
  | "store_closed"
  | "not_found"
  | "schema_corrupt"
  | "transaction_failed"
  | "idempotency_conflict"
  | "expected_revision_mismatch"
  | "invalid_transition"
  | "attempt_conflict"
  | "lease_required"
  | "lease_lost"
  | "lease_fenced"
  | "artifact_missing"
  | "artifact_corrupt"
  | "artifact_unavailable";

export type StepRejection = Readonly<{
  readonly code: StepRejectionCode;
  readonly diagnostic: string;
}>;

export type StepResult<T> =
  | Readonly<{ readonly ok: true; readonly value: T }>
  | Readonly<{ readonly ok: false; readonly rejection: StepRejection }>;

export type StepLedgerOptions = Readonly<{
  readonly runtimeRoot: string;
  readonly databasePath: string;
  readonly backupDirectory?: string;
  readonly mode?: "read-only" | "read-write";
  readonly now: () => number;
  readonly leaseStore: Pick<LeaseStore, "guard">;
  readonly artifactStore?: Pick<ArtifactStore, "verify">;
}>;

export type StepLedger = Readonly<{
  readonly plan: (input: unknown, lease: unknown) => StepResult<StepRecord>;
  readonly prepare: (input: unknown, lease: unknown) => StepResult<Readonly<{ readonly attempt: StepAttemptRecord; readonly step: StepRecord }>>;
  readonly transition: (input: unknown, lease: unknown) => StepResult<StepRecord>;
  readonly retry: (input: unknown, lease: unknown) => StepResult<Readonly<{ readonly attempt: StepAttemptRecord; readonly step: StepRecord }>>;
  readonly adopt: (input: unknown, lease: unknown) => StepResult<StepRecord>;
  readonly observeEffect: (input: unknown, lease: unknown) => StepResult<StepRecord>;
  readonly validate: (input: unknown, lease: unknown) => StepResult<StepRecord>;
  readonly complete: (input: unknown, lease: unknown) => StepResult<StepRecord>;
  readonly supersede: (input: unknown, lease: unknown) => StepResult<true>;
  readonly manualRecovery: (input: unknown, lease: unknown) => StepResult<true>;
  readonly recordRecoveryDecision: (input: unknown, lease: unknown) => StepResult<true>;
  readonly get: (stepId: unknown) => StepResult<StepRecord | undefined>;
  readonly scan: () => StepResult<RecoveryReport>;
  readonly inspect: () => StepSchemaStatus;
  readonly close: () => void;
}>;

export type StepOpenResult = StepResult<StepLedger>;

export type StepSchemaStatus = Readonly<{
  readonly schemaVersion: number;
  readonly mode: "read-only" | "read-write";
  readonly writable: boolean;
}>;
