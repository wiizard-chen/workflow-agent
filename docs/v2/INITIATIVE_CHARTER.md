# pi-workflow V2 Initiative Charter

> **Status:** Accepted architecture baseline; implementation not started  
> **Architecture generation:** V2  
> **Beads initiative:** `workflow-agent-c2b`  
> **Approved discussion date:** 2026-07-31  
> **Technical design:** [Architecture RFC](./ARCHITECTURE_RFC.md)  
> **Delivery decomposition:** [Initial Epic Map](./INITIAL_EPIC_MAP.md)

## 1. Executive Summary

pi-workflow V2 turns the current foreground, single-session workflow into a single-machine portfolio operating system for AI-assisted product delivery.

The user continuously defines and governs product goals. Each goal is represented as an Initiative, decomposed before implementation into bounded Epics. Every Epic has an independently approved PRD and a logical AI Engineering Lead that drives role-specific subagents. Implementation happens in isolated Delivery Unit worktrees and is delivered through normal GitHub pull requests. Product, Initiative, and Portfolio sessions remain interactive while engineering jobs continue under a persistent local control plane.

The central product outcome is:

> Starting engineering must no longer consume the session used to create the next PRD or supervise the portfolio.

V2 does not try to make giant Epics safer to run. It prevents giant Epics from entering engineering.

---

## 2. Problem Statement

### 2.1 Current behavior

The current V1 workflow has a useful and proven safety model:

- PLAN and BUILD are separated.
- The BUILD manager is code-read-only.
- A single dev writer implements each task.
- Independent reviewers gate task completion.
- Verification, commit ranges, model identity, effort, hashes, and final-review evidence fail closed.

However, the main Pi session is also the BUILD manager. `/execute` injects the manager prompt into the active conversation and the session remains responsible for the full lifecycle:

```text
split → dev → review → retry → verify → final review → finalize
```

A long-running BUILD therefore monopolizes the same session that the user needs for:

- producing another PRD;
- discussing another product goal;
- supervising other work;
- handling ordinary Pi tasks;
- making portfolio decisions.

The problem is not simply that `/execute` takes a long time. The interaction plane and execution control plane have the same lifecycle owner.

### 2.2 Why backgrounding the current manager is insufficient

A background promise or detached child process would free the terminal, but it would not establish:

- a persistent workflow job;
- durable checkpoints;
- deterministic recovery;
- repository and writer leases;
- multi-Epic scheduling;
- Portfolio-level governance;
- stable session ownership;
- GitHub PR and release lifecycle ownership.

V2 is therefore a control-plane redesign, not a UI patch.

---

## 3. Product Vision

The target operating model is:

```text
Human Portfolio Governor
└─ Portfolio
   └─ Initiative: one complete product objective
      ├─ Initiative Session + Charter + Epic Map
      └─ bounded Epic: one temporary virtual engineering department
         ├─ Epic Product Session + approved PRD
         ├─ logical Engineering Lead
         └─ Delivery Unit
            ├─ Tasks and Attempts
            ├─ Branch and managed Worktree
            └─ GitHub Pull Request
```

The user continuously supplies product definition. Approved bounded Epics enter a governed queue. Multiple AI engineering teams consume that queue within explicit capacity and conflict limits. GitHub, release systems, and observation systems remain the final authorities for their own domains.

---

## 4. Roles and Authority

### 4.1 Human Portfolio Governor

The user is the final authority for:

- Initiative Charter approval;
- the initial Epic Map;
- Epic PRD approval;
- product-contract changes;
- business priority;
- cross-Epic and cross-Initiative conflicts;
- significant risk acceptance;
- irreversible or production-sensitive actions;
- cancellation and termination plans;
- final product outcome acceptance where human judgment is required.

The user is not expected to manage every task, retry, test command, or local code decision.

### 4.2 Product AI

Product AI collaborates with the user in Portfolio, Initiative, and Epic Product Sessions. It may research, interrogate assumptions, propose decompositions, draft Charters and PRDs, and perform impact analysis.

Product AI cannot approve its own Charter, PRD, Change Request, risk exception, release exception, or verification downgrade.

### 4.3 Engineering Lead

Every Epic has one stable logical Engineering Lead. It acts as the AI engineering team leader and is responsible for:

- understanding the exact approved PRD version;
- proposing the Delivery Plan;
- decomposing the Epic into bounded tasks;
- preserving architectural consistency across tasks;
- driving dev, reviewer, final-review, CI, and integration roles;
- recording important technical decisions;
- escalating contract changes and material risk;
- summarizing progress for the Portfolio.

The Lead owns tactical engineering intent. It does not own lifecycle authority, leases, approvals, GitHub credentials, or production credentials.

A physical Lead session may be replaced after failure, context saturation, provider interruption, or upgrade. The logical Lead identity survives through structured state and handoff artifacts.

### 4.4 Role-specific subagents

Dev, Reviewer, Final Reviewer, CI Diagnoser, Scout, and related roles are bounded team members. Their session and run identifiers belong to the audit layer and are grouped under Delivery Units, Tasks, and Attempts. They are not top-level business objects that the user must manage.

Only the Engineering Lead may request role execution. Ordinary subagents cannot recursively spawn agents.

### 4.5 Workflow Runtime

The Workflow Runtime is infrastructure, not a product decision-maker. It owns:

- state transitions;
- permissions;
- leases and fencing;
- scheduling;
- durable steps and recovery;
- evidence validation;
- effect brokering;
- external-system reconciliation.

The Runtime may reject an unsafe or illegal Lead request. It may not invent or approve product scope.

---

## 5. Domain Model

### 5.1 Portfolio

The Portfolio is the user's global view of all workflow work. It contains Initiatives, capacities, priorities, health, milestones, decision inboxes, and critical events.

### 5.2 Initiative

An Initiative represents one complete product objective and its overall success criteria. It does not directly modify code.

Every formal workflow request belongs to an Initiative. A small request becomes a lightweight Single-Epic Initiative. Ordinary quick Pi work remains outside workflow.

### 5.3 Initiative Charter

The Charter defines:

- the overall objective;
- non-goals;
- global constraints;
- overall risk boundaries;
- the initial Epic Map;
- cross-Epic dependencies and conflicts;
- overall release strategy;
- Initiative-level success and closure criteria.

It is intentionally not a giant implementation PRD.

### 5.4 Epic

An Epic is a temporary virtual engineering department organized around one bounded, independently verifiable result.

Each Epic:

- binds one primary repository;
- owns one independent PRD lineage;
- has one logical Engineering Lead;
- can be independently approved, queued, delivered, observed, cancelled, and closed;
- is expected to complete within a short active engineering window.

### 5.5 Epic PRD

The Epic PRD is the product contract for one bounded Epic. It is versioned and immutable after approval. Engineering starts only after explicit human approval of a content-addressed document version.

### 5.6 Change Request

A Change Request proposes a controlled change to an approved Charter or PRD. AI may propose and analyze it; the user approves or rejects it. Approval creates a new Charter or PRD version.

### 5.7 Delivery Unit

A Delivery Unit is the code-integration boundary:

```text
one Delivery Unit = one branch = one managed worktree = one GitHub PR
```

Most bounded Epics should have one Delivery Unit. A second sequential Unit is allowed when it is necessary for safe staged integration. Needing many Units is a decomposition failure.

### 5.8 Task and Attempt

A Task is an internal implementation unit. An Attempt is an immutable execution and review round for a Task. Failed attempts are retained; they are never overwritten to look successful.

---

## 6. Product and Governance Lifecycle

### 6.1 Initiative lifecycle

```text
idea
→ Initiative Charter draft
→ initial Epic Map
→ human approval
→ active Initiative
→ rolling Epic definition and delivery
→ Initiative integration verification
→ outcome verified
→ closed
```

### 6.2 Epic lifecycle

```text
Epic PRD draft
→ readiness review
→ human approval of frozen PRD
→ eligible queue
→ scheduled engineering
→ Delivery Unit PR
→ code integration
→ release when applicable
→ observation when applicable
→ outcome verification
→ closed
```

### 6.3 Approval is not scheduling

Human approval means an Epic is permitted to enter the engineering queue. Scheduling depends on priority, dependencies, conflicts, capacity, budget, and readiness. Approval does not force immediate execution.

### 6.4 Controlled change

Substantive changes to scope, acceptance, release policy, risk, or overall Initiative structure require a Change Request. Technical choices inside the approved contract remain within Engineering Lead autonomy unless they introduce material risk or irreversibility.

