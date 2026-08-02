# pi-workflow V2 Initial Epic Map

> **Status:** Initial implementation decomposition; every Epic still requires its own Readiness Review
> **Initiative:** `workflow-agent-c2b`
> **Charter:** [Initiative Charter](./INITIATIVE_CHARTER.md)
> **Architecture:** [Architecture RFC](./ARCHITECTURE_RFC.md)

## 1. Purpose

This document decomposes the V2 architecture into **83 bounded implementation Epics (E01–E83)**. It is not a task list to execute blindly. Before an Epic is approved for engineering, its Product Session must confirm scope, repository change surface, acceptance, risk, Verification Profile, and Active Engineering Time.

The map intentionally creates an early walking skeleton and recurring integration gates. It does not postpone all cross-component risk until the final E2E.

---

## 2. Bounded Epic Rules

The `Dependencies` field on each Epic is the only authoritative scheduling graph in this document. `Route note`/historical `Unlocks` text is explanatory only and must never be used by a scheduler. Before Beads tasks are created, tooling must parse the authoritative dependency fields, reject unknown IDs/cycles, and generate any critical-path or parallel-group views from that graph.

Every implementation Epic must satisfy:

- one primary, independently verifiable result;
- one primary repository and subsystem;
- target Active Engineering Time `≤ 2h`;
- estimated `> 4h` means mandatory decomposition;
- `3–7` implementation tasks after PRD split;
- default one Delivery Unit and one PR;
- explicit upstream dependencies and downstream unlocks;
- explicit non-goals;
- independent stop/rollback boundary;
- a frozen Verification Profile before BUILD.

The estimates below exclude queue time, GitHub wait, user decisions, release windows, and observation windows.

---

## 3. Delivery Strategy

### 3.1 Parallel lanes

```text
Foundation lane *(illustrative only; the `Dependencies` fields below are authoritative)*
  E02 Domain kernel
   ├─ E70 Readiness
   ├─ E73 Plan/preflight
   ├─ E76 Supersession
   ├─ E77 Attention/Blocker
   └─ E79 TaskAttempt
      E70 + E73 + E76 → E74 Product/Approval → E75 ChangeRequest
      E70 + E74 + E77 → E71 Scheduling/Allocation
      E71 + E76 + E77 + E79 → E78 Engineering/Task
      E78 + E79 → E72 Delivery → E80 Release → E81 Outcome
      E70–E81 → E82 closure → E83 display → Protocol → Store → Daemon → Artifact → Lease

Walking-skeleton lane
  Pi Worker → Git workspace → Local vertical slice

Governance lane
  Beads Adapter → Governance Saga → Scheduler/Policy

Delivery lane
  Sandbox → Verification → GitHub Broker → PR Feedback

Product UX lane
  Document Bundle → Session Navigation → Docs → Dashboard

Release/migration lane
  Release → Observation → V1 Import → Cutover → Fault Matrix → Real E2E

Qualification/reuse lane
  Permission PEP qualification → policy/role/sandbox consumers
  Durable backend spike → Runtime store decision
  Workspace backend spike → repository/worktree decision
```

### 3.2 Early vertical slice

The first integration milestone is not a production-ready daemon. It is a thin but real path:

```text
V2 client
→ workflowd command
→ SQLite job
→ fenced worker
→ Pi SDK Lead
→ one role execution stub
→ managed worktree change
→ controlled commit
→ artifact registration
→ completed local Step
```

This walking skeleton must exist before the project invests in every broker and UI.

---

## 4. Epic Catalog

## E01 — V2 workspace and package boundaries

- **Goal:** Establish a V1-compatible monorepo structure for independent V2 packages and applications.
- **Deliverables:** workspace configuration; shared TypeScript config; empty `workflowd`, worker, domain, protocol, and test packages.
- **Task outline:** configure workspaces; add package boundaries; add build/test scripts; preserve V1 entrypoints; add package smoke tests.
- **Non-goals:** no Runtime behavior; no `/execute` change.
- **Dependencies:** none.
- **Unlocks:** all V2 implementation.
- **Active time:** `1h`.
- **Delivery Units:** 1.
- **Verification Profile:** `standard`.
- **Acceptance:** V1 tests/typecheck still pass; all empty V2 packages compile independently.
- **Stop boundary:** removing the new workspace files restores the prior project without changing V1 behavior.

## E02 — Domain identities, hierarchy, and primitive transition kernel

- **Goal:** Deliver one pure backend-neutral vocabulary for branded identities, immutable revisioned envelopes, hierarchy ownership, canonical ordering, and generic primitive transition results.
- **Result:** `Portfolio → Initiative → Epic → DeliveryUnit → Task` parent/repository invariants; distinct `TaskAttemptId`, `StepAttemptId`, `RoleRunId`, and `LaunchPermitId`; caller-supplied scalar refs/timestamps; `DomainTransitionRecord`; typed expected-revision rejection; and a single-dimension conformance helper exposed through `@pi-workflow/v2-domain`.
- **Scope:** identity/reference types, immutable envelopes, canonical ordering, hierarchy validators, generic transition result/rejection/record contracts, deterministic zero-side-effect exports/tests.
- **Non-goals:** no Portfolio/Product lifecycle, ApprovalAttempt record/lifecycle, ChangeRequest record/lifecycle, supersession, TaskAttempt record/lifecycle, ordered plan/preflight, Readiness, projections, Attention/Blocker, Scheduling, Engineering, Task lifecycle, Delivery, Release, Outcome, closure, display, persistence, RPC, Beads, Git, GitHub, Runtime, Worker, Scheduler, Lease, Permission, adapter, or third-party backend selection. E02 exposes only the shared identity seams named by its closed scalar contract, including `ApprovalAttemptId`, `ChangeRequestId`, `TaskAttemptId`, `StepAttemptId`, `RoleRunId`, and `LaunchPermitId`; the owning later Epics consume those seams and own the corresponding records and lifecycles.
- **Dependencies:** E01.
- **Unlocks:** E10, E20, E70, E73, E76, E77, E79 (route notes only; `Dependencies` remains authoritative).
- **Active time:** `1.5-2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** all D01, D02, D09, D16, and D21 E02 obligations are covered by continuous AC-001–AC-012 in the E02 PRD; D03, D05, and D07 remain explicit downstream constraints rather than E02 implementation claims; no deferred lifecycle family or projection is exported.
- **Stop boundary:** pure package and deterministic tests can be reverted without migration or external cleanup.

## E03 — Versioned Command/Query/Event schemas

- **Goal:** Create the shared runtime-validated protocol contracts used by daemon, workers, Pi client, and Dashboard.
- **Deliverables:** command, query, event, aggregate, protocol-version, principal, and human-presence-grant schemas.
- **Task outline:** define envelopes; add TypeBox/JSON Schema; define server-derived principal scopes; define one-time approval grants; define compatibility rules; test malformed, stale, and forged-human messages.
- **Non-goals:** no transport and no command handlers.
- **Dependencies:** E83.
- **Unlocks:** E04, E05, E11, E15.
- **Active time:** `1.5h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** missing command ID, authenticated principal context, expected version, or invalid payload is rejected; a client-supplied `actor.type=human` is never trusted.
- **Stop boundary:** protocol package is isolated from V1.

## E04 — SQLite WAL store and migration bootstrap

- **Goal:** Provide a transactional Runtime database that can initialize, migrate, back up, and fail safely.
- **Deliverables:** database factory; WAL setup; schema versioning; migration lock; pre-migration backup.
- **Task outline:** select driver; initialize pragmas; implement migrations; add schema validation; test interrupted migration.
- **Non-goals:** no domain commands or external adapters.
- **Dependencies:** E01, E68.
- **Unlocks:** E05, E06, E09, E10.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** unknown schema blocks mutation; migrations are deterministic; backup and recovery are tested.
- **Stop boundary:** database lives only under a test/runtime directory and does not alter Beads.

## E05 — Command journal, event log, and durable outbox

- **Goal:** Implement idempotent command processing primitives and atomic projection/event/outbox writes.
- **Deliverables:** command journal; aggregate version checks; append-only event log; outbox claim/retry/ack.
- **Task outline:** implement command hashing; expected-version transaction; event sequencing; outbox leasing; crash/retry tests.
- **Non-goals:** no Beads or GitHub transport.
- **Dependencies:** E03, E04.
- **Unlocks:** E06, E10, E13, E19.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** duplicate command returns original result; collision rejects; outbox recovery does not duplicate confirmation.
- **Stop boundary:** internal store only.

## E06 — Unix-socket daemon and typed client

- **Goal:** Start a user-level `workflowd` process that supports health, query, command, and durable event subscription over a protected Unix socket.
- **Deliverables:** daemon bootstrap; JSON-RPC framing; typed client; protocol handshake; event cursor reconnect.
- **Task outline:** create socket server; enforce `0600`; implement handshake; implement health/query; test disconnect/replay.
- **Non-goals:** no worker execution and no business UI.
- **Dependencies:** E03, E05.
- **Unlocks:** E07, E09, E14, E24, E25.
- **Active time:** `1.5h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** incompatible clients get read-only diagnostics only; event gaps can be replayed by cursor; the transport exposes authenticated connection material and an extension point that E41 can turn into server-issued principals.
- **Stop boundary:** daemon has no external mutation capability.

## E07 — Content-addressed Artifact Store

- **Goal:** Store immutable evidence with atomic write, SHA-256 identity, retention classification, and integrity checks.
- **Deliverables:** artifact registration; atomic writer; manifest; integrity/orphan scanner; redaction metadata boundary.
- **Task outline:** temp/fsync/rename flow; hashing; registration; corruption test; retention class schema.
- **Non-goals:** no PRD renderer and no remote backup.
- **Dependencies:** E04.
- **Unlocks:** E10, E17, E18, E22, E30.
- **Active time:** `1.5h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** registered artifacts are immutable; truncation/hash drift is detected; sensitive classification is retained.
- **Stop boundary:** artifacts are isolated from V1 `.workflow` output.

