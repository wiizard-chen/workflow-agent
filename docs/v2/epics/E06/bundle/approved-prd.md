# V2 E06 — Unix-socket daemon and typed client

| Field | Value |
|---|---|
| Initiative | `workflow-agent-c2b` |
| Epic | `workflow-agent-c2b.11` |
| Map ID | `E06` |
| Document version | `draft-v1` |
| Product status | **DRAFT RECOMMENDED MVP** |
| Approval status | **PENDING EXACT MANIFEST CONFIRMATION** |
| Engineering eligibility | **INELIGIBLE UNTIL BUNDLE READBACK** |
| Primary repository | `workflow-agent` |
| Primary workspace | `@pi-workflow/workflowd` |
| Primary implementation area | `apps/workflowd/src/transport` |
| Delivery Units | 1 |
| Maximum implementation tasks | 5 |
| Verification Profile | `strict` |
| Approval manifest | Candidate only |
| Authoritative approval hash | Not assigned |

> This is a bounded local transport candidate. It does not authorize external
> network access, worker execution, authentication issuance, or mutation of a
> user database. Implementation evidence is valid only against the exact
> generated Bundle and Beads readback.

## 1. Authority and dependency boundary

E06 is subordinate to the Initiative Charter, Architecture RFC, Initial Epic
Map, E03 protocol PRD, and E05 journal PRD. The Map defines E06 dependencies as
**E03 and E05**. E03 owns protocol versions, schema tuples, accepted envelope
validation, and principal-context shape. E05 owns durable command/event facts.
E06 owns only local transport lifecycle, framing, handshake compatibility, and
typed dispatch between a client and the existing workflowd authority.

E06 does not mint authenticated principals. A daemon may expose connection
material (`connectionId`, `connectionGeneration`, and `daemonEpoch`) and accept
an explicitly injected trusted principal resolver for tests or a future E41
integration. Without that resolver, mutation commands fail closed while health
and read-only event replay remain available.

## 2. Problem and bounded result

E05 can durably record a command and replay events, but there is no local
process boundary through which a client can reach that authority. E06 delivers
one user-level Unix-domain socket daemon and a typed client that can:

1. create and securely own a socket below an explicit Runtime root;
2. negotiate an exact protocol version before any operation;
3. expose health and cursor-based event replay over bounded framed messages;
4. accept a trusted principal resolver for an E03 command intent and commit it
   through E05; and
5. push newly committed events to active cursor subscribers while allowing a
   disconnected client to reconnect and replay from its last cursor.

The result is a local control-plane walking skeleton. It is not a worker host,
scheduler, authentication service, business query layer, UI, or remote API.

## 3. Recommended implementation decisions

### 3.1 Unix socket and path policy

Use Node's built-in `node:net` Unix-domain server. `socketPath` must be an
absolute path below `runtimeRoot`; the default is `<runtimeRoot>/workflowd.sock`.
The implementation rejects path escape, symlink, hardlink, non-socket replacement,
overlong paths, and unsafe parent components. A stale socket is removed only
after no-follow lstat proves it is an owned socket below the same root. After
listen, the socket is chmoded and rechecked as `0600`; group/other bits or a
replacement inode fail closed. No abstract namespace sockets are used.

The daemon creates no directory outside the explicit Runtime root. `start()`
is the first operation with a filesystem effect; importing the package is
side-effect free. `close()` stops accepting connections, closes clients, and
unlinks only the verified socket inode.

### 3.2 Framing and bounds

Each message is a four-byte unsigned big-endian length followed by one UTF-8
JSON document. A frame length of zero, a frame larger than 1 MiB, invalid UTF-8,
non-canonical JSON, a sparse/hostile object, or an incomplete frame at EOF is a
typed protocol error and closes that connection. The parser is incremental and
never uses newline splitting or `JSON.parse` on unbounded accumulated input.