### 6.5 Cancellation

Cancellation is controlled termination, not automatic erasure. The system first prevents new scheduling, merges, and releases, then produces a Termination Plan covering:

- unstarted Epics;
- dirty or unfinished worktrees;
- open PRs;
- merged but unreleased code;
- released behavior;
- data migrations;
- dependent work.

The user decides what is retained, completed, closed, reverted, disabled, or compensated. History remains auditable.

---

## 7. Bounded Epic Policy

Parallelism exists to complete the user's main objective through multiple controlled Epics. It is not a mechanism for rescuing a giant Epic.

### 7.1 Semantic invariants

An Epic must have:

- one primary result;
- one coherent acceptance boundary;
- independent delivery value;
- an independent failure and stop boundary;
- a credible rollback or isolation strategy;
- one Engineering Lead that can fully understand it;
- one primary release strategy;
- one primary repository and one main subsystem, with at most one adjacent compatibility layer.

Violating these invariants results in `MUST_DECOMPOSE`. It cannot be overridden by a force flag.

### 7.2 Initial size budget

- Target Active Engineering Time: `≤ 2h`.
- Warning: `> 2h`.
- Estimated `> 4h` before approval: mandatory decomposition.
- Actual Active Engineering Time reaches `4h` without entering final delivery: automatic circuit breaker and re-evaluation.
- Target tasks: `3–7`.
- Default Delivery Units: `1`.
- Usual maximum Delivery Units: `2`.

Queue time, waiting for GitHub checks, waiting for a human decision, release windows, and observation windows do not count as Active Engineering Time.

### 7.3 Three-layer readiness gate

Every Epic must pass:

1. semantic invariants;
2. quantitative size and risk budget;
3. a read-only Engineering Lead feasibility review against the real repository.

A mild quantitative exception may be approved with a recorded rationale. Multiple severe overruns or any semantic invariant failure require decomposition.

---

## 8. Parallelism and Scheduling

Initial capacity defaults:

- Global active Engineering Teams: `4`.
- Active Delivery Units per repository: `2`.
- Writers per Delivery Unit: `1`.
- Integration operations per base branch: `1`.

The scheduler considers:

- human business priority;
- Initiative critical path;
- dependencies and blockers;
- conflict relationships;
- waiting time and starvation prevention;
- repository and provider capacity;
- remaining budget;
- current delivery phase.

An Epic waiting for a product decision, a long external review, or an observation window should normally release scarce engineering capacity without blocking unrelated work.

---

## 9. Delivery, Release, and Outcome

### 9.1 GitHub PR is the delivery interface

The GitHub PR is a bidirectional collaboration surface. Checks, reviews, comments, conflicts, external commits, merge queues, and merge state flow back into the engineering loop.

Code issues are handled automatically within retry and budget policy. Product-contract or material-risk issues are routed to the correct Product Session.

The Runtime may request GitHub auto-merge only after all internal and external gates are satisfied. It never bypasses branch protection.

### 9.2 Integration is not release

A merged PR means code is integrated. It does not automatically authorize product exposure.

Delivery Units declare release semantics such as:

- Dark;
- Internal;
- Gradual;
- Immediate;
- Manual.

High-risk, irreversible, security-sensitive, privacy-sensitive, or production-destructive operations require explicit policy and approval.

### 9.3 Release is not outcome

An Epic closes according to its approved completion strategy:

- Code Integration;
- Release Verification;
- Outcome Verification;
- Manual Acceptance.

Runtime metrics and observation evidence remain separate from AI interpretation. AI may explain evidence but cannot rewrite samples or deterministic thresholds.

### 9.4 Pre-authorized rollback

AI may execute only pre-authorized, reversible, and verifiable rollback actions. Anything outside that contract pauses and becomes a critical decision.

---

## 10. Sessions and User Experience

### 10.1 Three product-session levels

- Portfolio Session: global supervision, priority, capacity, Inbox, and navigation.
- Initiative Session: Charter, Epic Map, cross-Epic decisions, and Initiative changes.
- Epic Product Session: PRD construction, approval, Epic changes, release and outcome decisions.

Users navigate by business entity, not by session identifier or path.

### 10.2 Engineering sessions

Engineering Lead sessions are managed by the Runtime and may have multiple physical generations. Dev and reviewer runs remain audit details.

