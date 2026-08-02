#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const E02_CANDIDATE_COMMIT =
  "536d98693506fc30ea2388d61e135e8c81262813";
export const E02_MANIFEST_SHA256 =
  "95a111697d11d867c9a28368b9d8edf4bcc6dd4da716f9a93347264cec3096c8";
export const E70_MANIFEST_SHA256 =
  "a51426d4280ce25e6fd1a37db2265ce08a5de0c5dbf0799cbc8e3f2daceaeac3";
export const E70_SOURCE_PRD_SHA256 =
  "8a549a06f13e708adf468fd4eb3e3905c25094737f6b4f61d1cd7efee9978593";
export const E70_GENERATOR_SHA256 =
  "b5c306d265481821a8bed2198bb82849b1cf6144a32e6f1ffb541275539f8032";
export const E70_PUBLIC_EXPORT_CONTRACT_SHA256 =
  "79fa146cb2bcf561a0df63a3ab2ad5532f1584c4a0eface9896c9f1ceb473d5b";
export const E70_VERIFICATION_CONTRACT_SHA256 =
  "ab63bc83427bf4439af6d45c62811b78299ce9df9cda4592beeb3ad86777913c";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const generatorPath = "docs/v2/epics/E70/generate-bundle.mjs";
const e70Directory = "docs/v2/epics/E70";
const bundleDirectory = `${e70Directory}/bundle`;
const e02TestPath = "packages/v2-domain/test/t5-worktree-verifier.test.mjs";
const e02AttackMarker =
  'test("E02 verifier uses NUL-safe paths and rejects the attack matrix", async (t) => {';
const E02_ATTACK_SUFFIX_SHA256 =
  "6efc305207551ac94afb053b4d070d0cf3702def576d50662bb4dce076f5dac1";
const E02_FINAL_T5_TEST_SHA256 =
  "93695c0f43f97ec0f477e279fb0c3bd4c51c98f9fa02ad5116cabbf309a50946";

const frozenIntegrationFiles = {
  "package.json":
    "e0a332901724e9967905bc6529fed8bf9b6ac406ebd57bd3c65b6cd9be68d4d6",
  "package-lock.json":
    "670862a34e784dfe663d8c2ea7851d9e9b5ec8e40c3d69926b527dee2a23d1d5",
  "tsconfig.v2.json":
    "c8e9313feb98d7940135961129cc7eab03124636ec35e879fecc31d35e7f5d8d",
  "scripts/validate-v2-boundaries.mjs":
    "5fe5a2fe94c61ba528ca4d5643cf456e8963cf62c5af33fb71951968ea6bdee0",
  "scripts/clean-v2-output.mjs":
    "3bc8bf54d216da86ed608b40e63ae9666ae8a3a9ba7a90883a477195a313567a",
  "packages/v2-readiness/package.json":
    "e1b3b4f22904cae51f5528d58661db00ab62d208a22af0f63646633852ae753f",
  "packages/v2-readiness/tsconfig.json":
    "d87e5505d716d62a94b9b12f1db75d2c7dc6761ee397314d8eeb6bd77a532396",
};

const expectedIgnoredReadinessOutputs = new Set([
  "packages/v2-readiness/dist/.tsbuildinfo",
  ...[
    "assessment",
    "candidate",
    "evidence",
    "freshness",
    "index",
    "internal",
    "qualification",
    "types",
  ].flatMap((name) => [
    `packages/v2-readiness/dist/${name}.d.ts`,
    `packages/v2-readiness/dist/${name}.d.ts.map`,
    `packages/v2-readiness/dist/${name}.js`,
    `packages/v2-readiness/dist/${name}.js.map`,
  ]),
]);

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
  "package-lock.json",
  "tsconfig.v2.json",
  "scripts/validate-v2-boundaries.mjs",
  "scripts/clean-v2-output.mjs",
  "scripts/verify-e70-worktree.mjs",
  e02TestPath,
  "docs/v2/ARCHITECTURE_RFC.md",
  "docs/v2/INITIAL_EPIC_MAP.md",
  "docs/v2/INITIATIVE_CHARTER.md",
  "docs/v2/THIRD_PARTY_REUSE_SURVEY.md",
]);

const allowedPathPrefixes = [
  "packages/v2-readiness/",
  `${e70Directory}/`,
];

const authorityPaths = {
  "ARCHITECTURE_RFC.md": "docs/v2/ARCHITECTURE_RFC.md",
  "INITIAL_EPIC_MAP.md": "docs/v2/INITIAL_EPIC_MAP.md",
  "INITIATIVE_CHARTER.md": "docs/v2/INITIATIVE_CHARTER.md",
  "THIRD_PARTY_REUSE_SURVEY.md": "docs/v2/THIRD_PARTY_REUSE_SURVEY.md",
};

