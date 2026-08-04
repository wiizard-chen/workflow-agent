# V2 E05 — Command journal, event log, and durable outbox

| Field | Value |
|---|---|
| Initiative | `workflow-agent-c2b` |
| Epic | `workflow-agent-c2b.10` |
| Map ID | `E05` |
| Document version | `draft-v1` |
| Product status | **DRAFT / RECOMMENDED MVP** |
| Approval status | **PENDING EXACT MANIFEST CONFIRMATION** |
| Engineering eligibility | **INELIGIBLE UNTIL BUNDLE READBACK** |
| Primary repository | `workflow-agent` |
| Primary workspace | `@pi-workflow/workflowd` |
| Primary implementation area | `apps/workflowd/src/persistence` |
| Delivery Units | 1 |
| Target Active Engineering Time | `2h` |
| Maximum implementation tasks | 5 |
| Verification Profile | `strict` |

This bounded MVP defines the next local walking-skeleton primitive after E04.
The current user goal authorizes local implementation work in the candidate
worktree, but the exact Bundle Manifest remains the durable approval handle.
This contract does not authorize transport, external effects, or a replacement
of Beads/Git/GitHub authority.

## 1. Authority and dependency boundary

This PRD is subordinate to the Initiative Charter, Architecture RFC, Initial
Epic Map, E03 protocol contract, and E04 SQLite persistence contract. The
authoritative scheduling dependencies are exactly **E03 and E04**. E68 remains
an E04 qualification input and is not a second E05 runtime dependency.

E03 owns accepted Command/Event envelope and server-principal semantics. E04
owns SQLite path, WAL, migration, backup, and schema fail-closed behavior. E05
owns only the durable facts needed to process an accepted command atomically:
command identity/result, opaque aggregate head revision, append-only events,
opaque projection materializations, and transport-neutral outbox intents.

`workflowd` remains the sole Runtime mutation writer. No public API exposes a
native SQLite handle, SQL executor, migration callback, network client, Beads
client, Git client, or external provider.

## 2. Problem and bounded result

The E03 protocol can validate a command, but without a journal the same command
can be applied twice; without an append-only event log, aggregate history and
recovery cannot be reconstructed; without an outbox, durable intent can be lost
between a database commit and a later transport. E05 delivers one narrow
transaction boundary:

```text
accepted command
  -> idempotency journal + aggregate revision
  -> N server-sequenced events
  -> opaque projection rows
  -> stable outbox operation IDs
```

All of those facts are committed together or none are committed. A retry with
the same command identity returns the original stored result without creating
new events or outbox rows. A retry with a changed canonical input rejects with a
stable collision code. Outbox delivery is **at-least-once intent** with a stable
operation key; E05 makes no external exactly-once claim and performs no send.

## 3. Frozen implementation decisions

### 3.1 One E04 database and a reviewed extension

E05 registers one static schema extension, `e05-command-journal-v1`, through a
narrow internal E04 extension seam. The seam binds the table names, exact create
SQL, columns, indexes, and migration owner before SQLite is opened. It is not an
arbitrary caller-provided allowlist. A database opened through the ordinary E04
factory without the E05 extension continues to diagnose E05 tables as unknown.

The E05 migration is the next ordered migration after E04 bootstrap. Its
canonical SQL and SHA-256 are part of the PRD Bundle and are never discovered
from a directory or package at runtime.

### 3.2 Canonical command identity

The journal hashes a canonical identity projection of the accepted command. It
covers command ID, protocol/schema tuple, payload, aggregate reference and
expected revision, correlation ID, stable principal kind/ID, and grant ref; it
deliberately excludes connection ID/generation and daemon epoch so a reconnect
can replay the same command. The E02 canonical JSON helper normalizes object key order. Cycles, accessors,
symbols, polluted prototypes, sparse arrays, non-finite numbers, lone
surrogates, oversized values, and unknown envelope fields fail closed before a
write.

The journal stores canonical input, its hash, canonical original result, result
hash, outcome, revision, event IDs, and outbox IDs. Successful and deterministic
terminal rejections are journaled; a command ID never changes its meaning after
its first durable result.

