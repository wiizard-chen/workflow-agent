#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

export const E01_BASELINE_COMMIT =
  "d5debd4d03114a80a45b14ccdb7439b944d6461d";
export const E02_MANIFEST_SHA256 =
  "95a111697d11d867c9a28368b9d8edf4bcc6dd4da716f9a93347264cec3096c8";
export const E02_GENERATOR_SHA256 =
  "c6763b06453567231cade5b6c72dbe5910bec621b8c560b49a3fd6f240e10ac6";
export const E02_SOURCE_PRD_SHA256 =
  "b61d2642e66183a8eb772d9986fffbf4f56fe7932b1a016c279fe2845c136b58";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const e01Directory = "docs/v2/epics/E01";
const generatorRelativePath = "docs/v2/epics/E02/generate-bundle.mjs";
const bundleDirectory = "docs/v2/epics/E02/bundle";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const forbiddenGitEnvironmentVariables = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
];

const exactAllowedPaths = new Set([
  "package.json",
  "scripts/validate-v2-boundaries.mjs",
  "scripts/verify-e02-worktree.mjs",
  "docs/v2/ARCHITECTURE_RFC.md",
  "docs/v2/INITIAL_EPIC_MAP.md",
  "docs/v2/INITIATIVE_CHARTER.md",
  "docs/v2/THIRD_PARTY_REUSE_SURVEY.md",
]);

const allowedPathPrefixes = [
  "packages/v2-domain/",
  "docs/v2/epics/E02/",
];

const authorityPaths = {
  "ARCHITECTURE_RFC.md": "docs/v2/ARCHITECTURE_RFC.md",
  "INITIAL_EPIC_MAP.md": "docs/v2/INITIAL_EPIC_MAP.md",
  "INITIATIVE_CHARTER.md": "docs/v2/INITIATIVE_CHARTER.md",
  "THIRD_PARTY_REUSE_SURVEY.md": "docs/v2/THIRD_PARTY_REUSE_SURVEY.md",
};

function fail(message) {
  throw new Error(message);
}

function compareUtf16(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function quotePath(repositoryPath) {
  return JSON.stringify(repositoryPath);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha1GitBlob(value) {
  const header = Buffer.from(`blob ${value.length}\0`, "utf8");
  return createHash("sha1").update(header).update(value).digest("hex");
}

function readBuffer(root, repositoryPath) {
  return readFileSync(join(root, ...repositoryPath.split("/")));
}

function readText(root, repositoryPath) {
  return decodeUtf8(readBuffer(root, repositoryPath), repositoryPath);
}

function readJson(root, repositoryPath) {
  try {
    return JSON.parse(readText(root, repositoryPath));
  } catch (error) {
    fail(`${quotePath(repositoryPath)} is not valid JSON: ${error.message}`);
  }
}

function decodeUtf8(buffer, label) {
  try {
    return utf8Decoder.decode(buffer);
  } catch {
    fail(`${label} contains a path that is not valid UTF-8`);
  }
}

export function parseNulFields(buffer, label = "NUL-delimited output") {
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0) {
    fail(`${label} is missing its final NUL delimiter`);
  }
  const fields = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    const field = buffer.subarray(start, index);
    if (field.length === 0) fail(`${label} contains an empty field`);
    fields.push(decodeUtf8(field, label));
    start = index + 1;
  }
  return fields;
}

function commandOutputTail(buffer) {
  const text = decodeUtf8(buffer, "command output").trimEnd();
  return text.split("\n").slice(-20).join("\n");
}

function commandEnvironment(kind) {
  const environment = { ...process.env, LANG: "C", LC_ALL: "C" };
  if (kind === "git") {
    for (const name of Object.keys(environment)) {
      if (name.startsWith("GIT_")) delete environment[name];
    }
    environment.GIT_ATTR_NOSYSTEM = "1";
    environment.GIT_CONFIG_GLOBAL = "/dev/null";
    environment.GIT_CONFIG_NOSYSTEM = "1";
    environment.GIT_CONFIG_SYSTEM = "/dev/null";
    environment.GIT_NO_REPLACE_OBJECTS = "1";
    environment.GIT_OPTIONAL_LOCKS = "0";
    environment.GIT_PAGER = "cat";
    environment.GIT_TERMINAL_PROMPT = "0";
    environment.PAGER = "cat";
  }
  if (kind === "generator") {
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
  }
  return environment;
}