The JSON-RPC envelope is exact: `jsonrpc: "2.0"`, a string or non-negative
integer request `id`, a known method, and an optional plain `params` object.
Responses preserve the request ID. Notifications use no ID and are server to
client only for event delivery.

### 3.3 Handshake and compatibility

The first request must be `handshake` with `{ protocolVersion: 1,
clientName: string }`. The server returns the negotiated version, connection
material, daemon epoch, and a capability list. A client that does not support
version 1 receives `protocol_incompatible` and a read-only diagnostic mode; it
may still call `health` and `events.replay`, but mutation methods return
`read_only_diagnostics`. Requests before handshake, duplicate handshakes, and
unknown protocol versions fail closed without dispatching to E05.

Connection material is provenance, not authentication. The default resolver is
absent. A configured resolver receives immutable handshake metadata and must
return an E03 `ServerPrincipalContext` or `undefined`; no resolver result is
trusted until `acceptCommandIntent` validates it. E41 can later replace this
injected seam with server-issued authentication without changing the wire
contract.

### 3.4 Methods and event cursor

The strict MVP method set is:

```text
handshake
health
events.replay { afterGlobalCursor?: non-negative integer, limit?: 1..128 }
events.subscribe { afterGlobalCursor?: non-negative integer, limit?: 1..128 }
command.commit { intent, result, events, projections?, outbox[] }
```

`events.replay` returns events ordered by the E05 global cursor. `events.subscribe`
returns the replay immediately and registers the connection for future event
notifications. Each notification contains the event and its cursor. A client
must acknowledge progress locally by reconnecting with the last cursor; E06
does not add a second cursor store or claim exactly-once delivery.

`command.commit` accepts an E03 raw `CommandIntent`, resolves a trusted server
principal, calls `acceptCommandIntent`, and passes the accepted envelope to E05.
The daemon broadcasts only events committed by that call. Query and command
payloads are bounded by the same 1 MiB/64-depth/128-item limits as E05.

### 3.5 Serialization and failure model

One request is dispatched at a time per connection. A handler never executes
arbitrary SQL, shell commands, filesystem paths, or network calls supplied by a
client. Errors contain only stable `code` and safe `diagnostic` strings. A
malformed request closes the connection; a method-level rejection returns a
typed JSON-RPC error without changing journal state. A daemon restart loses
only live subscriptions; committed facts remain replayable through E05.

## 4. Frozen public boundary

The package entrypoint may expose only typed daemon/client facades and protocol
data. It must not expose `net.Server`, `net.Socket`, arbitrary framing buffers,
the E05 internal Runtime handle, SQL, or callbacks that perform external I/O.

```ts
type WorkflowDaemonOptions = Readonly<{
  readonly runtimeRoot: string;
  readonly databasePath: string;
  readonly socketPath?: string;
  readonly now: () => number;
  readonly resolvePrincipal?: (connection: ConnectionMaterial, intent: unknown) => ServerPrincipalContext | undefined;
}>;

type WorkflowDaemon = Readonly<{
  readonly start: () => Promise<WorkflowResult<DaemonStatus>>;
  readonly status: () => DaemonStatus;
  readonly close: () => Promise<void>;
}>;

type WorkflowClient = Readonly<{
  readonly connect: () => Promise<WorkflowResult<HandshakeResult>>;
  readonly health: () => Promise<WorkflowResult<HealthResult>>;
  readonly replayEvents: (options?: unknown) => Promise<WorkflowResult<readonly JournalEvent[]>>;
  readonly commitCommand: (input: unknown) => Promise<WorkflowResult<CommandCommitValue>>;
  readonly subscribeEvents: (options: unknown, onEvent: (event: JournalEvent) => void) => Promise<WorkflowResult<true>>;
  readonly close: () => Promise<void>;
}>;
```

Exact names may be finalized during task split, but the observable contract is
fixed: all results are recursively frozen, no native socket/SQL handle escapes,
and all methods are local and transport-neutral.

## 5. Acceptance criteria

