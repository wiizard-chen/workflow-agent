export const WORKER_LEASE_RESOURCE_KINDS = Object.freeze([
  "epic",
  "delivery-unit",
  "integration",
  "release",
  "product-session",
  "repository",
] as const);

export type LeaseResourceKind = (typeof WORKER_LEASE_RESOURCE_KINDS)[number];

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
  readonly status: "active" | "revoked";
}>;

export type LeaseOperationRejection = Readonly<{
  readonly code: string;
  readonly diagnostic: string;
}>;

export type LeaseOperationResult<T> =
  | Readonly<{ readonly ok: true; readonly value: T }>
  | Readonly<{ readonly ok: false; readonly rejection: LeaseOperationRejection }>;

export type WorkerHeartbeat = Readonly<{
  readonly status: "idle" | "running" | "stopped" | "failed";
  readonly failure: LeaseOperationRejection | undefined;
  readonly beat: () => LeaseOperationResult<LeaseRecord>;
  readonly start: () => LeaseOperationResult<true>;
  readonly stop: () => void;
}>;

export type LeaseAuthority = Readonly<{
  readonly acquire: (request: unknown) => LeaseOperationResult<LeaseRecord>;
  readonly guard: (credentials: unknown) => LeaseOperationResult<Readonly<{ readonly record: LeaseRecord; readonly checkedAtEpochMs: number }>>;
  readonly createHeartbeat: (credentials: unknown) => LeaseOperationResult<WorkerHeartbeat>;
  readonly revoke?: (credentials: unknown) => LeaseOperationResult<LeaseRecord>;
}>;

export type WorkerCapability = "diagnostic-read";

export type WorkerResource = Readonly<{
  readonly id: string;
  readonly kind: "runtime";
  readonly capabilities: readonly [WorkerCapability, ...WorkerCapability[]];
}>;

export type WorkerState = "idle" | "starting" | "running" | "aborting" | "exited";

export type WorkerFailureCode =
  | "invalid_input"
  | "invalid_state"
  | "resource_denied"
  | "prompt_rejected"
  | "lease_required"
  | "lease_lost"
  | "heartbeat_failed"
  | "persistence_failed"
  | "adapter_failed"
  | "worker_closed";

export type WorkerFailure = Readonly<{
  readonly code: WorkerFailureCode;
  readonly diagnostic: string;
  readonly cause?: string | undefined;
  readonly lease?: LeaseOperationRejection | undefined;
}>;

export type WorkerResult<T> =
  | Readonly<{ readonly ok: true; readonly value: T }>
  | Readonly<{ readonly ok: false; readonly rejection: WorkerFailure }>;

export type DiagnosticPrompt = Readonly<{
  readonly text: string;
}>;

export type DiagnosticResult = Readonly<{
  readonly text: string;
  readonly sessionId: string;
}>;

export type LeadSessionContext = Readonly<{
  readonly cwd: string;
  readonly runtimeRoot: string;
  readonly statePath: string;
  readonly sessionFile: string;
  readonly generation: number;
  readonly resume: boolean;
  readonly resources: readonly WorkerResource[];
  readonly loader: AllowlistedResourceLoader;
}>;

export type LeadSession = Readonly<{
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly prompt: (text: string) => Promise<string>;
  readonly abort: (reason: string) => Promise<void>;
  readonly dispose: () => Promise<void> | void;
}>;

export type LeadSessionFactory = (context: LeadSessionContext) => Promise<LeadSession>;

export type AllowlistedResourceLoader = Readonly<{
  readonly list: () => readonly WorkerResource[];
  readonly resolve: (resourceId: unknown) => WorkerResult<WorkerResource>;
}>;

export type WorkerStateRecord = Readonly<{
  readonly version: 1;
  readonly workerId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly resourceIds: readonly string[];
  readonly lease: LeaseCredentials;
  readonly state: WorkerState;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
  readonly handoffFromGeneration?: number;
  readonly handoffSnapshotHash?: string;
  readonly failure?: WorkerFailure;
}>;

export type WorkerSnapshot = Readonly<{
  readonly workerId: string;
  readonly generation: number | undefined;
  readonly sessionId: string | undefined;
  readonly state: WorkerState;
  readonly heartbeatStatus: "idle" | "running" | "stopped" | "failed" | "none";
  readonly failure: WorkerFailure | undefined;
  readonly lease: LeaseCredentials | undefined;
}>;

export type WorkerHostOptions = Readonly<{
  readonly workerId: string;
  readonly cwd: string;
  readonly runtimeRoot: string;
  readonly statePath?: string;
  readonly leaseStore: LeaseAuthority;
  readonly leaseRequest: LeaseRequest;
  readonly resources: readonly WorkerResource[];
  readonly createLeadSession: LeadSessionFactory;
  readonly now?: () => number;
  readonly heartbeatPollMs?: number;
}>;

export type WorkerHost = Readonly<{
  readonly start: () => Promise<WorkerResult<WorkerSnapshot>>;
  readonly resume: () => Promise<WorkerResult<WorkerSnapshot>>;
  readonly handoff: () => Promise<WorkerResult<WorkerSnapshot>>;
  readonly diagnose: (prompt: unknown) => Promise<WorkerResult<DiagnosticResult>>;
  readonly pulse: () => Promise<WorkerResult<WorkerSnapshot>>;
  readonly abort: (reason?: unknown) => Promise<WorkerResult<WorkerSnapshot>>;
  readonly snapshot: () => WorkerSnapshot;
  readonly close: () => Promise<void>;
}>;

export type WorkerProcessOptions = Readonly<{
  readonly host: WorkerHost;
  readonly abortSignal?: AbortSignal;
  readonly installSignalHandlers?: boolean;
}>;

export type WorkerProcessResult = Readonly<{
  readonly exitCode: 0 | 1 | 78;
  readonly snapshot: WorkerSnapshot;
}>;