## E08 — Lease, heartbeat, and fencing core

- **Goal:** Prevent stale or duplicate workers from mutating the same Runtime resource.
- **Deliverables:** lease tables/API; monotonic fencing; heartbeat TTL; stale-command rejection.
- **Task outline:** acquire/renew/revoke; token increment; heartbeat service; sensitive-command guard; daemon restart tests.
- **Non-goals:** no scheduler policy.
- **Dependencies:** E04, E05.
- **Unlocks:** E09, E10, E14, E16, E27.
- **Active time:** `1.5h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** stale generation cannot mutate; token survives daemon restart; lease allocation and state change are atomic.
- **Stop boundary:** no real worker process is launched.

## E09 — Pi SDK Engineering Lead worker host

- **Goal:** Launch a fenced `workflow-worker` that embeds a persistent Pi SDK Lead session with an explicit ResourceLoader.
- **Deliverables:** Worker process; Lead session generation; heartbeat; controlled extension binding; graceful abort.
- **Task outline:** create SDK session; configure model/runtime; bind allowlisted tools; persist generation; report lifecycle and usage.
- **Non-goals:** no Dev/Reviewer execution and no code mutation.
- **Dependencies:** E06, E08.
- **Unlocks:** E11, E16.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** repository executable extensions are not auto-loaded; lease loss aborts and exits; session can resume or hand off generation.
- **Stop boundary:** Worker can only perform a no-mutation diagnostic prompt.

## E10 — Step Ledger and generic recovery scanner

- **Goal:** Persist every side-effecting step and classify incomplete work for adopt, retry, supersede, or manual recovery.
- **Deliverables:** Step state machine; immutable `StepAttemptRecord` records (one causal record per durable Step execution attempt); input hashes; incomplete-step scanner; recovery report.
- **Task outline:** consume E02 `StepAttemptId`; define Step states and `StepAttemptRecord`; persist prepared input; mark observed/validated; implement scanner; inject interrupted steps. E10 never creates a TaskAttempt or RoleRun.
- **Non-goals:** no GitHub-specific or Dev-specific recovery logic.
- **Dependencies:** E02, E05, E07, E08.
- **Unlocks:** E11, E16, E20, E31.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** interrupted effects never appear completed; `StepAttemptRecord` records cannot be overwritten; recovery decisions are evented.
- **Stop boundary:** generic ledger can be removed without external effects.

## E11 — First local walking skeleton

- **Goal:** Prove client → daemon → fenced Worker → Pi Lead → one permitted role stub → artifact → completed Step.
- **Deliverables:** one synthetic V2 Job; one role execution stub; one immutable result artifact; end-to-end local smoke.
- **Task outline:** create test command; allocate worker; issue one permit; run stub role; register artifact; complete Step and display status.
- **Non-goals:** no repository mutation, Beads, GitHub, sandbox, or PR.
- **Dependencies:** E03, E06, E07, E08, E09, E10.
- **Unlocks:** validates the process model before deeper brokers.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** the interactive client remains responsive; daemon/worker restart recovers the synthetic Job without duplicate Step completion.
- **Stop boundary:** synthetic fixture only.

## E12 — V2 Beads core-type mapping adapter

- **Goal:** Provide an asynchronous, fail-loud Beads 1.1.0 adapter using core issue types plus `workflow.kind` metadata, labels, markers, and readback.
- **Deliverables:** repository Beads client; core `epic/feature/task/bug/decision` mapping; `workflow.kind` metadata merge; operation marker; JSON parsing.
- **Task outline:** async process wrapper; core type schema; create/update/comment/readback; marker adoption; failure tests.
- **Non-goals:** no Portfolio workspace and no approval Saga.
- **Dependencies:** E02, E03.
- **Unlocks:** E13, E29.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** uses `--dolt-auto-commit on` and `-C`; never uses forbidden commands; warning-prefixed malformed output fails visibly.
- **Stop boundary:** adapter tests use isolated Beads fixtures.

## E13 — Portfolio Beads workspace and governance Saga

- **Goal:** Make Beads-confirmed Initiative/Epic governance the effective source for approval and Runtime generation.
- **Deliverables:** Portfolio workspace; Initiative/Epic Reference mapping; bidirectional links; Beads-first Saga; drift reconciliation.
- **Task outline:** initialize workspace; create mappings; implement approval pending/confirm; implement generation marker; inject crash after Beads write.
- **Non-goals:** no Product Session UI.
- **Dependencies:** E05, E12.
- **Unlocks:** E14, E24, E29, E30.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** unconfirmed Beads approval cannot schedule; confirmed Beads effect is adopted after daemon crash; V1/V2 markers are read back.
- **Stop boundary:** only fixture governance workspaces until migration Epic.

## E14 — Scheduler, dependency graph, capacity, and budgets

- **Goal:** Allocate only eligible bounded Epics using priority, critical path, conflicts, capacity, and budget.
- **Deliverables:** deterministic scheduler; global/repo capacity; dependency/conflict graph; Active Engineering Time and hard-stop policy.
- **Task outline:** eligibility computation; scoring; capacity accounting; aging; budget checkpoint stop; scenario tests.
- **Non-goals:** no real repository Worker launch beyond test adapter.
- **Dependencies:** E08, E13, E58, E71.
- **Unlocks:** E21, E24, E32.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** conflicting Epics do not co-run; blocked waits release slots; hard budget prevents new permits.
- **Stop boundary:** scheduler can run in dry projection mode.

## E15 — Repository registry, managed mirror, and governance checkout

- **Goal:** Register a GitHub repository by stable remote identity and create Workflow-owned mirror and Beads governance checkout independent of user checkout.
- **Deliverables:** repository registry; remote normalization; bare mirror; stable governance checkout; fetch lease.
- **Task outline:** derive repository ID; clone/fetch mirror; establish governance checkout; resolve base SHA; validate relocation.
- **Non-goals:** no Delivery Unit branch/worktree.
- **Dependencies:** E06, E08, E12, E69.
- **Unlocks:** E16, E17, E19.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** dirty/moved user checkout does not affect formal base or Beads path; local-only anonymous base is rejected in GitHub delivery mode.
- **Stop boundary:** managed repository can be safely unregistered before active Units exist.

## E16 — Delivery Unit branch, worktree, and path jail

- **Goal:** Create one isolated branch/worktree per Unit and enforce the filesystem boundary required by a single writer.
- **Deliverables:** worktree manager; branch identity; canonical path/symlink defenses; active-worktree metadata.
- **Task outline:** create branch/worktree; validate remote/base; implement realpath and symlink confinement; protect `.git`/Runtime/Beads paths; test escape attempts.
- **Non-goals:** no commit creation, cleanup policy, push, or PR.
- **Dependencies:** E08, E10, E15.
- **Unlocks:** E17, E19, E20.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** no write outside Unit; `.git`, Runtime, Beads, and other worktrees are protected; branch/worktree identity is reproducible from the Unit record.
- **Stop boundary:** fixture worktrees can be removed before any commit or remote effect.

## E17 — Second walking skeleton with real managed worktree

- **Goal:** Extend the walking skeleton through a real jailed worktree edit and controlled local commit.
- **Deliverables:** synthetic repository fixture; Lead-requested role stub; one file change; brokered commit; artifact and recovery proof.
- **Task outline:** register fixture repo; allocate Unit; issue permit; apply jailed edit; commit through broker; crash/recover after commit.
- **Non-goals:** no full subagent, sandbox, Beads lifecycle close, push, or PR.
- **Dependencies:** E11, E15, E16, E42, E43.
- **Unlocks:** proves the execution boundary before sandbox and role integration.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** commit is adopted after injected crash and not duplicated; user checkout is untouched.
- **Stop boundary:** test repository only.

## E18 — Product Session Store and attachment leases

- **Goal:** Manage Portfolio, Initiative, Epic Product, and Lead session bindings using Pi JSONL and single-writer attachment fencing.
- **Deliverables:** session registry; canonical/fork storage; attachment lease; recovery generation; immutable checkpoint snapshots.
- **Task outline:** create binding schema; attach/detach; fork/promote; detect damaged JSONL; snapshot on approval/handoff.
- **Non-goals:** no final Pi navigation commands.
- **Dependencies:** E06, E07, E08.
- **Unlocks:** E24, E25.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** two clients cannot append concurrently; fork is non-authoritative; session replacement rebinds extensions/subscriptions atomically.
- **Stop boundary:** stored sessions are independent from V1 defaults.

## E19 — Layered Policy resolver and immutable snapshots

- **Goal:** Resolve Built-in/User/Repository/Initiative/Epic configuration into deterministic content-addressed Policy Snapshots.
- **Deliverables:** resolver; source hashes; model/tool capability probe; migration request; Emergency Deny.
- **Task outline:** define layers; merge/validate; hash snapshot; capability probe; migration/deny tests.
- **Non-goals:** no verification executor or release adapter implementation.
- **Dependencies:** E03, E07, E15, E67.
- **Unlocks:** E20, E21, E22, E27.
- **Active time:** `1.5h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** active work does not drift with config files; unsupported model/effort fails; Emergency Deny pauses rather than silently migrates.
- **Stop boundary:** policy package is pure plus capability probes.

## E20 — Launch Permits and role-specific subagent tools

