# E09 Delivery Evidence

Status: implemented MVP candidate; local quality gates pass. This evidence is
bound to the deterministic E09 document bundle and records no external effect.

## Bundle identity

- Manifest SHA-256: `3b9d102148e9391a47c86b05490d7ffd71106fb0e3a1223d1317e90955835907`
- Determinism command: `node docs/v2/epics/E09/generate-bundle.mjs --check`
- Runtime package: `@pi-workflow/workflow-worker`

## Verification evidence

| Gate | Result |
|---|---|
| Worker tests | PASS (17/17), including fresh-process import safety, lifecycle, allowlist/accessor attacks, diagnostic prompt rejection, lease/heartbeat loss, abort/dispose races, persistence/resume/handoff, monotonic timestamps, signal/AbortSignal handling, and process exit mappings (78/1/0) |
| Worker typecheck | PASS |
| workflowd regression tests | PASS (63/63) |
| Full repository tests (`npm test`) | PASS (v1 + v2 workspaces) |
| Full repository typecheck (`npm run typecheck`) | PASS |
| V2 boundary validation | PASS (6 workspaces; 19 negative fixtures rejected) |
| E09 bundle check | PASS (manifest above) |
| `git diff --check` | PASS |
| Hostile lease rejection/accessor handling | PASS; fail-closed abort and dispose |
| Acquire/handoff cleanup | PASS; failed startup paths revoke acquired authority |
| Resume allowlist and timestamp rollback | PASS; persisted resource IDs and monotonic terminal times validated |

## Scope boundary

The worker remains local and diagnostic-only. It does not expose shell, write,
Git, Beads, repository-extension discovery, or subagent capability. Pi SDK
loading is lazy and resource loading is allowlist-bound. E09 does not imply a
commit, push, PR, or external model-side effect.
