# V2 E11 — First local walking skeleton

| Field | Value |
|---|---|
| Initiative | `workflow-agent-c2b` |
| Epic | `workflow-agent-c2b.15` |
| Map ID | `E11` |
| Document version | `draft-v1` |
| Product status | **DRAFT RECOMMENDED MVP** |
| Approval status | **PENDING EXACT MANIFEST CONFIRMATION** |
| Engineering eligibility | **INELIGIBLE UNTIL BUNDLE READBACK** |
| Primary workspace | root-level integration harness (`scripts/` or root `test/`) |
| Delivery Units | 1 |
| Maximum implementation tasks | 5 |
| Verification Profile | strict |
| Active Engineering Time | `2h` |

> E11 is a synthetic, root-level walking skeleton. It composes the public
> `@pi-workflow/workflowd` and `@pi-workflow/workflow-worker` entrypoints to
> prove the first durable local path. It is not a production application
> dependency, does not mutate a repository, and does not grant general role or
> subagent authority. No implementation is authorized until the exact Bundle
> manifest and Beads write/readback gates succeed.

## 1. Authority and dependency boundary

E11 is subordinate to the Initiative Charter, Architecture RFC, and Initial
Epic Map. The authoritative E11 map section is pinned by this SHA-256:

```text
8656b55ea858e3778f3e57dcf9b8d307904ccfc0791a92be317eaee61825db5c
```

The direct implementation dependencies are E03, E06, E07, E08, E09, and E10,
in that order:

- **E03** owns versioned Command/Query/Event envelopes, registry validation,
  server-derived principal context, and the synthetic E11 message catalog.
- **E06** owns the Unix-socket daemon and typed client. E11 starts and stops a
  local daemon and uses its public client; it does not add a second transport.
- **E07** owns immutable content-addressed artifacts, metadata, and integrity
  verification. E11 registers exactly one result artifact through its facade.
- **E08** owns leases, fencing tokens, heartbeats, and credential validation.
  E11 uses a structural lease port and never duplicates lease persistence.
- **E09** owns the fenced WorkerHost and Pi Lead session boundary. E11 supplies
  an injected deterministic fake Lead adapter and the narrow synthetic seam.
- **E10** owns the Step state machine and evidence-bearing completion. E11
  drives `prepare → executing → effect-observed → validated → completed`.

The harness is root-level orchestration, not a package-level dependency. It may
import public entrypoints from both applications, but **`workflow-worker` must
never import `workflowd`**, directly or transitively. Worker dependencies are
structural ports (`LeaseAuthority`, lease request, Lead factory, and resources)
only. The daemon may compose E08, E10, and E07 runtime stores when starting the
fixture; the required schema-extension seam must be documented and tested.

## 2. Problem and bounded result

The project has durable protocol, daemon, lease, worker, artifact, and Step
primitives, but no evidence that they compose into a recoverable local job. E11
delivers a single deterministic synthetic Job and a local end-to-end smoke:

```text
typed client
  → workflowd command journal/event log
  → fenced WorkerHost
  → deterministic fake Pi Lead
  → one permitted synthetic role stub
  → immutable JSON result artifact
  → validated and completed E10 Step
  → status read/display
```

The fixture uses temporary runtime, socket, session, and artifact roots and
cleans all generated state. It has no model, provider, network, Git, Beads,
GitHub, shell, sandbox, worktree, repository, or pull-request dependency.

### 2.1 Synthetic fixture contract

The E03 catalog is the only business-shaped protocol surface in this epic:

- command: `synthetic.e11.job.start` v1, payload `{ jobId, stepId }`, with the
  required aggregate revision;
- query: `synthetic.e11.job.read` v1, payload `{ jobId }`;
- event: `synthetic.e11.job.started` v1, payload `{ jobId, stepId }`;
- event: `synthetic.e11.job.completed` v1, payload
  `{ jobId, stepId, artifactRef }`.

The fixture uses stable identifiers (`e11-job-001`, `e11-step-001`, and a
stable operation/attempt key) and a canonical JSON role result. The start
command is accepted by the client, but the coordinator—not an untrusted
caller—supplies the completion result, event, projection, outbox, and E10
evidence after the Worker and artifact checks succeed.

### 2.2 Synthetic permit and role seam

E09 intentionally has no generic permit or Dev/Reviewer execution API. E11
therefore defines only a narrow test seam for one synthetic role, for example
`runSyntheticRole({ permit, jobId, stepId, input })`. The seam must enforce:

1. an opaque fixture permit is issued by the coordinator for this exact
   `jobId`/`stepId` and role;
2. the permit is one-time, generation-bound, lease/fencing-bound, and rejected
   on replay, mismatch, expiry, or stale fencing token;
