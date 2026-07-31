# RFC-0001: pi-workflow V2 Architecture

> **Status:** Accepted architecture baseline; implementation not started
> **Initiative:** `workflow-agent-c2b`
> **Charter:** [Initiative Charter](./INITIATIVE_CHARTER.md)
> **Implementation map:** [Initial Epic Map](./INITIAL_EPIC_MAP.md)
> **Target runtime:** TypeScript/Node.js on Pi SDK, single active executor machine

## 1. Abstract

pi-workflow V2 introduces a user-level persistent control plane named `workflowd`. Interactive Pi sessions become clients for Portfolio governance and product definition rather than owners of BUILD execution. Each active bounded Epic is executed by an isolated `workflow-worker` that embeds a persistent Pi SDK `AgentSession` as the logical Engineering Lead. The Lead drives role-specific subagents through Runtime-issued launch permits. Code is written in Workflow-managed Delivery Unit worktrees and delivered through normal GitHub pull requests.

The architecture separates authority by domain:

- Beads: long-term product and engineering governance;
- SQLite: Runtime jobs, leases, steps, events, scheduling, and recovery;
- Product Session Store: conversational history;
- Document Bundle: approved product document version;
- GitHub: branches, PRs, reviews, checks, and merge state;
- Release/Observation providers: deployment and outcome facts.

The system is single-machine by design, fail-closed at authority boundaries, and migrated from V1 per Initiative without dual mutation.

---

## 2. Context and V1 Baseline

V1 has proven several valuable controls:

- the manager is code-read-only;
- only one dev writer operates at a time;
- dev and reviewer roles are separated;
- requested and resolved model/effort are audited;
- task closure binds claim baseline, commit range, review pass, and verification;
- final verification and review use deterministic artifacts;
- reviewer retry is bounded and loop-resistant;
- missing evidence fails closed.

V1 also has structural constraints that V2 must remove:

- `/execute` injects the BUILD manager prompt into the active main session;
- authoritative state is held in process/module mutable variables;
- writer exclusivity is scoped to one extension process;
- the manager receives a generic `subagent` capability;
- task closure assumes accepted commits are already integrated into the target checkout HEAD;
- long shell operations use synchronous process helpers that are incompatible with independent heartbeats;
- only one active workflow context is naturally represented per session.

These are not treated as isolated V1 bugs. They are consequences of the V1 ownership model.

---

## 3. Architectural Decisions

| ADR | Decision |
|---|---|
| ADR-001 | One user-level singleton `workflowd` is the persistent control plane. |
| ADR-002 | Runtime persistence uses SQLite WAL plus immutable content-addressed artifacts. |
| ADR-003 | Clients and workers use versioned Command/Query/Event messages over JSON-RPC 2.0 and Unix domain sockets. |
| ADR-004 | Initiative, Epic, and Delivery state use orthogonal state dimensions with derived display status. |
| ADR-005 | Runtime exclusivity uses durable leases and monotonic fencing tokens. |
| ADR-006 | Recovery is based on a Step Ledger, idempotent operations, and external reconciliation. |
| ADR-007 | `workflow-worker` embeds Pi SDK `AgentSession`; it does not nest `pi --mode rpc`. |
| ADR-008 | Engineering Leads receive role-specific tools; generic subagent orchestration is not exposed. |
| ADR-009 | Every Epic, Job, and Delivery Unit binds an immutable resolved Policy Snapshot. |
| ADR-010 | Workflow owns a dedicated Pi-native JSONL Product Session Store with attachment leases. |
| ADR-011 | Formal code execution uses Workflow-managed repository mirrors and Delivery Unit worktrees. |
| ADR-012 | GitHub integration uses an API Broker; polling provides correctness and webhooks only accelerate reconciliation. |
| ADR-013 | Approved documents are content-addressed bundles; HTML is the human approval view. |
| ADR-014 | Untrusted code, build, test, and verification execute in a sandbox by default. |
| ADR-015 | Verification is layered and selectable only through governed Verification Profiles. |
| ADR-016 | Release and observation use versioned allowlisted adapters. |
| ADR-017 | Pi TUI and a localhost Web Dashboard share one Runtime state source. |
| ADR-018 | One machine is the active executor; no active-active `workflowd` control-plane cluster is in scope. |
| ADR-019 | Portfolio, Initiative, Epic, and Step budgets constrain execution and retries. |
| ADR-020 | Cross-system transitions use authority-aware write-through sagas. |
| ADR-021 | V2 is built side-by-side and adopted per Initiative with an atomic generation guard. |
| ADR-022 | Initiative may span repositories, but every bounded Epic binds one primary repository. |
| ADR-023 | Beads uses core issue types plus `workflow.kind` metadata rather than custom types. |