- **Goal:** Let the Lead drive approved roles only through a shared immutable one-time Launch Permit core, initially exposing Dev/Reviewer tools.
- **Deliverables:** RoleRun/LaunchPermit issue-consume core; `run_dev_role`; `run_task_review`; `run_final_review`; audit validation.
- **Task outline:** consume E02 `RoleRunId`/`LaunchPermitId`; define `RoleRunRecord`/`LaunchPermit` schema and lifecycles; implement daemon issue; implement Worker execution adapter; validate resolved model/tools; prevent recursive spawn.
- **Non-goals:** no production sandbox and no GitHub.
- **Dependencies:** E02, E09, E10, E19, E67, E78, E79.
- **Unlocks:** E21, E23.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** one `LaunchPermitId` authorizes exactly one `RoleRunRecord`; permits cannot be reused; generic subagent is unavailable; writer and model drift fail closed.
- **Stop boundary:** role runs operate only on fixtures until sandbox is complete.

## E21 — Sandbox backend capability spike

- **Goal:** Select and prove the default macOS sandbox backend and its enforceable isolation boundary.
- **Deliverables:** Docker/Colima/Podman comparison; capability probe; network/mount/secret escape tests; accepted implementation ADR.
- **Task outline:** test candidate runtimes; verify mount isolation; verify env clearing; verify network policy; document selected backend/fallback.
- **Non-goals:** no full verification framework.
- **Dependencies:** E01, E15, E16.
- **Unlocks:** E22.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** selected backend satisfies required controls or the Initiative records a blocked capability; no silent host fallback.
- **Stop boundary:** spike changes no production workflow behavior.

## E22 — Sandbox Runner and jailed Dev tools

- **Goal:** Execute sandbox process lifecycle under an approved backend and enforce mount, environment, network, and resource isolation.
- **Deliverables:** Sandbox interface/backend; prepare/exec/cancel/destroy; env/network/resource policy; process cleanup.
- **Task outline:** prepare and destroy sandbox; mount Unit only; clear secrets; apply limits; enforce cancellation; test network and host-path isolation.
- **Non-goals:** no Dev file-tool API and no layered Verification Profiles.
- **Dependencies:** E16, E17, E19, E21, E67.
- **Unlocks:** E23, E31.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** sandbox cannot read user secrets or other worktrees; host mode requires explicit policy; process timeout and cancellation are recoverable.
- **Stop boundary:** backend can be disabled without enabling host execution.

## E23 — Verification Contract and governed profile policy

- **Goal:** Define Task/Unit/GitHub/Epic/Initiative gate contracts and governed `fast`, `standard`, `strict`, and custom profile floors.
- **Deliverables:** gate schemas; profile inheritance; risk floor rules; escalation/downgrade policy.
- **Task outline:** define gate types; define profile matrix; implement risk-floor resolver; implement automatic escalation; implement governed downgrade request.
- **Non-goals:** no command execution, evidence persistence, cache, or GitHub check ingestion.
- **Dependencies:** E07, E19, E22.
- **Unlocks:** E27, E28, E31.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** a requested profile below the repository/risk floor is rejected; risk paths escalate automatically; downgrade requires a governed Policy Migration and explicit reduced assurance.
- **Stop boundary:** policy evaluation is pure and executes no repository command.

## E24 — Pi V2 entity navigation and Product Session client

- **Goal:** Make the main Pi session a Portfolio/Initiative/Epic product workspace that connects to `workflowd` without owning BUILD.
- **Deliverables:** V2 extension entry; entity navigation; session switch/rebind; read-only status and Inbox shell; V1/V2 scope guard.
- **Task outline:** connect client; add portfolio/initiative/epic navigation; acquire attachment lease; switch runtime session; add generation guard.
- **Non-goals:** no full Dashboard and no V1 cutover.
- **Dependencies:** E06, E13, E18, E41.
- **Unlocks:** E25, E32.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** user navigates by entity ID/title, not session path; BUILD test Job does not block product interaction; V1 work is read-only to V2; Product AI cannot impersonate a human approval principal.
- **Stop boundary:** V2 extension remains opt-in.

## E25 — Document Bundle and deterministic HTML renderer

- **Goal:** Generate immutable Charter/PRD bundles whose exact HTML is human-readable and approval-bindable.
- **Deliverables:** Markdown source; structured JSON schema; sanitized HTML; manifest; draft/approved watermark.
- **Task outline:** define schemas; implement renderer; sanitize/CSP; hash bundle; test deterministic rebuild and unsafe HTML.
- **Non-goals:** no GitHub Pages publication.
- **Dependencies:** E07.
- **Unlocks:** E26, E33.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** any source/JSON/HTML/renderer change alters manifest; approved bundle cannot be overwritten; unsafe script is removed.
- **Stop boundary:** local HTML remains usable if publishing is absent.

## E26 — Product approval flow using HTML manifest

- **Goal:** Connect Product Session approval to exact Document Bundle, Beads readback, and Epic eligibility.
- **Deliverables:** preview command; human approval command; pending governance Saga; session checkpoint; approved manifest binding.
- **Task outline:** generate preview; display/open HTML; submit approval; write Beads marker; confirm projection; block mismatched draft.
- **Non-goals:** no GitHub Docs publication.
- **Dependencies:** E13, E18, E24, E25, E41, E47, E58, E70, E73, E74.
- **Unlocks:** first formal V2 approved Epic flow.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** user approves the exact HTML manifest through a trusted client human-presence grant; Product AI/Worker cannot mint or replay that grant; Beads failure prevents eligibility; Pages availability is irrelevant to approval validity.
- **Stop boundary:** approval can remain V2-only without changing V1.

## E27 — GitHub capability and credential spike

- **Goal:** Prove GitHub App/OAuth capabilities for target repositories, auto-merge, merge queue, review threads, and private Docs publication.
- **Deliverables:** capability probe; least-privilege matrix; private Pages fallback decision; accepted GitHub integration ADR.
- **Task outline:** test authentication modes; inspect permissions; test API surfaces; test Pages visibility; document blocked/manual fallbacks.
- **Non-goals:** no production PR Broker.
- **Dependencies:** E06, E15, E46.
- **Unlocks:** E28, E29.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** required capabilities are known before implementation; sensitive Docs never default public; token never enters Agent context.
- **Stop boundary:** uses test repositories and reversible credentials only.

## E28 — GitHub read-model and reconciliation core

- **Goal:** Converge repository, PR, review, and check projections through read-only REST/GraphQL reconciliation.
- **Deliverables:** repository/PR query client; polling reconciler; webhook-trigger deduplication; rate-limit/backoff; durable cursors.
- **Task outline:** integrate Octokit reads; implement polling; dedupe triggers; persist cursors; test rate limits and missed webhook recovery.
- **Non-goals:** no credential storage implementation, branch push, PR creation, review repair, or merge.
- **Dependencies:** E05, E15, E19, E27, E46.
- **Unlocks:** E29, E30, E33.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** polling alone converges; duplicate webhooks do not duplicate events; insufficient permissions block before BUILD.
- **Stop boundary:** read-only GitHub capability first.

## E29 — Pull request branch push and idempotent publish

- **Goal:** Push one Unit branch and create or adopt exactly one GitHub PR.
- **Deliverables:** controlled branch push; stable PR marker; PR lookup/adoption; Node ID binding; crash recovery.
- **Task outline:** validate local/remote SHA; push branch; search by head/marker; create when absent; adopt after crash; persist authoritative binding.
- **Non-goals:** no required-check evaluation, base refresh, auto-merge, feedback loop, or merge queue.
- **Dependencies:** E13, E16, E23, E28.
- **Unlocks:** E30, E31, E34.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** PR creation crash does not duplicate; remote SHA mismatch is detected; only the exact Unit branch/marker can be adopted.
- **Stop boundary:** test-repository PR can be closed without requesting merge.

## E30 — Pull request review-feedback ingestion

- **Goal:** Convert review comments and check failures into idempotent classified repair or decision events.
- **Deliverables:** review/thread cursor; feedback classification; one repair `RoleRunRecord` request per governed repair action; product/security escalation.
- **Task outline:** consume new threads; classify code/product/security/non-blocking feedback; dedupe by external ID; request repair or Inbox decision; preserve human resolution authority.
- **Non-goals:** no external commit adoption, force-push handling, merge queue, or auto-merge.
- **Dependencies:** E20, E28, E29.
- **Unlocks:** E31, E34.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** comments are not double-consumed; human blocking threads are not auto-resolved; product/security scope changes route to the correct Inbox.
- **Stop boundary:** feedback ingestion can be disabled while the PR remains visible.

## E31 — Third walking skeleton: real bounded Epic to merged PR

- **Goal:** Run a real Single-Epic V2 flow through approved PRD, Lead, Dev/Reviewer, sandbox, verification, PR, one feedback cycle, and merge.
- **Deliverables:** integration fixture; full audit chain; recovery checkpoint; report of active Product Session responsiveness.
- **Task outline:** approve fixture PRD; schedule; execute task; review/fix; publish PR; inject feedback; merge and run Epic Gate.
- **Non-goals:** no Docs Pages, Dashboard, release, observation, or V1 cutover.
- **Dependencies:** E14, E20, E22, E23, E26, E29, E30, E45, E48, E49, E54, E57, E72, E82, E83.
- **Unlocks:** proves core delivery before UX and release completion.
- **Active time:** `2h` plus external wait.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** Product Session remains usable; no duplicate effects after one injected Worker restart; merged state reconciles across Beads/SQLite/GitHub.
- **Stop boundary:** dedicated test repository only.

## E32 — Portfolio Docs repository and GitHub Pages publisher

- **Goal:** Publish approved bundles into a Portfolio Docs repository and expose safe HTML URLs with visibility enforcement.
- **Deliverables:** directory convention; Docs PR/publish Saga; Pages status/preview; private/local fallback.
- **Task outline:** build site map; publish branch; create/adopt Docs PR; reconcile Pages; enforce visibility; link exact manifest.
- **Non-goals:** no real-time Runtime Dashboard.
- **Dependencies:** E25, E27, E28.
- **Unlocks:** E33, E35.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `standard`.
- **Acceptance:** Pages failure does not invalidate PRD; private policy cannot publish public; URL resolves to exact manifest.
- **Stop boundary:** local rendered HTML remains fallback.