3. the role returns deterministic JSON bytes and has no filesystem, process,
   network, model, shell, Git, Beads, or repository capability; and
4. the seam is clearly synthetic and cannot be mistaken for E20's generic
   `LaunchPermit`, `RoleRun`, Dev, Reviewer, or scheduler authority.

The fake Lead adapter requests this one role through the injected seam. No
provider or Pi network call is made.

## 3. Recommended implementation decisions

### 3.1 Root-level coordinator and package boundaries

Place the smoke/harness in a root-level `scripts/` or root `test/` location.
It may compose `createWorkflowDaemon`, `createWorkflowClient`,
`openArtifactStore`, `openLeaseStore`, and `openStepLedger` through public
exports. Keep application package boundaries intact: there is no
`workflow-worker → workflowd` import, no shared private database handle, and
no package reaching into another application's source tree. Any E06 daemon
bootstrap extension needed to open E08/E10/E07 stores is a documented public
composition seam.

The coordinator owns lifecycle and evidence ordering. A client `commitCommand`
cannot declare a Step complete merely by placing a result in the request. The
coordinator commits `synthetic.e11.job.completed` only after all of the
following are true: the lease is current; the WorkerHost is running under the
same generation; the one-time synthetic permit is consumed; deterministic role
bytes are produced; E07 has registered and verified the artifact; and E10 has
validated the artifact-bound evidence.

### 3.2 Deterministic bytes and metadata

The role output is canonical UTF-8 JSON with sorted keys, stable newline and
encoding rules, and no clock, process ID, random ID, lease generation, or
temporary path. Retries and restart recovery therefore produce the same
content digest. Artifact metadata is also stable:

| Field | Required value |
|---|---|
| media type | `application/json` |
| authority | `workflowd.synthetic-e11` |
| retention | `standard` |
| redaction | `not-required` |

The artifact ID is the E07 content address (`sha256:<64 lowercase hex>`).
Metadata collisions reject. Recovery adopts and verifies an existing artifact
before completion; it never blindly reruns an unknown effect. Temporary roots
are removed after the smoke, including failure paths.

### 3.3 Step evidence and exactly-once completion

The coordinator binds the E10 record to:

- `stepId` and opaque `stepAttemptId`;
- canonical input hash;
- synthetic role and model label (`synthetic-e11`);
- output location under the temporary artifact root;
- Worker generation, lease ID, and fencing token;
- policy snapshot hash for the fixture; and
- artifact ID/SHA-256 plus validation evidence.

The legal state path is exactly:

```text
prepare → executing → effect-observed → validated → completed
```

Use deterministic command, operation, event, and outbox IDs. A duplicate start,
completion replay, client reconnect, or daemon restart returns the original
outcome and does not append a second completion event or create a second Step
attempt. Completion is committed once, after validation, and remains visible
through event replay/projection/Step read. If the existing E06 transport has no
general query bridge, E11 may define a narrow read-only synthetic status seam;
that seam must not allow mutation or bypass the daemon journal.

### 3.4 Restart, fencing, and recovery

Inject a restart at a meaningful boundary (after role effect/artifact
registration and before final completion, or an equivalent persisted
checkpoint). On restart, the new Worker generation must obtain a strictly newer
fencing token, validate the persisted Step and artifact, and adopt the known
artifact. It must not run an unknown effect a second time. The recovery path
then appends exactly one completion event and projection update. A stale worker
or revoked lease cannot mutate the Step, artifact metadata, or completion
outbox. The client remains responsive while the daemon/worker performs this
work; the smoke must exercise a concurrent health/status or bounded prompt.

### 3.5 No production authority

This epic does not add a generic role runner, scheduler, sandbox, repository
writer, Git broker, Beads adapter, GitHub client, PR flow, or model/provider
integration. The one role stub is fixture-only and read-only. Removing the
harness must leave production package behavior and application dependency
direction unchanged.

## 4. Frozen public and test boundary

The root harness may use a test-only adapter/fixture, but production exports
must remain narrow. The worker receives structural ports and exposes no
workflowd client, daemon, SQLite/SQL, artifact writer, shell, Git, Beads,
subagent, or arbitrary mutation callback. The coordinator must not expose
native handles or permit callers to supply trusted completion evidence.

The deterministic fake Lead records only secret-free lifecycle facts needed by
the smoke (generation, permit consumption, role invocation count, and result
hash). It must be possible to assert that the role invocation count is one even
when recovery occurs.

## 5. Acceptance criteria

- **AC-001 Protocol contract:** the synthetic E03 command/query/event catalog
  validates; malformed, stale revision, unknown schema/version, and forged
  completion payloads reject without a partial write.
