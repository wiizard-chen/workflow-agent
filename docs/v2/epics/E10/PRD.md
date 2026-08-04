# V2 E10 — Step Ledger and generic recovery scanner

| Field | Value |
|---|---|
| Initiative | `workflow-agent-c2b` |
| Epic | `workflow-agent-c2b.14` |
| Map ID | `E10` |
| Document version | `draft-v1` |
| Product status | **DRAFT RECOMMENDED MVP** |
| Approval status | **PENDING EXACT MANIFEST CONFIRMATION** |
| Engineering eligibility | **INELIGIBLE UNTIL BUNDLE READBACK** |
| Primary workspace | `@pi-workflow/workflowd` |
| Primary implementation area | `apps/workflowd/src/steps` |
| Delivery Units | 1 |
| Maximum implementation tasks | 5 |
| Verification Profile | strict |
| Runtime schema migration | version `4` |

> E10 is a generic Runtime step ledger. It records the causal attempt and
> current projection for every side-effecting Step, then reports incomplete
> work for an explicit recovery decision. It does not infer that an external
> effect succeeded merely because a process stopped without an error. This
> candidate authorizes no implementation, migration, worker launch, or
> external effect until its exact Bundle manifest is confirmed and the Beads
> write/readback gate succeeds.

## 1. Authority and dependency boundary

E10 is subordinate to the Initiative Charter, Architecture RFC, and Initial
Epic Map. Its direct implementation dependencies are E02, E05, E07, and E08:

- E02 owns the opaque `StepAttemptId` identity seam and generic transition
  result/rejection contracts. E10 owns the Runtime `StepAttemptRecord`, Step
  state machine, current projection, and recovery decisions; it must not
  redefine E02 identity, revision, ordering, or parent invariants.
- E05 owns the command journal/event-log/outbox substrate. E10 consumes its
  transaction boundary and idempotency conventions. A local E10 event table
  is permitted as the Runtime extension seam when E05's family registry is
  not yet available; it must remain append-only and transactionally coupled.
- E07 owns content-addressed artifact metadata and integrity verification. E10
  injects a narrow read-only verifier or facade; it does not copy, repair,
  delete, or migrate E07's dedicated metadata database. E07 and E05 database
  migrations are independent, so E10 must not compose their schemas by
  pretending their migration version numbers are one database.
- E08 owns leases, fencing tokens, and heartbeat facts. Every E10 mutation
  carries the current lease ID and fencing token and validates them in the
  same SQLite transaction as the revision check.

`TaskAttempt`, `RoleRun`, and `LaunchPermit` are not interchangeable with a
`StepAttemptRecord`: E79 owns TaskAttempt, while E20 owns RoleRun and
LaunchPermit. E10 never creates or updates those records. E10 also has no
GitHub-, Git-, Beads-, Dev-, Reviewer-, scheduler-, worker-launch-, or
external-adapter-specific recovery policy.

## 2. Problem and bounded result

The Runtime needs one durable causal record for every side-effecting Step. A
daemon or worker can be interrupted between preparing input, starting work,
observing an effect, and validating evidence. A current row that only says
“running” cannot distinguish a safe retry from an already-published effect,
and an absent error cannot be treated as completion.

The E10 MVP delivers:

1. a typed Step state machine with `planned → prepared → executing →
   effect-observed → validated → completed` and explicit exceptional states;
2. immutable `StepAttemptRecord` rows that freeze canonical input/hash,
   expected HEAD, policy/role/model, output location, worker generation,
   lease/fencing proof, sequence, and preparation time;
3. a version-4 Runtime SQLite extension over the E04/E05/E08 store boundary,
   with current projection, append-only events, expected-revision checks, and
   idempotent operation keys;
4. lease/fencing-guarded transitions, effect observation, validation, and
   completion, with rollback on any stale or malformed credential;
5. a deterministic, read-only interrupted-Step scanner and recovery report;
   and
6. explicit, append-only `adopt`, `retry`, `supersede`, and
   `manual-recovery` decisions. A decision is evidence-bearing and never an
   implicit retry or completion.

## 3. Recommended implementation decisions

### 3.1 State and transition contract

The legal normal path is:

```text
planned → prepared → executing → effect-observed → validated → completed
```

The exceptional states are `failed`, `aborted`, `superseded`, and `unknown`.
`superseded` is terminal. `unknown` means that the effect boundary cannot be
established and requires reconciliation or an explicit manual decision. An
interrupted `executing` Step is never promoted to `completed` by process
absence, and an `effect-observed` Step is adoptable only after explicit
validation evidence. A failed or aborted retry creates a new immutable
`StepAttemptRecord`; the prior attempt and events remain unchanged.

Every mutation supplies `stepId`, `expectedRevision`, an idempotency key, and
current E08 lease credentials. The transaction checks the projection revision,
current lease and fencing token, legal transition, and operation hash before
writing the new projection and event. A duplicate key with the same canonical
operation hash returns the original result; a duplicate key with a different
hash is rejected as a collision.

