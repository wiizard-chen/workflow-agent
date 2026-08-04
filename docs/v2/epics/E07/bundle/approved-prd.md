# V2 E07 — Content-addressed Artifact Store

| Field | Value |
|---|---|
| Initiative | workflow-agent-c2b |
| Epic | workflow-agent-c2b.12 |
| Map ID | E07 |
| Document version | draft-v1 |
| Product status | DRAFT RECOMMENDED MVP |
| Approval status | PENDING EXACT MANIFEST CONFIRMATION |
| Engineering eligibility | INELIGIBLE UNTIL BUNDLE READBACK |
| Primary repository | workflow-agent |
| Primary workspace | @pi-workflow/workflowd |
| Primary implementation area | apps/workflowd/src/artifacts |
| Delivery Units | 1 |
| Maximum implementation tasks | 5 |
| Verification Profile | strict |

> This bounded local store does not authorize uploads, deletion, redaction
> processing, secret scanning, business approval, or publication to Docs.
> Evidence is valid only against the exact generated Bundle and Beads readback.

## 1. Authority and dependency boundary

E07 is subordinate to the Initiative Charter, Architecture RFC, Initial Epic
Map, and the E04 Runtime database contract. The Map defines E07's dependency
as E04. E04 owns secure SQLite initialization, WAL policy, migration locking,
schema inspection, and backup/recovery. E07 owns only immutable content objects
and their registration/integrity metadata.

Artifact bytes are the content-addressed source of truth. The E07 SQLite
registry is a typed index containing identity, path, size, media type, authority,
retention classification, creation time, and optional redaction metadata. A
registry row never grants Domain authority or approval. E56 later owns actual
redaction, access, retention, and deletion enforcement.

E07 uses a dedicated metadata database below the explicit artifact root. It must
not extend the E05 journal database, mutate Beads, write V1 .workflow output,
or infer a caller's authority from artifact metadata.

## 2. Problem and bounded result

Workers need durable evidence without treating logs, transcripts, PRD bundles, or
verification output as mutable application state. E07 delivers a local store
that can:

1. write bytes to a temporary owner-only file, hash them with SHA-256, fsync,
   and atomically rename them into a derived object path;
2. register the immutable object exactly once with typed metadata;
3. return the same record for identical digest and metadata, while rejecting
   metadata collisions instead of overwriting bytes;
4. read and verify bytes while detecting truncation, replacement, symlink,
   hardlink, permission, and digest drift; and
5. scan registry and object tree for missing, corrupt, or unregistered objects
   without silently repairing or deleting anything.

This is a local recoverable artifact substrate, not a redaction engine,
retention scheduler, access-control service, remote object store, renderer, or
business evidence-acceptance workflow.

## 3. Recommended implementation decisions

### 3.1 Root and path policy

artifactRoot is an absolute, explicit directory dedicated to V2 artifacts. The
store creates only:

    <artifactRoot>/objects/<first-two-hex>/<sha256>
    <artifactRoot>/tmp/<random-staging-name>
    <artifactRoot>/artifact-meta.db
    <artifactRoot>/backups/ (owned by E04 when needed)

The root and object/prefix directories are owner-only (0700); object and staging
files are owner-only (0600). Existing components are checked with lstat and
no-follow identity rules. Symlinks, hardlinks, non-regular files, foreign
owners, broad permissions, path escapes, and replacements fail closed. Object
paths are derived only from a validated digest.

Importing the package is side-effect free. Opening is the first operation
allowed to create root, metadata database, SQLite sidecars, object directories,
or staging. Read-only mode creates nothing and may report existing problems.

### 3.2 Identity, atomicity, and immutability

The identity is sha256:<64 lowercase hexadecimal digits>. The canonical relative
path is objects/<digest[0:2]>/<digest>. put accepts a Uint8Array/Buffer snapshot
of at most 64 MiB and a closed metadata record; it copies caller bytes before
hashing and never invokes accessors or arbitrary iterators.

The writer creates a random staging file with O_CREAT|O_EXCL|O_NOFOLLOW, writes
all bytes, fsyncs the file, verifies the digest, and renames it into the derived
final path. It fsyncs the containing directory where supported. An existing
final object is never replaced: its identity and content are verified and it is
reused. Registry insertion happens only after the object is durable; a failed
insertion removes only the staging or newly-created object owned by that call.

### 3.3 Registration metadata and redaction boundary

The strict MVP metadata fields are:

    mediaType       non-empty MIME-like string, <= 256 bytes
    authority       non-empty stable producer reference, <= 256 bytes
    retentionClass  ephemeral | standard | governance | sensitive
    redaction       optional { status: not-required | pending | redacted,
                                policyId?: non-empty stable reference }

No credential, token, or artifact bytes are copied into diagnostics. Redaction
metadata describes policy state only; E07 never claims content is safe, does not
transform bytes, and does not publish an artifact. Metadata is canonicalized and
stored with a hash so registry tamper is detectable.

### 3.4 Registry and integrity scanner

The dedicated E07 extension contains one table keyed by artifact_id and uniquely
indexed by sha256 and relative_path. It stores canonical metadata JSON plus its
SHA-256, byte size, and creation epoch milliseconds. E04 migration lock and
schema validation remain authoritative; E07 never exposes native SQLite or SQL.

verify checks the registry row, derived path, owner-only regular file identity,
recorded size, and SHA-256. scan is read-only and returns sorted immutable lists
of missing, corrupt, and orphans. An orphan is a safe regular object file under
the canonical object tree with no registry row. Unsafe entries are reported as
integrity failures, not followed or deleted. The scanner never silently repairs.

## 4. Frozen public boundary