### 3.3 Revisions and append-only events

An aggregate head is an opaque `(aggregateType, aggregateId, revision)` row.
Missing heads have revision `0`. The transaction compares the accepted
envelope's `aggregate.expectedRevision` with that row while holding
`BEGIN IMMEDIATE`. A successful command advances the head by the number of
events and assigns event sequences `oldRevision + 1 ... newRevision`; callers
cannot supply a sequence, gap, or cross-aggregate identity.

Each event stores the E03 schema tuple, canonical payload, server principal
snapshot, causation command ID, correlation ID, occurred-at value, aggregate
sequence, and a monotonically assigned local cursor position. Event rows are
insert-only. Aggregate and global cursors are read-only helpers; transport and
subscriptions belong to E06.

### 3.4 Opaque projections

To satisfy the map's atomic projection/event/outbox result without taking Domain
authority, E05 stores only opaque materializations:
`(projectionName, projectionKey, sourceAggregateRevision, sourceEventId,
valueJson, valueSha256)`. A projection write must bind to an event produced by
the same transaction and may not overwrite a newer source revision. E05 does
not define Product, Approval, Task, Beads, or Dashboard semantics.

### 3.5 Durable outbox and leases

Each committed event may have zero or more opaque outbox intents. Each intent
has an `intentKind`; its stable operation key is derived from `(eventId,
intentKind)` and is unique. A pending or expired leased row can be
claimed atomically in deterministic `(availableAt, outboxId)` order. The claim
returns an owner and generation token. Acknowledge/retry requires the current
owner and generation; stale, forged, expired, or duplicate-conflicting tokens
reject. Reclaim increments attempt count but preserves operation ID and payload
hash. This is a local lease/fencing primitive only; E08 owns the general lease
model later.

## 4. Public contract

The package entrypoint exposes `openCommandJournal` and immutable result/error
types only. The API accepts explicit paths and injected timestamps/IDs where
needed by tests; it reads no environment, home directory, cwd, or network.

```ts
type CommandJournalOptions = {
  readonly runtimeRoot: string;
  readonly databasePath: string;
  readonly backupDirectory?: string;
  readonly mode?: "read-only" | "read-write";
  /** Required for mutable operations; returns canonical UTC epoch milliseconds. */
  readonly now: () => number;
};

type CommandCommitInput = {
  /** `unknown` at the boundary; an E03 fixed-registry guard must accept it. */
  readonly accepted: unknown;
  readonly result: JsonValue;
  readonly events: readonly PendingEvent[];
  readonly projections?: readonly ProjectionWrite[];
  readonly outbox: readonly OutboxIntent[];
};

type PendingEvent = {
  readonly eventId: string;
  readonly schemaId: SchemaId;
  readonly schemaVersion: SchemaVersion;
  readonly payload: JsonValue;
  /** Principal, causationId, correlationId, aggregate, sequence and occurredAt are derived by E05. */
};

type OutboxIntent = {
  readonly eventId: string;
  readonly intentKind: string;
  readonly payload: JsonValue;
  /** Defaults to the commit clock; bounded UTC epoch milliseconds when supplied. */
  readonly availableAtEpochMs?: number;
};

type ProjectionWrite = {
  readonly projectionName: string;
  readonly projectionKey: string;
  readonly sourceEventId: string;
  readonly sourceAggregateRevision: number;
  readonly value: JsonValue;
};

// MVP bounds are part of the runtime contract, not tuning suggestions.
// IDs/keys <=256 UTF-8 bytes; each canonical JSON <=1 MiB; depth <=64;
// events, projections, and outbox intents per command <=128.

type CommandCommitResult =
  | { readonly ok: true; readonly replayed: boolean; readonly commandId: string;
      readonly result: JsonValue; readonly revision: number;
      readonly eventIds: readonly string[]; readonly outboxIds: readonly string[] }
  | { readonly ok: false; readonly rejection: JournalRejection };
```