---

## 4. Non-negotiable Invariants

These invariants are implementation acceptance criteria, not guidance.

1. **Lead intent, Runtime authority.** The Engineering Lead may choose among legal tactical actions and propose plans. Only `workflowd` may create attempts, allocate capacity, grant leases, transition lifecycle state, approve effects, or broker mutations.
2. **Single active Runtime generation.** An Initiative is authoritative in V1 or V2, never both. The generation marker is written to and read back from governance Beads. V1 must reject V2-owned work and V2 must reject active V1 ownership.
3. **Bounded Epic fail-closed.** An Epic that violates single-result, independent acceptance, rollback, or size constraints cannot be forced into BUILD.
4. **One Unit, one writer, one branch, one worktree, one PR.** Multiple tasks may execute serially inside a Unit. Parallel writers in one Unit are forbidden.
5. **Current fencing token required.** Every sensitive worker command must carry a current lease ID and fencing token. Stale workers cannot mutate state even if their process recovers.
6. **Beads confirmation before governance effect.** PRD, Charter, Change Request, cancellation, and risk approvals are not effective until Beads write and readback succeed.
7. **External authority confirmation.** PR, merge, release, rollback, and outcome states advance only after confirmation from their authoritative systems.
8. **Evidence invalidation is monotonic.** A new external commit, changed HEAD, changed base, changed policy, changed verification profile, changed sandbox, or changed gate invalidates relevant prior evidence.
9. **No credential-bearing agents.** Agents never receive GitHub, release, production, SSH, cloud, or model-provider secrets that are unnecessary for their role.
10. **No host-general mutation tools for Dev.** Dev file and command tools are jailed to the current Unit and cannot access Runtime state, Beads, `.git`, other worktrees, or user home.
11. **No protection bypass.** Runtime may enable GitHub auto-merge but cannot bypass branch protection, required reviews, checks, or merge queues.
12. **Short integration lease.** The base-branch integration lease covers fetch/update/rebase, verification, push, and merge/queue request. It is released while waiting for GitHub. A changed base requires reacquisition and revalidation.
13. **Immutable approved inputs.** Approved PRD bundles, Policy Snapshots, Attempts, Launch Permits, and Verification definitions are immutable.
14. **No silent degradation.** Missing sandbox, model, credential, tool, adapter, or verification capability blocks execution. Host execution, model migration, and verification downgrade require explicit governed policy.
15. **Single active executor machine.** A Portfolio has one active `workflowd` execution authority. Remote workers may be added later under that control plane; multiple active control planes are out of scope.
16. **Sensitive artifact policy.** Logs, transcripts, CI output, and documents are subject to redaction, access, and retention policy. Full thinking content is not published to Docs or Dashboard by default.

---

## 5. Process Topology

```text
Pi TUI Client ─────────────┐
Local Web Dashboard ───────┼── Command / Query / Event ──┐
CLI / Diagnostics ─────────┘                              │
                                                         ▼
                                                   workflowd
                                  ┌──────────────────────┼──────────────────────┐
                                  │                      │                      │
                           SQLite Runtime          Domain Brokers          Worker Lifecycle Manager
                           Event / Inbox           Beads / GitHub          spawn / drain / recover
                           Lease / Budget          Docs / Release                   │
                           Scheduler               Observation                      ▼
                                                                         workflow-worker
                                                                         Pi SDK AgentSession
                                                                         Engineering Lead
                                                                              │
                                                                     role-specific tools
                                                                              │
                                                                     role subagent runs
                                                                              │
                                                                        Sandbox Runner
```

### 5.1 `workflowd`

`workflowd` is a user-level singleton managed by the operating system user service (`launchd` on macOS, `systemd --user` on Linux).

It owns:

- Runtime mutation authority;
- SQLite and migrations;
- Command handlers and projections;
- scheduler, capacity, and budgets;
- leases and fencing;
- worker lifecycle;
- brokers and adapters;
- Inbox and event routing;
- reconciliation and recovery.

It does not load models, execute repository code, or host an Engineering Lead.

### 5.2 `workflow-worker`

One active Epic has at most one authoritative Worker generation. A Worker:

- embeds Pi SDK;
- hosts the Engineering Lead session;
- exposes only role-specific custom tools;
- uses permits issued by `workflowd`;
- reports independent heartbeat and telemetry;
- launches role subagents through the approved execution engine;
- aborts and exits immediately after lease loss.