function runCommand(
  root,
  command,
  args,
  allowedStatuses = [0],
  environmentKind = "default",
) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: null,
    env: commandEnvironment(environmentKind),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    fail(`${command} ${args.join(" ")} could not run: ${result.error.message}`);
  }
  if (!allowedStatuses.includes(result.status)) {
    const output = Buffer.concat([result.stdout, result.stderr]);
    fail(
      `${command} ${args.join(" ")} exited ${String(result.status)}` +
        (output.length === 0 ? "" : `:\n${commandOutputTail(output)}`),
    );
  }
  return result;
}

function runGit(root, args, allowedStatuses = [0]) {
  return runCommand(
    root,
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "diff.external=",
      ...args,
    ],
    allowedStatuses,
    "git",
  );
}

function assertSafeGitEnvironment() {
  for (const name of forbiddenGitEnvironmentVariables) {
    if (Object.hasOwn(process.env, name)) {
      fail(`unsafe Git environment variable is set: ${name}`);
    }
  }
  for (const name of Object.keys(process.env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) {
      fail(`unsafe Git environment variable is set: ${name}`);
    }
  }
}

function gitText(root, args) {
  const result = runGit(root, args);
  if (result.stderr.length !== 0) {
    fail(`git ${args.join(" ")} wrote to stderr`);
  }
  return decodeUtf8(result.stdout, `git ${args.join(" ")} output`).trimEnd();
}

function parseNameStatus(buffer) {
  const fields = parseNulFields(buffer, "git diff --name-status output");
  if (fields.length % 2 !== 0) {
    fail("git diff --name-status output has an incomplete record");
  }
  const records = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if (!/^[ACDMTUXB]$/.test(status)) {
      fail(`unsupported tracked change status ${status} for ${quotePath(path)}`);
    }
    if (status === "U") fail(`unmerged tracked path is forbidden: ${quotePath(path)}`);
    records.push({ path, status });
  }
  return records;
}

function parseRawDiff(buffer) {
  const fields = parseNulFields(buffer, "git diff --raw output");
  if (fields.length % 2 !== 0) {
    fail("git diff --raw output has an incomplete record");
  }
  const records = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index];
    const path = fields[index + 1];
    const match = header.match(
      /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([ACDMTUXB])$/,
    );
    if (!match) fail(`malformed git raw diff record for ${quotePath(path)}: ${header}`);
    records.push({
      path,
      oldMode: match[1],
      newMode: match[2],
      status: match[5],
    });
  }
  return records;
}

function sortedUnique(values, label) {
  const sorted = [...values].sort(compareUtf16);
  if (new Set(sorted).size !== sorted.length) {
    fail(`${label} contains duplicate paths`);
  }
  return sorted;
}

function validateRepositoryPath(repositoryPath) {
  if (
    typeof repositoryPath !== "string" ||
    repositoryPath.length === 0 ||
    isAbsolute(repositoryPath)
  ) {
    fail(`invalid repository-relative path: ${JSON.stringify(repositoryPath)}`);
  }
  const components = repositoryPath.split("/");
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    fail(`invalid repository path components: ${JSON.stringify(repositoryPath)}`);
  }
  return components;
}

function deniedPathReason(repositoryPath) {
  const components = validateRepositoryPath(repositoryPath);
  if (components[0] === ".beads") return ".beads state";
  if (components.includes("dist")) return "generated dist output";
  if (components.at(-1) === "package-lock.json") return "package-lock.json";
  if (
    repositoryPath === e01Directory ||
    repositoryPath.startsWith(`${e01Directory}/`)
  ) {
    return "frozen E01 content";
  }
  return null;
}

function isAllowedCandidatePath(repositoryPath) {
  return (
    exactAllowedPaths.has(repositoryPath) ||
    allowedPathPrefixes.some((prefix) => repositoryPath.startsWith(prefix))
  );
}