## E33 — Local Dashboard query API and durable event stream

- **Goal:** Expose Portfolio/Initiative/Epic read models and resumable events through a localhost-only API.
- **Deliverables:** HTTP query API; SSE/WebSocket event cursor; Origin/Host enforcement; protocol mapping.
- **Task outline:** map read queries; implement event stream; resume from cursor; reject non-local hosts/origins; test disconnect/replay.
- **Non-goals:** no human authentication bootstrap, CSRF mutation path, Inbox commands, or visual UI.
- **Dependencies:** E06, E13, E14, E24, E28, E50.
- **Unlocks:** E34, E35.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** non-local hosts/origins are rejected; disconnected clients resume from a durable cursor; API performs no mutation without the separate trusted-principal command path.
- **Stop boundary:** API remains localhost-only.

## E34 — Portfolio Dashboard overview

- **Goal:** Provide a visual Portfolio overview for Initiative health, running/queued Epics, capacity, budget, and Critical/Decision counts.
- **Deliverables:** Portfolio page; Initiative list; capacity/budget widgets; event-driven refresh; Docs/GitHub navigation.
- **Task outline:** select UI stack; build overview data client; render portfolio cards; render capacity/budget; handle event refresh.
- **Non-goals:** no full Epic detail, dependency editor, Inbox mutation, release/observation detail, or audit explorer.
- **Dependencies:** E32, E33, E51.
- **Unlocks:** final user experience and E2E.
- **Active time:** `2h`; split further if readiness predicts more.
- **Delivery Units:** 1.
- **Verification Profile:** `standard`.
- **Acceptance:** all `needs-decision` and `critical` counts are discoverable from the overview; state matches Pi TUI; Dashboard remains read-only until trusted Inbox commands are implemented.
- **Stop boundary:** Pi client remains fully functional if Dashboard is unavailable.

## E35 — Release Adapter framework

- **Goal:** Execute and reconcile releases through versioned allowlisted adapters without exposing credentials to Agents.
- **Deliverables:** adapter contracts; registry; Manual adapter; GitHub Actions adapter; release operation Saga and lease.
- **Task outline:** define API; validate adapter policy; implement manual path; implement GitHub Actions path; inject timeout/unknown.
- **Non-goals:** no metric observation or vendor-specific feature flags beyond contract stubs.
- **Dependencies:** E05, E08, E19, E28, E80.
- **Unlocks:** E36, E39.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** timeout reconciles before retry; repository cannot load arbitrary production extension; operation ID prevents duplicate release.
- **Stop boundary:** Manual adapter remains safe baseline.

## E36 — Observation, outcome, and pre-authorized rollback

- **Goal:** Evaluate release outcomes from authoritative samples and execute only approved reversible rollback actions.
- **Deliverables:** Observation Adapter contract; manual acceptance; deterministic threshold evaluator; rollback Saga; Critical escalation.
- **Task outline:** define metric samples; implement evaluator; implement manual adapter; implement rollback authorization; test failed rollback.
- **Non-goals:** no broad vendor integration catalog.
- **Dependencies:** E07, E35, E81.
- **Unlocks:** E39.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** AI explanation cannot change samples; unauthorized irreversible rollback pauses; rollback result is re-verified.
- **Stop boundary:** external operations use test/manual adapters.

## E37 — V1 state inspector and historical importer

- **Goal:** Inspect V1 `.workflow`/Beads/Git evidence and import safe PLAN or historical work into V2 without claiming V2 guarantees.
- **Deliverables:** read-only inspector; evidence classifier; stable import IDs; Single-Epic Initiative import plan.
- **Task outline:** parse V1 state; inspect Beads children; inspect commits/artifacts; classify trust; implement idempotent historical import.
- **Non-goals:** no active BUILD migration.
- **Dependencies:** E07, E12, E18, E19.
- **Unlocks:** E38.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** inspection is read-only; missing evidence is explicit; repeated import does not duplicate business entities.
- **Stop boundary:** imported records remain non-executing until separately approved.

## E38 — V1/V2 atomic generation cutover

- **Goal:** Transfer one Initiative's mutation authority from V1 to V2 with Beads-confirmed generation guards and rollback on incomplete migration.
- **Deliverables:** migration lease; V1/V2 bidirectional guards; authority Saga; safe rollback; V1 artifact viewer.
- **Task outline:** freeze V1; export snapshot; validate safe boundary; write/readback generation; enable V2; inject failures between stages.
- **Non-goals:** no automatic migration of active V1 BUILD.
- **Dependencies:** E13, E24, E29, E37.
- **Unlocks:** E39, E40.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** no instant has two mutation authorities; failed migration leaves prior authority intact; V1 rejects V2 marker.
- **Stop boundary:** migration is performed only on dedicated fixtures until final acceptance.

## E39 — Local recovery regression matrix aggregator

- **Goal:** Combine independently proven local fault families into one repeatable Runtime recovery gate.
- **Deliverables:** generated local recovery matrix; unified regression command; cross-family audit assertions.
- **Task outline:** import E60–E62 fixtures; generate matrix; run aggregate suite; verify common invariants; publish report.
- **Non-goals:** no new fault injector and no external-authority failures.
- **Dependencies:** E60, E61, E62.
- **Unlocks:** E40.
- **Active time:** `1h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** the aggregate command proves no stale writer, false Step completion, duplicate local commit, or unaudited recovery across all local families.
- **Stop boundary:** matrix only references fixture suites.

## E40 — Real GitHub V2 end-to-end and default-enable gate

- **Goal:** Demonstrate the complete V2 product outcome and establish evidence for making new Initiatives default to V2.
- **Deliverables:** real test Initiative; HTML approval; bounded Epic delivery; PR feedback; auto-merge; Docs; release/observation; second simultaneous PRD session; final report.
- **Task outline:** create Initiative; approve Charter/PRD; execute Epic; inject feedback/restart; merge; publish docs; observe outcome; verify parallel product work.
- **Non-goals:** no production repository or production credential.
- **Dependencies:** E31, E32, E34, E36, E38, E39, E52, E53, E55, E56.
- **Unlocks:** new-Initiative V2 default; later V1 mutation retirement.
- **Active time:** `2h` plus external wait and observation.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** Product Session remains free throughout BUILD; Beads/SQLite/GitHub/Docs converge; daemon/worker restart recovers; no V1/V2 double write.
- **Stop boundary:** dedicated test repositories and reversible resources only.

## E41 — Trusted client principals and human-presence approval grants

- **Goal:** Make human approval cryptographically and procedurally distinct from model- or Worker-submitted commands.
- **Deliverables:** server-issued principals; connection capability binding; single-use human-presence grant; approval audit.
- **Task outline:** authenticate Pi/Worker/internal connections; issue principal context; implement trusted confirmation nonce; bind grant to command/document/version; test replay and impersonation.
- **Non-goals:** no Product approval flow or Dashboard UI.
- **Dependencies:** E03, E06.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** caller-supplied human actor is ignored/rejected; Product AI and Worker cannot mint, replay, or consume a human grant; audit identifies principal and grant.
- **Stop boundary:** no governance command is enabled until this boundary exists.

## E42 — Controlled Git commit broker

- **Goal:** Create exactly one validated local implementation commit without giving Dev general Git mutation.
- **Deliverables:** diff intake; file-scope validation; commit message/trailers; commit/result artifact.
- **Task outline:** receive implementation intent; validate lease/worktree/diff; reject forbidden files; create commit; record SHA and trailers.
- **Non-goals:** no worktree creation, cleanup, push, or PR.
- **Dependencies:** E10, E16, E19.
- **Active time:** `1.5h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** commit binds Job/Unit/Task/`TaskAttemptId`/PRD; unknown or out-of-scope diff fails; duplicate operation adopts existing commit.
- **Stop boundary:** fixture branch only.

## E43 — Worktree cleanup and orphan recovery

