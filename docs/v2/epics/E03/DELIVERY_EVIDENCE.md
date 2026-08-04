# E03 Local Delivery Evidence

Status: local implementation complete; candidate bundle remains pending exact
Human Governor manifest confirmation and Beads readback.

## Candidate identity

- Manifest: `cf9f088c5257e829165e2fa499bd1c4c5b77e46e301569b930822a66dfd8e1af`
- Bundle generator: `node docs/v2/epics/E03/generate-bundle.mjs --check`
- Primary package: `@pi-workflow/v2-protocol`
- Dependency baseline: E02 manifest `95a111697d11d867c9a28368b9d8edf4bcc6dd4da716f9a93347264cec3096c8`

## Implemented boundary

- Exact `protocolVersion = 1` and `(messageKind, schemaId, schemaVersion)` lookup.
- Two-stage untrusted intent → server-derived accepted envelope.
- RFC principal kinds with human-presence grants restricted to the
  `human-interactive-client` context.
- Immutable TypeBox registry, duplicate rejection, canonical manifest/hash, and
  public descriptor isolation from internal validators.
- Defensive rejection of accessors, proxies, symbols, cycles, sparse arrays,
  non-finite values, hostile prototypes, malformed schema descriptors, and
  invalid grant references.
- Synthetic E11 command/query/event catalog with no E70–E83 imports.
- Schema descriptors fail closed before TypeBox compilation: JSON Schema
  boolean/empty schemas and common TypeBox schemas are accepted, while arrays,
  unknown `type` values, unknown keywords, accessors, and proxies are rejected.

## Verification

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run test` | PASS (V1 + E02 65 + E70 47 + E03 12 + remaining V2 smoke suites) |
| `node scripts/validate-v2-boundaries.mjs` | PASS (6 workspaces, 19 negative fixtures) |
| E03 bundle `--check` | PASS |
| `git diff --check` | PASS |

No transport, persistence, handler, worker, external-system, or migration
authority was added by E03. No commit, push, PR, or remote sync is implied by
this evidence file.
