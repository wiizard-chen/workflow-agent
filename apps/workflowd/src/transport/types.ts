import type {
  CommandCommitValue,
  JournalEvent,
  JournalInspection,
} from "../journal/index.js";
import type { ServerPrincipalContext } from "@pi-workflow/v2-protocol";

export const WORKFLOW_PROTOCOL_VERSION = 1 as const;
export const MAX_TRANSPORT_FRAME_BYTES = 1024 * 1024;
export const MAX_TRANSPORT_BATCH = 128;

export type TransportRejectionCode =
  | "invalid_options"
  | "socket_path_invalid"
  | "socket_conflict"
  | "socket_permission_denied"
  | "socket_unavailable"
  | "frame_invalid"
  | "frame_too_large"
  | "protocol_error"
  | "protocol_incompatible"
  | "not_connected"
  | "read_only_diagnostics"
  | "unknown_method"
  | "unauthorized"
  | "invalid_request"
  | "journal_rejection"
  | "daemon_closed"
  | "transport_failed";

export type TransportRejection = Readonly<{
  readonly code: TransportRejectionCode;
  readonly diagnostic: string;
}>;
export type WorkflowResult<T> =
  | Readonly<{ readonly ok: true; readonly value: T }>
  | Readonly<{ readonly ok: false; readonly rejection: TransportRejection }>;

export type ConnectionMaterial = Readonly<{
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly daemonEpoch: string;
}>;

export type HandshakeResult = Readonly<ConnectionMaterial & {
  readonly protocolVersion: typeof WORKFLOW_PROTOCOL_VERSION;
  readonly compatible: boolean;
  readonly diagnosticsOnly: boolean;
  readonly capabilities: readonly string[];
}>;

export type DaemonStatus = Readonly<{
  readonly running: boolean;
  readonly socketPath: string;
  readonly daemonEpoch: string;
  readonly connectionCount: number;
  readonly journal: JournalInspection | null;
}>;

export type HealthResult = Readonly<{
  readonly protocolVersion: typeof WORKFLOW_PROTOCOL_VERSION;
  readonly daemonEpoch: string;
  readonly connectionCount: number;
  readonly journal: JournalInspection;
}>;

export type WorkflowDaemonOptions = Readonly<{
  readonly runtimeRoot: string;
  readonly databasePath: string;
  readonly socketPath?: string;
  readonly now: () => number;
  readonly resolvePrincipal?: (connection: ConnectionMaterial, intent: unknown) => ServerPrincipalContext | undefined;
}>;

export type WorkflowDaemon = Readonly<{
  readonly start: () => Promise<WorkflowResult<DaemonStatus>>;
  readonly status: () => DaemonStatus;
  readonly close: () => Promise<void>;
}>;

export type WorkflowClientOptions = Readonly<{
  readonly socketPath: string;
  readonly clientName: string;
  readonly supportedProtocolVersions?: readonly number[];
}>;

export type WorkflowClient = Readonly<{
  readonly connect: () => Promise<WorkflowResult<HandshakeResult>>;
  readonly health: () => Promise<WorkflowResult<HealthResult>>;
  readonly replayEvents: (options?: unknown) => Promise<WorkflowResult<readonly JournalEvent[]>>;
  readonly commitCommand: (input: unknown) => Promise<WorkflowResult<CommandCommitValue>>;
  readonly subscribeEvents: (options: unknown, onEvent: (event: JournalEvent) => void) => Promise<WorkflowResult<true>>;
  readonly close: () => Promise<void>;
}>;