- **Goal:** Safely retain, recover, or remove managed worktrees after completion, failure, or worker loss.
- **Deliverables:** dirty/orphan classifier; cleanup preconditions; recovery hold; prune audit.
- **Task outline:** classify clean/dirty/orphan; verify no active lease/process; preserve unknown work; remove safe worktree; test interrupted cleanup.
- **Non-goals:** no branch push or GitHub deletion.
- **Dependencies:** E10, E16, E42.
- **Active time:** `1.5h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** unknown dirty work is never deleted; completed clean fixtures are removed idempotently; cleanup is auditable.
- **Stop boundary:** cleanup can be disabled while retaining worktrees.

## E44 — Jailed Dev file and command tools

- **Goal:** Expose Dev-readable and writable tools only through the Unit path jail and Sandbox Runner.
- **Deliverables:** jailed read/edit/write/search; sandboxed command proxy; symlink/TOCTOU defenses; tool audit.
- **Task outline:** implement canonical path resolver; wrap file operations; route commands to sandbox; protect forbidden paths; test escape races.
- **Non-goals:** no role Permit or verification policy.
- **Dependencies:** E16, E22.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** host builtin mutation tools are absent; every file/command action remains inside the Unit boundary and is audited.
- **Stop boundary:** tools remain fixture-only until role integration.

## E45 — Verification execution, evidence, and cache

- **Goal:** Execute frozen verification gates in sandbox and register immutable, safely reusable evidence.
- **Deliverables:** argv executor; evidence manifest; gate cache key; output artifact; failure semantics.
- **Task outline:** resolve gate/profile; run sandbox command; capture bounded output; hash evidence; implement exact-input cache; test invalidation.
- **Non-goals:** no profile authoring or GitHub required-check ingestion.
- **Dependencies:** E07, E22, E23, E44.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** Agent text cannot override failure; changed HEAD/policy/image/gate invalidates evidence; exact successful inputs may reuse cache.
- **Stop boundary:** only local fixture gates execute.

## E46 — General credential broker and secret references

- **Goal:** Resolve least-privilege credentials for GitHub and adapters without storing or exposing plaintext secrets to Agents or Runtime artifacts.
- **Deliverables:** credential reference schema; OS Keychain provider; scoped retrieval API; access audit; revocation handling.
- **Task outline:** define references; integrate Keychain abstraction; bind callers/scopes; inject ephemeral credentials to brokers; test denial and revocation.
- **Non-goals:** no GitHub-specific API behavior and no release adapter.
- **Dependencies:** E04, E06, E41.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** plaintext secrets never enter SQLite/session/artifact/model context; unauthorized principal requests fail; access is auditable.
- **Stop boundary:** test credentials only.

## E47 — Beads remote-durability policy ADR and capability probe

- **Goal:** Decide and prove when local governance confirmation must be remotely durable before execution or delivery.
- **Deliverables:** `local-confirmed`/`remote-before-execution`/`remote-before-delivery` comparison; remote capability probe; accepted ADR; blocked-state semantics.
- **Task outline:** inspect current Dolt remote behavior; test push/pull conflict; model offline behavior; choose default; define policy schema.
- **Non-goals:** no broad multi-machine executor support.
- **Dependencies:** E12, E13.
- **Active time:** `1.5h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** the durability milestone is explicit and tested; failure cannot be silently ignored.
- **Stop boundary:** spike does not change existing V1 sync policy.

## E48 — GitHub merge-readiness and auto-merge request

- **Goal:** Advance a published PR through base refresh, required checks/reviews, and policy-compliant auto-merge request.
- **Deliverables:** readiness evaluator; short integration lease cycle; reverify/push; auto-merge enablement; authoritative merge confirmation.
- **Task outline:** inspect base/checks/reviews; acquire integration lease; update/reverify/push; release lease; enable auto-merge; reconcile merged OID.
- **Non-goals:** no feedback classification, external commit adoption, or merge queue groups.
- **Dependencies:** E23, E28, E29, E45.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** integration lease is not held during GitHub wait; branch protection is never bypassed; only GitHub confirms merge.
- **Stop boundary:** test PR only.

## E49 — External commit, force-push, and merge-queue handling

- **Goal:** Reconcile human/bot commits and merge groups without inheriting stale evidence.
- **Deliverables:** external commit attribution; evidence invalidation; adoption flow; force-push alert; merge-group projection.
- **Task outline:** compare known/current HEAD; classify origin; invalidate/review; detect rewritten history; reconcile merge queue checks.
- **Non-goals:** no ordinary review-comment classification.
- **Dependencies:** E28, E29, E45, E48.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** external commits always trigger revalidation; unsafe force-push pauses; merge-group state cannot be confused with PR-head state.
- **Stop boundary:** automation may pause and leave PR human-visible.

## E50 — Local Dashboard authentication and mutation channel

- **Goal:** Bind browser sessions to trusted principals and protect mutation commands from localhost cross-origin attacks.
- **Deliverables:** one-time bootstrap token; secure cookie; CSRF; Origin/Host checks; human-presence confirmation integration.
- **Task outline:** create bootstrap flow; issue browser principal; implement CSRF; enforce allowed origin/host; test malicious local web page.
- **Non-goals:** no query pages or Inbox business logic.
- **Dependencies:** E06, E41.
- **Active time:** `1.5h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** same-UID/localhost access alone cannot forge human approval; expired/replayed tokens fail.
- **Stop boundary:** Dashboard can remain disabled.

## E51 — Inbox routing and governed decision application

- **Goal:** Route Epic, Initiative, Portfolio, and Critical decisions to the correct workspace and apply only trusted, versioned responses.
- **Deliverables:** Inbox lifecycle; scope router; decision commands; conflict refresh; Product Session notification.
- **Task outline:** define item schema; route by scope/severity; acknowledge/decide/apply; validate grant/version; test duplicate and stale responses.
- **Non-goals:** no visual Dashboard detail page.
- **Dependencies:** E13, E24, E33, E41, E50.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** ordinary events do not interrupt unrelated sessions; Critical events do; AI cannot self-approve an Inbox item.
- **Stop boundary:** Pi TUI remains the baseline decision client.

## E52 — Dashboard Initiative/Epic detail and audit views

- **Goal:** Add detailed dependency, PR, release, outcome, Inbox, and audit views after the Portfolio overview exists.
- **Deliverables:** Initiative graph; Epic/Unit detail; Inbox action UI; release/outcome panel; audit timeline.
- **Task outline:** render dependency graph; build detail queries; integrate trusted commands; render evidence links; test stale-version refresh.
- **Non-goals:** no AI chat or remote access.
- **Dependencies:** E32, E34, E35, E36, E51.
- **Active time:** `2h`; split at readiness if the selected UI stack cannot meet the budget.
- **Delivery Units:** 1.
- **Verification Profile:** `standard`.
- **Acceptance:** detail state matches Runtime; stale decisions do not overwrite; every displayed approval/effect links to authority evidence.
- **Stop boundary:** Portfolio overview and Pi client remain usable without detail views.

## E53 — External-authority recovery matrix aggregator

- **Goal:** Combine independently proven Beads, GitHub/Docs, release/observation, and migration fault families into one external Saga gate.
- **Deliverables:** generated authority matrix; unified external-fault regression command; duplicate-effect assertions.
- **Task outline:** import E63–E66 fixtures; generate matrix; run aggregate suite; verify authority-specific confirmation; publish report.
- **Non-goals:** no new fault injector and no local Worker/SQLite/session faults.
- **Dependencies:** E63, E64, E65, E66.
- **Active time:** `1h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** unknown effects reconcile before retry and the aggregate suite proves no duplicate approval, PR, release, or migration authority transition.
- **Stop boundary:** matrix only references test providers and fixture suites.

## E54 — Delivery Plan and Beads Task/Unit lifecycle

- **Goal:** Turn an approved Delivery Plan into Repository Beads Units/Tasks and close them only after commit, review, and verification evidence.
- **Deliverables:** plan manifest; feature/task/dependency creation; claim; pass/fail/reopen; Unit completion reconciliation.
- **Task outline:** validate plan; create feature/tasks; add `blocks`; claim with baseline; bind the causal `TaskAttemptId` evidence; close/reopen; reconcile Unit completion.
- **Non-goals:** no PR publish or product approval.
- **Dependencies:** E12, E13, E20, E42, E45, E78, E79.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** no task closes without accepted commit, independent review, and required gate evidence; retries retain history; parent/blocks semantics are correct.
- **Stop boundary:** fixture Repository Beads only.

## E55 — Pause, cancellation, and Termination Plan

- **Goal:** Stop future work safely and produce a governed disposition plan for worktrees, PRs, merged code, releases, and dependencies.
- **Deliverables:** pause/cancel commands; scheduling/merge/release stops; impact collector; Termination Plan bundle; decision application.
- **Task outline:** freeze new work; inspect Units/PRs/releases/dependencies; render options; obtain human decision; execute only approved disposition.
- **Non-goals:** no automatic destructive revert or data compensation engine.
- **Dependencies:** E13, E14, E43, E48, E35, E51, E71, E72, E78, E80, E82.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** cancel never silently deletes or reverts; open effects are enumerated; destructive action requires a fresh human grant.
- **Stop boundary:** cancellation may stop after producing the plan.

## E56 — Sensitive artifact redaction, access, and retention enforcement

- **Goal:** Prevent secrets and sensitive thinking/log content from leaking through artifacts, Dashboard, or Docs and enforce retention policy.
- **Deliverables:** redaction pipeline; access classes; retention/deletion jobs; secret scanning; safe export policy.
- **Task outline:** classify artifacts; redact known secret patterns; enforce readers; implement expiry/deletion; test Dashboard/Docs export denial.
- **Non-goals:** no credential retrieval, which belongs to E46.
- **Dependencies:** E07, E41, E46.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** plaintext credentials and default full thinking cannot be published; retention actions are auditable; authority evidence needed for governance is not prematurely deleted.
- **Stop boundary:** retention deletion begins in dry-run/report mode.

## E57 — Engineering Lead analysis, change, CI, conflict, and publish tools

- **Goal:** Complete the Engineering Lead's delivery and escalation tool surface beyond Dev/Reviewer execution and the early read-only readiness analyzer.
- **Deliverables:** `diagnose_ci_failure`; `analyze_merge_conflict`; `request_change`; `request_publish`.
- **Task outline:** define contracts; issue read-only permits; route CI/conflict evidence; submit governed change intent; submit publish intent; test illegal direct effects.
- **Non-goals:** no generic subagent or GitHub mutation tool.
- **Dependencies:** E20, E28, E29, E30, E45, E67, E72, E75, E78, E79.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** tools create proposals/permits only; Lead cannot directly approve Change Requests, push, merge, or alter lifecycle state.
- **Stop boundary:** each tool can be disabled independently by policy.

## E58 — Bounded Epic Readiness Gate

- **Goal:** Produce an authoritative `READY`, `NEEDS_REFINEMENT`, `MUST_DECOMPOSE`, or `BLOCKED` decision before PRD approval can create eligibility.
- **Deliverables:** semantic-invariant evaluator; quantitative budget/risk score; read-only Lead feasibility review; exception record; readiness artifact.
- **Task outline:** validate single result/acceptance/rollback; calculate size/risk budget; run repository feasibility permit; combine evidence; persist decision and exception.
- **Non-goals:** no implementation task split or scheduler allocation.
- **Dependencies:** E12, E19, E25, E59, E70.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** semantic violation cannot be force-approved; estimated >4h yields decomposition; approved Epic eligibility requires exact readiness artifact and PRD manifest.
- **Stop boundary:** readiness is read-only and cannot mutate code.

