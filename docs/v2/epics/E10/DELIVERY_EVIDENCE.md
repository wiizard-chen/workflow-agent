# E10 PRD Bundle Evidence

Status: implemented MVP candidate; local quality gates pass. The manifest is
still retained as a deterministic candidate because no new exact human
confirmation was recorded in this session.

## Candidate identity

- Bundle manifest SHA-256: `43ce2c177f4088dbb93d26fcf1bc2c5cd7fd48b6b2fa51fcfab24ba1155ac6b4`
- Generator: `node docs/v2/epics/E10/generate-bundle.mjs --check`
- Runtime schema migration named by the contract: version `4`
- Dependency set parsed from `INITIAL_EPIC_MAP.md`: E02, E05, E07, E08
- Candidate bundle files: `approved-prd.md`, `approved-prd.html`,
  `document.json`, `manifest.json`, and `manifest.sha256`

## Local evidence

| Gate | Result |
|---|---|
| PRD and Bundle generation | PASS |
| Bundle `--check` determinism | PASS (`43ce2c177f4088dbb93d26fcf1bc2c5cd7fd48b6b2fa51fcfab24ba1155ac6b4`) |
| Dependency parser | PASS (E02, E05, E07, E08) |
| Authority-document hashes | PASS (RFC, Initial Epic Map, Charter, reuse survey bound in `document.json` and `manifest.json`) |
| Dependency manifest baselines | PASS (E02, E05, E07, E08 bound in the candidate manifest) |
| `git diff --check` | PASS |
| Workflowd E10 tests | PASS (6 focused + 64 workflowd tests) |
| Workflowd typecheck/build | PASS |
| Human exact-manifest confirmation | PENDING |
| Beads write/readback | PENDING |
| Implementation/test gates | PASS |

## Frozen boundary represented by the candidate

- E10 owns the Runtime Step projection, immutable `StepAttemptRecord`, state
  machine, input/hash binding, scanner, report, and explicit recovery events.
- E02 owns `StepAttemptId`; E05 owns the journal substrate; E07 remains a
  separate artifact metadata/verifier boundary; E08 owns lease/fencing proof.
- E08's opener remains v3-compatible for fresh runtimes and can reopen the
  composite v4 Runtime after E10 has installed its extension, preserving lease
  fencing across daemon restart without exposing E10 tables through E08's API.
- E10 does not create TaskAttempts, RoleRuns, or LaunchPermits and contains no
  GitHub-, Git-, Beads-, Dev-, Reviewer-, scheduler-, worker-launch-, or
  external-adapter-specific recovery logic.
- Scanner output is read-only and deterministic. Unknown or interrupted effects
  require evidence/reconciliation/manual recovery; they are never silently
  completed or blindly retried.

No commit, push, PR, schema migration, worker launch, external effect, or Beads
closure is implied by this evidence file. The implementation is present in the
candidate worktree and remains subject to the conservative handoff policy.