function inspectFilesystemPath(root, repositoryPath, mustExist) {
  const components = validateRepositoryPath(repositoryPath);
  let currentPath = root;
  for (let index = 0; index < components.length; index += 1) {
    currentPath = join(currentPath, components[index]);
    let stats;
    try {
      stats = lstatSync(currentPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (mustExist) fail(`changed path does not exist: ${quotePath(repositoryPath)}`);
      return { exists: false };
    }
    if (stats.isSymbolicLink()) {
      fail(`symlink path or ancestor is forbidden: ${quotePath(repositoryPath)}`);
    }
    if (index < components.length - 1 && !stats.isDirectory()) {
      fail(`changed path has a non-directory ancestor: ${quotePath(repositoryPath)}`);
    }
    if (index === components.length - 1 && !stats.isFile()) {
      fail(`changed path is not a regular file: ${quotePath(repositoryPath)}`);
    }
    if (index === components.length - 1) return { exists: true, stats };
  }
  fail(`could not inspect changed path: ${quotePath(repositoryPath)}`);
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    fail(`${label} does not match the frozen value`);
  }
}

function trackedDiffArguments(origin, format, baselineCommit) {
  const args = ["diff"];
  if (origin === "staged") args.push("--cached");
  args.push(
    format,
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
  );
  if (origin === "committed") args.push(baselineCommit, "HEAD");
  if (origin === "staged") args.push("HEAD");
  if (origin === "baseline-worktree") args.push(baselineCommit);
  args.push("--");
  return args;
}

function collectTrackedOrigin(root, origin, baselineCommit) {
  const nameStatusResult = runGit(
    root,
    trackedDiffArguments(origin, "--name-status", baselineCommit),
  );
  const rawResult = runGit(
    root,
    trackedDiffArguments(origin, "--raw", baselineCommit),
  );
  const tracked = parseNameStatus(nameStatusResult.stdout).sort((left, right) =>
    compareUtf16(left.path, right.path));
  const raw = parseRawDiff(rawResult.stdout).sort((left, right) =>
    compareUtf16(left.path, right.path));
  assertDeepEqual(
    raw.map(({ path, status }) => ({ path, status })),
    tracked,
    `raw and name-status ${origin} change sets`,
  );
  return {
    raw,
    tracked,
    outputHashes: {
      nameStatusSha256: sha256(nameStatusResult.stdout),
      rawDiffSha256: sha256(rawResult.stdout),
    },
  };
}

export function collectCandidateChanges(
  root,
  baselineCommit = E01_BASELINE_COMMIT,
) {
  assertSafeGitEnvironment();
  const originOrder = ["committed", "staged", "unstaged"];
  const origins = Object.fromEntries(
    originOrder.map((origin) => [
      origin,
      collectTrackedOrigin(root, origin, baselineCommit),
    ]),
  );
  const baselineWorktree = collectTrackedOrigin(
    root,
    "baseline-worktree",
    baselineCommit,
  );
  const untrackedResult = runGit(root, [
    "ls-files",
    "--others",
    "-z",
    "--exclude-per-directory=.gitignore",
    "--",
  ]);
  const untracked = sortedUnique(
    parseNulFields(untrackedResult.stdout, "git ls-files untracked output"),
    "untracked path list",
  );
  const trackedByPath = new Map();
  const raw = [];
  for (const origin of originOrder) {
    for (const record of origins[origin].tracked) {
      const originRecords = trackedByPath.get(record.path) ?? [];
      originRecords.push({ origin, status: record.status });
      trackedByPath.set(record.path, originRecords);
    }
    raw.push(
      ...origins[origin].raw.map((record) => ({ ...record, origin })),
    );
  }
  const tracked = [...trackedByPath]
    .map(([path, pathOrigins]) => ({ origins: pathOrigins, path }))
    .sort((left, right) => compareUtf16(left.path, right.path));
  raw.sort((left, right) =>
    compareUtf16(left.path, right.path) ||
    compareUtf16(left.origin, right.origin));
  const all = [...new Set([...trackedByPath.keys(), ...untracked])]
    .sort(compareUtf16);
  return {
    all,
    baselineWorktree: baselineWorktree.tracked,
    raw,
    tracked,
    untracked,
    rawOutputHashes: {
      baselineWorktree: baselineWorktree.outputHashes,
      origins: Object.fromEntries(
        originOrder.map((origin) => [origin, origins[origin].outputHashes]),
      ),
      untrackedSha256: sha256(untrackedResult.stdout),
    },
  };
}