## E59 — Read-only repository feasibility permit and analyzer

- **Goal:** Give Readiness Review a bounded, read-only way to inspect the actual registered repository before approval.
- **Deliverables:** feasibility Permit; `analyze_codebase`/`readiness_review` role tool; read-only capability ceiling; structured feasibility artifact.
- **Task outline:** define permit; bind repository/base/PRD; expose read/search-only tools; run analyzer; validate model/tool/output audit.
- **Non-goals:** no Dev/Reviewer, no task split, no code mutation, no GitHub delivery.
- **Dependencies:** E09, E10, E15, E19, E20.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** analyzer cannot mutate code/Beads/GitHub; each analysis uses exactly one E20 `RoleRunRecord` and one-time `LaunchPermit` with current fencing token, expiry, Worker generation, fixed input/output, and recovery audit; result binds exact PRD/base/policy.
- **Stop boundary:** analysis is advisory evidence consumed only by E58.

## E60 — Daemon, SQLite, command, Lease, and Step fault family

- **Goal:** Prove deterministic recovery for control-plane persistence and fencing failures.
- **Deliverables:** daemon-restart, command-replay, SQLite checkpoint, lease-expiry, and Step-transition fault fixtures.
- **Task outline:** inject daemon death; replay commands; interrupt Step transaction; expire/regrant lease; assert event and projection recovery.
- **Non-goals:** no Worker session or Git worktree faults.
- **Dependencies:** E05, E08, E10.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** no stale mutation, duplicate command effect, or false Step completion; fencing remains monotonic.
- **Stop boundary:** local Runtime fixtures only.

## E61 — Worker, Lead session, Permit, and subagent fault family

- **Goal:** Prove replacement and recovery when Worker/Lead/role execution fails independently of local Git effects.
- **Deliverables:** Worker kill, session truncation, permit-consumption, subagent abort, and generation-handoff fixtures.
- **Task outline:** kill Worker during run; corrupt session tail; retry consumed permit; abort subagent; replace Lead generation; verify audit.
- **Non-goals:** no commit/worktree or external authority faults.
- **Dependencies:** E09, E10, E18, E20.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** replacement Worker cannot reuse stale permit; E18's actual bound JSONL corruption path produces a new recovery generation; role result is adopted or discarded explicitly.
- **Stop boundary:** no repository mutation fixture.

## E62 — Worktree, commit, and cleanup fault family

- **Goal:** Prove recovery for dirty worktrees, commit-before-checkpoint crashes, orphaned processes, and interrupted cleanup.
- **Deliverables:** Git/worktree fault injector; commit adoption tests; dirty hold; cleanup resume report.
- **Task outline:** crash after commit; leave dirty uncommitted diff; orphan process; interrupt cleanup; verify adopt/retain/remove outcomes.
- **Non-goals:** no GitHub push/PR or Beads approval failures.
- **Dependencies:** E10, E16, E42, E43.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** commits are not duplicated; dirty unknown work is retained; cleanup never removes active or unaudited state.
- **Stop boundary:** fixture repositories only.

## E63 — Beads governance Saga fault family

- **Goal:** Prove approval and generation authority across Beads write/readback, local confirmation, remote-durability, and SQLite crash boundaries.
- **Deliverables:** Beads-write/SQLite-crash fixture; readback mismatch; sync failure; marker adoption; governance recovery report.
- **Task outline:** inject after write; inject before readback; alter metadata concurrently; fail configured durability milestone; reconcile and assert authority.
- **Non-goals:** no GitHub or migration cutover faults.
- **Dependencies:** E13, E47.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** unconfirmed governance never becomes effective; confirmed markers are adopted exactly once; durability policy is enforced.
- **Stop boundary:** isolated Portfolio/Repository Beads fixtures.

## E64 — GitHub and Docs external-effect fault family

- **Goal:** Prove idempotent recovery for push, PR, webhook, force-push, merge queue, Docs PR, and Pages failures.
- **Deliverables:** GitHub/Docs test-provider faults; operation adoption; evidence invalidation assertions; recovery report.
- **Task outline:** crash after PR create; duplicate webhook; alter branch externally; rewrite history; fail Pages publish; reconcile exact authority state.
- **Non-goals:** no release/observation or Beads faults.
- **Dependencies:** E28, E29, E30, E32, E48, E49.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** no duplicate PR/Docs publication; stale evidence is invalidated; GitHub remains authoritative after every injection.
- **Stop boundary:** test repositories only.

## E65 — Release and observation external-effect fault family

- **Goal:** Prove reconciliation for release timeout, unknown status, duplicate callback, observation drift, and rollback failure.
- **Deliverables:** adapter fault fixtures; operation adoption; metric integrity assertions; Critical escalation report.
- **Task outline:** timeout release; replay callback; return unknown; alter observation sequence; fail rollback; reconcile before retry.
- **Non-goals:** no GitHub/Docs or migration faults.
- **Dependencies:** E35, E36.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** release is never blindly replayed; raw samples remain immutable; failed rollback becomes Critical.
- **Stop boundary:** manual/test adapters only.

## E66 — V1/V2 migration fault family

- **Goal:** Prove that every cutover interruption leaves exactly one authoritative Runtime generation.
- **Deliverables:** migration-stage fault injector; V1/V2 guard assertions; rollback/recovery report.
- **Task outline:** interrupt freeze; interrupt export; fail generation write/readback; restart after marker; attempted dual mutation; recover prior/new authority.
- **Non-goals:** no ordinary Beads approval or GitHub delivery faults.
- **Dependencies:** E38.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** no fault permits dual mutation; incomplete migration preserves prior authority; completed marker blocks V1.
- **Stop boundary:** migration fixtures only.

## E67 — Permission Backend qualification

- **Goal:** Qualify a bounded in-session PermissionBackend PEP using S1/S1.1 evidence and formal contract, integrator, provenance, operator-ceiling, and fault gates.
- **Deliverables:** versioned PermissionBackend SPI mapping; immutable operator-ceiling tests; session overlay precedence tests (`deny > ask > allow`, including MCP candidates); hard-deny terminal tests; provenance/artifact manifest; fault and drift report; accepted qualification record or explicit rejection.
- **Task outline:** pin candidate implementation(s); run S1 source/boundary review; run S1.1 dynamic probes for allow/ask/deny, missing backend, version drift, replay, cancellation, and malformed decisions; integrate through Runtime-issued requests; hash logs/results; verify no authority escape; record adopt/adapt/reference/reject outcome.
- **Non-goals:** no sandbox implementation; no project/session/yolo widening of the operator ceiling; no approval, Beads, Git, GitHub, credential, evidence, or scheduler authority; no claim that a source review is a passing qualification.
- **Dependencies:** E03, E06, E07, E09, E10, E12.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** only a pinned, reproducible candidate with complete contract, integrator, provenance, and fault evidence may be marked `QUALIFIED`; missing backend, unsupported capability, provenance mismatch, or version drift fails closed; hard deny is terminal; an unqualified candidate is disabled rather than silently replaced.
- **Stop boundary:** qualification fixtures and in-session PEP only; it cannot authorize repository process isolation or external effects.

## E68 — Native SQLite versus durable backend spike

- **Goal:** Compare native SQLite WAL plus the V2 Step Ledger with Temporal, Restate, DBOS TypeScript (`dbos-transact-ts`, PostgreSQL-backed), and Hatchet durable execution patterns behind `DurableExecutionBackend`.
- **Deliverables:** capability and authority comparison; recovery/idempotency/fencing probes; cost and operational notes; accepted durable-backend decision record or documented native-only result.
- **Task outline:** pin candidate sources; run S1 source review; run S1.1 restart, timer, cancellation, duplicate-effect, unknown-effect, and schema/version probes; compare artifact/hash and operational evidence; recommend native, adapt, or reject. No provider is presumed selected.
- **Non-goals:** no replacement of SQLite, no production migration, no PostgreSQL dependency adopted by implication, no external engine owning domain transitions, Beads, GitHub, approval, or evidence authority.
- **Dependencies:** E01.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** comparison covers the RFC's Step Ledger, fencing, authority-aware Saga, and artifact hash invariants; missing or non-reproducible evidence is `BLOCKED`; research findings do not become implementation dependencies without an accepted ADR.
- **Stop boundary:** isolated benchmark/fault fixtures only; native SQLite remains the baseline pending a separate decision.

## E69 — Native worktree versus Gas Town workspace backend spike

