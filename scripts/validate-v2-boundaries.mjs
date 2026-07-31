import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import ts from "typescript";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const WORKSPACES = [
  { directory: "packages/v2-domain", name: "@pi-workflow/v2-domain", kind: "production", allowed: [] },
  { directory: "packages/v2-protocol", name: "@pi-workflow/v2-protocol", kind: "production", allowed: ["@pi-workflow/v2-domain"] },
  { directory: "packages/v2-testkit", name: "@pi-workflow/v2-testkit", kind: "testkit", allowed: ["@pi-workflow/v2-domain", "@pi-workflow/v2-protocol"] },
  { directory: "apps/workflowd", name: "@pi-workflow/workflowd", kind: "application", allowed: ["@pi-workflow/v2-domain", "@pi-workflow/v2-protocol"] },
  { directory: "apps/workflow-worker", name: "@pi-workflow/workflow-worker", kind: "application", allowed: ["@pi-workflow/v2-domain", "@pi-workflow/v2-protocol"] },
];
const WORKSPACE_BY_NAME = new Map(WORKSPACES.map((workspace) => [workspace.name, workspace]));
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

function readJson(path, errors) {
  try {
    return JSON.parse(requireText(path));
  } catch (error) {
    errors.push(`${relative(repositoryRoot, path)} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

function requireText(path) {
  // All validator reads are synchronous so validation returns a deterministic error list.
  // eslint-disable-next-line no-sync
  return readFileSync(path, "utf8");
}

// Node ESM has no global require; retain sync traversal without a loader dependency.
import { readFileSync, readdirSync, statSync } from "node:fs";

function pathsEqual(left, right) {
  return resolve(left) === resolve(right);
}

function isInside(child, parent) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function internalDependencies(manifest) {
  const names = new Set();
  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (WORKSPACE_BY_NAME.has(name)) names.add(name);
    }
  }
  return names;
}

function allDeclaredInternalDependencies(manifest) {
  const names = internalDependencies(manifest);
  for (const field of ["devDependencies", "peerDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (WORKSPACE_BY_NAME.has(name)) names.add(name);
    }
  }
  return names;
}

function referenceDirectories(tsconfig, workspaceDirectory, errors, label) {
  if (tsconfig.references === undefined) return new Set();
  if (!Array.isArray(tsconfig.references)) {
    errors.push(`${label} tsconfig.json references must be an array when present.`);
    return new Set();
  }
  const targets = new Set();
  for (const reference of tsconfig.references) {
    if (!reference || typeof reference.path !== "string") {
      errors.push(`${label} has an invalid TypeScript project reference.`);
      continue;
    }
    targets.add(resolve(workspaceDirectory, reference.path));
  }
  return targets;
}

function packageExportPaths(exportsField) {
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) return new Map();
  const paths = new Map();
  for (const [key, value] of Object.entries(exportsField)) {
    if (typeof value === "string") paths.set(key, [value]);
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      paths.set(key, Object.values(value).filter((candidate) => typeof candidate === "string"));
    }
  }
  return paths;
}

function isPublicSpecifier(specifier, packageName, manifest) {
  const subpath = specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
  return packageExportPaths(manifest.exports).has(subpath);
}

function sourceFiles(directory) {
  const paths = [];
  if (!existsSync(directory)) return paths;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...sourceFiles(path));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) paths.push(path);
  }
  return paths;
}

function importSpecifiers(path) {
  const source = ts.createSourceFile(path, requireText(path), ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const addModuleSpecifier = (node) => {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) addModuleSpecifier(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) addModuleSpecifier(node.moduleReference.expression);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) addModuleSpecifier(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function validateExports(workspace, manifest, errors) {
  const exports = packageExportPaths(manifest.exports);
  const publicEntry = exports.get(".");
  if (!publicEntry) {
    errors.push(`${workspace.name} must export a public "." entrypoint.`);
    return;
  }
  const values = new Set(publicEntry);
  if (!values.has("./dist/index.js") || !values.has("./dist/index.d.ts")) {
    errors.push(`${workspace.name} public export must expose ./dist/index.js and ./dist/index.d.ts.`);
  }
  for (const [subpath, paths] of exports) {
    if (!subpath.startsWith(".") || paths.some((path) => !path.startsWith("./dist/") || path.includes(".."))) {
      errors.push(`${workspace.name} exports must expose only generated dist paths.`);
    }
  }
}

export function validateV2Boundaries(root = repositoryRoot) {
  const errors = [];
  const rootManifest = readJson(join(root, "package.json"), errors);
  if (!rootManifest) return errors;
  if (rootManifest.name !== "pi-workflow") errors.push("Root package.json must remain pi-workflow.");
  const workspacePatterns = new Set(rootManifest.workspaces ?? []);
  for (const expectedPattern of ["apps/*", "packages/*"]) {
    if (!workspacePatterns.has(expectedPattern)) errors.push(`Root workspaces must include ${expectedPattern}.`);
  }

  const rootTsconfig = readJson(join(root, "tsconfig.v2.json"), errors);
  const rootReferences = new Set();
  if (rootTsconfig) {
    for (const reference of rootTsconfig.references ?? []) {
      if (!reference || typeof reference.path !== "string") {
        errors.push("tsconfig.v2.json has an invalid project reference.");
        continue;
      }
      rootReferences.add(resolve(root, reference.path));
    }
  }

  const manifests = new Map();
  for (const workspace of WORKSPACES) {
    const directory = join(root, workspace.directory);
    const manifest = readJson(join(directory, "package.json"), errors);
    const tsconfig = readJson(join(directory, "tsconfig.json"), errors);
    if (!manifest || !tsconfig) continue;
    manifests.set(workspace.name, manifest);

    if (!pathsEqual(resolve(root, workspace.directory), directory)) errors.push(`${workspace.name} has an invalid workspace directory.`);
    if (manifest.name !== workspace.name) errors.push(`${workspace.directory} must be named ${workspace.name}.`);
    if (manifest.private !== true || manifest.type !== "module") errors.push(`${workspace.name} must be private native ESM.`);
    validateExports(workspace, manifest, errors);
    if (!rootReferences.has(directory)) errors.push(`tsconfig.v2.json must reference ${workspace.directory}.`);

    const dependencyNames = internalDependencies(manifest);
    const declaredDependencyNames = allDeclaredInternalDependencies(manifest);
    const referencePaths = referenceDirectories(tsconfig, directory, errors, workspace.name);
    const referencedNames = new Set();
    for (const referencePath of referencePaths) {
      const target = WORKSPACES.find((candidate) => pathsEqual(join(root, candidate.directory), referencePath));
      if (!target) errors.push(`${workspace.name} references a non-workspace project: ${relative(root, referencePath)}.`);
      else referencedNames.add(target.name);
    }
    for (const dependencyName of dependencyNames) {
      if (!referencedNames.has(dependencyName)) errors.push(`${workspace.name} declares ${dependencyName} without its TypeScript project reference.`);
    }
    for (const referenceName of referencedNames) {
      if (!dependencyNames.has(referenceName)) errors.push(`${workspace.name} references ${referenceName} without declaring it in dependencies.`);
    }
    for (const targetName of dependencyNames) {
      if (!workspace.allowed.includes(targetName)) errors.push(`${workspace.name} has forbidden dependency edge to ${targetName}.`);
      const target = WORKSPACE_BY_NAME.get(targetName);
      if (workspace.kind === "production" && target?.kind === "testkit") errors.push(`${workspace.name} production dependency cannot target testkit.`);
      if (workspace.kind === "application" && target?.kind === "application") errors.push(`${workspace.name} applications cannot depend on one another.`);
    }

    for (const sourceRoot of ["src", "test"]) {
      for (const path of sourceFiles(join(directory, sourceRoot))) {
        const productionSource = sourceRoot === "src";
        for (const specifier of importSpecifiers(path)) {
          if (specifier.startsWith(".")) {
            const target = resolve(dirname(path), specifier);
            const foreignWorkspace = WORKSPACES.find((candidate) => isInside(target, join(root, candidate.directory)) && candidate.name !== workspace.name);
            if (foreignWorkspace) errors.push(`${relative(root, path)} relative import crosses into ${foreignWorkspace.name}: ${specifier}.`);
            continue;
          }
          const targetWorkspace = WORKSPACES.find((candidate) => specifier === candidate.name || specifier.startsWith(`${candidate.name}/`));
          if (!targetWorkspace) continue;
          const targetManifest = manifests.get(targetWorkspace.name) ?? readJson(join(root, targetWorkspace.directory, "package.json"), errors);
          if (targetManifest && !isPublicSpecifier(specifier, targetWorkspace.name, targetManifest)) errors.push(`${relative(root, path)} deep-imports non-exported ${specifier}.`);
          if (targetWorkspace.name === workspace.name) continue;
          if (!declaredDependencyNames.has(targetWorkspace.name)) errors.push(`${relative(root, path)} imports undeclared internal dependency ${targetWorkspace.name}.`);
          if (productionSource && workspace.kind === "production" && targetWorkspace.kind === "testkit") errors.push(`${relative(root, path)} production source cannot import testkit.`);
          if (workspace.kind === "application" && targetWorkspace.kind === "application") errors.push(`${relative(root, path)} applications cannot import one another.`);
        }
      }
    }
  }

  for (const workspace of WORKSPACES) {
    const directory = resolve(root, workspace.directory);
    if (!rootReferences.has(directory)) errors.push(`tsconfig.v2.json is missing ${workspace.directory}.`);
  }
  if (rootReferences.size !== WORKSPACES.length) errors.push("tsconfig.v2.json must reference exactly the five approved V2 workspaces.");
  return errors;
}

async function mutateJson(path, mutate) {
  const value = JSON.parse(await readFile(path, "utf8"));
  mutate(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function runNegativeFixtureTests(root) {
  const fixture = await mkdtemp(join(tmpdir(), "pi-workflow-v2-boundary-"));
  try {
    await cp(root, fixture, {
      recursive: true,
      filter: (path) => ![".git", ".beads", "node_modules", "dist"].includes(path.split(sep).at(-1)),
    });
    const cases = [
      ["application-to-application dependency", async (candidate) => {
        await mutateJson(join(candidate, "apps/workflowd/package.json"), (manifest) => { manifest.dependencies["@pi-workflow/workflow-worker"] = "file:../workflow-worker"; });
        await mutateJson(join(candidate, "apps/workflowd/tsconfig.json"), (config) => { config.references.push({ path: "../workflow-worker" }); });
      }],
      ["production-to-testkit dependency", async (candidate) => {
        await mutateJson(join(candidate, "packages/v2-protocol/package.json"), (manifest) => { manifest.dependencies["@pi-workflow/v2-testkit"] = "file:../v2-testkit"; });
        await mutateJson(join(candidate, "packages/v2-protocol/tsconfig.json"), (config) => { config.references.push({ path: "../v2-testkit" }); });
      }],
      ["relative deep import", async (candidate) => {
        await writeFile(join(candidate, "apps/workflowd/src/forbidden.ts"), 'import "../../../packages/v2-domain/src/index.js";\n');
      }],
      ["dependency/reference disagreement", async (candidate) => {
        await mutateJson(join(candidate, "packages/v2-protocol/tsconfig.json"), (config) => { config.references = []; });
      }],
      ["source export", async (candidate) => {
        await mutateJson(join(candidate, "packages/v2-domain/package.json"), (manifest) => { manifest.exports["."].import = "./src/index.ts"; });
      }],
    ];
    for (const [label, mutate] of cases) {
      const candidate = await mkdtemp(join(tmpdir(), "pi-workflow-v2-boundary-case-"));
      try {
        await cp(fixture, candidate, { recursive: true });
        await mutate(candidate);
        assert.ok(validateV2Boundaries(candidate).length > 0, `negative fixture was accepted: ${label}`);
      } finally {
        await rm(candidate, { recursive: true, force: true });
      }
    }
    return cases.length;
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

const errors = validateV2Boundaries(repositoryRoot);
if (errors.length > 0) {
  console.error("V2 boundary validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  const negativeCases = await runNegativeFixtureTests(repositoryRoot);
  console.log(`V2 boundary validation passed for ${WORKSPACES.length} workspaces; ${negativeCases} negative fixture mutations were rejected.`);
}