### 5.3 Pi and Web clients

Clients present state and submit commands. They do not own jobs and do not directly mutate SQLite, Beads, GitHub, worktrees, or release systems.

---

## 6. Single-machine Deployment Boundary

V2 is a local control plane with one active executor machine per Portfolio.

Cross-machine synchronization may cover:

- Portfolio and Repository Beads;
- GitHub repositories and PRs;
- Docs repository and document bundles;
- exported session/artifact backups.

It does not create active-active scheduling. Machine handoff requires a formal drain, checkpoint, synchronization, ownership transfer, and reconciliation process. Unexpected takeover requires explicit revocation of the prior machine epoch and a recovery report.

The initial implementation excludes remote workers, distributed consensus, and multi-`workflowd` leader election. Interfaces may preserve an `ExecutionBackend` boundary for future single-control-plane remote workers.

---

## 7. Runtime Persistence

### 7.1 SQLite WAL

Recommended location:

```text
~/.pi/workflow/runtime/workflow.db
```

SQLite holds transactional Runtime facts, including:

- repositories and local locators;
- jobs and worker generations;
- aggregate versions and projections;
- commands and idempotency results;
- append-only domain events;
- durable outbox operations;
- leases and fencing tokens;
- scheduler entries, capacity, and budgets;
- Steps and Attempts;
- Inbox items and decisions;
- GitHub resource projections and cursors;
- release and observation operation projections;
- session bindings and attachment state;
- artifact references.

`workflowd` is the only mutation writer. Read-only diagnostics may use a safe API; they do not bypass migrations or invariants.

### 7.2 Migrations

Daemon startup must:

1. validate schema version;
2. acquire a migration lock;
3. create a pre-migration backup;
4. run ordered migrations;
5. validate the resulting schema;
6. start mutation RPC only after success.

Unknown or failed schema migration permits diagnostics and safe shutdown, not normal mutation.

### 7.3 Artifact Store

Recommended root:

```text
~/.pi/workflow/artifacts/
```

Artifacts are written to a temporary path, synchronized, hashed, atomically renamed, and registered. They are immutable after registration.

Typical artifacts:

- PRD and Charter bundles;
- diff and commit-range evidence;
- dev/reviewer/final-review output;
- verification stdout/stderr;
- CI logs;
- session handoff snapshots;
- recovery and termination reports;
- release and observation evidence.

SQLite stores ID, path, SHA-256, size, media type, authority, retention classification, and optional redaction metadata.

### 7.4 Secrets

SQLite, artifacts, session JSONL, logs, Docs, and Beads must not contain plaintext credentials. They store credential references resolved by a Credential Broker using OS Keychain or an equivalent secret store.

---

## 8. Authority Model

| Fact | Authority | Confirmation rule |
|---|---|---|
| Initiative Charter approval | Portfolio Beads | write + readback before domain event |
| Epic PRD approval | Repository Beads | write + readback before scheduling eligibility |
| Change Request and governance decision | Beads | write + readback |
| Job, Worker, Lease, Step, heartbeat | SQLite | local transaction |
| Product conversation | Product Session Store | append-only Pi session file + binding |
| Approved document version | Document Bundle manifest | exact manifest hash |
| Branch, PR, review, checks, merge | GitHub | API reconciliation |
| Release and rollback | external Release Adapter system | operation status confirmation |
| Metrics and outcome | Observation Adapter source | raw samples + deterministic evaluation |

An outbox transports intent to external authorities. It never redefines which system is authoritative.

---

## 9. Authority-aware Saga Protocol

### 9.1 Governance operation

```text
Command accepted as pending
→ validate actor/version/document
→ write Beads operation marker
→ commit/read back exact metadata and decision
→ SQLite transaction marks command complete
→ emit approved/cancelled/decided event
```

If Beads is unavailable, approval remains pending and no new engineering job may rely on it.

### 9.2 GitHub operation

```text
record operation intent
→ call GitHub Broker
→ query authoritative GitHub resource
→ bind Node ID / SHA / state
→ advance projection
```

Timeout results in `unknown` and reconciliation, not blind replay.

### 9.3 Docs operation

Document approval is bound to the local immutable bundle and Beads governance record. GitHub Docs and Pages publication may lag without invalidating approval. A publication warning remains visible.

### 9.4 Release operation

Release intent, execution, status lookup, and optional compensation are recorded as a saga. `released` is asserted only after provider confirmation.

---

## 10. Command, Query, and Event Protocol

### 10.1 Transport

