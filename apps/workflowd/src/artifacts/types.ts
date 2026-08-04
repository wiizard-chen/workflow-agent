export type ArtifactRetentionClass = "ephemeral" | "standard" | "governance" | "sensitive";
export type ArtifactRedactionStatus = "not-required" | "pending" | "redacted";

export type ArtifactRedactionMetadata = Readonly<{
  readonly status: ArtifactRedactionStatus;
  readonly policyId?: string;
}>;

export type ArtifactMetadata = Readonly<{
  readonly mediaType: string;
  readonly authority: string;
  readonly retentionClass: ArtifactRetentionClass;
  readonly redaction?: ArtifactRedactionMetadata;
}>;

export type ArtifactRecord = Readonly<ArtifactMetadata & {
  readonly artifactId: string;
  readonly sha256: string;
  readonly relativePath: string;
  readonly byteSize: number;
  readonly createdAtEpochMs: number;
}>;

export type ArtifactScan = Readonly<{
  readonly status: "clean" | "issues";
  readonly registered: number;
  readonly missing: readonly string[];
  readonly corrupt: readonly string[];
  readonly orphans: readonly string[];
}>;

export type ArtifactRejectionCode =
  | "invalid_options"
  | "invalid_input"
  | "path_invalid"
  | "permission_denied"
  | "driver_unavailable"
  | "read_only"
  | "not_found"
  | "collision"
  | "corrupt"
  | "registry_corrupt"
  | "transaction_failed"
  | "store_closed";

export type ArtifactRejection = Readonly<{
  readonly code: ArtifactRejectionCode;
  readonly diagnostic: string;
}>;

export type ArtifactResult<T> =
  | Readonly<{ readonly ok: true; readonly value: T }>
  | Readonly<{ readonly ok: false; readonly rejection: ArtifactRejection }>;

export type ArtifactStoreOptions = Readonly<{
  readonly artifactRoot: string;
  readonly mode?: "read-only" | "read-write";
  readonly now: () => number;
}>;

export type ArtifactStore = Readonly<{
  readonly put: (bytes: Uint8Array, metadata: unknown) => ArtifactResult<ArtifactRecord>;
  readonly read: (artifactId: unknown) => ArtifactResult<Uint8Array>;
  readonly verify: (artifactId: unknown) => ArtifactResult<ArtifactRecord>;
  readonly manifest: () => ArtifactResult<readonly ArtifactRecord[]>;
  readonly scan: () => ArtifactResult<ArtifactScan>;
  readonly close: () => void;
}>;

export type ArtifactOpenResult = ArtifactResult<ArtifactStore>;
