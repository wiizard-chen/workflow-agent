# Maintaining E01 package boundaries

E01 adds an npm workspace scaffold without changing the root Pi package. Keep the
root and its V1 resources independent from the V2 packages described here.

## Ownership and layout

| Path | Owner / purpose |
| --- | --- |
| root `package.json` | `pi-workflow`: the sole Pi package and npm workspace root |
| `extensions/`, `skills/`, `.pi/agents/`, `scripts/`, `test/`, `workflow.config.json` | V1 Pi-package resources; do not move them into a workspace |
| `apps/workflowd`, `apps/workflow-worker` | private V2 application scaffolds |
| `packages/v2-domain`, `packages/v2-protocol` | private V2 production-library scaffolds |
| `packages/v2-testkit` | private V2 test-support scaffold |

The only workspace globs are `apps/*` and `packages/*`; E01 uses the root
`package-lock.json` and npm. Do not add a second package manager or lockfile.

## Dependency boundary

Allowed production direction is:

```text
@pi-workflow/v2-domain
              ↑
@pi-workflow/v2-protocol
              ↑
@pi-workflow/workflowd   @pi-workflow/workflow-worker
```

`v2-domain` has no internal V2 dependency. `v2-protocol` may depend only on
`v2-domain`. Either application may depend on domain and protocol, but the two
applications must never depend on each other. `v2-testkit` is test-only: no
production package may list or import it as a production dependency.

Every cross-workspace import must use a declared `@pi-workflow/*` dependency
and the target package's public export. Do not import another workspace's
`src`, test, build, or internal paths, including through a relative path. Keep
all five workspace manifests `private` and `type: module`; none is publishable
from this scaffold.

Run the repository-owned guard after package-manifest, project-reference, or
cross-workspace-import changes:

```bash
node scripts/validate-v2-boundaries.mjs
```

It is the authority for the npm DAG, TypeScript-reference agreement, exports,
undeclared internal dependencies, forbidden application edges, testkit use, and
relative deep imports.

## Build output and commands

Production source is under each workspace's `src/`; generated JavaScript and
TypeScript declarations belong only in that workspace's ignored `dist/`.
`*.tsbuildinfo` is also generated and must not be committed. Reset generated V2
output with:

```bash
npm run clean:v2
```

| Command | Maintainer use |
| --- | --- |
| `npm run test:v1` | existing V1 tests |
| `npm run test:v2` | smoke tests for all five workspaces |
| `npm test` | both V1 and V2 tests |
| `npm run typecheck:v1` | V1 TypeScript boundary only |
| `npm run typecheck:v2` | cleans V2 output, then builds the reference graph |
| `npm run typecheck` | both TypeScript boundaries |
| `npm run build:v2` | build the V2 reference graph |
| `npm run check` | approved aggregate test, typecheck, and boundary validation |

V1 loading must continue to work with no V2 `dist/`: `scripts/wfpi` resolves
this repository as `WF_AGENT_HOME`, keeps the caller directory as the target,
and exposes the workflow/cache extensions plus the `.pi/agents` directory.
No E01 package may start a daemon, worker, session, socket, database, or other
runtime service during import or build.

## Compatibility gates

Use clone parity before publication; it clones the candidate, uses
`npm install --omit=dev`, and verifies core Pi resources separately from
isolated `pi-subagents` agent discovery:

```bash
node scripts/test-v2-package-compat.mjs --candidate "$PWD" --mode clone-parity
```

The actual Git-package mode is a separate post-push gate. It must use a
reachable immutable commit SHA, not a branch name, and remains a manager-run
operation because it exercises the remote Git transport:

```bash
node scripts/test-v2-package-compat.mjs --mode pi-git-install --source "git:github.com/wiizard-chen/workflow-agent@<candidate-sha>"
```

Both harness modes create and remove their own temporary Pi configuration and
target repository. Do not substitute a normal user Pi configuration, global
package fallback, SSH source, or provider credentials for those isolated
checks.

## Review and rollback

Before delivery, inspect the tracked diff for only E01/governance changes and
for no `dist/`, temporary directories, build metadata, session artifacts, or
absolute user-specific paths. E01 is scaffolding only: rollback is deleting or
restoring the E01 workspace files and root workspace configuration; it requires
no runtime, service, database, or state migration.