- Unix domain socket: `~/.pi/workflow/runtime/workflowd.sock`.
- File permission: `0600`.
- Framing: JSON-RPC 2.0 messages with versioned schemas.
- Dashboard: localhost-only HTTP plus SSE/WebSocket mapped to the same handlers.

### 10.2 Command envelope

Commands sent by a client contain business intent, not a trusted actor assertion:

```json
{
  "commandId": "cmd-...",
  "type": "epic.approve-prd",
  "aggregate": {
    "type": "epic",
    "id": "epic-...",
    "expectedVersion": 17
  },
  "correlationId": "initiative-...",
  "humanPresenceGrant": "grant-...",
  "payload": {}
}
```

- `commandId` is globally idempotent.
- The same ID with different input is rejected.
- `expectedVersion` prevents stale overwrite.
- The client cannot choose or override its actor type. `workflowd` derives the actor from the authenticated connection principal and records it in the command journal.
- Worker, Product Agent, scheduler, reconciler, and human-interactive clients use distinct server-issued principals and capability sets.

### 10.3 Trusted principals and human-presence grants

Unix-socket permission `0600` proves only that a process runs under the same OS account. It does not prove that a human approved an action. A model-driven client or compromised same-UID process must not be able to submit `actor.type=human`.

`workflowd` therefore authenticates every connection and assigns a non-forgeable server-side principal:

- `human-interactive-client` for an attached Pi TUI or authenticated Dashboard session;
- `product-agent` for Product AI tool calls;
- `engineering-worker` for one fenced Worker generation;
- `scheduler`, `github-reconciler`, `release-adapter`, and `system-recovery` for internal services.

Human-authority commands require a short-lived, single-use human-presence grant. The trusted TUI or Dashboard creates the grant only after an explicit confirmation surface outside model-controlled text. The grant is bound to:

- client principal and connection generation;
- command type;
- aggregate ID and expected version;
- exact Document Bundle or decision hash where applicable;
- expiry and one-time nonce.

Product AI may prepare an approval proposal and open the trusted confirmation surface, but it cannot obtain, synthesize, replay, or consume a human-presence grant by itself. Workers and internal services are never eligible for human grants. The daemon verifies and consumes the grant before dispatching a governance Saga.

Dashboard authentication, CSRF protection, and Pi extension UI confirmation are transport-specific implementations of the same principal/grant model. Approval audit records both the authenticated principal and the consumed grant ID.

### 10.4 Queries

Queries are side-effect-free projections such as:

- `portfolio.overview`;
- `initiative.get`;
- `epic.get`;
- `job.status`;
- `inbox.list`;
- `events.since`.

### 10.5 Events

Events are append-only and contain aggregate sequence, actor, causation, and correlation. Consumers use durable event cursors and can recover after disconnect.

### 10.6 Schema validation

Protocol, tools, artifacts, policies, adapters, and evidence use shared runtime JSON Schema definitions. TypeScript types alone are insufficient at process, network, disk, or model boundaries.

---

## 11. State Model

A single `status` enum is prohibited for complex aggregates.

### 11.1 Epic dimensions

- Product/Governance: `draft`, `readiness-review`, `awaiting-approval`, `approved`, `change-proposed`, `awaiting-change-approval`, `cancelled`, `superseded`.
- Scheduling: `not-eligible`, `eligible`, `queued`, `allocated`, `slot-released`.
- Engineering: `not-started`, `starting`, `running`, `paused`, `blocked`, `replanning`, `implementation-complete`, `failed`, `cancelled`.
- Delivery: `not-started`, `building`, `pr-open`, `awaiting-checks`, `changes-requested`, `ready-to-merge`, `merged`, `integrated`.
- Release: `not-required`, `not-started`, `ready`, `releasing`, `released`, `rolled-back`, `failed`.
- Outcome: `not-required`, `pending`, `observing`, `verified`, `failed`.
- Attention: `none`, `warning`, `needs-decision`, `critical`.

### 11.2 Delivery Unit dimensions

Engineering, PR, Release, and Outcome are tracked independently. Illegal transitions are rejected by explicit pure transition functions.

### 11.3 Display status

UI derives a primary status using precedence similar to:

```text
critical > needs-decision > failed > paused > blocked > running
> awaiting-checks > queued > observing > completed
```

Beads core status is a compatibility projection. Detailed Workflow state is stored in `workflow.*` metadata and Runtime projections.

---

## 12. Lease and Fencing Model

### 12.1 Lease resources

- Epic execution;
- Delivery Unit writer;
- base-branch integration;
- release operation;
- Product Session interactive writer;
- short-lived repository fetch or maintenance operations.