### 10.3 Information routing

- Routine work: Epic activity log only.
- Milestones: Portfolio feed.
- Epic product decisions: Epic Product Session Inbox.
- Initiative structure decisions: Initiative Session Inbox.
- Global governance: Portfolio Inbox.
- Funds, security, data-loss risk, or failed rollback: immediate Critical interrupt.

A blocked Epic cannot block the user's active product discussion or unrelated Epics.

### 10.4 Interfaces

- Pi TUI: product conversation, navigation, quick decisions, Critical interrupts.
- Local Web Dashboard: Portfolio supervision, graphs, queues, PRs, releases, observations, and audit.
- GitHub Pages/Docs: static HTML Charter, PRD, decision, and delivery documentation.

---

## 11. Document Model

Every approved product document is a content-addressed Document Bundle:

```text
source.md
document.json
rendered.html
manifest.json
```

The user reads and approves the exact rendered HTML. The technical authority is the manifest that binds the source, structured representation, rendered HTML, assets, and renderer version.

GitHub Pages is a presentation and distribution layer, not the only source of truth. Sensitive documents fail closed to local/private publication unless access policy is proven safe.

---

## 12. Scope

### 12.1 In scope

- user-level, single-machine persistent control plane;
- Portfolio, Initiative, bounded Epic, Delivery Unit, and Task/Attempt model;
- independent Engineering Lead workers;
- managed repository mirrors and worktrees;
- Beads governance integration;
- GitHub PR, review, checks, and auto-merge governance;
- HTML document portal;
- deterministic state machines, leases, fencing, recovery, and audit;
- sandboxed code execution;
- layered verification profiles;
- release and observation adapter framework;
- V1-to-V2 atomic migration.

### 12.2 Non-goals

- active-active multi-`workflowd` control-plane clustering;
- using giant Epics as the normal unit of work;
- multiple writers in one Delivery Unit;
- giving agents unrestricted GitHub or production credentials;
- loading arbitrary repository executable extensions into authoritative workers;
- treating GitHub Pages as the sole Runtime store;
- treating a long-lived LLM session as the workflow authority;
- allowing V1 and V2 to mutate the same Initiative;
- forcing ordinary quick Pi work into workflow governance;
- implementing every cloud release or observability vendor in the first Initiative.

---

## 13. Success Criteria

V2 is successful when all of the following are demonstrated:

1. Starting engineering does not consume or block the Portfolio, Initiative, or Epic Product Session.
2. The user can continuously construct and approve multiple PRDs while other bounded Epics execute.
3. Multiple Epics run under explicit capacity and conflict constraints while each Delivery Unit retains one writer.
4. Closing a Pi client does not destroy active jobs; jobs continue or recover from durable checkpoints.
5. Worker, daemon, Beads, GitHub, and release failure injection does not create duplicate PRs, duplicate closes, stale-writer mutations, or false completion.
6. GitHub review and CI feedback re-enter the Engineering Lead repair loop.
7. GitHub branch protection remains the final merge authority.
8. Approved HTML documents are traceable to exact immutable manifests.
9. Verification strength is selectable only through governed profiles with visible assurance.
10. Release and observation outcomes remain auditable and separable from code integration.
11. A real V2 end-to-end run completes Initiative → approved Epic → worktree → PR feedback → auto-merge → outcome.
12. After proven V2 adoption, V1 main-session BUILD mutation is retired.

---

## 14. Primary Risks

- Runtime ownership migration is materially larger than a normal extension refactor.
- Beads, SQLite, GitHub, Document Bundles, and release systems must not become competing authorities.
- Sandbox capabilities on macOS require real validation.
- GitHub App, private Pages, merge queue, and branch protection capabilities vary by account and repository.
- Testing may become the throughput bottleneck; governed profiles must optimize without permitting silent bypass.
- Session, log, CI, and artifact output may contain sensitive data and require redaction and retention controls.
- The Initial Epic Map itself must remain bounded and must be re-reviewed before implementation.

---

## 15. Traceability

The implementation architecture and non-negotiable invariants are defined in [Architecture RFC](./ARCHITECTURE_RFC.md).

The proposed bounded implementation sequence, dependencies, verification profiles, and stop boundaries are defined in [Initial Epic Map](./INITIAL_EPIC_MAP.md).
