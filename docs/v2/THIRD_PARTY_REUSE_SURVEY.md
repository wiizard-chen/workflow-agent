# V2 Third-Party Reuse Survey

> **Status:** research input to the accepted V2 architecture; no package or external backend is adopted by this document.
>
> **Scope:** Permission Policy Enforcement (PEP), role execution, durable execution, and workspace isolation. Product-domain state, approvals, Beads/Git/GitHub authority, and evidence acceptance remain V2 responsibilities.
>
> **Related decisions:** [Initiative Charter](./INITIATIVE_CHARTER.md), [Architecture RFC](./ARCHITECTURE_RFC.md), [Initial Epic Map](./INITIAL_EPIC_MAP.md), and the [E02 domain entry](./INITIAL_EPIC_MAP.md#e02-domain-identities-hierarchy-and-primitive-transition-kernel).

## 1. Decision posture

V2 uses **reuse first, authority last**. A third-party package may reduce implementation effort only when its behavior can be bounded behind a versioned SPI, independently qualified, and reconciled by `workflowd`. Adoption is not inferred from popularity, repository activity, a README, or a successful demo.

The decisions in this survey are deliberately narrower than “which framework is best”:

- `adopt`: use as a bounded implementation component after a qualification gate;
- `adapt`: wrap or translate selected behavior behind a V2-owned interface;
- `reference`: borrow concepts, tests, or operational patterns only;
- `reject`: do not use for the stated V2 boundary, while leaving future reconsideration possible.

A `reference` or `adapt` result is **not** a production integration. The research spikes in E67–E69 are qualification work, not adoption approvals.

## 2. Evidence discipline: S1 and S1.1

### 2.1 Evidence classes

- **S1 — source and boundary evidence:** pinned repository/package source, license/version metadata, public API documentation, and a written comparison against the V2 SPI. S1 establishes what a candidate claims to do; it does not establish that the candidate enforces the required boundary.
- **S1.1 — dynamic evidence:** a reproducible local probe or fault-injection run against the exact pinned version. The probe must exercise allow/ask/deny, cancellation, restart/recovery, version drift, provenance, and authority-boundary cases that matter to the proposed SPI. A passing happy path is insufficient.

S1.1 evidence is only local evidence until it is independently reproduced and reviewed. It must not be described as a V2 guarantee, and it must not be used to silently replace a V2 gate.

### 2.2 Artifact and hash rule

Each S1/S1.1 run records an immutable artifact manifest containing candidate name, source URL, resolved version or commit, probe definition hash, environment/runtime identity, result, and SHA-256 hashes of logs and outputs. Local orchestration records may live below the repository-relative, gitignored path `.pi-subagents/artifacts/`; that path is an **operator-local evidence cache**, not a committed source of truth and not a deployment input. This survey intentionally does not cite a temporary absolute path.

A missing artifact, missing hash, unverifiable provenance, or mismatch between the tested and requested version is `unknown`, not `pass`. The qualification gate must fail closed in that case. The current survey records the evidence contract and candidate boundaries; it does not claim that every candidate has passed S1.1.

## 3. Candidate boundaries and source links

The links below are primary source locators. Before any use, pin a commit/package version and re-run S1/S1.1; “latest” is not an acceptable runtime dependency.

### 3.1 Pi ecosystem and permission packages

| Candidate | Source links | What it can plausibly provide | Exact V2 boundary | Disposition |
|---|---|---|---|---|
| Pi SDK / pi-mono | [repository](https://github.com/badlogic/pi-mono) | Pi `AgentSession`/SDK primitives, session resources, extension/tool integration | V2 may use Pi SDK inside `workflow-worker`; SDK does not become lifecycle authority, approval authority, evidence authority, or sandbox | **adopt**, subject to the existing SDK worker boundary |
| `pi-agents-team@2026.7.18` | [npm package](https://www.npmjs.com/package/pi-agents-team), [repository](https://github.com/KristjanPikhof/pi-agents-team) | Interactive agent/team composition, prompt/tool orchestration, and reusable role wiring | Candidate may inform role composition or be adapted behind `RoleExecutionBackend`; it cannot receive generic unrestricted subagent power or decide Runtime effects | **reference/adapt**, pending pinned S1/S1.1 evidence |
| `pi-open-agents@0.1.13` | [npm package](https://www.npmjs.com/package/pi-open-agents), [repository](https://github.com/andrea-tomassi/pi-open-agents) | Open-agent/team composition and prompt/tool orchestration | Candidate remains subordinate to Runtime-issued permits and cannot own lifecycle, approval, evidence, or external-effect authority | **reference/adapt**, pending pinned S1/S1.1 evidence |
| `pi-crew@0.9.56` | [npm package](https://www.npmjs.com/package/pi-crew), [repository](https://github.com/baphuongna/pi-crew) | Team/crew coordination patterns for Pi-like agents | No direct ownership of permits, leases, task closure, Beads, GitHub, or approval; any adapter remains subordinate to `workflowd` | **reference/adapt**, not adopted by this survey |
| `@tmustier/pi-agent-teams@0.5.5` | [npm package](https://www.npmjs.com/package/@tmustier/pi-agent-teams), [repository](https://github.com/tmustier/pi-agent-teams) | Team abstraction and delegation ergonomics | May be used only as an in-session composition helper; no scheduler, authority, or evidence acceptance is delegated | **reference/adapt**, pending provenance and compatibility evidence |
| `@gotgenes/pi-permission-system@24.0.0` | [npm package](https://www.npmjs.com/package/@gotgenes/pi-permission-system), [repository package directory](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) | Permission/policy evaluation implementation candidate | Candidate for the narrow `PermissionBackend` PEP SPI only. It cannot expand the immutable operator ceiling, approve effects, or stand in for the sandbox | **adapt**, only after E67 qualification; otherwise **reject** |

The Pi packages above are not interchangeable. `pi-agents-team`, `pi-open-agents`, `pi-crew`, and `@tmustier/pi-agent-teams` provide composition patterns, not permission enforcement; `@gotgenes/pi-permission-system` is a permission candidate, not process isolation; and none of them is durable workflow recovery. The Pi worker may call a qualified adapter, but the worker and adapter remain fenced by Runtime-issued permits.

### 3.2 Governance and workspace operations

| Candidate | Source links | Useful boundary | Explicit non-boundary | Disposition |
|---|---|---|---|---|
| Beads | [repository](https://github.com/gastownhall/beads), [documentation](https://github.com/gastownhall/beads/tree/main/docs) | Issue/dependency governance, durable human-visible work records, Dolt-backed synchronization | Beads is governance authority for approved records where RFC says so; it is not the SQLite Runtime, scheduler, sandbox, Git broker, or evidence validator | **adopt**, through the V2 Beads adapter and authority-aware Saga |
| Gas Town | [repository](https://github.com/gastownhall/gastown) | Multi-agent workspace/crew operating patterns and operational conventions | Must not become a second scheduler or authority. Its workspace behavior can be evaluated behind `WorkspaceBackend`; it is not a sandbox, permission backend, or approval system | **reference/adapt**, E69 qualification required |

Gas Town may be a useful source of workspace ideas without being the V2 workspace implementation. The default remains the native managed mirror/worktree design in the RFC until a bounded E69 result says otherwise.

### 3.3 Agent execution and graph orchestration

| Candidate | Source links | Useful boundary | Explicit non-boundary | Disposition |
|---|---|---|---|---|
| OpenHands | [repository](https://github.com/OpenHands/OpenHands), [documentation](https://docs.openhands.dev/) | Agent runtime and tool-execution patterns, evaluation ideas | Does not become `workflowd`, the approval principal, the Beads/GitHub broker, or the evidence authority; any execution adapter must honor V2 permits and sandbox policy | **reference/adapt**, no direct adoption |
| LangGraph | [repository](https://github.com/langchain-ai/langgraph), [documentation](https://langchain-ai.github.io/langgraph/) | Explicit graph/state-machine modeling and checkpoint concepts | A graph library does not supply V2 authority, lease fencing, Beads confirmation, GitHub reconciliation, or sandboxing | **reference/adapt**, only for bounded internal orchestration if it passes the SPI review |

Neither OpenHands nor LangGraph is evidence that a V2 worker can safely mutate a repository. Their role is at most an implementation detail behind a qualified `RoleExecutionBackend`.

### 3.4 Durable execution candidates

| Candidate | Source links | Useful boundary | Explicit non-boundary | Disposition |
|---|---|---|---|---|
| Temporal | [repository](https://github.com/temporalio/temporal), [documentation](https://docs.temporal.io/) | Durable workflow/activity execution, retries, timers, history, visibility | Cannot own V2 domain state, Beads approval, Git/GitHub effects, or evidence acceptance without a V2 adapter and reconciliation | **reference/adapt**, E68 spike only |
| Restate | [repository](https://github.com/restatedev/restate), [documentation](https://docs.restate.dev/) | Durable handlers, retries, virtual objects, timers, and recovery model | Same authority restrictions; candidate durability is not permission, sandbox, or governance | **reference/adapt**, E68 spike only |
| DBOS TypeScript (`dbos-transact-ts`) | [TypeScript source](https://github.com/dbos-inc/dbos-transact-ts), [official documentation](https://docs.dbos.dev/) | Durable TypeScript workflow/state patterns backed by PostgreSQL transactions | This candidate's durable system-of-record is PostgreSQL; it is not a drop-in SQLite WAL backend and cannot become V2 authority. E68 must compare PostgreSQL's operational and transaction/recovery boundary with native SQLite/Step Ledger before any adapter decision | **reference/adapt**, E68 spike only |
| Hatchet | [repository](https://github.com/hatchet-dev/hatchet), [documentation](https://docs.hatchet.run/) | Task orchestration, workers, retries, scheduling/observability patterns | Cannot become the V2 scheduler authority, approval system, or evidence validator; external worker effects remain reconciled | **reference/adapt**, E68 spike only |

E68 compares these candidates with native SQLite WAL and the existing Step Ledger. No durable backend is selected by this survey. A durable engine that cannot preserve V2's authority-aware saga, fencing, idempotency, and artifact rules is rejected regardless of feature breadth.

## 4. Adopt/adapt/reference/reject matrix

| Capability | Adopt | Adapt | Reference | Reject as authority |
|---|---|---|---|---|
| Pi session and SDK integration | Pi SDK, under `workflow-worker` | `pi-agents-team`, `pi-open-agents`, `pi-crew`, and `@tmustier/pi-agent-teams` after S1.1 | Agent prompt/tool composition patterns | Any package that can directly mutate Runtime or approvals |
| In-session permission PEP | None without E67 qualification | `@gotgenes/pi-permission-system` behind `PermissionBackend` | Permission policy vocabulary and test ideas | Any backend that can widen operator ceiling or bypass hard deny |
| Role execution | Existing Pi-subagents contract remains the baseline | `pi-agents-team`, `pi-open-agents`, `pi-crew`, `@tmustier/pi-agent-teams`, OpenHands, or LangGraph behind `RoleExecutionBackend` | Evaluation and graph/checkpoint patterns | Generic recursive agent spawning or unbounded shell |
| Durable execution | Native SQLite/Step Ledger remains the baseline pending E68 | Temporal, Restate, DBOS TypeScript (`dbos-transact-ts`), or Hatchet adapter only after E68 | Retry/timer/history design | A backend that becomes an alternate authority or cannot reconcile effects |
| Workspace lifecycle | Native managed mirror/worktree remains the baseline pending E69 | Gas Town patterns behind `WorkspaceBackend` | Crew/workspace lease ideas | Any workspace system that can bypass path jail, branch policy, or cleanup audit |
| Governance | Beads adapter and readback Saga | None may replace the authority contract | Gas Town governance-adjacent conventions | External backend owning Beads approval or generation marker |
| Sandbox | V2 Sandbox Runner and selected backend from E21 | A candidate may provide a process adapter only | Isolation test patterns | Treating third-party role/durable/workspace software as a sandbox |

## 5. V2 interfaces and authority boundary

Every external candidate is called through a V2-owned SPI. The SPI is versioned, capability-limited, and bound to the immutable Policy Snapshot. An adapter returns facts and operation results; it does not get to define whether those facts are authoritative.

### 5.1 PermissionBackend

`PermissionBackend` is an **in-session Permission Policy Enforcement Point (PEP)**. It evaluates a proposed tool/action request against an immutable operator ceiling and a session overlay, returning `allow`, `ask`, or `deny` plus reason, policy version, and provenance. It is not a sandbox, credential broker, scheduler, or approval authority.

The Runtime remains the final authority for whether a permit exists and whether an effect may be committed. The PEP can only narrow or request confirmation; it cannot grant a capability above the operator ceiling.

### 5.2 RoleExecutionBackend

A `RoleExecutionBackend` accepts a Runtime-issued, one-time Launch Permit and executes one named role `RoleRunRecord` authorized by one `LaunchPermit`. Its contract includes exact role, model/effort, input hashes, worktree/session/output locators, capability ceiling, fencing token, expiry, cancellation, resolved version, and artifact manifest. It returns structured result/provenance facts. It may not create permits, mutate Beads/Git/GitHub, approve requests, or declare evidence accepted.

### 5.3 WorkspaceBackend

A `WorkspaceBackend` prepares, inspects, fences, and cleans a Delivery Unit workspace. It must report canonical path, branch/base identity, lease/fencing state, dirty state, and cleanup outcome. It may not decide product scope, mutate Beads approval, bypass the Git Broker, publish a PR, or erase unknown dirty work.

### 5.4 DurableExecutionBackend

A `DurableExecutionBackend` persists/replays bounded Steps, timers, retries, cancellation, and recovery observations. It must preserve immutable `TaskAttempt` records, `StepAttemptRecord` records, `RoleRunRecord` records, idempotency keys, fencing, authority-aware Saga boundaries, and artifact hashes. It may not redefine domain transitions, approve external effects, or replace Beads/GitHub/release/observation authority.

## 6. Qualification gates and maturity labels

A candidate is qualified only when all applicable gates pass against a pinned version:

1. **Contract gate:** the adapter implements the V2 SPI and rejects unsupported capabilities.
2. **Isolation gate:** capability ceiling, path, credential, network, and process boundaries are explicit; third-party orchestration is not accepted as sandbox evidence.
3. **Provenance gate:** source version, dependency lock, runtime/image identity, and artifact hashes are recorded.
4. **Fault gate:** restart, timeout, cancellation, duplicate request, stale fencing token, version drift, and unknown external effect are exercised.
5. **Authority gate:** no external backend can write or confirm Beads/Git/GitHub/approval/evidence authority; workflowd remains the sole Runtime authority.
6. **Operational gate:** metrics, logs, resource limits, cleanup, and safe disable/fallback behavior are understood.

Maturity labels are deliberately conservative:

- **research candidate:** source review only;
- **qualified adapter:** all gates pass for a pinned version and bounded capability set;
- **adopted component:** a qualified adapter is selected by an accepted ADR and integrated under the RFC;
- **not qualified:** evidence is missing, contradictory, or the boundary cannot be enforced.

The survey currently assigns research/adapt dispositions to most candidates. E67–E69 must produce the formal evidence before any candidate becomes an adopted component.

## 7. Consequences for E02 and implementation order

E02 remains a pure domain kernel package. Its branded identities, hierarchy/ownership invariants, revisioned envelopes, canonical ordering, generic transition results, and single-dimension conformance helper are backend-neutral: they do not import a PermissionBackend, durable engine, workspace provider, Pi team package, or third-party scheduler. Product/Approval, plan/preflight, Readiness, Attention/Blocker, Scheduling, Engineering/Task/TaskAttempt, Delivery, Release, Outcome, closure, and display belong to E70–E83. Backend choice enters through later SPI and qualification Epics, not through domain semantics.

The Initial Epic Map therefore keeps E02's scope and stop boundary unchanged while adding:

- E67 for PermissionBackend qualification and S1/S1.1 evidence;
- E68 for native SQLite versus durable backend comparison;
- E69 for native worktree versus Gas Town workspace comparison.

These are bounded research/qualification spikes. They are not permission to start implementation against the named external products.

## 8. Evidence register (current status)

The following is a completed **local S1.1 probe record**, not an E67 qualification result. It is intentionally recorded as dynamic evidence that still requires the formal E67 contract, integrator, provenance, isolation, authority, and fault gates:

| S1.1 field | Completed local evidence |
|---|---|
| Candidate/version | `@gotgenes/pi-permission-system@24.0.0` |
| Probe | Real isolated Pi load/co-load against the pinned candidate; the probe reproduced the hard-deny/operator-ceiling problem, then exercised the repaired prototype. |
| Result | Repair prototype review: **PASS**. This is local probe/review evidence only; it is not an adoption approval or a V2 guarantee. |
| Scope observed | 131 files / 2694 tests |
| Artifact location | Repository-relative `.pi-subagents/artifacts/` (gitignored, operator-local evidence cache; not a committed source of truth or deployment input) |
| Artifact hashes | `upstream-code.patch` SHA-256: `bb2a30...`; full patch SHA-256: `3f5c0d...` (the displayed values are the recorded prefixes from the local evidence register) |

The local probe has **not** been submitted upstream, has not passed a formal independent integrator review, and has not completed E67 fault qualification. In particular, this record does not claim that cancellation, restart/recovery, version drift, malformed decisions, provenance, or authority-boundary qualification gates have passed. E67 remains the formal qualification Epic; E68 and E69 remain separate durable-execution and workspace qualification work.

| Evidence | Required content | Status in this survey |
|---|---|---|
| S1 source review | pinned source/version, license, API/boundary notes | documented as source links and exact candidate versions; formal pin/manifest review remains an E67–E69 gate |
| S1.1 dynamic probe | reproducible probe, fault cases, output/artifact SHA-256 | **partially complete locally** for the `@gotgenes/pi-permission-system@24.0.0` probe above; not formal E67 qualification |
| E67 qualification | PermissionBackend contract, provenance, integrator, and fault gates | planned in Initial Epic Map; not claimed complete by the local S1.1 record |
| E68 qualification | native SQLite/Step Ledger versus Temporal/Restate/DBOS TypeScript/Hatchet | planned in Initial Epic Map |
| E69 qualification | native managed worktree versus Gas Town workspace adapter | planned in Initial Epic Map |

No row marked planned, partially complete locally, or not formally qualified may be used as an adoption approval.