### 12.2 Fencing

Each re-grant increments a durable token. Every sensitive command carries lease ID and fencing token. The daemon rejects stale tokens even if the old process is alive.

Initial suggested values:

- heartbeat interval: 5 seconds;
- worker lease TTL: 20 seconds.

These values are policy defaults, not protocol constants.

### 12.3 Lease loss

A Worker that loses its lease must:

1. stop launching work;
2. abort the Lead session;
3. interrupt current subagents and child process groups;
4. stop submitting state;
5. persist final diagnostics;
6. exit.

Long-running commands must be asynchronous so the heartbeat loop is not blocked.

### 12.4 Integration lease duration

The integration lease must not remain held while GitHub checks or merge queue wait. It covers only the local critical section:

```text
fetch latest base → update/rebase → verify → push → request merge/queue
```

A changed base later creates a new integration cycle with a new lease and evidence.

---

## 13. Step Ledger and Recovery

### 13.1 Step states

```text
planned → prepared → executing → effect-observed → validated → completed
```

Exceptional states:

```text
failed, aborted, superseded, unknown
```

A prepared Step freezes input hashes, expected HEAD, Attempt, policy, role, model, output location, and worker generation.

### 13.2 Recovery principles

- A session statement is not evidence that an effect occurred.
- Existing effects are adopted after validation rather than recreated.
- Unknown external effects are reconciled before retry.
- Attempts and artifacts are immutable.

### 13.3 Representative recovery

- Dev interruption: inspect worktree, dirty state, commits, trailers, and result artifacts.
- Reviewer interruption: validate schema, model/effort, input commit, and output hash.
- Push interruption: compare local and remote SHA.
- PR interruption: search by stable head branch and machine marker.
- Merge interruption: query `mergedAt` and merge commit OID.
- Release interruption: query the adapter using stable operation ID.

A recovered Lead receives the Runtime's authoritative snapshot and may not override it with conversational memory.

---

## 14. Policy and Budget

### 14.1 Configuration layers

1. Built-in defaults.
2. User Portfolio configuration.
3. Repository policy committed at the base revision.
4. Initiative policy from the approved Charter.
5. Epic and Delivery policy from the approved PRD.

### 14.2 Immutable snapshot

Every Epic, Job, and Unit binds a content-addressed resolved Policy Snapshot containing:

- source versions and hashes;
- role models and effort;
- agent definitions and tool contracts;
- capacity and budget;
- verification profile and gates;
- repository, branch, sandbox, GitHub, release, and observation policy.

Normal configuration changes affect new snapshots only. Active work requires Policy Migration. Emergency Deny may pause or revoke capability but may not silently alter execution and continue.

### 14.3 Budget hierarchy

Budgets apply at Portfolio, Initiative, Epic, and Step levels. They may include:

- Active Engineering Time;
- tokens and cost;
- task and reviewer attempts;
- CI runs;
- Sandbox compute;
- research calls.

Time, attempt, retry, and CI limits have safe defaults. Monetary hard limits require explicit user configuration. Hard limits stop new permits and pause at a safe checkpoint.

---

## 15. Pi SDK Worker and Sessions

### 15.1 Worker embedding

`workflow-worker` uses Pi SDK `createAgentSession`/`AgentSessionRuntime`, `SessionManager`, `ModelRuntime`, and an explicit `ResourceLoader`.

It does not automatically load arbitrary user or repository executable extensions. Versioned project context such as `AGENTS.md` may be included as instructions, while executable extension code remains deny-by-default.

### 15.2 Lead generations

One logical Lead can have multiple physical session generations. Generation changes require a handoff snapshot containing approved PRD, Delivery Plan, decisions, current Step, evidence, risks, and legal next actions.

### 15.3 Pi runtime replacement semantics

Product or Lead session switching must be atomic with Pi SDK semantics:

1. acquire attachment/worker lease;
2. resolve cwd-bound services and controlled ResourceLoader;
3. switch or create the session;
4. rebind extensions;
5. replace event subscriptions;
6. validate session ID and model;
7. only then expose writer attachment or acknowledge readiness.

### 15.4 Session checkpoints

Live JSONL is append-only mutable history, not an immutable artifact. PRD approval, canonical fork promotion, and Lead-generation handoff produce immutable summary/snapshot artifacts with hashes.

---

## 16. Role Execution and Launch Permits

The Lead receives tools such as:

- `analyze_codebase`;
- `run_dev_attempt`;
- `run_task_review`;
- `run_final_review`;
- `diagnose_ci_failure`;
- `analyze_merge_conflict`;
- `request_change`;
- `request_publish`.