- **Goal:** Compare the native managed mirror/worktree boundary with a narrowly adapted Gas Town workspace backend without weakening path jail, one-writer, branch, cleanup, or Git Broker authority.
- **Deliverables:** native-versus-adapter comparison; workspace SPI mapping; path/lease/dirty-state fault probes; accepted workspace decision record or a documented native-only result.
- **Task outline:** pin candidate source; run S1 source review; run S1.1 workspace probes; inject stale lease, symlink/path escape, dirty cleanup, crash, and duplicate preparation cases; record artifact manifests and SHA-256 hashes; recommend native, adapt, or reject.
- **Non-goals:** no Gas Town adoption by default; no scheduler, Beads, GitHub, approval, sandbox, or evidence authority delegation; no production workspace migration.
- **Dependencies:** E01.
- **Active time:** `2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.
- **Acceptance:** the selected option preserves the V2 WorkspaceBackend contract and authority boundaries; missing provenance or fault evidence is `BLOCKED`; a third-party workspace is never treated as a sandbox.
- **Stop boundary:** research fixtures only; native worktree remains the implementation baseline until an accepted ADR selects otherwise.
---

## E70 — Readiness and governance evidence

- **Goal:** Own immutable `ReadinessAssessment` and governance evidence used to qualify exact candidates without mutating Product authority.
- **Result:** applicability, disposition, freshness/staleness, source revisions, and eligibility evidence inputs with fail-closed qualification.
- **Scope:** Readiness records and evidence references; exact-candidate qualification; freshness/applicability rules; evidence-only projections.
- **Non-goals:** no Product/Approval, ChangeRequest, supersession, plan/preflight, Attention/Blocker, queue, Allocation, Scheduling, Engineering, Task/TaskAttempt, Delivery, Release, Outcome, closure, display, persistence, or external authority.
- **Dependencies:** E02.
- **Unlocks:** E71, E74, E77 (route notes only; `Dependencies` remains authoritative).
- **Acceptance:** readiness evidence is immutable, exact-candidate, applicable/fresh, and fails closed; no downstream mutation authority exists.
- **Stop boundary:** evidence package reverts without changing Product or external systems.
- **Active time:** `1.5-2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.

## E71 — Scheduling and Allocation

- **Goal:** Own eligibility-to-queue and Allocation decisions after governance qualification.
- **Result:** deterministic eligibility, queue disposition, capacity/budget inputs, and immutable `Allocation` facts with no Engineering authority.
- **Scope:** scheduling policy, queue transitions, capacity/conflict accounting, Allocation and lease-facing facts.
- **Non-goals:** no Readiness record ownership, Product/Approval, ChangeRequest, supersession, plan/preflight, Attention/Blocker, Engineering, Task/TaskAttempt, Delivery, Release, Outcome, closure, display, persistence, Worker launch, or third-party scheduler authority.
- **Dependencies:** E70, E74, E77.
- **Unlocks:** E14, E78 (route notes only; `Dependencies` remains authoritative).
- **Acceptance:** eligibility, queue, and Allocation remain separate and consume qualified evidence; no Engineering state is changed.
- **Stop boundary:** scheduling package reverts without leases, Worker launch, or external cleanup.
- **Active time:** `1.5-2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.

## E72 — Delivery facets

- **Goal:** Own provider-neutral Delivery facets and integration facts independently from Engineering, Release, and Outcome.
- **Result:** candidate, review, checks, mergeability, and integration facets with deterministic evidence and no provider authority delegation.
- **Scope:** Delivery facet identities, transitions, projections, and provider-observation references.
- **Non-goals:** no Product/Approval, ChangeRequest, supersession, plan/preflight, Readiness, Attention/Blocker, Scheduling/Allocation, Engineering/Task/TaskAttempt, Release, Outcome, closure, display, persistence, GitHub mutation, or external provider authority.
- **Dependencies:** E78, E79.
- **Unlocks:** E31, E80, E81 (route notes only; `Dependencies` remains authoritative).
- **Acceptance:** Delivery facets are independent and provider observations cannot become provider authority.
- **Stop boundary:** Delivery package reverts without release or provider compensation.
- **Active time:** `1.5-2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.

## E73 — Ordered plans and preflight

- **Goal:** Own explicit cross-dimension ordered transition plans and pure preflight without executing effects.
- **Result:** dependency-ordered, revision-bound plan schema with structural and speculative validation, stop-on-failure and compensation/reconciliation declarations.
- **Scope:** plan identity, steps, dependencies, authority classification, preconditions, failure policy, pure preflight, and no-effect diagnostics.
- **Non-goals:** no primitive kernel replacement, Product/Approval, ChangeRequest, supersession, Readiness, Attention/Blocker, Scheduling, Engineering, Task/TaskAttempt, Delivery, Release, Outcome, closure, display, persistence, Runtime Saga, authorization, or external effect.
- **Dependencies:** E02.
- **Unlocks:** E74, E75, E82 (route notes only; `Dependencies` remains authoritative).
- **Acceptance:** preflight validates structure/revisions/speculative domain steps and produces no effect or authorization.
- **Stop boundary:** plan package reverts without persisted plan execution or external cleanup.
- **Active time:** `1.5-2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.

## E74 — Product lifecycle and Approval

- **Goal:** Own Portfolio/Product lifecycle and immutable initial `ApprovalAttempt` governance while consuming Readiness qualification.
- **Result:** Product transition matrices, frozen approval submissions, and approval decisions that never schedule or execute work.
- **Scope:** Portfolio administrative lifecycle; Initiative/Epic Product lifecycle; immutable ApprovalAttempt records; applicable Readiness handoff; approval history.
- **Non-goals:** no E02 kernel replacement, ChangeRequest, supersession, plan execution, Scheduling/Allocation, Attention/Blocker, Engineering/Task/TaskAttempt, Delivery, Release, Outcome, closure, display, persistence, or external grant authority.
- **Dependencies:** E70, E73, E76.
- **Unlocks:** E26, E71, E75 (route notes only; `Dependencies` remains authoritative).
- **Acceptance:** Product/Approval matrices preserve frozen history; approval never queues, allocates, or activates work.
- **Stop boundary:** Product/Approval package reverts without scheduling or external grant cleanup.
- **Active time:** `1.5-2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.

## E75 — ChangeRequest lifecycle

- **Goal:** Own the full governed lifecycle of changes to an approved Product baseline.
- **Result:** legal ChangeRequest transition matrix with baseline preservation and explicit application handoff.
- **Scope:** ChangeRequest records using the E02-owned `ChangeRequestId` seam; draft/proposed/awaiting-approval/approved/applying/applied and terminal rejection/withdrawal/supersession/application-failed edges; approved→applying and applying→applied plan primitives.
- **Non-goals:** no Product/Approval authority, supersession relation ownership, E02 kernel replacement, plan engine, Readiness, Attention/Blocker, Scheduling, Engineering, Task/TaskAttempt, Delivery, Release, Outcome, closure, display, persistence, or same-store atomic commit.
- **Dependencies:** E73, E74, E76.
- **Unlocks:** E82 (route notes only; `Dependencies` remains authoritative).
- **Acceptance:** all legal ChangeRequest edges preserve the approved baseline until applied and have no implicit multi-aggregate primitive.
- **Stop boundary:** ChangeRequest package reverts without changing the approved baseline or external systems.
- **Active time:** `1.5-2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.

## E76 — Supersession

- **Goal:** Own explicit predecessor/successor relations without automatic authority or evidence inheritance.
- **Result:** acyclic, kind-compatible supersession records and dimension-local terminal transitions.
- **Scope:** supersession relation, legal edges, terminal states, successor compatibility, chain validation, and non-inheritance contract.
- **Non-goals:** no Product lifecycle implementation, ApprovalAttempt, ChangeRequest, plan/preflight, Readiness, Attention/Blocker, Scheduling, Engineering, Task/TaskAttempt, Delivery, Release, Outcome, closure, display, persistence, or authority transfer.
- **Dependencies:** E02.
- **Unlocks:** E74, E75, E78 (route notes only; `Dependencies` remains authoritative).
- **Acceptance:** supersession is explicit, compatible, acyclic, terminal, and transfers no authority/evidence.
- **Stop boundary:** supersession package reverts without rewriting predecessor or successor authority.
- **Active time:** `1.5h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.

## E77 — Attention and Blocker

- **Goal:** Own structured blocker facts and Attention signals as separate immutable governance dimensions.
- **Result:** dimension-local `BlockerFact`, `AttentionSignal`, and deterministic severity projection consumed without direct lifecycle mutation.
- **Scope:** signal/fact identities, legal transitions, severity derivation, applicability, source revisions, and operation-specific blocker references.
- **Non-goals:** no Readiness, Product/Approval, ChangeRequest, supersession, plan/preflight, Scheduling/Allocation, Engineering/Task/TaskAttempt, Delivery, Release, Outcome, closure, display, persistence, or direct mutation of other dimensions.
- **Dependencies:** E02.
- **Unlocks:** E71, E78 (route notes only; `Dependencies` remains authoritative).
- **Acceptance:** Attention and Blocker are distinct immutable dimensions with deterministic source revisions.
- **Stop boundary:** signal package reverts without mutating scheduling or Engineering.
- **Active time:** `1.5-2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.

## E78 — Engineering and Task lifecycle

- **Goal:** Own Engineering control and Task lifecycle after scheduling, including explicit Task acceptance boundaries.
- **Result:** independent Engineering and Task matrices with `paused` authority, dimension-local blocked projections, and no automatic Task acceptance from TaskAttempt success.
- **Scope:** Engineering control; Task lifecycle; candidate/review/acceptance boundaries; Task ownership use; TaskAttempt references consumed from E79.
- **Non-goals:** no Product/Approval, ChangeRequest, supersession, plan/preflight, Readiness, Attention/Blocker authority, Scheduling/Allocation authority, TaskAttempt record/lifecycle, Delivery, Release, Outcome, closure, display, persistence, Worker orchestration, or provider authority.
- **Dependencies:** E71, E76, E77, E79.
- **Unlocks:** E20, E31, E54, E55, E57, E72 (route notes only; `Dependencies` remains authoritative).
- **Acceptance:** Engineering and Task transitions are independent; TaskAttempt success never auto-accepts Task.
- **Stop boundary:** Engineering/Task package reverts without Worker, Beads, or external cleanup.
- **Active time:** `1.5-2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.

## E79 — TaskAttempt record and lifecycle