Additional operations are `readEvents`, `readOutbox`, `claimOutbox`,
`ackOutbox`, `retryOutbox`, and `inspectJournal`; event reads use an exclusive
integer global cursor, optional aggregate filtering, and a bounded limit;
outbox reads use status and deterministic `(availableAtEpochMs, outboxId)` order.
`ackOutbox` and `retryOutbox` require `{outboxId, owner, generation}`; a valid
ack is idempotent only when its canonical ack payload hash is unchanged.
None of these operations returns SQL or a native connection. Stable rejection families include `invalid_input`, `read_only`,
`idempotency_collision`, `expected_revision_mismatch`, `event_conflict`,
`projection_conflict`, `outbox_conflict`, `outbox_fenced`, `schema_corrupt`,
`migration_failed`, and `transaction_failed`.

## 5. Transaction and recovery contract

1. Re-validate the unknown accepted envelope with an E03-owned fixed-registry
   guard and each event payload against the same registry; canonicalize all
   caller data without invoking accessors. The caller cannot inject migrations
   or a trusted principal object. Event epoch milliseconds are checked as safe
   non-negative integers and re-read as `new Date(ms).toISOString()` for the
   E03 `occurredAt` field. The accepted envelope must carry stable server
   principal provenance; a plain forged object is rejected.
2. Acquire the E04 SQLite write reservation and re-read schema under the lock.
3. Replay an existing command by hash, or compare the aggregate head revision.
4. Insert journal, head, events, projections, and outbox rows in one transaction
   using prepared statements and fixed SQL.
5. Validate row counts, hashes, contiguous sequences, and causal IDs before
   commit; rollback on every error.
6. On reopen, a command committed before process death is replayable and
   produces no second event/outbox operation. An uncommitted attempt leaves no
   partial fact. An outbox claim that dies before acknowledgement becomes
   reclaimable after its lease expires with the same operation ID.

E05 does not write an external confirmation record and cannot guarantee what an
external sink did after receiving an intent. A downstream adapter must dedupe by
the stable outbox operation ID.

## 6. Acceptance criteria and attack matrix

- **AC-001:** Fresh E04 storage upgrades to the exact E05 extension; reopen,
  read-only inspection, migration digest, table/index definitions, and schema
  digest are deterministic.
- **AC-002:** Canonical command identity is key-order independent; hostile JSON,
  unknown fields, forged principal/grant fields, accessors, cycles, symbols,
  non-finite numbers, and oversize input reject without side effects.
- **AC-003:** Same command ID and hash returns the byte-equivalent original
  result with unchanged journal/event/projection/outbox counts; same ID and a
  different hash returns `idempotency_collision` with no mutation.
- **AC-004:** Expected revision `0` creates a head; aggregate commands require
  an aggregate, expected revision, and at least one event, while journal-only
  commands omit aggregate/events/projections/outbox. Stale or missing expected
  revision rejects; concurrent writers with one expected revision produce one
  commit and one typed stale result. Deterministic terminal rejections are
  journaled so a command ID cannot later change meaning.
- **AC-005:** The server assigns contiguous per-aggregate event sequences and
  global cursor positions. Caller-supplied sequence, gap, duplicate event ID,
  or cross-aggregate event rejects. Direct update/delete is not an API path and
  schema tampering is diagnosed.
- **AC-006:** Opaque projection writes are bound to a newly committed event and
  source revision; stale overwrites reject and no Domain transition is exported.
- **AC-007:** Journal, head, events, projections, and outbox are all-or-none at
  every injected failure point, including process close before commit.
- **AC-008:** Each outbox intent has one stable operation ID derived from
  `(eventId, intentKind)` and immutable payload/hash; zero-intent events are
  valid. Duplicate/orphan intents cannot create a second row.
- **AC-009:** Concurrent claim has one winner; expired leases are reclaimable
  with incremented attempt and stable operation ID; ordering and limits are
  deterministic.
- **AC-010:** Ack/retry requires the current owner/generation. Stale, forged,
  wrong-item, expired, duplicate-conflicting, or post-ack operations reject;
  same valid acknowledgement is idempotent.
- **AC-011:** Reopen after commit/crash recovers replay and outbox intent without
  duplicate local facts; external exactly-once remains explicitly out of scope.
- **AC-012:** Read-only handles never create/mutate rows, acquire a write lock,
  or create backups; unsupported/unknown schemas fail closed.