### 3.2 Immutable prepared attempt

`prepare` allocates an opaque E02 `StepAttemptId` and appends one immutable
attempt row. The row is a frozen canonical JSON input plus SHA-256, optional
expected repository HEAD, policy snapshot hash, role, model, output location,
worker generation, lease ID, fencing token, sequence, and preparation time.
No public API exposes a mutable database handle, SQL, or arbitrary mutation
callback. Attempts cannot be updated or deleted; a new retry is a new row.

### 3.3 Storage and artifact seam

The Runtime extension uses migration version `4` and these logical tables:

| Table | Responsibility |
|---|---|
| `workflow_step` | current state, revision, current attempt pointer, effect/validation projections, update time |
| `workflow_step_attempt` | append-only immutable prepared attempts |
| `workflow_step_event` | append-only transitions and recovery decisions with before/after state, operation hash, revision, and evidence |

The implementation may map these tables onto E04/E05's native SQLite factory,
but must not expose or merge E07's separate artifact metadata database. The
artifact verifier is injected as a read-only capability and must bind the
artifact ID, size, media type, and content hash to validation evidence.

### 3.4 Recovery scanner and decisions

`scan()` reads only committed projections, attempts, events, lease state, and
injected artifact metadata. It sorts cases by canonical `stepId`, then
revision, then `stepAttemptId`, and returns a deterministic report hash. It
does not repair rows, touch artifacts/worktrees, acquire leases, or infer
external success. A case contains a reason and whether evidence is required.

The only decisions are:

| Action | Required condition |
|---|---|
| `adopt` | explicit external-effect evidence and successful E07 validation |
| `retry` | no adopted effect, prior attempt is failed/aborted, and a new immutable attempt is prepared |
| `supersede` | a newer causal attempt or explicit authority makes the old attempt obsolete |
| `manual-recovery` | effect or evidence remains unknown, conflicting, malformed, or unavailable |

Decision events are append-only and idempotent. Scanner output alone never
changes a Step state.

### 3.5 Public package boundary

`@pi-workflow/workflowd` exports typed immutable records and a narrow
`openStepLedger` facade (`prepare`, `transition`, `observeEffect`, `validate`,
`complete`, `read`, `scan`, explicit recovery decision methods, `inspect`, and
`close`). The boundary exports no SQL/native SQLite handle, filesystem path
writer, artifact writer/deleter, lease store, worker process handle, model,
Git/GitHub/Beads client, or arbitrary callback that can mutate storage.

## 4. Frozen public types

The exact TypeScript names may be adapted to the existing E02/E04/E05/E08
contracts, but their semantics are frozen:

```ts
type StepState =
  | "planned" | "prepared" | "executing" | "effect-observed"
  | "validated" | "completed" | "failed" | "aborted" | "superseded"
  | "unknown";

type RecoveryAction = "adopt" | "retry" | "supersede" | "manual-recovery";

type StepAttemptRecord = Readonly<{
  stepAttemptId: StepAttemptId;
  stepId: string;
  sequence: number;
  idempotencyKey: string;
  inputJson: JsonValue;
  inputSha256: string;
  expectedHead?: string;
  policySha256: string;
  role: string;
  model: string;
  outputLocation: string;
  workerGeneration: number;
  leaseId: string;
  fencingToken: number;
  preparedAtEpochMs: number;
}>;

type StepRecord = Readonly<{
  stepId: string;
  state: StepState;
  revision: number;
  stepAttemptId?: StepAttemptId;
  effect?: JsonValue;
  validation?: JsonValue;
  updatedAtEpochMs: number;
}>;

type RecoveryCase = Readonly<{
  stepId: string;
  stepAttemptId?: StepAttemptId;
  state: StepState;
  revision: number;
  action: RecoveryAction;
  reason: string;
  evidenceRequired: boolean;
}>;

type RecoveryReport = Readonly<{
  status: "clean" | "needs-recovery";
  scannedAtEpochMs: number;
  cases: readonly RecoveryCase[];
  reportSha256: string;
}>;
```

Inputs must be canonical, deeply immutable JSON values. Accessors, symbols,
cycles, unsafe proxies, non-finite numbers, NULs, path escapes, and unknown
fields are rejected before a transaction. Returned records are defensive
copies/frozen views and cannot mutate the ledger.

## 5. Acceptance criteria

- **AC-001 Contract/state matrix:** every legal transition succeeds and every
  illegal jump, terminal mutation, missing attempt, malformed evidence, or
  invalid state is rejected without a partial write.
- **AC-002 Prepared immutability:** a prepared row contains all frozen input,
  policy, identity, output, worker, and lease fields; update/delete attempts
  fail; retry creates a distinct sequence and `StepAttemptId`.
- **AC-003 Revision/idempotency:** stale expected revision rejects; same-key
  same-hash replay returns the original result; same-key different-hash
  collision rejects; concurrent writers have one winner.