It does not receive a generic `subagent`, unrestricted shell, GitHub, Beads, or release tool.

Before role execution, `workflowd` creates an immutable Attempt and one-time Launch Permit specifying:

- exact role and namespaced agent;
- requested model and thinking effort;
- worktree cwd;
- output artifact path;
- session directory;
- allowed tools and capability ceiling;
- writer/read-only classification;
- current fencing token;
- expiry.

The Worker executes the permit through pi-subagents. Resolved model/effort, cwd, tool audit, output, and usage are validated before acceptance. Drift fails closed.

---

## 17. Product Session Store

Recommended root:

```text
~/.pi/workflow/sessions/
```

Scopes:

- Portfolio canonical session;
- Initiative canonical and fork sessions;
- Epic Product canonical and fork sessions;
- Engineering Lead generations.

SQLite stores stable binding IDs, not only absolute paths. Beads stores binding references and summaries.

A canonical Product Session has one interactive writer lease. Other clients may observe or create non-authoritative forks. Fork promotion is an explicit governed action.

Product-session capabilities:

- Portfolio: Runtime queries and governance proposal tools; no repository mutation. Human-authority commands still require a trusted client principal and one-time human-presence grant.
- Initiative: cross-repository read-only analysis and Charter tooling.
- Epic Product: target-repository read/search/web tools; no code mutation.

---

## 18. Beads Architecture

### 18.1 Portfolio workspace

A dedicated Workflow Portfolio Beads workspace stores:

- Initiative as core `epic` with `workflow.kind=initiative`;
- non-authoritative Epic Reference as `feature`;
- Initiative Change Request and governance decisions as `decision`;
- Portfolio incidents as `bug`.

### 18.2 Repository governance workspace

Each registered repository has a stable Workflow-managed governance checkout or Beads workspace independent of the user's interactive checkout. It stores:

- bounded Epic as `epic`;
- Delivery Unit as `feature`;
- implementation Task as `task`;
- implementation Bug as `bug`;
- Epic Change Request and technical decision as `decision`.

The user's checkout is a locator and product-analysis surface, not the sole physical home of authoritative repository Beads.

### 18.3 Metadata and labels

- authoritative domain kind: `workflow.kind` metadata;
- query projections: `wf:*` labels;
- cross-workspace references include stable repository ID and remote issue ID;
- Portfolio Epic References are explicitly `authoritative=false`.

### 18.4 Beads 1.1.0 constraints

The adapter must preserve tested behavior:

- use `--dolt-auto-commit on`;
- use global `-C <repo>`;
- only `blocks` dependencies affect ready blocking;
- `bd ready` may include parent Epics;
- comments use `bd comment`;
- do not use `bd edit`, normal-operation `bd import`, or `bd doctor --fix`.

### 18.5 Open durability policy

Whether a governance milestone requires local Dolt commit only, remote-before-execution, or remote-before-delivery remains an implementation ADR. The default must be explicit and visible; it cannot be silently inferred.

---

## 19. Repository Mirror, Worktree, and Git Broker

### 19.1 Repository identity

Repository identity is derived primarily from normalized GitHub remote identity, not local path. The registry may track multiple local checkout locators.

### 19.2 Managed repository store

`workflowd` maintains a bare mirror/object store and a stable governance checkout. Formal base revisions come from remote branches. Local unpushed user commits are not implicit Workflow inputs.

### 19.3 Delivery Unit worktree

Each Unit receives a dedicated branch and worktree from the managed repository store. Dev cannot operate on the user's current checkout.

### 19.4 Jailed file tools

Dev must not receive host Pi builtin mutation tools without confinement. File operations must enforce canonical paths and defend against:

- `..` escape;
- symlink and hardlink escape;
- TOCTOU replacement;
- `.git` mutation;
- other worktrees;
- Runtime and Artifact Stores;
- Beads governance workspace.

### 19.5 Controlled commit

Dev submits an implementation intent. The Git Broker validates the diff, verification state, file boundaries, and active lease, then creates a local commit with stable Workflow trailers.

### 19.6 Worktree cleanup

Cleanup requires merged/closed state, no active worker or lease, no unknown dirty changes, and registered artifacts. Recovery-needed worktrees are retained.

---

## 20. Sandbox

The daemon and Lead Worker run on the host under controlled capabilities. Repository code execution occurs through a Sandbox Runner.

The Sandbox:

- mounts only the current Unit worktree;
- does not mount user home, SSH, Pi credentials, Runtime state, other worktrees, or Docker socket;
- starts with an environment allowlist;
- denies network by default, with policy allowlists;
- binds container/image digest in the Policy Snapshot;
- limits CPU, memory, processes, disk, output, and time;
- supports controlled dependency caches without cross-job writable trust.

A missing Sandbox blocks the Job. Host Mode is an explicit, audited exception and never an automatic fallback.

---

## 21. Verification

### 21.1 Layers

1. Task Gate: targeted tests and local specification evidence.
2. Delivery Unit Gate: required repository suite for the complete PR diff.
3. GitHub Gate: required checks, reviews, protection, and merge queue.
4. Epic Gate: approved PRD acceptance against the latest merged base.
5. Initiative Gate: cross-Epic Charter success and integration.

### 21.2 Profiles

Repositories define allowed profiles such as `fast`, `standard`, `strict`, and named custom profiles. Readiness and actual diff determine the minimum profile.

- escalation may be automatic;
- downgrade requires human approval and Policy Migration;
- skipped gates and reduced assurance are explicit;
- GitHub required checks, evidence integrity, independent review, and applicable risk floors cannot be disabled.

### 21.3 Evidence

Each verification run binds gate definition hash, argv/script, policy, sandbox image, environment policy, HEAD, duration, exit code, and output artifacts. A changed input invalidates cache reuse.

---

## 22. GitHub Broker

The Broker uses Octokit REST/GraphQL behind a domain API. Credentials are supplied by a GitHub App where possible, with user OAuth/`gh` bootstrap supported through the Credential Broker.

The Broker handles:

- repository capability probes;
- branch push;
- idempotent PR creation/adoption;
- reviews and threads;
- checks, workflow runs, and merge queues;
- external commits and force-push detection;
- auto-merge enablement;
- rate limits and backoff;
- Docs repository publication.

Polling is the correctness mechanism. Webhooks or relay events only trigger immediate reconciliation. A webhook payload does not directly transition authoritative state.

Human blocking threads are not automatically resolved by AI. External commits invalidate prior evidence and require adoption and revalidation.

---

## 23. Document Bundle and Docs Portal

An approved Charter or PRD bundle contains:

```text
source.md
document.json
rendered.html
manifest.json
assets/
```

The manifest binds all hashes and renderer version. Approved bundles are immutable.

GitHub Docs repository structure exposes Portfolio, Initiative, Epic, Change Request, decision, and delivery pages. GitHub Pages publication is subject to visibility policy. If private access cannot be proven, sensitive documents remain local/private and public publication is blocked.

The renderer sanitizes raw HTML, disallows arbitrary script, uses a fixed version, and emits a restrictive CSP.

---

## 24. Release and Observation Adapters

Adapters are versioned, allowlisted packages loaded by Runtime policy, not arbitrary repository extensions.

Release adapters expose prepare, execute, status, rollback, and rollback-status operations. Observation adapters expose metric definitions, sampling, deterministic evaluation, and stop operations.

Initial adapter contracts should support:

- Manual Release/Acceptance;
- GitHub Actions release;
- sandboxed command release;
- feature-flag style activation;
- deterministic outcome evaluation.

Credentials are references resolved only at execution. Timeouts create `unknown` operations that must be reconciled before retry.

---

## 25. Portfolio UI and Inbox

### 25.1 Pi TUI

Product conversation, entity navigation, quick approval, Inbox handling, and Critical interrupt.

### 25.2 Local Web Dashboard

Portfolio, Initiative graph, queue, capacity, budgets, PR state, release, observation, and audit. It binds only to localhost and uses one-time session bootstrap, secure cookies, CSRF, Origin/Host checks, CSP, and the same command handlers as UDS clients.

### 25.3 Inbox

Inbox items have `open`, `acknowledged`, `decided`, `applied`, and `closed` states. Routing is scope-aware. Only Critical funds/security/data/rollback events interrupt arbitrary active conversations.

---

## 26. Scheduling and Capacity

Initial defaults:

- global Engineering capacity: 4;
- per-repository active Delivery Units: 2;
- per-Unit writers: 1;
- per-base integration operations: 1.

The scheduler considers priority, Initiative critical path, dependencies, conflict graph, aging, provider/resource capacity, remaining budget, and current phase.

Product work is independent of engineering capacity. Long waits should release engineering slots when safe.

---

## 27. V1 to V2 Migration

V2 is developed side-by-side with V1. A Workflow Initiative has an authoritative `runtimeGeneration` marker in Beads.

### 27.1 Rules

