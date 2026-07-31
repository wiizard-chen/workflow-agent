# E01 delivery evidence

This record covers the T5 local delivery check from the frozen task baseline.
All paths below are repository-relative so that the evidence is portable and
contains no user checkout, temporary-home, session, installed-package, or other
absolute path.

## Identity and governance

| Item | Recorded value |
| --- | --- |
| Task | `workflow-agent-c2b.2.5` (E01-T5) |
| Delivery branch | `v2/e01-workspace-boundaries` |
| Frozen task baseline / locally cloned candidate | `339d45288dbca6f26f8f26446d3a18163d4876e0` |
| Governance baseline | `4f823a806669171b772beb1b2b73f1210a527daf` — `docs(v2): establish approved E01 governance baseline` |
| Approved PRD snapshot | `docs/v2/epics/E01/bundle/approved-prd.md` — `ccd1a1ac852d6596dafb3027fa71593e106b447abfaec1db08888d6fa7d10616` (SHA-256) |
| Approved bundle manifest | `docs/v2/epics/E01/bundle/manifest.json` — `959404794dab7c804ba43bcc6456ec4fe7b087b58fc463973de3bfcd397a5ab6` (SHA-256) |
| Manifest checksum sidecar | `docs/v2/epics/E01/bundle/manifest.sha256` — `cb94502f07f8aae1b5a19e01e5ef003ba704f9ede3a288b9e34652023e433d7d` (SHA-256 of the sidecar) |

The approved PRD snapshot and manifest hashes above were recomputed locally
with `shasum -a 256`. The frozen baseline is a descendant of the governance
baseline. This delivery adds only the E01 maintainer boundary guide and this
local evidence; it does not change runtime behavior.

## E01 ancestry examined

The following linear ancestry from the governance baseline through the frozen
T5 baseline was reviewed:

```text
4f823a806669171b772beb1b2b73f1210a527daf  docs(v2): establish approved E01 governance baseline
e2cb643e9b4e5c863c0ab5794a95bcca9f774dd7  docs(v2): freeze E01 task specifications
ca525f24b089ca6424213cbff22f9b25f2576e10  E01-T1 Root workspace and TypeScript orchestration
b57acc18c66f7508b6d8b771e6d27c7a38d888be  E01-T2 Scaffold five private V2 workspaces
9ef82cab93b8c9f231bc1c6eeb870472ce528e74  E01-T3 V2 tests and boundary validator
fb90bc65b4475b0e9148f15ed57ff10ba5e28222  E01-T3 reviewer fixes
2bd5ffc109eaebf342bb1a28f7a4a1a82441750b  E01-T4 Isolated wfpi and Pi Git-package compatibility
321e72608ff3421e7ecd9cb85fc2c929a315ffbf  E01-T4 Isolated wfpi and Pi Git-package compatibility
3863c8dfabfbb0cc001b17e6982ac08465045593  E01-T4 reviewer round2 fixes
339d45288dbca6f26f8f26446d3a18163d4876e0  E01-T4 Isolated wfpi and Pi Git-package compatibility
```

The T5 delivery commit SHA is deliberately emitted by Git after this evidence
is committed and is reported in the delivery handoff. A Git commit cannot
reliably contain its own object ID because the file contents participate in the
object hash. The exact locally cloned candidate SHA above is therefore bound to
the clone-parity result; the manager must substitute the emitted final T5 SHA
in the remote gate below.

## Observed local toolchain

| Tool | Exact observed version |
| --- | --- |
| Node.js | `v24.15.0` |
| npm | `11.12.1` |
| TypeScript | `5.9.3` |
| Git | `2.42.1` |
| Pi | `0.82.1` |

These satisfy the manifest floors/observations: Node `>=22.19.0`, npm lockfile
version 3, TypeScript 5.9.3, Git 2.42.1, and Pi compatibility floor 0.81.1.

## Frozen local gate

Before running the command, inherited Pi/subagent/diagnostic overrides were
cleared. The following exact gate was run from the repository root:

```bash
env -u PI_CODING_AGENT_DIR -u PI_CODING_AGENT_SESSION_DIR \
  -u PI_SKIP_VERSION_CHECK -u PI_TELEMETRY -u PI_SUBAGENT_EXTRA_AGENT_DIRS \
  -u WF_AGENT_HOME -u WF_PI_EXECUTABLE -u WF_CACHE_DIAGNOSTIC -u NODE_OPTIONS \
  bash -lc 'npm ci && npm run check && node scripts/validate-v2-boundaries.mjs && node scripts/test-v2-package-compat.mjs --candidate "$PWD" --mode clone-parity && git diff --check'
```

Result: **pass (exit 0)**. `npm ci` completed from the committed lockfile;
`npm run check` covered V1 and all five V2 workspace tests/typechecks; the
boundary validator passed; and clone parity passed for the frozen candidate.
Clone parity proved `npm install --omit=dev`, isolated core extension/skill
loading, isolated `pi-subagents` agent discovery, no persistent user Pi
configuration change, and temporary-state cleanup. `git diff --check` passed.

## Candidate hygiene

The final tracked T5 diff was checked for only these E01 documents:

```text
docs/v2/epics/E01/MAINTAINING_PACKAGE_BOUNDARIES.md
docs/v2/epics/E01/DELIVERY_EVIDENCE.md
```

No tracked `dist/`, `node_modules`, temporary compatibility directory,
`.pi-subagents` artifact, `.pi/git`, `.pi/npm`, `*.tsbuildinfo`, build metadata,
or absolute user-specific path is included. Ignored generated V2 `dist/`
output is local build output only and remains untracked.

## Remote Git-package gate: pending manager

**Status: pending-manager — not run and not claimed as passed.** The final T5
commit has not been pushed, so an actual Pi Git-package assertion for its SHA
would not be meaningful. After the authorized branch push makes the final
handoff SHA reachable, the manager must run exactly:

```bash
node scripts/test-v2-package-compat.mjs --mode pi-git-install --source "git:github.com/wiizard-chen/workflow-agent@<final-t5-commit-sha>"
```

This is the required remote gate; do not replace `<final-t5-commit-sha>` with a
branch name or treat clone parity as a remote Git-package pass.
