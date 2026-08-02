import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  E01_BASELINE_COMMIT,
  E02_MANIFEST_SHA256,
  parseNulFields,
  verifyCandidateChanges,
} from "../../../scripts/verify-e02-worktree.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(testDirectory, "../../..");
const E02_CANDIDATE_COMMIT =
  "536d98693506fc30ea2388d61e135e8c81262813";

function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_AUTHOR_EMAIL: "verifier@example.invalid",
      GIT_AUTHOR_NAME: "E02 Verifier Test",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_EMAIL: "verifier@example.invalid",
      GIT_COMMITTER_NAME: "E02 Verifier Test",
    },
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`,
  );
  return result.stdout.trimEnd();
}

function writeRepositoryFile(root, repositoryPath, content) {
  const absolutePath = join(root, ...repositoryPath.split("/"));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  return absolutePath;
}

function createFixtureRepository() {
  const root = mkdtempSync(join(tmpdir(), "e02-worktree-verifier-"));
  git(root, ["init", "--quiet"]);
  writeRepositoryFile(
    root,
    ".gitignore",
    "node_modules/\npackages/*/dist/\n.beads/dolt/\n",
  );
  writeRepositoryFile(root, "package-lock.json", "{}\n");
  writeRepositoryFile(root, ".beads/config.yaml", "baseline: true\n");
  writeRepositoryFile(root, "docs/v2/epics/E01/PRD.md", "# E01 baseline\n");
  writeRepositoryFile(root, "outside-baseline.txt", "baseline\n");
  writeRepositoryFile(root, "packages/v2-domain/src/index.ts", "export {};\n");
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "--message", "baseline"]);
  return { root, baseline: git(root, ["rev-parse", "HEAD"]) };
}

function withFixture(run) {
  const fixture = createFixtureRepository();
  try {
    return run(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function verifyFrozenE02Fixture() {
  const parent = mkdtempSync(join(tmpdir(), "e02-exact-candidate-"));
  const root = join(parent, "repository");
  try {
    git(parent, ["clone", "--quiet", "--no-local", workspaceRoot, root]);
    git(root, ["checkout", "--quiet", "--detach", E02_CANDIDATE_COMMIT]);
    assert.equal(git(root, ["rev-parse", "HEAD"]), E02_CANDIDATE_COMMIT);
    const result = spawnSync(
      process.execPath,
      ["scripts/verify-e02-worktree.mjs"],
      { cwd: root, encoding: "utf8", env: process.env },
    );
    assert.equal(
      result.status,
      0,
      `frozen E02 verifier failed:\n${result.stdout}${result.stderr}`,
    );
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

test("E02 verifier accepts the exact candidate and frozen Bundle evidence", () => {
  const evidence = verifyFrozenE02Fixture();
  assert.equal(evidence.status, "verified");
  assert.equal(evidence.baseline.requiredCommit, E01_BASELINE_COMMIT);
  assert.equal(evidence.bundle.manifestSha256, E02_MANIFEST_SHA256);
  assert.equal(evidence.hygiene.prePostSnapshotEqual, true);
  assert.equal(
    evidence.hygiene.candidateUntrackedPolicy,
    "repository-gitignore-only",
  );
  assert.equal(Object.keys(evidence.bundle.authoritySectionHashes).length, 4);
});

test("E02 verifier uses NUL-safe paths and rejects the attack matrix", async (t) => {
  await t.test("allowed tracked and newline-named untracked files remain distinct", () =>
    withFixture(({ root, baseline }) => {
      writeRepositoryFile(root, "packages/v2-domain/src/index.ts", "export const value = 1;\n");
      const newlinePath = "packages/v2-domain/test/line\nbreak.mjs";
      writeRepositoryFile(root, newlinePath, "export {};\n");
      const changes = verifyCandidateChanges(root, baseline);
      assert.ok(changes.all.includes("packages/v2-domain/src/index.ts"));
      assert.ok(changes.all.includes(newlinePath));
    }));

  const attacks = [
    {
      label: "outside allowlist",
      expected: /outside the E02 allowlist/,
      mutate(root) {
        writeRepositoryFile(root, "outside.txt", "attack\n");
      },
    },
    {
      label: "info exclude cannot hide an outside file",
      expected: /outside the E02 allowlist/,
      mutate(root) {
        writeRepositoryFile(root, ".git/info/exclude", "hidden.txt\n");
        writeRepositoryFile(root, "hidden.txt", "attack\n");
      },
    },
    {
      label: "package lock",
      expected: /package-lock\.json/,
      mutate(root) {
        writeRepositoryFile(root, "package-lock.json", "{\"changed\":true}\n");
      },
    },
    {
      label: "Beads state",
      expected: /\.beads state/,
      mutate(root) {
        writeRepositoryFile(root, ".beads/config.yaml", "changed: true\n");
      },
    },
    {
      label: "frozen E01",
      expected: /frozen E01 content/,
      mutate(root) {
        writeRepositoryFile(root, "docs/v2/epics/E01/PRD.md", "# changed\n");
      },
    },
    {
      label: "tracked dist output",
      expected: /generated dist output/,
      mutate(root) {
        writeRepositoryFile(root, "packages/v2-domain/dist/hidden.js", "export {};\n");
        git(root, ["add", "--force", "packages/v2-domain/dist/hidden.js"]);
      },
    },
    {
      label: "untracked symlink",
      expected: /symlink path or ancestor/,
      mutate(root) {
        symlinkSync(
          "src/index.ts",
          join(root, "packages/v2-domain/link.ts"),
        );
      },
    },
    {
      label: "untracked whitespace",
      expected: /untracked file has whitespace errors/,
      mutate(root) {
        writeRepositoryFile(root, "packages/v2-domain/test/bad.mjs", "export {}; \n");
      },
    },
    {
      label: "tracked whitespace",
      expected: /tracked diff has whitespace errors/,
      mutate(root) {
        writeRepositoryFile(root, "packages/v2-domain/src/index.ts", "export {}; \n");
      },
    },
    {
      label: "gitlink mode",
      expected: /tracked gitlink is forbidden/,
      mutate(root, baseline) {
        git(root, [
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${baseline},packages/v2-domain/vendor`,
        ]);
      },
    },
    {
      label: "assume unchanged index flag",
      expected: /unsupported index state/,
      mutate(root) {
        git(root, [
          "update-index",
          "--assume-unchanged",
          "packages/v2-domain/src/index.ts",
        ]);
      },
    },
    {
      label: "skip worktree index flag",
      expected: /unsupported index state/,
      mutate(root) {
        git(root, [
          "update-index",
          "--skip-worktree",
          "packages/v2-domain/src/index.ts",
        ]);
      },
    },
    {
      label: "committed forbidden path restored in the worktree",
      expected: /outside the E02 allowlist/,
      mutate(root) {
        writeRepositoryFile(root, "outside-baseline.txt", "committed attack\n");
        git(root, ["add", "outside-baseline.txt"]);
        git(root, ["commit", "--quiet", "--message", "forbidden commit"]);
        writeRepositoryFile(root, "outside-baseline.txt", "baseline\n");
      },
    },
    {
      label: "staged forbidden add deleted from the worktree",
      expected: /outside the E02 allowlist/,
      mutate(root) {
        const path = writeRepositoryFile(root, "outside-staged.txt", "attack\n");
        git(root, ["add", "outside-staged.txt"]);
        rmSync(path, { force: true });
      },
    },
  ];

  for (const attack of attacks) {
    await t.test(attack.label, () =>
      withFixture(({ root, baseline }) => {
        attack.mutate(root, baseline);
        assert.throws(
          () => verifyCandidateChanges(root, baseline),
          attack.expected,
        );
      }));
  }

  await t.test("invalid UTF-8 Git path bytes fail closed", () => {
    assert.throws(
      () => parseNulFields(Buffer.from([0xff, 0x00]), "attack output"),
      /not valid UTF-8/,
    );
  });
});