The workflowd entrypoint may expose only a typed artifact facade and data types.
It must not expose a native SQLite connection, file descriptor, staging path,
writable Buffer, arbitrary path, SQL, or a callback that performs I/O.

    type ArtifactStoreOptions = Readonly<{
      readonly artifactRoot: string;
      readonly mode?: "read-only" | "read-write";
      readonly now: () => number;
    }>;

    type ArtifactMetadata = Readonly<{
      readonly mediaType: string;
      readonly authority: string;
      readonly retentionClass: "ephemeral" | "standard" | "governance" | "sensitive";
      readonly redaction?: Readonly<{
        readonly status: "not-required" | "pending" | "redacted";
        readonly policyId?: string;
      }>;
    }>;

    type ArtifactRecord = Readonly<ArtifactMetadata & {
      readonly artifactId: string;
      readonly sha256: string;
      readonly relativePath: string;
      readonly byteSize: number;
      readonly createdAtEpochMs: number;
    }>;

    type ArtifactScan = Readonly<{
      readonly status: "clean" | "issues";
      readonly registered: number;
      readonly missing: readonly string[];
      readonly corrupt: readonly string[];
      readonly orphans: readonly string[];
    }>;

    type ArtifactStore = Readonly<{
      readonly put: (bytes: Uint8Array, metadata: unknown) => ArtifactResult<ArtifactRecord>;
      readonly read: (artifactId: unknown) => ArtifactResult<Uint8Array>;
      readonly verify: (artifactId: unknown) => ArtifactResult<ArtifactRecord>;
      readonly manifest: () => ArtifactResult<readonly ArtifactRecord[]>;
      readonly scan: () => ArtifactResult<ArtifactScan>;
      readonly close: () => void;
    }>;

Every successful record/report is an independent recursively frozen snapshot;
read returns a new byte copy owned by the caller. ArtifactResult carries stable
typed rejection codes and secret-free diagnostics.

## 5. Acceptance criteria

- AC-001 Import/root safety: import has no filesystem effect; open creates only
  the explicit root and E04-owned metadata paths; V1 .workflow and outside paths
  remain untouched.
- AC-002 Atomic immutable write: a staged 0600 object is fsynced, verified, and
  atomically renamed; a final digest path is never overwritten; failed
  registration leaves no accepted partial row.
- AC-003 Idempotency/collision: same digest and metadata returns the original
  record; same digest with different metadata returns a typed collision; no
  duplicate row or byte replacement is possible.
- AC-004 Metadata boundary: media type, authority, retention class, and
  redaction status are validated, canonicalized, persisted, and returned;
  unknown fields, accessors, proxies, symbols, credentials, and invalid classes
  fail before mutation.
- AC-005 Integrity: verify/read detect missing files, truncation, replacement,
  wrong size, digest drift, symlink, hardlink, foreign owner, and broad mode;
  returned bytes are independent copies.
- AC-006 Scanner: manifest and scan are deterministic and sorted; missing,
  corrupt, and orphan paths are reported without mutation, deletion, or unsafe
  traversal.
- AC-007 Read-only/recovery: read-only opens create no directories, databases,
  backups, or objects; existing metadata remains inspectable and corruption is
  surfaced; E04 migration/backup invariants remain intact.
- AC-008 Boundary/gates: no native handle, SQL, staging path, network,
  retention deletion, redaction processing, or V1 output escapes the package;
  all V1/V2 quality gates remain green.

## 6. Attack and fault matrix

| ID | Fault/attack | Expected invariant |
|---|---|---|
| AM-01 | root/object/prefix symlink or path escape | no outside path is opened, followed, or removed |
| AM-02 | hardlink, foreign owner, broad mode, non-regular object | typed integrity rejection; no mutation |
| AM-03 | crash before rename or registry commit | no partial registry row; staging is isolated |
| AM-04 | same digest with altered metadata | collision; original bytes/metadata unchanged |
| AM-05 | truncation, bit flip, or replacement | verify/read/scan reports corruption |
| AM-06 | unregistered canonical object file | scan reports orphan and does not delete |
| AM-07 | malformed metadata/accessor/proxy/symbol/credential | fail closed before filesystem/SQL mutation |
| AM-08 | registry JSON/hash/size/path tamper | manifest/verify/scan reports corruption |
| AM-09 | read-only open or missing driver | no creation or mutation; typed diagnostics |

## 7. Non-goals and stop boundary

E07 does not implement secret scanning or redaction transforms (E56), retention
deletion/export policy (E56), access issuance (E41), Docs/Dashboard publication,
remote storage, workers, leases, scheduler policy, business evidence acceptance,
Beads/GitHub effects, or V1 .workflow migration. The store can be removed without
changing E05 facts or V1 behavior.

## 8. Implementation tasks

1. T1 — static schema and typed facade: define E07 registry extension, result/
   metadata/record types, exact validation, and side-effect-free exports.
2. T2 — safe content writer: implement root/object path policy, staging,
   fsync/rename, immutable digest reuse, and hostile path tests.
3. T3 — registration/integrity: add SQLite registration transaction, metadata
   hash, put/read/verify/manifest operations, collision and tamper tests.
4. T4 — scanner/failure matrix: implement deterministic orphan/missing/corrupt
   scan, read-only behavior, crash/permission/symlink/hardlink tests.
5. T5 — integration evidence: wire public exports, generate/read Bundle, run
  all quality gates, and write Beads evidence.

## 9. Verification profile

    npm --workspace=@pi-workflow/workflowd run test
    npm test
    npm run typecheck
    npm run validate:v2-boundaries
    node docs/v2/epics/E07/generate-bundle.mjs --check
    git diff --check

Status remains PENDING EXACT MANIFEST CONFIRMATION until the generated Bundle
hash is read back into Beads. Approval authorizes no external effects; tests
use temporary explicit artifact roots.
