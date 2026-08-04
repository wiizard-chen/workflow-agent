# V2 E68 — Native SQLite versus durable backend qualification

| Field | Value |
|---|---|
| Initiative | `workflow-agent-c2b` |
| Epic | `workflow-agent-c2b.9` |
| Map ID | `E68` |
| Document version | `draft-v1` |
| Product status | **DRAFT** |
| Approval status | **NOT APPROVED** |
| Engineering eligibility | **INELIGIBLE** |
| Primary repository | `workflow-agent` |
| Primary workspace | `@pi-workflow/workflowd` |
| Primary implementation area | `docs/v2/epics/E68` and isolated qualification fixtures |
| Delivery Units | 1 |
| Target Active Engineering Time | `2h` |
| Maximum implementation tasks | 5 |
| Verification Profile | `strict` |
| Approval manifest | Not created |
| Authoritative approval hash | Not assigned |

> This is a bounded research and qualification draft. It authorizes no provider
> adoption, SQLite replacement, production migration, external service, network
> effect, task implementation, branch/worktree, commit, or pull request.
> Engineering eligibility requires explicit approval of this exact immutable
> Document Bundle and successful Beads write/readback.

## 1. Authority and dependency boundary

This PRD is subordinate to:

- [Initiative Charter](../../INITIATIVE_CHARTER.md)
- [Architecture RFC](../../ARCHITECTURE_RFC.md)
- [Initial Epic Map](../../INITIAL_EPIC_MAP.md#e68--native-sqlite-versus-durable-backend-spike)
- [Third-Party Reuse Survey](../../THIRD_PARTY_REUSE_SURVEY.md)
- [E01 Workspace and Package Boundaries PRD](../E01/PRD.md)

The Initial Epic Map is the only scheduling authority. E68 depends on **E01**;
the bundle generator parses that field instead of maintaining a second graph.
E68 qualifies a future `DurableExecutionBackend` SPI. It does not replace the
native SQLite driver, alter E04's persistence contract, or make any candidate a
Runtime, Domain, Beads, GitHub, approval, release, observation, or evidence
authority. E04 may use native SQLite as its MVP baseline only after the E68
qualification decision is recorded; a different driver requires a separate
approved ADR and implementation Epic.

## 2. Problem statement

The RFC keeps native SQLite WAL plus the V2 Step Ledger as the local baseline,
while naming Temporal, Restate, DBOS TypeScript, and Hatchet as possible
durability patterns. Feature breadth is not evidence that a backend preserves
V2's authority boundaries. A durable engine can replay work yet still lose
idempotency, fencing, artifact provenance, or the distinction between a local
fact and an externally confirmed effect. Choosing one implicitly would also
turn a research package into an unreviewed production dependency.

E68 therefore produces comparable, pinned, reproducible evidence and an
explicit decision posture. Missing or non-reproducible evidence is a
first-class `BLOCKED` result, not a reason to infer adoption.

## 3. Goal and bounded result

E68 delivers one qualification record that:

1. defines the V2-owned `DurableExecutionBackend` comparison contract;
2. pins the native baseline and each candidate's source, dependencies, runtime,
   and artifact identity;
3. compares checkpoint/replay, timers, retries, cancellation, restart recovery,
   idempotency, duplicate/unknown effects, fencing, schema/version drift, and
   artifact hashes using isolated fixtures;
4. checks capability, isolation, provenance, fault, and authority gates;
5. records native-only, adapt-behind-SPI, reference-only, rejected, or blocked
   dispositions with evidence links and stable hashes; and
6. leaves `workflowd` as the sole authority and changes no production code.

The recommended MVP outcome is **native SQLite/Step Ledger remains the
baseline** unless a pinned candidate passes every applicable gate and a separate
ADR approves an adapter. A successful spike is not an adoption approval.

## 4. Recommended qualification decisions

### 4.1 Baseline

The baseline is the E04 native SQLite WAL store plus the RFC Step Ledger. The
fixture models `TaskAttempt`, `StepAttemptRecord`, `RoleRunRecord`, idempotency
keys, fencing tokens, authority-aware Saga boundaries, and content-addressed
artifact hashes. It is the comparator, not a candidate to be silently replaced.

### 4.2 Candidate set

The first comparison set is fixed to the candidates named by the survey:

| Candidate | Expected useful pattern | Required boundary |
|---|---|---|
| Temporal | durable workflow/activity history, timers, retries | adapter cannot own V2 state or external authority |
| Restate | durable handlers, virtual objects, recovery | adapter must preserve fencing and idempotency |
| DBOS TypeScript (`dbos-transact-ts`) | transaction-backed TypeScript durability | PostgreSQL is not a drop-in SQLite replacement |
| Hatchet | task orchestration, workers, retry/observability patterns | adapter cannot become scheduler or evidence authority |

The candidate list is closed for this Epic. Adding a provider requires a new
change request or a follow-up qualification task with its own provenance.

### 4.3 SPI and authority contract

The probe harness treats a backend as an untrusted adapter behind a versioned
interface:

```ts
type DurableExecutionBackend = Readonly<{
  readonly interfaceVersion: 1;
  readonly prepare: (step: StepInput) => Promise<PreparedStep>;
  readonly append: (record: StepAttemptRecord) => Promise<void>;
  readonly checkpoint: (checkpoint: Checkpoint) => Promise<void>;
  readonly recover: (step: StepInput) => Promise<RecoveryObservation>;
}>;
```

The exact implementation SPI may be refined only by a separate ADR. Every
request is bound to a Policy Snapshot hash, correlation ID, fencing token,
idempotency key, and candidate provenance. The adapter may return facts and
operation status; it may not create permits, approve effects, mutate Beads/Git/
GitHub, declare evidence accepted, or redefine Domain transitions.

### 4.4 Evidence and provenance

Each result records candidate name/version/commit, lockfile digest, runtime and
OS identity, fixture version, command line, input/output artifact hashes, and
timestamps in the evidence envelope. Network access is disabled by default.
If an upstream service is required, the task records the capability as
unavailable and produces `BLOCKED` rather than using an operator credential or
an unpinned live service.

### 4.5 Disposition policy

`QUALIFIED` requires all contract, isolation, provenance, fault, and authority
gates. `ADAPT` means a candidate is useful only behind a future approved SPI;
it is not a production dependency. `REFERENCE` records design ideas without
runtime use. `REJECTED` records a failed invariant. `BLOCKED` records missing,
unreproducible, or externally unavailable evidence. No disposition changes
E04 or any downstream implementation automatically.

## 5. Users and success outcomes

### US-01 — Runtime architect

As a Runtime architect, I want a reproducible comparison so that a provider is
not selected because of marketing features or an unverified demo.

### US-02 — Fault-test author

As a fault-test author, I want the same restart, retry, duplicate, fencing, and
unknown-effect matrix against every candidate and the native baseline.

### US-03 — Governance reviewer

As a reviewer, I want exact provenance and authority assertions so that a
qualification record can be audited without trusting the provider's claims.

### US-04 — E04 maintainer

As an E04 maintainer, I want a native-only fallback that remains valid when a
candidate is unavailable or fails qualification.

Success means the decision record is deterministic, independently rerunnable,
and explicit about what was not proven. It does not require a hosted provider
to be reachable.

## 6. Frozen evidence boundary

The qualification artifact must expose only serializable, recursively immutable
facts:

```ts
type QualificationStatus =
  | "QUALIFIED" | "ADAPT" | "REFERENCE" | "REJECTED" | "BLOCKED";

type CandidateIdentity = Readonly<{
  readonly id: string;
  readonly version: string;
  readonly sourceRevision: string;
  readonly dependencyLockSha256: string;
  readonly runtime: string;
}>;

type ProbeResult = Readonly<{
  readonly name: string;
  readonly status: "pass" | "fail" | "blocked";
  readonly inputSha256: string;
  readonly outputSha256: string;
  readonly safeDetail?: string;
}>;

type QualificationRecord = Readonly<{
  readonly schemaVersion: 1;
  readonly baseline: CandidateIdentity;
  readonly candidates: readonly CandidateIdentity[];
  readonly probes: readonly ProbeResult[];
  readonly contractGate: "pass" | "fail" | "blocked";
  readonly isolationGate: "pass" | "fail" | "blocked";
  readonly provenanceGate: "pass" | "fail" | "blocked";
  readonly faultGate: "pass" | "fail" | "blocked";
  readonly authorityGate: "pass" | "fail" | "blocked";
  readonly disposition: QualificationStatus;
  readonly recordSha256: string;
}>;
```

No credential, arbitrary exception, environment dump, provider object, live
database handle, or mutable callback may appear in the record.

## 7. Functional requirements

### FR-001 — Closed candidate manifest

The harness validates the exact candidate set, source revisions, lockfile
digests, runtime identity, and fixture version before running probes. Duplicate,
floating, or unpinned candidates reject before execution.

### FR-002 — Versioned SPI mapping

Each candidate is invoked only through a V2-owned, capability-declared adapter
surface. Unsupported operations return typed `unsupported_capability`; no
provider API is exposed from the public workflowd package.

### FR-003 — Native baseline parity

The same logical fixture and expected invariants run against native SQLite/Step
Ledger and each available candidate. Timing or throughput differences never
override a failed invariant.

### FR-004 — Recovery matrix

Probes cover restart at checkpoint boundaries, timer wakeup, retry, cancellation,
duplicate request, stale fencing token, schema/version drift, and replay after
an unknown external effect. A provider must return a safe recovery observation
without claiming that an unconfirmed effect succeeded.

### FR-005 — Idempotency and fencing

Repeated idempotency keys produce one logical append; stale or mismatched
fencing tokens cannot mutate the current attempt. The test asserts the resulting
record and artifact hashes, not merely a provider status string.

### FR-006 — Authority isolation

Adapters cannot write Beads, Git, GitHub, approval/evidence tables, release or
observation stores, or the user's checkout. The harness detects attempted
filesystem, network, subprocess, and credential access and classifies it as a
failure or blocked capability.

### FR-007 — Provenance and artifact identity

Every probe has deterministic input/output hashes and a source/runtime
identity. Missing provenance invalidates qualification even if behavior passes.

### FR-008 — Fail-closed unavailable candidates

When a candidate cannot be installed or run locally, the result is `BLOCKED`
with a safe diagnostic. The harness never installs an unpinned package, reaches
an unapproved service, or silently substitutes a different provider.

### FR-009 — Deterministic comparison

Candidate ordering, probe ordering, canonical JSON, and decision digest are
stable across object insertion order, locale, timezone, and process ID.

### FR-010 — No implementation side effects

Importing the qualification package performs no filesystem, database, network,
timer, child-process, or provider initialization. Only an explicit fixture
runner may perform work, and it runs under a temporary root.

## 8. Non-functional and security requirements

- **Single authority:** `workflowd` remains the only Runtime enforcement and
  evidence authority.
- **Reproducibility:** source, dependencies, runtime, fixture, command, and
  artifacts are pinned and hashed.
- **Isolation:** probes use temporary directories, deny network by default, and
  never read `HOME`, the user's checkout, Beads state, or production secrets.
- **No false completion:** timeout, unknown effect, cancellation ambiguity, or
  missing callback becomes an explicit recovery observation or `BLOCKED`.
- **No hidden adoption:** a qualification record cannot alter package manifests,
  E04 driver selection, or runtime configuration.
- **Safe diagnostics:** errors contain stable codes and bounded details only.

## 9. Explicit non-goals

E68 does not implement or authorize:

- a production `DurableExecutionBackend` adapter;
- replacement of E04 native SQLite, a PostgreSQL service, or a hosted durable
  engine;
- Domain transition semantics, command handlers, Step Ledger ownership, or
  `workflowd` migration code;
- Beads, Git, GitHub, Docs, release, observation, approval, or evidence writes;
- scheduler, sandbox, workspace, worker, Pi SDK, or recursive agent execution;
- live production credentials, network service enrollment, or package
  installation from an unpinned source;
- throughput benchmarks used as a substitute for contract/fault evidence.

## 10. Acceptance criteria

### AC-001 — Exact candidate and baseline manifest

The generated manifest contains native SQLite/Step Ledger plus exactly
Temporal, Restate, DBOS TypeScript, and Hatchet, each with pinned identity or a
typed `BLOCKED` entry explaining unavailable provenance.

### AC-002 — Contract gate

Every runnable candidate maps to the V2-owned SPI, declares capabilities, and
rejects unsupported fields/version drift without widening authority.

### AC-003 — Recovery and fault matrix

Restart, checkpoint replay, timers, retries, cancellation, duplicate requests,
stale fencing, schema/version drift, and unknown external effects are exercised
with the same fixture and evidence schema.

### AC-004 — Idempotency and artifact integrity

Duplicate logical requests produce one append, stale fencing cannot mutate, and
record/artifact hashes remain deterministic across reruns.

### AC-005 — Isolation gate

Probe execution cannot write the user's checkout, Beads, Git, GitHub, approval,
release, observation, or evidence authority. Any attempted external effect is
captured and fails or blocks the candidate.

### AC-006 — Provenance gate

Source revision, dependency lock, runtime/image, command, fixture, and artifact
hashes are present and independently verifiable for every non-blocked result.

### AC-007 — Decision posture

The record selects exactly one disposition per candidate and a global
recommendation. `QUALIFIED` is impossible when any required gate is fail or
blocked; `BLOCKED` is retained when evidence is missing.

### AC-008 — Native fallback

If all external candidates are unavailable or fail, the record explicitly keeps
native SQLite/Step Ledger as the MVP baseline and does not modify E04.

### AC-009 — Deterministic bundle

The PRD bundle, evidence schema, candidate order, probe order, authority hashes,
and manifest SHA-256 are deterministic and pass the bundle `--check` command.

### AC-010 — Side-effect boundary

Fresh-process import is side-effect free; fixture execution uses only a
temporary explicit root and leaves no provider process or network service.

### AC-011 — Existing V2 gates

The repository's V2 typecheck, test, boundary validation, and `git diff --check`
remain green without weakening E01, E02, E03, E04, or E70 evidence.

## 11. Minimal task split

Exactly five bounded tasks fit this spike:

1. **Candidate/provenance manifest** — pin the closed candidate set, runtime,
   lockfiles, fixture version, and safe evidence schema.
2. **SPI and native baseline harness** — implement the in-memory/native fixture
   mapping and invariant assertions without changing production packages.
3. **Candidate capability probes** — run isolated source/API and availability
   probes; classify unsupported or unavailable candidates as `BLOCKED`.
4. **Fault and authority matrix** — exercise recovery, idempotency, fencing,
   unknown effects, isolation, and artifact hash assertions.
5. **Decision bundle and independent review** — canonicalize evidence, compute
   hashes, review the gates, and produce the recommendation/ADR input.

Tasks 2–4 depend on task 1; task 5 depends on all prior tasks. None may modify
E04's driver or introduce an external backend dependency.

## 12. Verification contract

The approved bundle will freeze the exact commands. The draft recommends:

```text
node docs/v2/epics/E68/qualification/validate-manifest.mjs
node docs/v2/epics/E68/qualification/run-fixtures.mjs --root <temporary-root>
node docs/v2/epics/E68/generate-bundle.mjs --check
npm run typecheck:v2
node scripts/validate-v2-boundaries.mjs
git diff --check
```

Every command records exit status, candidate/runtime identity, fixture root,
input/output hashes, and whether the result is pass, fail, or blocked. A hosted
provider is never contacted by the default verification command.

## 13. Rollback and stop boundary

E68 artifacts and temporary fixtures can be removed without touching a user
database, checkout, Beads state, or provider account. If a candidate requires
an external service, credential, unpinned install, or authority expansion, stop
and record `BLOCKED`; create a separate ADR/implementation Epic rather than
expanding this spike.

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Hosted provider unavailable | Record `BLOCKED`; native baseline remains valid |
| Provider claims durability without fencing | Require stale-token and duplicate-effect probes |
| PostgreSQL-backed candidate is mistaken for SQLite replacement | Keep DBOS as an adapter candidate and require separate ADR |
| Unknown external effect is replayed | Require reconcile-before-retry observations |
| Benchmark bias hides authority failure | Gate on invariants before cost/latency notes |
| Unpinned source changes result | Require revision/lock/runtime/artifact hashes |
| Probe mutates external state | Temporary root, network denial, and authority write detectors |

## 15. User approval checklist

- [ ] I approve this bounded E68 qualification scope and closed candidate set.
- [ ] I approve native SQLite/Step Ledger as the MVP baseline during research.
- [ ] I approve the versioned SPI and authority/fault/provenance gates.
- [ ] I approve `BLOCKED` as the result for unavailable or unreproducible evidence.
- [ ] I approve that any backend adoption requires a separate ADR and Epic.
- [ ] I approve the exact immutable E68 Document Bundle and Verification Contract.

| Approval manifest | Pending |
|---|---|
| Bundle hash | Pending |
| Verification Contract hash | Pending |