function validatePathPolicy(changeSet) {
  for (const repositoryPath of changeSet.all) {
    const denied = deniedPathReason(repositoryPath);
    if (denied !== null) {
      fail(`forbidden changed path (${denied}): ${quotePath(repositoryPath)}`);
    }
    if (!isAllowedCandidatePath(repositoryPath)) {
      fail(`changed path is outside the E02 allowlist: ${quotePath(repositoryPath)}`);
    }
  }
}

function validateRawModes(changeSet) {
  for (const record of changeSet.raw) {
    for (const mode of [record.oldMode, record.newMode]) {
      if (mode === "120000") fail(`tracked symlink is forbidden: ${quotePath(record.path)}`);
      if (mode === "160000") fail(`tracked gitlink is forbidden: ${quotePath(record.path)}`);
      if (!["000000", "100644", "100755"].includes(mode)) {
        fail(`unsupported tracked file mode ${mode}: ${quotePath(record.path)}`);
      }
    }
  }
}

function validateFilesystemPaths(root, changeSet) {
  for (const repositoryPath of changeSet.all) {
    const untracked = changeSet.untracked.includes(repositoryPath);
    inspectFilesystemPath(root, repositoryPath, untracked);
  }
}

function validateWhitespace(root, baselineCommit, changeSet) {
  const trackedChecks = [
    ["committed", [baselineCommit, "HEAD"]],
    ["staged", ["--cached", "HEAD"]],
    ["unstaged", []],
    ["baseline-worktree", [baselineCommit]],
  ];
  for (const [origin, revisionArguments] of trackedChecks) {
    const tracked = runGit(
      root,
      [
        "diff",
        "--check",
        "--no-ext-diff",
        "--no-textconv",
        ...revisionArguments,
        "--",
      ],
      [0, 2],
    );
    if (tracked.status !== 0 || tracked.stdout.length !== 0 || tracked.stderr.length !== 0) {
      fail(
        `${origin} tracked diff has whitespace errors` +
          (tracked.stdout.length === 0 ? "" : `:\n${commandOutputTail(tracked.stdout)}`),
      );
    }
  }
  for (const repositoryPath of changeSet.untracked) {
    const result = runGit(
      root,
      [
        "diff",
        "--no-index",
        "--check",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        "/dev/null",
        repositoryPath,
      ],
      [0, 1, 2, 3],
    );
    if (result.stdout.length !== 0 || result.stderr.length !== 0) {
      fail(`untracked file has whitespace errors: ${quotePath(repositoryPath)}`);
    }
    if (![0, 1].includes(result.status)) {
      fail(
        `untracked whitespace check exited ${String(result.status)}: ${quotePath(repositoryPath)}`,
      );
    }
  }
}

function validateIndexFlags(root) {
  const result = runGit(root, ["ls-files", "-v", "-z", "--"]);
  const records = parseNulFields(result.stdout, "git ls-files -v output");
  for (const record of records) {
    if (!/^H /.test(record)) {
      fail(`tracked path has assume-unchanged, skip-worktree, or unsupported index state: ${record}`);
    }
  }
}