- **AC-013:** SQL injection strings remain data; no ATTACH/PRAGMA/extension,
  arbitrary SQL, native handle, process, network, Beads, Git, GitHub, or
  environment/home access is reachable through the public package.
- **AC-014:** V1 tests, V2 typecheck/tests, boundary validation, bundle check, and
  `git diff --check` remain green and repeatable in a fresh temporary root.

The E05 extension manifest additionally binds its migration SHA-256, schema
digest, migration version, exact table/column/index descriptors, and trigger
allowlist. `openCommandJournal` rejects caller-supplied migrations and always
uses that fixed extension. Event timestamps and outbox availability are UTC
epoch milliseconds; the global event cursor is a dedicated INTEGER column.

### 6.1 Required attack/fault matrix

| ID | Attack or fault | Injection point | Fail-closed invariant | Expected observation |
|---|---|---|---|---|
| AM-01 | forged actor/grant or unknown schema | accepted-envelope validation | only E03 server context is persisted | `invalid_input`, zero rows |
| AM-02 | same command ID with changed payload/schema/revision | journal lookup | first canonical hash is immutable | `idempotency_collision`, unchanged digest |
| AM-03 | two writers use one expected revision | locked head compare | at most one head advance | one commit, one `expected_revision_mismatch` |
| AM-04 | supplied sequence/gap/foreign aggregate/event ID | event draft validation | store assigns contiguous sequence | `event_conflict`, no partial rows |
| AM-05 | failure after journal/event/projection/outbox write | transaction fault hook | durable facts are all-or-none | reopen shows complete set or none |
| AM-06 | stale or simultaneous outbox claim | conditional lease update | one current generation owns a row | one claim winner |
| AM-07 | forged/expired/old ack or retry token | outbox CAS | old owner cannot confirm intent | `outbox_fenced`, state unchanged |
| AM-08 | accessor/proxy/cycle/symbol/non-finite input | canonicalization | caller objects are never executed or mutated | `invalid_input`, side-effect counter zero |
| AM-09 | SQL injection/ATTACH/PRAGMA/unknown table | fixed prepared statements/migration gate | no arbitrary SQL surface | typed rejection, no external object |
| AM-10 | read-only or unknown/corrupt schema | open and mutation facade | diagnostics never become a write path | `read_only`/`schema_corrupt` |

## 7. Explicit non-goals and stop boundary

E05 does not implement Unix sockets/JSON-RPC/client handshake (E06), artifact
storage (E07), general leases (E08), workers (E09), Step Ledger (E10), Beads,
Git/GitHub, transport, scheduler, external dispatch, authentication or grant
issuance (E41), Domain lifecycle/authoritative projections (E70–E83), distributed
transactions, leader election, dynamic migration discovery, or external
exactly-once effects. Removing E05 from a fresh temporary Runtime root restores
the E04-only database; no user database is migrated by tests or bundle
generation.

## 8. Task split and verification

1. **T1 — E04 extension seam and E05 exact schema:** add reviewed extension
   descriptors, migration digest, schema inspection, and migration tests.
2. **T2 — journal/head/event transaction:** implement canonical input hashing,
   revision CAS, server-assigned sequences, append-only facts, and result replay.
3. **T3 — opaque projections and durable outbox:** add atomic projection rows,
   deterministic claim/lease/ack/retry, and bounded read APIs.
4. **T4 — crash/concurrency/attack matrix:** inject rollback points, hostile
   objects, concurrent writers/claimers, stale fencing, and reopen recovery.
5. **T5 — integration evidence:** update exports/scripts, regenerate the Bundle,
   run all quality gates, and record immutable hashes in Beads.

Frozen verification commands:

```text
npm --workspace=@pi-workflow/workflowd run test
npm run test:v1
npm run typecheck
npm run validate:v2-boundaries
node docs/v2/epics/E05/generate-bundle.mjs --check
git diff --check
```

The exact Bundle Manifest SHA-256, source PRD hash, dependency baselines, and
generated document hashes are the delivery evidence. The Bundle filename and
HTML renderer are not approval authorities.