- **AC-001 Socket safety:** start creates only the configured socket, mode is
  `0600`, stale unsafe replacements fail closed, and close removes the verified
  socket without touching unrelated files.
- **AC-002 Handshake gate:** compatible clients negotiate version 1; older or
  newer clients receive read-only diagnostics; pre-handshake and duplicate
  handshake requests never reach journal mutation.
- **AC-003 Framing bounds:** fragmented frames, multiple frames, invalid JSON,
  oversize lengths, sparse/accessor/proxy params, and truncated EOF are handled
  deterministically without unbounded allocation or process crashes.
- **AC-004 Health/replay:** health reports daemon epoch and E05 schema status;
  replay returns contiguous events strictly after a cursor in global order.
- **AC-005 Command bridge:** only a configured trusted principal resolver can
  enable `command.commit`; E03 validation and E05 idempotency/rollback remain
  authoritative; a command result is broadcast only after a durable commit.
- **AC-006 Reconnect:** a subscribed client can disconnect and replay from its
  last cursor; notifications are at-least-once and duplicate-safe by event ID.
- **AC-007 Fail closed:** unknown methods, malformed envelopes, wrong IDs,
  command attempts in diagnostics mode, resolver failures, and journal errors
  return stable typed errors with no partial transport-side mutation.
- **AC-008 Boundaries:** no worker, scheduler, business UI, external network,
  authentication issuance, arbitrary SQL, or user database migration is added;
  all V1/V2 quality gates remain green.

## 6. Attack and fault matrix

| ID | Fault/attack | Expected invariant |
|---|---|---|
| AM-01 | socket symlink/path escape/replacement | no outside file is opened or unlinked |
| AM-02 | frame length > 1 MiB or fragmented bomb | bounded allocation and connection-local failure |
| AM-03 | forged principal/accepted envelope | E03 rejects; E05 row counts unchanged |
| AM-04 | incompatible/pre-handshake mutation | diagnostics only; no journal call |
| AM-05 | duplicate request ID or replayed command | original result/event IDs; no duplicate facts |
| AM-06 | disconnect during notification | committed cursor remains replayable |
| AM-07 | resolver throws or returns malformed context | typed command rejection; daemon stays healthy |
| AM-08 | unknown method/extra fields/accessors/proxies | stable protocol error; no handler execution |
| AM-09 | daemon close/restart | socket is cleaned; E05 facts reopen and replay |

## 7. Non-goals and stop boundary

E06 does not implement authentication or grant issuance (E41), worker/Lead
execution (E09), leases (E08), artifact storage (E07), scheduler policy,
business queries, UI, TCP/HTTP, remote clients, Beads/GitHub effects, or
exactly-once external delivery. The daemon is a local transport adapter over
E05 and can be removed without changing persisted journal facts.

## 8. Implementation tasks

1. **T1 — socket lifecycle and bounded framing:** secure path checks, server
   lifecycle, 0600 ownership, length-prefixed parser, and frame tests.
2. **T2 — handshake and typed errors:** exact JSON-RPC envelopes, compatibility
   gate, connection material, diagnostics mode, and hostile-input tests.
3. **T3 — E05 dispatch bridge:** health/replay/command methods, trusted
   principal resolver seam, serialized per-connection dispatch, and broadcast.
4. **T4 — typed client and reconnect:** client facade, subscription callback,
   cursor replay, disconnect/reconnect, and restart tests.
5. **T5 — integration evidence:** public export boundary, Bundle readback,
   full quality gates, and Beads evidence.

## 9. Verification profile

```text
npm --workspace=@pi-workflow/workflowd run test
npm test
npm run typecheck
npm run validate:v2-boundaries
node docs/v2/epics/E06/generate-bundle.mjs --check
git diff --check
```

Status remains **PENDING EXACT MANIFEST CONFIRMATION** until the generated
Bundle hash is read back into Beads. Approval authorizes no external effects;
the daemon must use temporary explicit Runtime roots in tests.