function resolveRepositoryAndBaseline(root, baselineCommit) {
  const actualRoot = realpathSync(root);
  const gitRoot = realpathSync(gitText(root, ["rev-parse", "--show-toplevel"]));
  if (actualRoot !== gitRoot) fail("verifier root is not the Git worktree root");
  const resolvedBaseline = gitText(root, [
    "rev-parse",
    "--verify",
    `${baselineCommit}^{commit}`,
  ]);
  if (resolvedBaseline !== baselineCommit) {
    fail(`E01 baseline resolved to an unexpected commit: ${resolvedBaseline}`);
  }
  const headCommit = gitText(root, ["rev-parse", "HEAD"]);
  const ancestor = runGit(
    root,
    ["merge-base", "--is-ancestor", baselineCommit, headCommit],
    [0, 1],
  );
  if (ancestor.status !== 0) {
    fail(`HEAD ${headCommit} is not a descendant of E01 baseline ${baselineCommit}`);
  }
  const objectFormat = gitText(root, ["rev-parse", "--show-object-format"]);
  if (objectFormat !== "sha1") fail(`unsupported Git object format: ${objectFormat}`);
  const alternatesPath = gitText(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "objects/info/alternates",
  ]);
  try {
    if (lstatSync(alternatesPath).size !== 0) {
      fail("Git object alternates are forbidden during E02 verification");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const attributesPath = gitText(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/attributes",
  ]);
  try {
    const attributesStats = lstatSync(attributesPath);
    if (!attributesStats.isFile() || attributesStats.isSymbolicLink()) {
      fail("Git info/attributes must be absent or an empty regular file");
    }
    if (attributesStats.size !== 0) {
      fail("non-empty Git info/attributes is forbidden during E02 verification");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { headCommit, resolvedBaseline };
}

function parseLsTree(buffer) {
  return parseNulFields(buffer, "git ls-tree output").map((record) => {
    const tab = record.indexOf("\t");
    if (tab === -1) fail(`malformed git ls-tree record: ${record}`);
    const metadata = record.slice(0, tab).split(" ");
    if (metadata.length !== 3) fail(`malformed git ls-tree metadata: ${record}`);
    return {
      mode: metadata[0],
      type: metadata[1],
      object: metadata[2],
      path: record.slice(tab + 1),
    };
  });
}

function enumerateRegularFiles(root, directoryPath) {
  const files = [];
  function visit(repositoryPath) {
    const absolutePath = join(root, ...repositoryPath.split("/"));
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) fail(`symlink is forbidden in frozen tree: ${quotePath(repositoryPath)}`);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolutePath).sort(compareUtf16)) {
        visit(`${repositoryPath}/${entry}`);
      }
      return;
    }
    if (!stats.isFile()) fail(`non-regular file is forbidden in frozen tree: ${quotePath(repositoryPath)}`);
    files.push(repositoryPath);
  }
  visit(directoryPath);
  return files.sort(compareUtf16);
}

function baselineE01Entries(root, baselineCommit) {
  const result = runGit(root, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    baselineCommit,
    "--",
    e01Directory,
  ]);
  const entries = parseLsTree(result.stdout).sort((left, right) =>
    compareUtf16(left.path, right.path));
  if (entries.length === 0) fail("E01 baseline tree is empty");
  return entries;
}

function verifyE01Freeze(root, baselineCommit, headCommit, entries) {
  const baselineTree = gitText(root, [
    "rev-parse",
    `${baselineCommit}:${e01Directory}`,
  ]);
  const headTree = gitText(root, ["rev-parse", `${headCommit}:${e01Directory}`]);
  if (headTree !== baselineTree) fail("HEAD changed the frozen E01 tree");
  const currentPaths = enumerateRegularFiles(root, e01Directory);
  assertDeepEqual(
    currentPaths,
    entries.map(({ path }) => path),
    "working E01 file set",
  );
  for (const entry of entries) {
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
      fail(`unsupported E01 baseline entry ${entry.mode} ${entry.type}: ${quotePath(entry.path)}`);
    }
    const absolutePath = join(root, ...entry.path.split("/"));
    const stats = lstatSync(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      fail(`E01 entry is not a regular file: ${quotePath(entry.path)}`);
    }
    const currentMode = (stats.mode & 0o111) === 0 ? "100644" : "100755";
    if (currentMode !== entry.mode) fail(`E01 file mode changed: ${quotePath(entry.path)}`);
    const bytes = readFileSync(absolutePath);
    decodeUtf8(bytes, entry.path);
    const object = sha1GitBlob(bytes);
    if (object !== entry.object) fail(`E01 file bytes changed: ${quotePath(entry.path)}`);
  }
  return {
    baselineTree,
    fileCount: entries.length,
    manifestSha256: sha256(readBuffer(root, `${e01Directory}/bundle/manifest.json`)),
    prdSha256: sha256(readBuffer(root, `${e01Directory}/PRD.md`)),
  };
}