- V1 work remains V1 until completed or explicitly migrated.
- V2 work is never mutated by V1 commands.
- Active V1 BUILD is not automatically imported.
- Migration acquires a lease, freezes V1 mutation, validates Beads/Git/evidence, writes and reads back the V2 generation marker, then enables V2 authority.
- Failure before confirmation leaves V1 authoritative.

### 27.2 Import classes

- PLAN-only V1: import PRD as a Single-Epic Initiative draft and rerun readiness.
- completed V1: import as historical evidence without pretending it used V2 controls.
- active BUILD: finish V1, cancel/replan, or migrate only at a proven safe checkpoint.

### 27.3 Retirement gate

V1 mutation is removed only after V2 passes unit, integration, fault-injection, and real GitHub end-to-end delivery, and all active V1 work is completed or migrated. V1 artifact viewing/import remains available.

---

## 28. Security Threat Model

| Threat | Required controls |
|---|---|
| Repository prompt/extension injection | explicit ResourceLoader; no arbitrary executable extensions |
| Stale Worker split brain | lease, fencing, heartbeat, process-group abort |
| Path or symlink escape | jailed file tools, canonical path validation, sandbox mount boundary |
| Secret exfiltration | no host env inheritance; credential broker; redaction |
| Direct GitHub/production mutation | domain brokers and adapters; no agent credentials |
| External force-push | detection, evidence invalidation, pause/adoption |
| Public PRD leakage | fail-closed visibility policy; local/private fallback |
| Config or model drift | immutable Policy Snapshot; explicit migration |
| Test skipping presented as pass | governed profiles and explicit assurance |
| V1/V2 double mutation | Beads generation marker and bidirectional guards |
| Unsafe release replay | stable operation ID and provider reconciliation |
| Sensitive transcript publication | retention/redaction policy; thinking excluded by default |

---

## 29. Observability and Audit

Runtime audit records:

- commands, actors, versions, causation, and correlation;
- state transitions and events;
- worker and session generations;
- leases and fencing tokens;
- agent role, requested/resolved model and effort, usage, and tool audit;
- Steps, Attempts, commits, artifacts, verification, and reviews;
- Beads, GitHub, Docs, release, and observation authoritative references;
- Active Engineering Time, token, cost, CI, and compute budgets.

High-frequency token deltas and heartbeats are not published to Docs. Logs and artifacts are classified for retention and redaction.

---

## 30. Open Implementation Decisions

The following remain implementation ADRs and are not silently fixed by this RFC:

- SQLite driver and migration library;
- HTTP server and Dashboard framework;
- default macOS Sandbox backend;
- static-site renderer/theme;
- GitHub App bootstrap UX;
- Beads remote durability milestone policy;
- session/artifact backup transport;
- exact table schemas, RPC method list, and transition matrices;
- retention periods and redaction implementation;
- exact repository governance checkout layout.

Each choice must preserve the invariants in Section 4.

---

## 31. Verification Strategy for V2

V2 itself requires:

### 31.1 Unit tests

- state transition matrices;
- protocol schema and actor authorization;
- command idempotency and expected version;
- lease fencing and token monotonicity;
- policy snapshot determinism;
- artifact integrity;
- verification profile floors.

### 31.2 Integration tests

- SQLite migrations and recovery;
- Beads governance saga;
- repository mirror and worktree jail;
- Pi SDK session replacement and extension rebinding;
- Worker/Permit role execution;
- GitHub Broker mocks and reconciliation;
- sandbox isolation;
- Docs rendering determinism.

### 31.3 Failure injection

- Worker dies after commit;
- Beads write succeeds before SQLite confirmation;
- PR creation succeeds before daemon checkpoint;
- stale Worker resumes after replacement;
- duplicate webhook/comment/check event;
- external commit and force-push;
- integration base changes;
- release returns timeout/unknown;
- session JSONL is truncated;
- V1/V2 migration fails between authority steps.

### 31.4 Real end-to-end

A real GitHub test repository must demonstrate:

```text
Initiative
→ Charter and HTML approval
→ bounded Epic PRD approval
→ queue and Worker
→ Lead, Dev, Reviewer
→ managed worktree and commit
→ PR and review feedback
→ auto-merge under protection
→ Epic verification
→ Docs publication
→ observation/acceptance
```

During the run, the original Pi Product Session must remain free to construct a second PRD.

---

## 32. Traceability

The product goals and organizational boundaries that this RFC implements are defined in [Initiative Charter](./INITIATIVE_CHARTER.md).

Every architectural subsystem and invariant is assigned to bounded delivery work in [Initial Epic Map](./INITIAL_EPIC_MAP.md).
