# E11 Delivery Evidence — First local walking skeleton

Status: implementation candidate; exact human Manifest confirmation is still
required before this Bundle can be called approved.

## Bundle and authority

- Bundle check: `node docs/v2/epics/E11/generate-bundle.mjs --check`
- Candidate Manifest SHA-256: `04c4b40171069c58c04fb14c061c789f324c19b300e0ab9a87e0d1fbd4268017`
- E11 PRD map-section SHA-256: `8656b55ea858e3778f3e57dcf9b8d307904ccfc0791a92be317eaee61825db5c`
- Dependencies are pinned to the E03, E06, E07, E08, E09, and E10 Bundle
  manifests by the generated document.

## Implemented boundary

`scripts/e11-walking-skeleton.mjs` is a root-level, test-only coordinator. It
uses only the public `@pi-workflow/workflowd` and
`@pi-workflow/workflow-worker` entrypoints plus the E03 protocol registry. It
does not add a workflow-worker → workflowd import, expose a native database
handle, or create a production role runner. All runtime, socket, session, and
artifact state is created below a private temporary directory and removed in a
`finally` block.

The fake Lead has one explicit diagnostic prompt and one opaque,
generation/lease/fencing-bound synthetic permit. Its output is canonical JSON
with a stable content digest; it has no model, provider, network, shell, Git,
Beads, repository, or subagent capability.

## Focused smoke evidence

`npm run test:e11` passed. The smoke proves:

- E03 query validation and forged query rejection;
- daemon/client handshake, health while the role is executing, and journaled
  start command;
- duplicate start and duplicate completion replay without a second event;
- E10 `planned → prepared → executing → effect-observed → validated →
  completed` with an immutable attempt and artifact-bound validation;
- E07 content-addressed JSON registration, verification, and tamper rejection;
- E09 worker generation 1 → generation 2 handoff with a strictly newer
  fencing token;
- stale generation mutation rejection and revoked-worker lease-loss abort;
- one-time permit and exactly one fake-role invocation across recovery;
- completion event replay by cursor and a clean deterministic recovery scan;
- an outside temporary socket path rejected before startup.

The deterministic smoke result included:

```text
artifactId: sha256:7a16b6c09be74083634af60de362f8e245a9f2fceaa544f177df39d1f8b3275e
generation: 2
fencingToken: 2
roleInvocations: 1
eventCount: 2
recoveryStatus: clean
```

## Quality gates

The following gates were run on the candidate after the E11 implementation:

- `npm run test:e11` — pass
- `npm test` — pass (V1 plus V2 package, daemon, worker, and E11 smoke)
- `npm run typecheck` — pass
- `npm run validate:v2-boundaries` — pass
- `node docs/v2/epics/E11/generate-bundle.mjs --check` — pass
- `node docs/v2/epics/E09/generate-bundle.mjs --check` — pass
- `node docs/v2/epics/E10/generate-bundle.mjs --check` — pass
- `git diff --check` — pass

No commit, push, external service, repository mutation, Git operation, or
Beads/Dolt remote sync was performed by the implementation.