function slugForHeading(title) {
  return title
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function markdownSections(markdown) {
  const headings = [...markdown.matchAll(/^(#{1,6})[ \t]+(.+)$/gm)].map(
    (match) => ({ index: match.index, slug: slugForHeading(match[2]) }),
  );
  const sections = new Map();
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (sections.has(heading.slug)) fail(`duplicate Markdown heading: ${heading.slug}`);
    const end = index + 1 < headings.length ? headings[index + 1].index : markdown.length;
    sections.set(heading.slug, markdown.slice(heading.index, end));
  }
  return sections;
}

function sectionHashes(markdown) {
  return Object.fromEntries(
    [...markdownSections(markdown)]
      .map(([slug, section]) => [slug, sha256(section)])
      .sort(([left], [right]) => compareUtf16(left, right)),
  );
}

function verificationCommands(sourceMarkdown) {
  const section = markdownSections(sourceMarkdown).get(
    "7-strict-verification-contract",
  );
  if (!section) fail("E02 PRD is missing the strict verification section");
  const block = section.match(/```text\n([\s\S]*?)\n```/);
  if (!block) fail("E02 PRD is missing the verification command block");
  return block[1].split("\n").filter(Boolean);
}

function preflightBundleGenerator(root) {
  const manifestPath = `${bundleDirectory}/manifest.json`;
  const sidecarPath = `${bundleDirectory}/manifest.sha256`;
  const sourcePath = "docs/v2/epics/E02/PRD.md";
  const manifestBytes = readBuffer(root, manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== E02_MANIFEST_SHA256) {
    fail(
      `E02 Manifest hash is not the frozen candidate ${E02_MANIFEST_SHA256}: ${manifestSha256}`,
    );
  }
  const manifest = JSON.parse(decodeUtf8(manifestBytes, manifestPath));
  const generatorSha256 = sha256(readBuffer(root, generatorRelativePath));
  if (
    generatorSha256 !== E02_GENERATOR_SHA256 ||
    manifest.generator?.sha256 !== E02_GENERATOR_SHA256
  ) {
    fail("E02 generator raw hash is not the frozen Manifest generator hash");
  }
  const sourcePrdSha256 = sha256(readBuffer(root, sourcePath));
  if (
    sourcePrdSha256 !== E02_SOURCE_PRD_SHA256 ||
    manifest.sourcePrdSha256 !== E02_SOURCE_PRD_SHA256
  ) {
    fail("E02 source PRD raw hash is not the frozen Manifest source hash");
  }
  const sidecarBytes = readBuffer(root, sidecarPath);
  const expectedSidecar = `${E02_MANIFEST_SHA256}  manifest.json\n`;
  if (!sidecarBytes.equals(Buffer.from(expectedSidecar, "utf8"))) {
    fail("E02 Manifest checksum sidecar failed pre-execution readback");
  }
}

function runBundleGeneratorCheck(root) {
  preflightBundleGenerator(root);
  const argv = ["node", generatorRelativePath, "--check"];
  const result = runCommand(
    root,
    process.execPath,
    [generatorRelativePath, "--check"],
    [0],
    "generator",
  );
  if (result.stderr.length !== 0) fail("E02 Bundle generator wrote to stderr");
  return {
    argv,
    exitCode: result.status,
    stdout: decodeUtf8(result.stdout, "E02 Bundle generator stdout"),
    stdoutSha256: sha256(result.stdout),
  };
}

function verifyBundleReadback(root, generatorCheck, e01Freeze) {
  const manifestPath = `${bundleDirectory}/manifest.json`;
  const sidecarPath = `${bundleDirectory}/manifest.sha256`;
  const sourcePath = "docs/v2/epics/E02/PRD.md";
  const documentPath = `${bundleDirectory}/document.json`;
  const manifestBytes = readBuffer(root, manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== E02_MANIFEST_SHA256) {
    fail(
      `E02 Manifest hash is not the frozen candidate ${E02_MANIFEST_SHA256}: ${manifestSha256}`,
    );
  }
  const expectedGeneratorStdout =
    `E02 bootstrap bundle verified: ${manifestSha256}\n`;
  if (generatorCheck.stdout !== expectedGeneratorStdout) {
    fail("E02 Bundle generator reported an unexpected Manifest hash");
  }
  const sidecarBytes = readBuffer(root, sidecarPath);
  const expectedSidecar = `${manifestSha256}  manifest.json\n`;
  if (!sidecarBytes.equals(Buffer.from(expectedSidecar, "utf8"))) {
    fail("E02 Manifest checksum sidecar is not an exact raw-byte match");
  }
  const manifest = readJson(root, manifestPath);
  const sourceBytes = readBuffer(root, sourcePath);
  const sourceMarkdown = decodeUtf8(sourceBytes, sourcePath);
  const sourcePrdSha256 = sha256(sourceBytes);
  const computedSectionHashes = sectionHashes(sourceMarkdown);
  const commands = verificationCommands(sourceMarkdown);
  const verificationSha256 = sha256(`${commands.join("\n")}\n`);
  const document = readJson(root, documentPath);

  if (manifest.sourcePrdSha256 !== sourcePrdSha256) fail("Manifest source PRD hash mismatch");
  if (manifest.candidate?.sourcePrdSha256 !== sourcePrdSha256) fail("Candidate source PRD hash mismatch");
  if (manifest.documents?.source?.sha256 !== sourcePrdSha256) fail("Source document hash mismatch");
  if (manifest.generator?.sha256 !== sha256(readBuffer(root, generatorRelativePath))) {
    fail("Bundle generator hash mismatch");
  }
  assertDeepEqual(manifest.sectionHashes, computedSectionHashes, "Manifest section hashes");
  assertDeepEqual(document.sectionHashes, computedSectionHashes, "structured document section hashes");
  if (document.sourcePrdSha256 !== sourcePrdSha256) fail("structured document source hash mismatch");
  assertDeepEqual(document.verification?.commands, commands, "structured verification commands");
  assertDeepEqual(manifest.verificationContract?.commands, commands, "Manifest verification commands");
  if (manifest.verificationContract?.sha256 !== verificationSha256) {
    fail("Manifest verification contract hash mismatch");
  }

  const documentPaths = {
    html: `${bundleDirectory}/approved-prd.html`,
    markdown: `${bundleDirectory}/approved-prd.md`,
    source: sourcePath,
    structured: documentPath,
  };
  const documentHashes = {};
  for (const [name, repositoryPath] of Object.entries(documentPaths)) {
    const bytes = readBuffer(root, repositoryPath);
    decodeUtf8(bytes, repositoryPath);
    const computed = sha256(bytes);
    if (manifest.documents?.[name]?.sha256 !== computed) {
      fail(`Manifest ${name} document hash mismatch`);
    }
    documentHashes[name] = computed;
  }
  if (manifest.candidate?.bundleMarkdownSha256 !== documentHashes.markdown) {
    fail("Candidate Bundle Markdown hash mismatch");
  }

  assertDeepEqual(
    Object.keys(manifest.authorityDocuments ?? {}).sort(compareUtf16),
    Object.keys(authorityPaths).sort(compareUtf16),
    "authority document set",
  );
  const authorityDocuments = {};
  const authoritySectionHashes = {};
  const authoritySectionSetSha256 = {};
  for (const [name, repositoryPath] of Object.entries(authorityPaths)) {
    const contentBytes = readBuffer(root, repositoryPath);
    const content = decodeUtf8(contentBytes, repositoryPath);
    const computed = sha256(contentBytes);
    if (manifest.authorityDocuments[name]?.sha256 !== computed) {
      fail(`authority document hash mismatch: ${name}`);
    }
    const computedSections = sectionHashes(content);
    assertDeepEqual(
      manifest.authoritySectionHashes?.[name],
      computedSections,
      `authority section hashes for ${name}`,
    );
    authorityDocuments[name] = computed;
    authoritySectionHashes[name] = computedSections;
    authoritySectionSetSha256[name] = sha256(
      `${JSON.stringify(computedSections, null, 2)}\n`,
    );
  }

  const e01Dependency = manifest.dependencyBaselines?.E01;
  if (e01Dependency?.finalCandidateCommit !== E01_BASELINE_COMMIT) {
    fail("Manifest E01 final candidate commit mismatch");
  }
  if (e01Dependency?.prd?.sha256 !== e01Freeze.prdSha256) {
    fail("Manifest E01 PRD dependency hash mismatch");
  }
  if (e01Dependency?.manifest?.sha256 !== e01Freeze.manifestSha256) {
    fail("Manifest E01 Manifest dependency hash mismatch");
  }

  return {
    authorityDocuments,
    authoritySectionHashes,
    authoritySectionSetSha256,
    documentHashes,
    generatorSha256: manifest.generator.sha256,
    manifestSha256,
    manifestSidecarSha256: sha256(sidecarBytes),
    sectionHashes: computedSectionHashes,
    sourcePrdSha256,
    structuredDocumentSha256: documentHashes.structured,
    verificationContractSha256: verificationSha256,
  };
}

function snapshotFile(root, repositoryPath) {
  const inspected = inspectFilesystemPath(root, repositoryPath, false);
  if (!inspected.exists) return { exists: false };
  const bytes = readBuffer(root, repositoryPath);
  return {
    exists: true,
    executable: (inspected.stats.mode & 0o111) !== 0,
    sha256: sha256(bytes),
    size: bytes.length,
  };
}

function verificationInputPaths(changeSet, e01Entries) {
  return [...new Set([
    ...changeSet.all,
    generatorRelativePath,
    "docs/v2/epics/E02/PRD.md",
    `${bundleDirectory}/approved-prd.html`,
    `${bundleDirectory}/approved-prd.md`,
    `${bundleDirectory}/document.json`,
    `${bundleDirectory}/manifest.json`,
    `${bundleDirectory}/manifest.sha256`,
    ...Object.values(authorityPaths),
    ...e01Entries.map(({ path }) => path),
  ])].sort(compareUtf16);
}

function captureSnapshot(root, baselineCommit, inputPaths) {
  const changeSet = collectCandidateChanges(root, baselineCommit);
  return {
    changedPaths: changeSet.all,
    headCommit: gitText(root, ["rev-parse", "HEAD"]),
    inputs: Object.fromEntries(
      inputPaths.map((repositoryPath) => [
        repositoryPath,
        snapshotFile(root, repositoryPath),
      ]),
    ),
    rawOutputHashes: changeSet.rawOutputHashes,
    tracked: changeSet.tracked,
    untracked: changeSet.untracked,
  };
}

export function verifyCandidateChanges(
  root,
  baselineCommit = E01_BASELINE_COMMIT,
) {
  validateIndexFlags(root);
  const changeSet = collectCandidateChanges(root, baselineCommit);
  validatePathPolicy(changeSet);
  validateRawModes(changeSet);
  validateFilesystemPaths(root, changeSet);
  validateWhitespace(root, baselineCommit, changeSet);
  return changeSet;
}

export function verifyE02Worktree(root = repositoryRoot) {
  const { headCommit } = resolveRepositoryAndBaseline(root, E01_BASELINE_COMMIT);
  const changeSet = verifyCandidateChanges(root, E01_BASELINE_COMMIT);
  const e01Entries = baselineE01Entries(root, E01_BASELINE_COMMIT);
  const inputPaths = verificationInputPaths(changeSet, e01Entries);
  const before = captureSnapshot(root, E01_BASELINE_COMMIT, inputPaths);
  const e01Freeze = verifyE01Freeze(
    root,
    E01_BASELINE_COMMIT,
    headCommit,
    e01Entries,
  );
  const generatorCheck = runBundleGeneratorCheck(root);
  const bundle = verifyBundleReadback(root, generatorCheck, e01Freeze);
  const after = captureSnapshot(root, E01_BASELINE_COMMIT, inputPaths);
  assertDeepEqual(after, before, "pre/post verification worktree snapshot");

  return {
    schemaVersion: 1,
    verifier: "scripts/verify-e02-worktree.mjs",
    status: "verified",
    baseline: {
      requiredCommit: E01_BASELINE_COMMIT,
      headCommit,
      descendant: true,
      e01: e01Freeze,
    },
    changedPaths: {
      all: changeSet.all,
      tracked: changeSet.tracked,
      untracked: changeSet.untracked,
    },
    hygiene: {
      allowlist: "exact",
      candidateUntrackedPolicy: "repository-gitignore-only",
      trackedWhitespace: "clean-relative-to-baseline",
      untrackedWhitespace: "clean-no-index",
      regularFilesOnly: true,
      prePostSnapshotEqual: true,
    },
    bundle: {
      generatorCheck: {
        argv: generatorCheck.argv,
        exitCode: generatorCheck.exitCode,
        stdoutSha256: generatorCheck.stdoutSha256,
        stdoutTail: generatorCheck.stdout.trimEnd(),
      },
      ...bundle,
    },
    tools: {
      git: gitText(root, ["--version"]),
      node: process.version,
    },
  };
}

function invokedAsMain() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(scriptPath);
  } catch {
    return resolve(process.argv[1]) === resolve(scriptPath);
  }
}

if (invokedAsMain()) {
  if (process.argv.length !== 2) {
    process.stderr.write("Usage: node scripts/verify-e02-worktree.mjs\n");
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(verifyE02Worktree(), null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`E02 worktree verification failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