const frozenE02Files = {
  "docs/v2/epics/E02/PRD.md":
    "b61d2642e66183a8eb772d9986fffbf4f56fe7932b1a016c279fe2845c136b58",
  "docs/v2/epics/E02/bundle/approved-prd.html":
    "6cef1e148b95e15431a4eb7bcaea8b7d3de2bd1951bfc96de7334b024e872aa2",
  "docs/v2/epics/E02/bundle/approved-prd.md":
    "cb8c8c0f1f896df0c34c41829e7b983e253af08257541428107a33715ae362dd",
  "docs/v2/epics/E02/bundle/document.json":
    "06cc409d2889fb7df1a64695f892ab3df19bd9df27d8fd011bccbc25cd82b5d5",
  "docs/v2/epics/E02/bundle/manifest.json": E02_MANIFEST_SHA256,
  "docs/v2/epics/E02/bundle/manifest.sha256":
    "856c95bcd9c7013162d25af9e3ce411a2e011d17211d4de63bee8a0530814811",
  "docs/v2/epics/E02/generate-bundle.mjs":
    "c6763b06453567231cade5b6c72dbe5910bec621b8c560b49a3fd6f240e10ac6",
  "packages/v2-domain/package.json":
    "38706602e92fe1c6348fa7f6b94cba467085b8056fcc7670f2d84ade5d0d0a29",
  "packages/v2-domain/src/index.ts":
    "04bcc42725ed99305cd8b50ee9404182edb13e173d8792e1f278d04371179e95",
  "packages/v2-domain/tsconfig.json":
    "4a0c5c3f0d1070b48a54f454a4ad0429f582f91c3271b94d5ea36c407bd81575",
  "scripts/verify-e02-worktree.mjs":
    "6d9f3f26e879e334294346aeb09638b90ce740181edc40850064f330ec59de0d",
};

const e02GeneratedFiles = {
  "packages/v2-domain/dist/index.d.ts":
    "78c0f4a0dd675075b1c3cee08d3005aacd38885638508acdca472d41d38f566c",
  "packages/v2-domain/dist/index.js":
    "86203fd6c4ecae5f0f7654483cedd354e4d22c949ed0005095ad6094446f1077",
};

const expectedE02RuntimeExports = [
  "INITIAL_REVISION",
  "applyPrimitiveTransition",
  "canonicalizeJson",
  "checkSingleDimensionConformance",
  "createRevisionEnvelope",
  "isTypedDomainRejection",
  "parseScalar",
  "validateHierarchy",
  "validateOwnershipNext",
  "validateRevisionEnvelope",
];

const expectedE70RuntimeExports = [
  "assessReadiness",
  "createGovernanceEvidence",
  "createReadinessCandidateBinding",
  "projectReadinessFreshness",
  "qualifyReadinessForConsumption",
];

const expectedVerificationCommands = [
  "npm run clean:v2",
  "npm run build:v2",
  "npm run typecheck:v2",
  "npm run test:v2",
  "npm run validate:v2-boundaries",
  "node docs/v2/epics/E70/generate-bundle.mjs --check",
  "node scripts/verify-e70-worktree.mjs",
  "npm pack --dry-run --workspace @pi-workflow/v2-readiness",
  "git diff --check",
];

function fail(message) {
  throw new Error(message);
}