- **AC-002 Boundary safety:** the harness is root-level; public composition
  does not add `workflow-worker → workflowd` imports or private-handle access;
  boundary validation remains clean.
- **AC-003 Client responsiveness:** while the daemon/worker executes or
  recovers the fixture, the client can complete a bounded health/status request
  and reconnect/replay events without blocking on role execution.
- **AC-004 Lease/fencing:** missing, expired, revoked, mismatched, or stale
  credentials reject worker/permit/Step mutations; a restart uses a newer
  fencing token and stale completion cannot win.
- **AC-005 Permit ceiling:** exactly one synthetic permit authorizes exactly
  one role invocation for the stable job/step; replay, mismatch, or generic
  role/permit requests reject.
- **AC-006 Artifact integrity:** deterministic role bytes register once with
  E07 metadata; truncation, hash drift, metadata collision, missing
  registration, or unverifiable content prevents Step completion.
- **AC-007 Step evidence:** E10 records the bound attempt, input hash, worker
  generation, lease/fencing proof, artifact ID, and validation evidence before
  the `completed` transition.
- **AC-008 Exactly-once completion:** duplicate command, reconnect, retry, and
  restart recovery produce one completion event, one completed Step, and one
  stable artifact digest; no duplicate attempt is created.
- **AC-009 Recovery adoption:** after an injected restart with a known artifact,
  recovery verifies/adopts that artifact and completes once without rerunning an
  unknown effect; an absent or conflicting artifact fails closed.
- **AC-010 Temporary isolation:** the smoke uses temporary runtime/session,
  socket, and artifact roots, never touches a repository or external system,
  and cleans all generated state on success and failure.
- **AC-011 Runtime composition:** daemon startup opens the required E08/E10/E07
  runtime schemas through documented seams and refuses unknown/partial schema
  state without corrupting prior data.
- **AC-012 Evidence and delivery:** focused smoke/restart/fencing tests,
  package regression tests, strict typecheck/boundary checks, deterministic
  Bundle/Manifest readback, and `git diff --check` are recorded in delivery
  evidence.

## 6. Attack and fault matrix

| ID | Fault/attack | Expected invariant |
|---|---|---|
| AM-01 | client supplies completed result/evidence | coordinator ignores/rejects it; no completion before real evidence |
| AM-02 | duplicate start/completion command | original outcome returned; no duplicate event, Step, or artifact |
| AM-03 | stale/revoked lease or fencing token | Worker, permit, artifact, and Step mutation fail closed |
| AM-04 | permit replay or wrong job/step/role | one-time seam rejects without role invocation |
| AM-05 | role returns clock/random/path-dependent bytes | deterministic fixture rejects or canonicalizes before registration |
| AM-06 | artifact truncation/hash or metadata drift | E07 verify/validation rejects; no completion |
| AM-07 | daemon restart before completion | newer worker adopts known artifact and completes once |
| AM-08 | worker restart with unknown effect | no blind rerun; recovery requires explicit evidence/manual boundary |
| AM-09 | client disconnect during execution | daemon continues; reconnect/replay yields one terminal outcome |
| AM-10 | runtime schema missing/unknown/partial | composition fails closed without mutating prior state |
| AM-11 | symlink/path escape in temp roots | fixture rejects and cleanup remains scoped to owned temp paths |
| AM-12 | fake Lead tries model/network/shell/repository access | hard capability ceiling; adapter never receives those capabilities |

## 7. Non-goals and stop boundary

E11 does not implement production role execution, E20 LaunchPermits,
TaskAttempt/RoleRun, scheduling, Beads lifecycle, Git/GitHub, repository or
worktree mutation, sandboxing, pull requests, model/provider/network calls,
durable external execution, or a generic daemon query protocol. The synthetic
fixture is removable and may only run against temporary local state. A passing
smoke proves process composition and recovery evidence; it does not authorize
the next production execution epic.

## 8. Implementation tasks

| Beads task | Deliverable |
|---|---|
| E11-T1 | Protocol/fixture contract and narrow synthetic permit seam |
| E11-T2 | Root-level coordinator wiring client, daemon, Worker, Step, and Artifact without app-to-app imports |
| E11-T3 | Deterministic fake Lead/role stub and immutable artifact registration |
| E11-T4 | Restart/recovery, fencing, idempotency, and responsiveness integration tests |
| E11-T5 | Bundle, Manifest, delivery evidence, and strict quality gates |

## 9. Verification commands

```text
npm --workspace=@pi-workflow/v2-protocol run test
npm --workspace=@pi-workflow/workflowd run test
npm --workspace=@pi-workflow/workflow-worker run test
npm run test:e11
npm test
npm run typecheck
npm run validate:v2-boundaries
node docs/v2/epics/E11/generate-bundle.mjs --check
git diff --check
```