- **Goal:** Own the pure domain `TaskAttempt` record and lifecycle while preserving Task acceptance as a separate transition.
- **Result:** immutable TaskAttempt records keyed by `TaskAttemptId`, with explicit result/evidence and no generic attempt identity.
- **Scope:** TaskAttempt record, legal transitions, evidence binding, retry/history semantics, and consumption of the immutable E02 `TaskAttemptOwnerRef`; E79 does not redefine the TaskAttempt-to-Task identity relation.
- **Non-goals:** no generic `AttemptId`, StepAttemptRecord Runtime ownership, RoleRunRecord/LaunchPermit Runtime ownership, Product/Approval, ChangeRequest, supersession, plan/preflight, Readiness, Attention/Blocker, Scheduling/Allocation, Engineering/Task authority, Delivery, Release, Outcome, closure, display, persistence, Worker execution, or automatic Task acceptance.
- **Dependencies:** E02.
- **Unlocks:** E20, E54, E57, E72, E78 (route notes only; `Dependencies` remains authoritative).
- **Acceptance:** TaskAttempt records are immutable and never substituted for StepAttemptRecord or RoleRunRecord.
- **Stop boundary:** TaskAttempt package reverts without Runtime execution or external cleanup.
- **Active time:** `1.5-2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.

## E80 — Release

- **Goal:** Own Release disposition separately from immutable provider-confirmed Release operations.
- **Result:** provider-neutral Release lifecycle, `ReleaseOperation` records, confirmation/unknown/reconciliation semantics, and no outcome authority.
- **Scope:** Release identity, disposition, operation records, rollback intent/status references, and provider confirmation boundaries.
- **Non-goals:** no Product/Approval, ChangeRequest, supersession, plan/preflight, Readiness, Attention/Blocker, Scheduling, Engineering/Task/TaskAttempt, Delivery facet ownership, Outcome, closure, display, persistence, adapter implementation, or provider authority.
- **Dependencies:** E72.
- **Unlocks:** E81, E82 (route notes only; `Dependencies` remains authoritative).
- **Acceptance:** Release disposition, operation, confirmation, and unknown/reconciliation remain separate from Outcome.
- **Stop boundary:** Release package reverts without provider rollback or external compensation.
- **Active time:** `1.5-2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.

## E81 — Outcome

- **Goal:** Own outcome requirements, observation runs, and outcome assessments after Delivery and Release facts.
- **Result:** deterministic observation/evaluation records that preserve raw observations and cannot rewrite Delivery or Release authority.
- **Scope:** outcome requirements, `ObservationRun`, raw observations, `OutcomeAssessment`, thresholds, and terminal evaluation semantics.
- **Non-goals:** no Product/Approval, ChangeRequest, supersession, plan/preflight, Readiness, Attention/Blocker, Scheduling, Engineering/Task/TaskAttempt, Delivery, Release authority, closure, display, persistence, observation provider authority, or rollback execution.
- **Dependencies:** E72, E80.
- **Unlocks:** E82 (route notes only; `Dependencies` remains authoritative).
- **Acceptance:** raw observations remain immutable and assessments cannot rewrite Delivery or Release.
- **Stop boundary:** Outcome package reverts without observation-provider cleanup.
- **Active time:** `1.5-2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.

## E82 — Closure projection

- **Goal:** Own complete fail-closed closure composition across all applicable domain families.
- **Result:** versioned closure facets and projection that reports satisfied/unsatisfied requirements, unresolved effects, active plans, and source revisions without a writable universal close state.
- **Scope:** closure policy, required facets, unresolved effects, active plan/change references, successor disposition, and deterministic closure projection.
- **Non-goals:** no lifecycle authority in Product, Approval, ChangeRequest, supersession, Readiness, Attention/Blocker, Scheduling, Engineering, Task/TaskAttempt, Delivery, Release, or Outcome; no plan execution, persistence, display presentation, or external authority.
- **Dependencies:** E70, E71, E72, E73, E74, E75, E76, E77, E78, E79, E80, E81.
- **Unlocks:** E83, E31, E55 (route notes only; `Dependencies` remains authoritative).
- **Acceptance:** closure fails closed on missing facets/unresolved effects and has no writable universal close state.
- **Stop boundary:** closure projection reverts without deleting authoritative facts.
- **Active time:** `1.5-2h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.

## E83 — Display projection

- **Goal:** Own structured deterministic display projections over raw authoritative facts.
- **Result:** lossless primary/badge/reason/source-version output with no mutation authority and a direct handoff to protocol consumers.
- **Scope:** projection version, primary label, phase, badges, reasons, blocker/attention references, source revisions, stable precedence, and raw-fact preservation.
- **Non-goals:** no Product or domain-family lifecycle, closure authority, plan/preflight, persistence, UI mutation, display-side effects, or third-party authority.
- **Dependencies:** E82.
- **Unlocks:** E03, E31 (route notes only; `Dependencies` remains authoritative).
- **Acceptance:** display preserves all raw facts, reasons, blockers, and source revisions and has no mutation authority.
- **Stop boundary:** display package reverts without altering domain authority or UI state.
- **Active time:** `1.5h`.
- **Delivery Units:** 1.
- **Verification Profile:** `strict`.

## 5. Dependency Graph Validation

The authoritative graph is the `Dependencies` field of E01–E83. Handwritten linear critical paths and parallel groups have been removed because they can drift from the formal graph.

Before this map is converted into Beads implementation work, a deterministic graph generator must:

1. parse every Epic ID and dependency;
2. reject unknown references and cycles;
3. produce direct dependents, topological waves, and critical-path candidates;
4. verify that every claimed walking skeleton has all required predecessors;
5. emit the exact `blocks` relationships used by Beads;
6. store a graph hash beside the generated task plan.

`Dependencies` are scheduling constraints. Any remaining `Unlocks` text in an Epic entry is only a non-authoritative route note and may mention indirect product value.

---

## 6. Charter Outcome Traceability

| Charter outcome | Owning Epics |
|---|---|
| Product session remains free during BUILD | E06, E09, E11, E18, E24, E31, E40 |
| Durable daemon and recoverable workers | E04–E11, E39 |
| Bounded Epic readiness and capacity | E02, E13, E14, E58, E59, E67, E70, E71, E73, E74, E77 |
| Permission policy enforcement and operator ceiling | E19, E20, E22, E57, E67 |
| Durable execution qualification and authority boundary | E04, E05, E10, E39, E60, E68 |
| Workspace backend qualification and native worktree boundary | E08, E15–E17, E42–E44, E62, E69 |
| Single Unit writer and managed worktree | E08, E15–E17, E42–E44, E69 |
| Lead-driven role subagents under Runtime authority | E09, E19, E20, E31, E57 |
| Beads governance and Task/Unit lifecycle | E12, E13, E26, E38, E47, E54 |
| Governed verification strength | E21–E23, E45 |
| Normal GitHub PR lifecycle and feedback | E27–E31, E46, E48, E49 |
| Trusted human approval and Inbox | E03, E06, E24, E26, E41, E50, E51 |
| HTML PRD portal | E25, E26, E32, E34, E52 |
| Release, observation, cancellation, and rollback | E35, E36, E55 |
| Sensitive credentials and artifacts | E46, E56 |
| V1/V2 no-double-write migration | E37–E40 |
| Failure recovery without duplicate effects | E10, E17, E29–E31, E39, E53, E40 |
| Third-party reuse and qualification gates | E67–E69, [Reuse Survey](./THIRD_PARTY_REUSE_SURVEY.md) |

---

## 7. RFC Coverage Traceability

| RFC area | Primary Epics |
|---|---|
| Domain identities, hierarchy, and primitive transition kernel | E02 |
| Readiness and governance evidence | E70 |
| Scheduling and Allocation | E71 |
| Delivery facets | E72 |
| Plans and preflight | E73 |
| Product lifecycle and Approval | E74 |
| ChangeRequest | E75 |
| Supersession | E76 |
| Attention and Blocker | E77 |
| Engineering and Task lifecycle | E78 |
| TaskAttempt | E79 |
| Release | E80 |
| Outcome | E81 |
| Closure projection | E82 |
| Display projection | E83 |
| Protocol and trusted principals | E03, E06, E41, E50 |
| SQLite/event/outbox | E04, E05, E68 |
| Lease/fencing | E08 |
| Step recovery | E10, E39, E53, E60–E66, E68 |
| Durable execution and `DurableExecutionBackend` SPI | E04, E10, E39, E60, E68 |
| Pi SDK Worker and role tools | E09, E20, E57, E67 |
| Policy, readiness, and budget | E14, E19, E58, E67 |
| Sessions | E18, E24 |
| Beads governance and task lifecycle | E12, E13, E47, E54 |
| Mirror/worktree/Git and `WorkspaceBackend` SPI | E15–E17, E42, E43, E62, E69 |
| Sandbox and jailed Dev tools | E21, E22, E44, E67 |
| Verification | E23, E45 |
| GitHub | E27–E31, E46, E48, E49 |
| Document/Docs | E25, E26, E32 |
| Dashboard/Inbox | E33, E34, E41, E50–E52 |
| Release/Outcome/Termination | E35, E36, E55 |
| Security, secrets, retention | E41, E46, E56 |
| Migration | E37, E38 |
| Failure/E2E | E31, E39, E40, E53 |

---

## 8. Pre-implementation Readiness Checklist

Before converting an entry in this map into executable Beads tasks, confirm:

- [ ] one primary result and one Delivery Unit;
- [ ] 3–7 tasks after detailed split;
- [ ] target Active Engineering Time `≤ 2h`;
- [ ] one primary package/subsystem;
- [ ] exact upstream and downstream dependencies;
- [ ] Verification Profile and required gates;
- [ ] independent rollback/stop boundary;
- [ ] no hidden production credential or public-doc requirement;
- [ ] no V1/V2 shared mutation authority;
- [ ] an integration or walking-skeleton check exists within a short distance of the Epic.

If any Epic fails this checklist, split it before approval rather than expanding its task list.