function compareUtf16(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function quotePath(path) {
  return JSON.stringify(path);
}

function decodeUtf8(buffer, label) {
  try {
    return utf8Decoder.decode(buffer);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

function readBuffer(root, path) {
  return readFileSync(join(root, ...path.split("/")));
}

function readText(root, path) {
  return decodeUtf8(readBuffer(root, path), path);
}

function readJson(root, path) {
  try {
    return JSON.parse(readText(root, path));
  } catch (error) {
    fail(`${quotePath(path)} is not valid JSON: ${error.message}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) fail(`${label} does not match`);
}

export function parseNulFields(buffer, label = "NUL-delimited output") {
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0) fail(`${label} is missing its final NUL delimiter`);
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

function commandEnvironment(kind) {
  const environment = { ...process.env, LANG: "C", LC_ALL: "C" };
  if (kind === "git") {
    for (const name of Object.keys(environment)) {
      if (name.startsWith("GIT_")) delete environment[name];
    }
    Object.assign(environment, {
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      PAGER: "cat",
    });
  }
  if (kind === "generator" || kind === "module") {
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
  }
  return environment;
}

function commandOutputTail(buffer) {
  return decodeUtf8(buffer, "command output").trimEnd().split("\n").slice(-20).join("\n");
}

function runCommand(root, command, args, statuses = [0], kind = "default") {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: null,
    env: commandEnvironment(kind),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`${command} could not run: ${result.error.message}`);
  if (!statuses.includes(result.status)) {
    const output = Buffer.concat([result.stdout, result.stderr]);
    fail(`${command} ${args.join(" ")} exited ${String(result.status)}` +
      (output.length === 0 ? "" : `:\n${commandOutputTail(output)}`));
  }
  return result;
}

function runGit(root, args, statuses = [0]) {
  return runCommand(root, "git", [
    "-c", "core.fsmonitor=false",
    "-c", "core.attributesFile=/dev/null",
    "-c", "diff.external=",
    ...args,
  ], statuses, "git");
}

function gitText(root, args) {
  const result = runGit(root, args);
  if (result.stderr.length !== 0) fail(`git ${args.join(" ")} wrote to stderr`);
  return decodeUtf8(result.stdout, `git ${args.join(" ")} output`).trimEnd();
}

function assertSafeGitEnvironment() {
  for (const name of forbiddenGitEnvironmentVariables) {
    if (Object.hasOwn(process.env, name)) fail(`unsafe Git environment variable is set: ${name}`);
  }
  for (const name of Object.keys(process.env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) {
      fail(`unsafe Git environment variable is set: ${name}`);
    }
  }
}

function validateRepositoryPath(path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) {
    fail(`invalid repository-relative path: ${JSON.stringify(path)}`);
  }
  const components = path.split("/");
  if (components.some((part) => part === "" || part === "." || part === "..")) {
    fail(`invalid repository path components: ${quotePath(path)}`);
  }
  return components;
}

function parseNameStatus(buffer, label) {
  const fields = parseNulFields(buffer, label);
  if (fields.length % 2 !== 0) fail(`${label} has an incomplete record`);
  const records = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if (!/^[ACDMTUXB]$/.test(status)) fail(`unsupported tracked status ${status}`);
    if (status === "U") fail(`unmerged tracked path is forbidden: ${quotePath(path)}`);
    records.push({ path, status });
  }
  return records.sort((left, right) => compareUtf16(left.path, right.path));
}

function parseRawDiff(buffer, label) {
  const fields = parseNulFields(buffer, label);
  if (fields.length % 2 !== 0) fail(`${label} has an incomplete record`);
  const records = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index];
    const path = fields[index + 1];
    const match = header.match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([ACDMTUXB])$/);
    if (!match) fail(`malformed raw diff for ${quotePath(path)}: ${header}`);
    records.push({ path, oldMode: match[1], newMode: match[2], status: match[5] });
  }
  return records.sort((left, right) => compareUtf16(left.path, right.path));
}

function diffArguments(origin, format, baseline) {
  const args = ["diff"];
  if (origin === "staged") args.push("--cached");
  args.push(format, "-z", "--no-renames", "--no-ext-diff", "--no-textconv");
  if (origin === "committed") args.push(baseline, "HEAD");
  if (origin === "staged") args.push("HEAD");
  if (origin === "baseline-worktree") args.push(baseline);
  args.push("--");
  return args;
}

function collectTrackedOrigin(root, origin, baseline) {
  const names = runGit(root, diffArguments(origin, "--name-status", baseline));
  const raw = runGit(root, diffArguments(origin, "--raw", baseline));
  const tracked = parseNameStatus(names.stdout, `${origin} name-status`);
  const modes = parseRawDiff(raw.stdout, `${origin} raw diff`);
  assertDeepEqual(
    modes.map(({ path, status }) => ({ path, status })),
    tracked,
    `${origin} raw/name-status records`,
  );
  return { modes, tracked, nameStatusSha256: sha256(names.stdout), rawSha256: sha256(raw.stdout) };
}

export function collectE70CandidateChanges(root, baseline = E02_CANDIDATE_COMMIT) {
  assertSafeGitEnvironment();
  const originNames = ["committed", "staged", "unstaged"];
  const origins = Object.fromEntries(originNames.map((origin) => [
    origin,
    collectTrackedOrigin(root, origin, baseline),
  ]));
  const baselineWorktree = collectTrackedOrigin(root, "baseline-worktree", baseline);
  const untrackedResult = runGit(root, [
    "ls-files", "--others", "-z", "--exclude-per-directory=.gitignore", "--",
  ]);
  const untracked = parseNulFields(untrackedResult.stdout, "untracked paths").sort(compareUtf16);
  if (new Set(untracked).size !== untracked.length) fail("untracked paths contain duplicates");
  const ignoredResult = runGit(root, [
    "ls-files", "--others", "--ignored", "-z", "--exclude-standard", "--",
    "packages/v2-readiness", e70Directory,
  ]);
  const ignored = parseNulFields(ignoredResult.stdout, "ignored E70 paths").sort(compareUtf16);
  if (new Set(ignored).size !== ignored.length) fail("ignored E70 paths contain duplicates");
  const all = [...new Set([
    ...untracked,
    ...originNames.flatMap((origin) => origins[origin].tracked.map(({ path }) => path)),
  ])].sort(compareUtf16);
  return {
    all,
    baselineWorktree: baselineWorktree.tracked,
    origins,
    ignored,
    ignoredSha256: sha256(ignoredResult.stdout),
    untracked,
    untrackedSha256: sha256(untrackedResult.stdout),
  };
}

function validateIgnoredPaths(root, changeSet) {
  for (const path of changeSet.ignored) {
    validateRepositoryPath(path);
    if (!expectedIgnoredReadinessOutputs.has(path)) {
      fail(`unexpected ignored E70 artifact: ${quotePath(path)}`);
    }
    inspectPath(root, path);
  }
  const existingExpected = [...expectedIgnoredReadinessOutputs]
    .filter((path) => {
      try {
        return lstatSync(join(root, ...path.split("/"))).isFile();
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    })
    .sort(compareUtf16);
  assertDeepEqual(changeSet.ignored, existingExpected, "ignored generated E70 output set");
}

function deniedPathReason(path) {
  const components = validateRepositoryPath(path);
  if (components.some((part) => part.startsWith("."))) return "hidden path";
  if (components.includes("dist")) return "generated tracked output";
  return null;
}

function validatePathPolicy(changeSet) {
  for (const path of changeSet.all) {
    const denied = deniedPathReason(path);
    if (denied !== null) fail(`forbidden changed path (${denied}): ${quotePath(path)}`);
    if (!exactAllowedPaths.has(path) && !allowedPathPrefixes.some((prefix) => path.startsWith(prefix))) {
      fail(`changed path is outside the E70 allowlist: ${quotePath(path)}`);
    }
  }
}

function validateRawModes(changeSet) {
  for (const origin of Object.values(changeSet.origins)) {
    for (const record of origin.modes) {
      for (const mode of [record.oldMode, record.newMode]) {
        if (mode === "120000") fail(`tracked symlink is forbidden: ${quotePath(record.path)}`);
        if (mode === "160000") fail(`tracked gitlink is forbidden: ${quotePath(record.path)}`);
        if (!["000000", "100644", "100755"].includes(mode)) {
          fail(`unsupported tracked mode ${mode}: ${quotePath(record.path)}`);
        }
      }
    }
  }
}

function inspectPath(root, path, required = true) {
  const components = validateRepositoryPath(path);
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (required) fail(`required path is missing: ${quotePath(path)}`);
      return { exists: false };
    }
    if (stats.isSymbolicLink()) fail(`symlink path or ancestor is forbidden: ${quotePath(path)}`);
    if (index < components.length - 1 && !stats.isDirectory()) {
      fail(`non-directory ancestor: ${quotePath(path)}`);
    }
    if (index === components.length - 1) {
      if (!stats.isFile()) fail(`path is not a regular file: ${quotePath(path)}`);
      return { exists: true, stats };
    }
  }
  fail(`could not inspect ${quotePath(path)}`);
}

function validateChangedFilesystem(root, changeSet) {
  for (const path of changeSet.all) inspectPath(root, path, false);
}

function validateIndexFlags(root) {
  const result = runGit(root, ["ls-files", "-v", "-z", "--"]);
  for (const record of parseNulFields(result.stdout, "git ls-files -v")) {
    if (!/^H /.test(record)) fail(`tracked path has unsupported index state: ${record}`);
  }
  const itaArguments = [
    "diff", "--cached", "--raw", "-z", "--no-renames", "--no-ext-diff",
    "--no-textconv", "--",
  ];
  const invisible = runGit(root, [
    ...itaArguments.slice(0, 2), "--ita-invisible-in-index", ...itaArguments.slice(2),
  ]);
  const visible = runGit(root, [
    ...itaArguments.slice(0, 2), "--ita-visible-in-index", ...itaArguments.slice(2),
  ]);
  if (!invisible.stdout.equals(visible.stdout)) {
    fail("intent-to-add index entries are forbidden");
  }
}

function validateWhitespace(root, baseline, changeSet) {
  const checks = [
    ["committed", [baseline, "HEAD"]],
    ["staged", ["--cached", "HEAD"]],
    ["unstaged", []],
    ["baseline-worktree", [baseline]],
  ];
  for (const [origin, revisions] of checks) {
    const result = runGit(root, [
      "diff", "--check", "--no-ext-diff", "--no-textconv", ...revisions, "--",
    ], [0, 2]);
    if (result.status !== 0 || result.stdout.length !== 0 || result.stderr.length !== 0) {
      fail(`${origin} tracked diff has whitespace errors`);
    }
  }
  for (const path of changeSet.untracked) {
    const result = runGit(root, [
      "diff", "--no-index", "--check", "--no-ext-diff", "--no-textconv",
      "--", "/dev/null", path,
    ], [0, 1, 2, 3]);
    if (result.stdout.length !== 0 || result.stderr.length !== 0 || ![0, 1].includes(result.status)) {
      fail(`untracked file has whitespace errors: ${quotePath(path)}`);
    }
  }
}

function resolveRepository(root) {
  const actualRoot = realpathSync(root);
  const gitRoot = realpathSync(gitText(root, ["rev-parse", "--show-toplevel"]));
  if (actualRoot !== gitRoot) fail("verifier root is not the Git worktree root");
  const baseline = gitText(root, ["rev-parse", "--verify", `${E02_CANDIDATE_COMMIT}^{commit}`]);
  if (baseline !== E02_CANDIDATE_COMMIT) fail("E02 baseline resolved unexpectedly");
  const head = gitText(root, ["rev-parse", "HEAD"]);
  if (runGit(root, ["merge-base", "--is-ancestor", baseline, head], [0, 1]).status !== 0) {
    fail(`HEAD ${head} is not a descendant of E02 baseline ${baseline}`);
  }
  if (gitText(root, ["rev-parse", "--show-object-format"]) !== "sha1") {
    fail("unsupported Git object format");
  }
  const alternates = gitText(root, ["rev-parse", "--path-format=absolute", "--git-path", "objects/info/alternates"]);
  try {
    if (lstatSync(alternates).size !== 0) fail("Git object alternates are forbidden");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const attributes = gitText(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/attributes"]);
  try {
    const stats = lstatSync(attributes);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== 0) {
      fail("Git info/attributes must be absent or an empty regular file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { baseline, head };
}

export function verifyE70CandidateChanges(root, baseline = E02_CANDIDATE_COMMIT) {
  validateIndexFlags(root);
  const changeSet = collectE70CandidateChanges(root, baseline);
  validatePathPolicy(changeSet);
  validateRawModes(changeSet);
  validateChangedFilesystem(root, changeSet);
  validateIgnoredPaths(root, changeSet);
  validateWhitespace(root, baseline, changeSet);
  return changeSet;
}

function enumerateRegularFiles(root, directoryPath) {
  const files = [];
  function visit(path) {
    const absolute = join(root, ...path.split("/"));
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) fail(`symlink in verification input: ${quotePath(path)}`);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolute).sort(compareUtf16)) visit(`${path}/${entry}`);
    } else if (stats.isFile()) files.push(path);
    else fail(`non-regular verification input: ${quotePath(path)}`);
  }
  visit(directoryPath);
  return files.sort(compareUtf16);
}

function verifyFrozenHashes(root, mapping, label) {
  const evidence = {};
  for (const [path, expected] of Object.entries(mapping)) {
    inspectPath(root, path);
    const actual = sha256(readBuffer(root, path));
    if (actual !== expected) fail(`${label} changed: ${quotePath(path)}`);
    evidence[path] = actual;
  }
  return evidence;
}

function verifyE02Freeze(root) {
  const e02Files = enumerateRegularFiles(root, "docs/v2/epics/E02");
  assertDeepEqual(e02Files, Object.keys(frozenE02Files).filter((path) =>
    path.startsWith("docs/v2/epics/E02/")).sort(compareUtf16), "frozen E02 file set");
  const files = verifyFrozenHashes(root, frozenE02Files, "frozen E02 input");
  assertDeepEqual(
    enumerateRegularFiles(root, "packages/v2-domain/src"),
    ["packages/v2-domain/src/index.ts"],
    "frozen E02 production source file set",
  );
  const generated = verifyFrozenHashes(root, e02GeneratedFiles, "frozen E02 generated contract");
  const testBytes = readBuffer(root, e02TestPath);
  if (sha256(testBytes) !== E02_FINAL_T5_TEST_SHA256) fail("final E02 T5 test bytes changed");
  const markerBytes = Buffer.from(e02AttackMarker, "utf8");
  const markerOffset = testBytes.indexOf(markerBytes);
  if (markerOffset < 0) fail("E02 attack matrix marker is missing");
  const attackSuffixSha256 = sha256(testBytes.subarray(markerOffset));
  if (attackSuffixSha256 !== E02_ATTACK_SUFFIX_SHA256) fail("E02 attack matrix bytes changed");
  const runtime = runCommand(root, process.execPath, [
    "--input-type=module", "--eval",
    'import("./packages/v2-domain/dist/index.js").then((m)=>process.stdout.write(JSON.stringify(Object.keys(m).sort())))',
  ], [0], "module");
  if (runtime.stderr.length !== 0) fail("E02 runtime export inspection wrote to stderr");
  const runtimeExports = JSON.parse(decodeUtf8(runtime.stdout, "E02 runtime exports"));
  assertDeepEqual(runtimeExports, expectedE02RuntimeExports, "E02 runtime exports");
  return { files, generated, attackSuffixSha256, runtimeExports };
}

function slugForHeading(title) {
  return title.replace(/`/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function sectionHashes(markdown) {
  const headings = [...markdown.matchAll(/^(#{1,6})[ \t]+(.+)$/gm)].map((match) => ({
    index: match.index,
    slug: slugForHeading(match[2]),
  }));
  const result = {};
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (Object.hasOwn(result, heading.slug)) fail(`duplicate Markdown heading: ${heading.slug}`);
    const end = index + 1 < headings.length ? headings[index + 1].index : markdown.length;
    result[heading.slug] = sha256(markdown.slice(heading.index, end));
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => compareUtf16(left, right)));
}

function runBundleCheck(root) {
  const manifestPath = `${bundleDirectory}/manifest.json`;
  const sidecarPath = `${bundleDirectory}/manifest.sha256`;
  const manifestBytes = readBuffer(root, manifestPath);
  if (sha256(manifestBytes) !== E70_MANIFEST_SHA256) fail("E70 approved Manifest hash changed");
  if (sha256(readBuffer(root, generatorPath)) !== E70_GENERATOR_SHA256) fail("E70 generator hash changed");
  if (sha256(readBuffer(root, `${e70Directory}/PRD.md`)) !== E70_SOURCE_PRD_SHA256) fail("E70 PRD hash changed");
  const sidecar = readBuffer(root, sidecarPath);
  if (!sidecar.equals(Buffer.from(`${E70_MANIFEST_SHA256}  manifest.json\n`, "utf8"))) {
    fail("E70 Manifest sidecar is not an exact byte match");
  }
  const result = runCommand(root, process.execPath, [generatorPath, "--check"], [0], "generator");
  if (result.stderr.length !== 0) fail("E70 Bundle generator wrote to stderr");
  const stdout = decodeUtf8(result.stdout, "E70 Bundle generator stdout");
  const expectedStdout = `E70 PRD candidate bundle verified: ${E70_MANIFEST_SHA256}\n`;
  if (stdout !== expectedStdout) fail("E70 Bundle generator stdout changed");
  return { stdout, stdoutSha256: sha256(result.stdout) };
}

function verifyBundleReadback(root, generatorCheck) {
  const manifest = readJson(root, `${bundleDirectory}/manifest.json`);
  const document = readJson(root, `${bundleDirectory}/document.json`);
  const source = readText(root, `${e70Directory}/PRD.md`);
  const sourceHash = sha256(Buffer.from(source, "utf8"));
  if (sourceHash !== E70_SOURCE_PRD_SHA256 || manifest.sourcePrdSha256 !== sourceHash ||
      manifest.candidate?.sourcePrdSha256 !== sourceHash || document.sourcePrdSha256 !== sourceHash) {
    fail("E70 source PRD readback mismatch");
  }
  const sections = sectionHashes(source);
  assertDeepEqual(manifest.sectionHashes, sections, "E70 Manifest section hashes");
  assertDeepEqual(document.sectionHashes, sections, "E70 document section hashes");
  const documentPaths = {
    html: `${bundleDirectory}/approved-prd.html`,
    markdown: `${bundleDirectory}/approved-prd.md`,
    source: `${e70Directory}/PRD.md`,
    structured: `${bundleDirectory}/document.json`,
  };
  const documentHashes = {};
  for (const [name, path] of Object.entries(documentPaths)) {
    const bytes = readBuffer(root, path);
    decodeUtf8(bytes, path);
    documentHashes[name] = sha256(bytes);
    if (manifest.documents?.[name]?.sha256 !== documentHashes[name]) fail(`E70 ${name} hash mismatch`);
  }
  if (manifest.candidate?.bundleMarkdownSha256 !== documentHashes.markdown) {
    fail("E70 Bundle Markdown hash mismatch");
  }
  const publicContract = manifest.publicExportContract;
  if (publicContract?.types?.length !== 39 || publicContract?.values?.length !== 5 ||
      new Set(publicContract.types).size !== 39 || new Set(publicContract.values).size !== 5) {
    fail("E70 public export cardinality changed");
  }
  assertDeepEqual(publicContract.values, [
    "createReadinessCandidateBinding",
    "createGovernanceEvidence",
    "assessReadiness",
    "projectReadinessFreshness",
    "qualifyReadinessForConsumption",
  ], "E70 public value export order");
  const publicText = `Types:\n${publicContract.types.join("\n")}\n\nValues:\n${publicContract.values.join("\n")}\n`;
  if (sha256(publicText) !== E70_PUBLIC_EXPORT_CONTRACT_SHA256 ||
      publicContract.sha256 !== E70_PUBLIC_EXPORT_CONTRACT_SHA256) fail("E70 public export contract hash mismatch");
  assertDeepEqual(manifest.verificationContract?.commands, expectedVerificationCommands, "E70 verification commands");
  assertDeepEqual(document.verification?.commands, expectedVerificationCommands, "E70 document verification commands");
  if (sha256(`${expectedVerificationCommands.join("\n")}\n`) !== E70_VERIFICATION_CONTRACT_SHA256 ||
      manifest.verificationContract?.sha256 !== E70_VERIFICATION_CONTRACT_SHA256) {
    fail("E70 verification contract hash mismatch");
  }
  assertDeepEqual(Object.keys(manifest.authorityDocuments ?? {}).sort(compareUtf16),
    Object.keys(authorityPaths).sort(compareUtf16), "E70 authority document set");
  const authority = {};
  for (const [name, path] of Object.entries(authorityPaths)) {
    const bytes = readBuffer(root, path);
    const content = decodeUtf8(bytes, path);
    const hash = sha256(bytes);
    if (manifest.authorityDocuments[name]?.sha256 !== hash) fail(`authority document changed: ${name}`);
    assertDeepEqual(manifest.authorityDocuments[name]?.sectionHashes, sectionHashes(content),
      `authority section hashes: ${name}`);
    authority[name] = hash;
  }
  const e02 = manifest.dependencyBaselines?.E02;
  if (e02?.finalCandidateCommit !== E02_CANDIDATE_COMMIT ||
      e02?.approvedManifest?.sha256 !== E02_MANIFEST_SHA256 ||
      e02?.prd?.sha256 !== frozenE02Files["docs/v2/epics/E02/PRD.md"] ||
      e02?.packageSource?.sha256 !== frozenE02Files["packages/v2-domain/src/index.ts"]) {
    fail("E70 Manifest E02 dependency baseline mismatch");
  }
  return {
    authority,
    documentHashes,
    generatorCheck,
    manifestSha256: E70_MANIFEST_SHA256,
    publicExportContractSha256: E70_PUBLIC_EXPORT_CONTRACT_SHA256,
    sectionHashes: sections,
    sourcePrdSha256: sourceHash,
    verificationContractSha256: E70_VERIFICATION_CONTRACT_SHA256,
  };
}

function validateReadinessSourceBoundary(root, path) {
  const text = readText(root, path);
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const sourceRoot = resolve(root, "packages/v2-readiness/src");
  const absolutePath = resolve(root, path);
  const forbiddenGlobals = new Set([
    "Bun",
    "Date",
    "Deno",
    "Function",
    "WebSocket",
    "XMLHttpRequest",
    "console",
    "crypto",
    "eval",
    "fetch",
    "global",
    "globalThis",
    "performance",
    "process",
    "queueMicrotask",
    "require",
    "setImmediate",
    "setInterval",
    "setTimeout",
  ]);

  function validateSpecifier(specifier, node) {
    if (specifier.startsWith(".")) {
      if (!specifier.endsWith(".js")) {
        fail(`E70 relative import lacks the explicit .js suffix: ${quotePath(path)}`);
      }
      const target = resolve(dirname(absolutePath), specifier);
      const targetRelative = relative(sourceRoot, target);
      if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
        fail(`E70 relative import escapes its source boundary: ${quotePath(path)}`);
      }
      return;
    }
    if (specifier === "@pi-workflow/v2-domain") return;
    if (specifier === "node:crypto") {
      if (path !== "packages/v2-readiness/src/internal.ts" || !ts.isImportDeclaration(node)) {
        fail(`node:crypto is allowed only as the internal createHash import: ${quotePath(path)}`);
      }
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (clause?.name || clause?.isTypeOnly || !bindings || !ts.isNamedImports(bindings) ||
          bindings.elements.length !== 1 || bindings.elements[0].name.text !== "createHash" ||
          bindings.elements[0].propertyName) {
        fail(`E70 node:crypto import must be exactly { createHash }: ${quotePath(path)}`);
      }
      return;
    }
    fail(`E70 source imports a forbidden module ${JSON.stringify(specifier)}: ${quotePath(path)}`);
  }

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (!ts.isStringLiteralLike(node.moduleSpecifier)) {
        fail(`E70 source has a non-literal module specifier: ${quotePath(path)}`);
      }
      validateSpecifier(node.moduleSpecifier.text, node);
    }
    if (ts.isImportEqualsDeclaration(node)) {
      fail(`E70 source uses forbidden import-equals syntax: ${quotePath(path)}`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      fail(`E70 source uses a forbidden dynamic import: ${quotePath(path)}`);
    }
    if (ts.isIdentifier(node) && forbiddenGlobals.has(node.text)) {
      fail(`E70 source references forbidden global ${node.text}: ${quotePath(path)}`);
    }
    if (ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) && node.expression.text === "Math" && node.name.text === "random") {
      fail(`E70 source references forbidden Math.random: ${quotePath(path)}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function verifyPackageContract(root) {
  for (const path of [
    "scripts/clean-v2-output.mjs",
    "scripts/validate-v2-boundaries.mjs",
    "scripts/verify-e70-worktree.mjs",
  ]) {
    inspectPath(root, path);
  }
  const manifest = readJson(root, "packages/v2-readiness/package.json");
  assertDeepEqual(manifest, {
    name: "@pi-workflow/v2-readiness",
    version: "0.0.0",
    private: true,
    type: "module",
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    scripts: {
      build: "tsc --build tsconfig.json",
      typecheck: "tsc --build tsconfig.json",
      test: "npm run build && node --test test/*.test.mjs",
    },
    dependencies: { "@pi-workflow/v2-domain": "file:../v2-domain" },
  }, "E70 package boundary");
  const tsconfig = readJson(root, "packages/v2-readiness/tsconfig.json");
  assertDeepEqual(tsconfig.references, [{ path: "../v2-domain" }], "E70 TypeScript project references");
  const rootTsconfig = readJson(root, "tsconfig.v2.json");
  const references = rootTsconfig.references.map(({ path }) => path);
  if (references.length !== 6 || !references.includes("./packages/v2-readiness")) {
    fail("root TypeScript readiness wiring is incomplete");
  }
  const rootManifest = readJson(root, "package.json");
  if (!rootManifest.scripts?.["test:v2"]?.includes("@pi-workflow/v2-readiness") ||
      rootManifest.scripts?.["validate:v2-boundaries"] !== "node scripts/validate-v2-boundaries.mjs") {
    fail("root npm readiness wiring is incomplete");
  }
  if (!readText(root, "scripts/clean-v2-output.mjs").includes('"packages/v2-readiness"') ||
      !readText(root, "scripts/validate-v2-boundaries.mjs").includes('name: "@pi-workflow/v2-readiness"')) {
    fail("root clean/boundary readiness wiring is incomplete");
  }
  const lock = readJson(root, "package-lock.json");
  if (lock.packages?.["node_modules/@pi-workflow/v2-readiness"]?.resolved !== "packages/v2-readiness" ||
      lock.packages?.["node_modules/@pi-workflow/v2-readiness"]?.link !== true ||
      lock.packages?.["packages/v2-readiness"]?.dependencies?.["@pi-workflow/v2-domain"] !== "file:../v2-domain") {
    fail("package-lock readiness wiring is incomplete");
  }
  for (const path of ["packages/v2-readiness/dist/index.js", "packages/v2-readiness/dist/index.d.ts"]) {
    inspectPath(root, path);
  }
  const runtime = runCommand(root, process.execPath, [
    "--input-type=module", "--eval",
    'import("./packages/v2-readiness/dist/index.js").then((m)=>process.stdout.write(JSON.stringify(Object.keys(m).sort())))',
  ], [0], "module");
  if (runtime.stderr.length !== 0) fail("E70 runtime export inspection wrote to stderr");
  const runtimeExports = JSON.parse(decodeUtf8(runtime.stdout, "E70 runtime exports"));
  assertDeepEqual(runtimeExports, expectedE70RuntimeExports, "E70 runtime exports");
  const sourceFiles = enumerateRegularFiles(root, "packages/v2-readiness/src");
  for (const path of sourceFiles) validateReadinessSourceBoundary(root, path);
  return { runtimeExports, sourceFiles };
}

function snapshotFile(root, path) {
  const inspected = inspectPath(root, path, false);
  if (!inspected.exists) return { exists: false };
  const bytes = readBuffer(root, path);
  return {
    exists: true,
    executable: (inspected.stats.mode & 0o111) !== 0,
    sha256: sha256(bytes),
    size: bytes.length,
  };
}

function snapshotInputPaths(root, changeSet) {
  const paths = new Set([
    ...changeSet.all,
    ...Object.keys(frozenE02Files),
    ...Object.keys(e02GeneratedFiles),
    e02TestPath,
    "package.json",
    "package-lock.json",
    "tsconfig.v2.json",
    "scripts/clean-v2-output.mjs",
    "scripts/validate-v2-boundaries.mjs",
    "scripts/verify-e70-worktree.mjs",
    ...Object.values(authorityPaths),
    ...enumerateRegularFiles(root, e70Directory),
    ...enumerateRegularFiles(root, "packages/v2-readiness"),
  ]);
  return [...paths].sort(compareUtf16);
}

function snapshot(root, paths) {
  const changes = collectE70CandidateChanges(root);
  return {
    changes,
    head: gitText(root, ["rev-parse", "HEAD"]),
    inputs: Object.fromEntries(paths.map((path) => [path, snapshotFile(root, path)])),
  };
}

export function verifyE70Worktree(root = repositoryRoot) {
  const baseline = resolveRepository(root);
  const changes = verifyE70CandidateChanges(root);
  const inputPaths = snapshotInputPaths(root, changes);
  const before = snapshot(root, inputPaths);
  const e02 = verifyE02Freeze(root);
  const integrationFiles = verifyFrozenHashes(
    root,
    frozenIntegrationFiles,
    "frozen E70 integration input",
  );
  const bundle = verifyBundleReadback(root, runBundleCheck(root));
  const packageContract = verifyPackageContract(root);
  const after = snapshot(root, inputPaths);
  assertDeepEqual(after, before, "pre/post E70 verification snapshot");
  return {
    schemaVersion: 1,
    verifier: "scripts/verify-e70-worktree.mjs",
    status: "verified",
    baseline: { requiredCommit: baseline.baseline, headCommit: baseline.head, descendant: true },
    changedPaths: { all: changes.all, untracked: changes.untracked },
    hygiene: {
      allowlist: "exact",
      hiddenPaths: "rejected",
      invalidUtf8: "rejected",
      indexFlags: "rejected",
      regularFilesOnly: true,
      trackedGeneratedOutput: "rejected",
      prePostSnapshotEqual: true,
    },
    e02,
    integrationFiles,
    bundle,
    packageContract,
    tools: { git: gitText(root, ["--version"]), node: process.version },
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
    process.stderr.write("Usage: node scripts/verify-e70-worktree.mjs\n");
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(verifyE70Worktree(), null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`E70 worktree verification failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
