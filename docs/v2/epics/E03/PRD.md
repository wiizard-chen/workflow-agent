# V2 E03 — Versioned Command/Query/Event schemas

| Field | Value |
|---|---|
| Initiative | `workflow-agent-c2b` |
| Epic | `workflow-agent-c2b.7` |
| Map ID | `E03` |
| Document version | `draft-v1` |
| Product status | **APPROVED FOR MVP IMPLEMENTATION** |
| Primary package | `@pi-workflow/v2-protocol` |
| Dependencies | E02 |
| Delivery Units | 1 |
| Verification Profile | `strict` |

This PRD fixes the smallest transport-neutral protocol substrate needed by the
local walking skeleton. It does not authorize a transport, daemon, persistence,
authentication, grant issuance/consumption, or Domain lifecycle implementation.

## 1. Problem and outcome

Workflow clients, `workflowd`, workers, and later Dashboard consumers need one
runtime-validated message contract that can evolve without silently accepting a
different payload. E03 delivers immutable generic Command, Query, and Event
envelopes, an explicit schema registry, and a removable synthetic E11 catalog.
The package remains independent of E70–E83 and owns no handlers or side effects.

## 2. Frozen product decisions

1. E03 depends on E02, not E83. E02 supplies only shared scalar and canonical
   JSON vocabulary; E03 does not import later Domain families.
2. Messages use two stages. A client submits an untrusted intent. After the
   authenticated connection boundary, `workflowd` creates the accepted
   envelope and injects a server-derived principal and, when required, a
   separately verified opaque human-presence grant. Client actor/principal/
   trusted-grant assertions are structurally rejected, never ignored.
3. Version compatibility is exact. `protocolVersion` is the integer `1` and
   payload lookup is exact `(messageKind, schemaId, schemaVersion)`. Unknown
   versions reject. There is no semver range, guessed fallback, or silent
   adapter; future adapters must be explicitly registered pure functions.
4. Registries are explicit immutable compositions. Duplicate tuples reject at
   construction; registry validation never dispatches handlers. No global
   mutable registry or dynamic discovery exists.
5. A descriptor declares whether an aggregate expected revision and verified
   human-presence grant are required. E03 validates shape and binding only;
   server-issued principal kinds are the RFC's seven exact kinds, only the
   `human-interactive-client` kind may carry a verified grant, and E41/Runtime
   owns authentication, authorization, expiry, and atomic grant consumption.

## 3. Public contract

The package exports `PROTOCOL_VERSION = 1`, branded-compatible protocol
identities, exact `CommandIntent`/`QueryIntent`, server-created accepted
envelopes, server-created `EventEnvelope`, typed rejection results, immutable
`SchemaRegistry`, and the catalog factory `createSyntheticE11Registry()`.

Intent top-level keys are closed. They may contain message identity, the exact
schema tuple, payload, correlation ID, aggregate reference, and an untrusted
`humanPresenceGrantRef`. They may not contain `actor`, `principal`,
`humanPresenceGrant`, `humanPresenceGrantContext`, authorization claims, or
unknown keys. Accepted envelopes copy and freeze caller data, add only the
server context, and never copy a principal from the intent.

The registry manifest is canonical and SHA-256 hashed. Descriptor order does
not affect the digest. The registry is immutable after construction and only
exposes resolve/validate operations.

## 4. Synthetic E11 catalog

The catalog is deliberately disposable and contains no E70–E83 imports:

| Kind | Schema ID | Version | Required fields | Gates |
|---|---|---:|---|---|
| command | `synthetic.e11.job.start` | 1 | `jobId`, `stepId` | aggregate revision |
| query | `synthetic.e11.job.read` | 1 | `jobId` | none |
| event | `synthetic.e11.job.started` | 1 | `jobId`, `stepId` | server principal |
| event | `synthetic.e11.job.completed` | 1 | `jobId`, `stepId`, `artifactRef` | server principal |

All synthetic fields are opaque non-empty strings. The catalog is a fixture for
the walking skeleton, not a definition of Job, Step, Artifact, Product, or
Delivery authority.

## 5. Acceptance criteria

- [ ] Protocol version `1` and exact schema tuples are enforced; malformed,
      unknown, semver-like, and future values fail closed.
- [ ] Commands and queries validate exact closed envelopes and payload schemas;
      required aggregate revisions and grant bindings are enforced.
- [ ] Client principal/actor/trusted-grant forgery is structurally rejected;
      accepted envelopes contain only server-derived principal/grant context;
      principal kinds use the RFC's exact seven-value vocabulary and only a
      `human-interactive-client` may carry a verified grant.
- [ ] Registry construction rejects duplicate tuples and invalid schemas,
      produces order-independent canonical manifest/hash, and cannot mutate or
      dispatch after construction.
- [ ] Successful outputs are deep-copied and frozen; hostile prototypes,
      accessors, symbols, proxies, cycles, sparse arrays, and non-finite values
      fail without invoking caller getters or mutating input.
- [ ] Synthetic E11 command/query/events validate without importing E70–E83;
      removing the catalog leaves generic substrate behavior unchanged.
- [ ] Package typecheck, runtime tests, boundary validation, and root V2 gates
      pass.

## 6. Out of scope

- JSON-RPC, Unix sockets, framing, transport handshakes, and client sessions.
- Authentication, principal derivation, human-grant issuance, expiry, replay,
  nonce storage, or grant consumption.
- Command handlers, query execution, event persistence, journals, outboxes,
  scheduling, workers, Beads, GitHub, Dashboard, or external adapters.
- Product/Approval/Task/Delivery/Release/Outcome/closure/display semantics.

## 7. Reversion boundary

E03 can be removed with its package tests and synthetic catalog without a
Runtime migration, external cleanup, transport change, or mutation of E02.