- **AC-004 Lease/fencing:** stale, expired, revoked, mismatched, or malformed
  E08 credentials reject every sensitive mutation in the same transaction and
  leave projection, attempt, event, and outbox state unchanged.
- **AC-005 Effect evidence:** absence of an error never completes a Step;
  interrupted `executing` becomes `unknown`/recovery-required; an
  `effect-observed` Step adopts only with explicit, hash-bound validation.
- **AC-006 Artifact integrity:** truncation, hash drift, missing registration,
  path escape, schema drift, or unverifiable artifact prevents validation and
  completion; E10 never repairs or deletes the artifact.
- **AC-007 Scanner determinism:** `scan()` is read-only, has no filesystem or
  network side effect, orders cases canonically, and yields identical report
  bytes/hash for identical committed inputs and clock value.
- **AC-008 Recovery decisions:** adopt/retry/supersede/manual-recovery are
  explicit append-only idempotent events; `unknown` cannot be blindly retried
  or completed; superseded is terminal.
- **AC-009 Restart and migration:** close/reopen preserves attempts,
  revisions, events, operation outcomes, and scanner output; version-4
  migration is deterministic, guarded by E04 migration locking, and refuses
  unknown schema or partial migration without corrupting prior data.
- **AC-010 Failure atomicity:** injected transaction, permission, lock,
  crash-after-write, symlink, hardlink, and clock faults fail closed and leave
  no partially published projection or recovery decision.
- **AC-011 Boundary safety:** exports contain no native handle, SQL, arbitrary
  mutation callback, E07 database merger, TaskAttempt/RoleRun/LaunchPermit,
  scheduler, worker launch, Git, GitHub, Beads, or role-specific recovery
  dependency.
- **AC-012 Evidence and delivery:** focused tests, hostile-input/fault matrix,
  E04/E05/E07/E08 regression tests, strict typecheck/boundary checks,
  deterministic Bundle check, and `git diff --check` pass.

## 6. Attack and fault matrix

| ID | Fault/attack | Expected invariant |
|---|---|---|
| AM-01 | illegal transition or terminal mutation | typed rejection; no write |
| AM-02 | stale revision or duplicate-key hash collision | rejection; prior result/state unchanged |
| AM-03 | stale/revoked/expired fencing credentials | atomic guard failure and rollback |
| AM-04 | interrupted executing process | scanner reports unknown/recovery; never completed |
| AM-05 | unknown external effect | reconcile/manual decision required; no blind retry |
| AM-06 | artifact truncation/hash drift/path escape | validation and completion fail closed |
| AM-07 | attempt overwrite/delete or mutable returned object | immutable causal history |
| AM-08 | crash between projection/event/decision writes | one atomic committed outcome or none |
| AM-09 | migration/schema drift/partial migration | fail closed with prior schema/data recoverable |
| AM-10 | scanner clock, order, restart, or duplicate run | stable report bytes/hash and no mutation |
| AM-11 | accessors, proxy, symbol, cycle, NUL, non-finite, unknown field | reject before I/O |
| AM-12 | symlink/hardlink/permission/path race | no outside-root write or artifact mutation |
| AM-13 | injected callback/native DB handle | public boundary does not expose mutation authority |

## 7. Non-goals and stop boundary

E10 does not implement TaskAttempt, RoleRun, LaunchPermit, scheduler or
capacity policy, worker/process launch, Pi SDK sessions, repository/worktree
inspection, Git/GitHub/Beads operations, push/merge/release, external adapter
reconciliation, artifact repair/deletion, automatic effect inference, remote
durability, or a replacement durable-execution provider. The generic ledger
and fixture data can be removed without external cleanup or a V1 migration.

## 8. Implementation tasks

| Beads task | Deliverable |
|---|---|
| `workflow-agent-c2b.14.1` | Contract/types, state transition matrix, canonical input and public-boundary tests |
| `workflow-agent-c2b.14.2` | Version-4 schema/migration, immutable attempts, projection/events, and idempotency |
| `workflow-agent-c2b.14.3` | E08 lease/fencing guarded mutations and injected E07 read-only artifact verification |
| `workflow-agent-c2b.14.4` | Deterministic interrupted-step scanner, report, and explicit recovery decision events |
| `workflow-agent-c2b.14.5` | Fault/contract matrix, restart/migration tests, Bundle/Manifest, and delivery evidence |

## 9. Verification commands

```text
npm --workspace=@pi-workflow/workflowd run test
npm --workspace=@pi-workflow/workflowd run typecheck
npm test
npm run typecheck
npm run validate:v2-boundaries
node docs/v2/epics/E10/generate-bundle.mjs --check
git diff --check
```

The implementation must also run the E04/E05/E07/E08 focused suites and the
deterministic hostile-input/fault matrix described in AC-012. No command in
this PRD authorizes a commit, push, PR, external adapter, or Beads closure.
