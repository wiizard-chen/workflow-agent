import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

import * as domain from "@pi-workflow/v2-domain";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDirectory, "..");
const workspaceRoot = path.resolve(packageRoot, "../..");
const declarationPath = path.join(packageRoot, "dist/index.d.ts");
const sourceDirectory = path.join(packageRoot, "src");
const packageJsonPath = path.join(packageRoot, "package.json");
const packageTsconfigPath = path.join(packageRoot, "tsconfig.json");
const moduleUrl = pathToFileURL(path.join(packageRoot, "dist/index.js")).href;

const expectedValueExports = [
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
].sort();

const expectedTypeExports = [
  "PortfolioId",
  "InitiativeId",
  "EpicId",
  "DeliveryUnitId",
  "TaskId",
  "TaskAttemptId",
  "StepAttemptId",
  "RoleRunId",
  "LaunchPermitId",
  "ApprovalAttemptId",
  "ChangeRequestId",
  "RepositoryId",
  "TransitionId",
  "EvidenceRef",
  "BundleRef",
  "DecisionRef",
  "ActorRef",
  "ReasonRef",
  "DomainTimestamp",
  "TransitionName",
  "Revision",
  "PositiveOrdinal",
  "EntityIdScalarKind",
  "ScalarKind",
  "ScalarByKind",
  "ScalarResult",
  "ScalarRejection",
  "JsonPrimitive",
  "JsonValue",
  "DeepReadonly",
  "CanonicalJsonResult",
  "CanonicalJsonRejection",
  "CanonicalJsonReason",
  "ImmutableRevisionEnvelope",
  "NewRevisionEnvelopeInput",
  "EnvelopeResult",
  "EnvelopeRejection",
  "PortfolioIdentityRecord",
  "InitiativeIdentityRecord",
  "EpicIdentityRecord",
  "DeliveryUnitIdentityRecord",
  "TaskIdentityRecord",
  "HierarchyIdentityRecord",
  "TaskAttemptOwnerRef",
  "HierarchySnapshot",
  "HierarchyValidationResult",
  "HierarchyRejection",
  "HierarchyRejectionCode",
  "OwnershipValidationResult",
  "OwnershipRejection",
  "DimensionMap",
  "DimensionedDomainValue",
  "DomainTransitionContext",
  "PrimitiveTransitionRequest",
  "DomainTransitionResult",
  "DomainTransitionRecord",
  "TypedDomainRejection",
  "PrimitiveTransitionRejection",
  "SingleDimensionConformanceCase",
  "SingleDimensionConformanceResult",
  "ConformanceViolation",
  "ConformanceViolationCode",
].sort();

function compilerDiagnostics(program) {
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return diagnostics.length === 0
    ? ""
    : ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => workspaceRoot,
        getNewLine: () => "\n",
      });
}

test("TypeScript checker sees the exact 62-type and 10-value export namespaces", () => {
  assert.equal(expectedTypeExports.length, 62);
  assert.equal(new Set(expectedTypeExports).size, 62);
  assert.equal(expectedValueExports.length, 10);
  assert.equal(new Set(expectedValueExports).size, 10);
  const expectedExportNames = [
    ...expectedTypeExports,
    ...expectedValueExports,
  ].sort();
  assert.equal(expectedExportNames.length, 72);
  assert.equal(new Set(expectedExportNames).size, 72);
  const program = ts.createProgram([declarationPath], {
    exactOptionalPropertyTypes: true,
    lib: ["lib.es2022.d.ts"],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: false,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    types: [],
  });
  assert.equal(compilerDiagnostics(program), "");
  const sourceFile = program.getSourceFile(declarationPath);
  assert.ok(sourceFile);
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  assert.ok(moduleSymbol);
  const exports = checker.getExportsOfModule(moduleSymbol);
  const allNames = exports.map(({ name }) => name).sort();
  assert.equal(allNames.length, 72);
  assert.equal(new Set(allNames).size, 72);
  assert.deepEqual(allNames, expectedExportNames);
  const resolvedExports = exports.map((symbol) => ({
    exported: symbol,
    resolved: (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol)
      : symbol,
  }));
  const unclassifiedNames = resolvedExports
    .filter(({ resolved }) =>
      (resolved.flags & (ts.SymbolFlags.Value | ts.SymbolFlags.Type)) === 0)
    .map(({ exported }) => exported.name)
    .sort();
  const valueNames = exports
    .map((symbol) => ({
      exported: symbol,
      resolved: (symbol.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(symbol)
        : symbol,
    }))
    .filter(({ resolved }) => (resolved.flags & ts.SymbolFlags.Value) !== 0)
    .map(({ exported }) => exported.name)
    .sort();
  const typeNames = resolvedExports
    .filter(({ resolved }) => (resolved.flags & ts.SymbolFlags.Type) !== 0)
    .map(({ exported }) => exported.name)
    .sort();

  assert.deepEqual(unclassifiedNames, []);
  assert.deepEqual(valueNames, expectedValueExports);
  assert.deepEqual(typeNames, expectedTypeExports);
});

test("package exports exactly one public entrypoint and rejects runtime subpaths", async () => {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  assert.deepEqual(Object.keys(packageJson.exports), ["."]);
  assert.deepEqual(packageJson.exports["."], {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  });
  assert.deepEqual(Object.keys(domain).sort(), expectedValueExports);
  const blockedSubpath = [
    "@pi-workflow/v2-domain",
    "dist",
    "index.js",
  ].join("/");
  await assert.rejects(
    import(blockedSubpath),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
});

const approvedScopeIdentifiers = new Set([
  "TaskAttemptId",
  "StepAttemptId",
  "RoleRunId",
  "LaunchPermitId",
  "ApprovalAttemptId",
  "ChangeRequestId",
  "TaskAttemptOwnerRef",
  "taskAttemptId",
  "taskAttemptOwners",
]);

const forbiddenIdentifierWordSequences = [
  ["attempt", "id"],
  ["approval", "attempt"],
  ["change", "request"],
  ["task", "attempt"],
  ["lifecycle"],
  ["transition", "matrix"],
  ["supersession"],
  ["predecessor"],
  ["successor"],
  ["plan"],
  ["preflight"],
  ["readiness"],
  ["projection"],
  ["attention"],
  ["blocker"],
  ["scheduling"],
  ["eligibility"],
  ["queue"],
  ["allocation"],
  ["engineering"],
  ["delivery", "facet"],
  ["release"],
  ["outcome"],
  ["closure"],
  ["display"],
  ["persistence"],
  ["rpc"],
  ["beads"],
  ["git"],
  ["github"],
  ["runtime"],
  ["worker"],
  ["scheduler"],
  ["lease"],
  ["permission"],
  ["adapter"],
  ["clock"],
  ["process"],
  ["fetch"],
  ["web", "socket"],
  ["set", "timeout"],
  ["set", "interval"],
  ["set", "immediate"],
  ["queue", "microtask"],
  ["random", "uuid"],
  ["random", "bytes"],
];

function identifierWords(identifier) {
  return identifier
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z\d]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function containsWordSequence(words, sequence) {
  return words.some((_, index) =>
    sequence.every((word, offset) => words[index + offset] === word));
}

function isForbiddenScopeIdentifier(identifier) {
  if (approvedScopeIdentifiers.has(identifier)) return false;
  const words = identifierWords(identifier);
  return forbiddenIdentifierWordSequences.some((sequence) =>
    containsWordSequence(words, sequence));
}

function auditSource(fileName, sourceText) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const foundIdentifiers = [];
  const moduleSpecifiers = [];
  function visit(node) {
    if (ts.isIdentifier(node) && isForbiddenScopeIdentifier(node.text)) {
      foundIdentifiers.push(node.text);
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      moduleSpecifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      moduleSpecifiers.push("[dynamic-import]");
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { foundIdentifiers, moduleSpecifiers };
}

function enumerateTypeScriptSources(directory) {
  const sources = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...enumerateTypeScriptSources(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      sources.push(entryPath);
    }
  }
  return sources.sort();
}

test("source and package scope contain no deferred authority or effect surface", () => {
  const sourcePaths = enumerateTypeScriptSources(sourceDirectory);
  assert.ok(sourcePaths.length > 0);

  const configFile = ts.readConfigFile(packageTsconfigPath, ts.sys.readFile);
  assert.equal(
    configFile.error,
    undefined,
    configFile.error === undefined
      ? ""
      : ts.formatDiagnostic(configFile.error, {
          getCanonicalFileName: (fileName) => fileName,
          getCurrentDirectory: () => workspaceRoot,
          getNewLine: () => "\n",
        }),
  );
  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    packageRoot,
    undefined,
    packageTsconfigPath,
  );
  assert.equal(
    parsedConfig.errors.length,
    0,
    ts.formatDiagnostics(parsedConfig.errors, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => workspaceRoot,
      getNewLine: () => "\n",
    }),
  );
  assert.deepEqual(parsedConfig.fileNames.map((fileName) => path.resolve(fileName)).sort(), sourcePaths);

  const foundIdentifiers = [];
  const moduleSpecifiers = [];
  for (const sourceFilePath of sourcePaths) {
    const audit = auditSource(sourceFilePath, readFileSync(sourceFilePath, "utf8"));
    foundIdentifiers.push(...audit.foundIdentifiers);
    moduleSpecifiers.push(...audit.moduleSpecifiers);
  }

  assert.deepEqual([...new Set(foundIdentifiers)].sort(), []);
  assert.deepEqual(moduleSpecifiers, []);
  assert.deepEqual(
    [...new Set(auditSource("allowed-seams.ts", `
      type TaskAttemptId = string;
      type StepAttemptId = string;
      type RoleRunId = string;
      type LaunchPermitId = string;
      type ApprovalAttemptId = string;
      type ChangeRequestId = string;
      type TaskAttemptOwnerRef = { taskAttemptId: TaskAttemptId };
    `).foundIdentifiers)].sort(),
    [],
  );
  assert.deepEqual(
    [...new Set(auditSource("deferred-surfaces.ts", `
      interface ApprovalAttemptRecord {}
      type ReadinessProjection = unknown;
      const lifecyclePlan = null;
    `).foundIdentifiers)].sort(),
    ["ApprovalAttemptRecord", "ReadinessProjection", "lifecyclePlan"],
  );
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.optionalDependencies, undefined);
  assert.equal(packageJson.peerDependencies, undefined);
});

test("canonical bytes are invariant across timezone, locale, environment, and cwd", () => {
  const script = `
    import { canonicalizeJson } from ${JSON.stringify(moduleUrl)};
    const entries = [
      ["😀", "emoji"],
      ["€", "Euro"],
      ["z", [-0, 333333333.33333329, 1e30, 2e-3]],
      ["stamp", "2026-08-02T00:00:00+14:00"],
      ["1", "one"],
      ["\\r", "CR"],
    ];
    if (process.env.E02_CANONICAL_NOISE === "reverse") entries.reverse();
    const input = Object.fromEntries(entries);
    String.prototype.localeCompare = () => { throw new Error("localeCompare forbidden"); };
    JSON.stringify = () => { throw new Error("JSON.stringify forbidden"); };
    const result = canonicalizeJson(input);
    if (!result.ok) throw new Error(result.rejection.reason);
    process.stdout.write(result.text);
  `;
  const expected =
    '{"\\r":"CR","1":"one","stamp":"2026-08-02T00:00:00+14:00","z":[0,333333333.3333333,1e+30,0.002],"€":"Euro","😀":"emoji"}';
  const variants = [
    {
      cwd: packageRoot,
      env: { TZ: "UTC", LANG: "C", LC_ALL: "C", E02_CANONICAL_NOISE: "forward" },
    },
    {
      cwd: "/private/tmp",
      env: { TZ: "Pacific/Kiritimati", LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8", E02_CANONICAL_NOISE: "reverse" },
    },
    {
      cwd: "/",
      env: { TZ: "America/Los_Angeles", LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8", E02_CANONICAL_NOISE: "forward" },
    },
  ];
  for (const variant of variants) {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: variant.cwd,
        encoding: "utf8",
        env: { ...process.env, ...variant.env },
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, expected);
  }
});

test("fresh-process import and every public helper produce zero observable effects", () => {
  const script = `
    import childProcess from "node:child_process";
    import crypto from "node:crypto";
    import dgram from "node:dgram";
    import fs from "node:fs";
    import http from "node:http";
    import https from "node:https";
    import net from "node:net";
    import { isDeepStrictEqual } from "node:util";

    const moduleSource = fs.readFileSync(new URL(${JSON.stringify(moduleUrl)}), "utf8");
    const instrumentedModuleUrl = "data:text/javascript;base64," + Buffer.from(moduleSource).toString("base64");
    const originalGlobalKeys = Reflect.ownKeys(globalThis);
    const originalGlobalDescriptors = Object.getOwnPropertyDescriptors(globalThis);
    const originalEnvironment = Object.fromEntries(Object.entries(process.env));
    const originalCwd = process.cwd();
    const originalEventNames = process.eventNames();
    const originalRawListeners = originalEventNames.map((eventName) => [
      eventName,
      process.rawListeners(eventName),
    ]);
    const events = [];
    const restore = [];
    function patch(object, key, replacement) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor) {
        throw new Error("required effect trap is missing: " + String(key));
      }
      if (!descriptor.configurable && !("value" in descriptor && descriptor.writable)) {
        throw new Error("required effect trap is not patchable: " + String(key));
      }
      const replacementDescriptor = "value" in descriptor
        ? { ...descriptor, value: replacement }
        : {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            value: replacement,
            writable: true,
          };
      Object.defineProperty(object, key, replacementDescriptor);
      restore.push(() => Object.defineProperty(object, key, descriptor));
    }
    function trap(name, value) {
      return (..._args) => {
        events.push(name);
        return typeof value === "function" ? value() : value;
      };
    }
    for (const key of ["readFileSync", "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync", "renameSync", "openSync", "createReadStream", "createWriteStream"]) {
      patch(fs, key, trap("fs." + key, undefined));
    }
    for (const key of ["readFile", "writeFile", "appendFile", "mkdir", "rm", "unlink", "rename", "open"]) {
      patch(fs.promises, key, trap("fs.promises." + key, Promise.resolve(undefined)));
    }
    for (const key of ["spawn", "spawnSync", "exec", "execSync", "fork"]) {
      patch(childProcess, key, trap("child_process." + key, undefined));
    }
    for (const [object, prefix, keys] of [
      [http, "http", ["request", "get", "createServer"]],
      [https, "https", ["request", "get", "createServer"]],
      [net, "net", ["connect", "createConnection", "createServer"]],
      [dgram, "dgram", ["createSocket"]],
    ]) {
      for (const key of keys) patch(object, key, trap(prefix + "." + key, undefined));
    }
    for (const key of ["randomUUID", "randomBytes", "randomInt"]) {
      patch(crypto, key, trap("crypto." + key, "generated"));
    }
    for (const key of ["setTimeout", "setInterval", "setImmediate", "queueMicrotask"]) {
      patch(globalThis, key, trap("global." + key, Object.freeze({})));
    }
    for (const key of ["fetch", "WebSocket"]) {
      if (key in globalThis) {
        patch(globalThis, key, trap("global." + key, Object.freeze({})));
      }
    }
    patch(Date, "now", trap("Date.now", 0));
    patch(Math, "random", trap("Math.random", 0.5));
    patch(JSON, "stringify", trap("JSON.stringify", "trapped"));
    patch(process, "cwd", trap("process.cwd", "/effect-trap"));
    patch(process, "chdir", trap("process.chdir", undefined));
    patch(process, "kill", trap("process.kill", true));
    patch(process, "exit", trap("process.exit", undefined));
    for (const key of ["log", "warn", "error", "info", "debug"]) {
      patch(console, key, trap("console." + key, undefined));
    }

    let thrown = null;
    let checks = null;
    let restoration = null;
    try {
      const domain = await import(instrumentedModuleUrl);
      const parsed = domain.parseScalar("TaskId", "task-1");
      const canonical = domain.canonicalizeJson({ b: 2, a: [1] });
      const created = domain.createRevisionEnvelope({ id: "task-1", kind: "task", createdAt: "c", updatedAt: "u" });
      const restored = domain.validateRevisionEnvelope({ id: "task-1", kind: "task", revision: 2, createdAt: "c", updatedAt: "u" }, { idKind: "TaskId", expectedKind: "task" });
      const hierarchy = domain.validateHierarchy({ nodes: [], taskAttemptOwners: [] });
      const ownership = domain.validateOwnershipNext(
        { id: "portfolio", kind: "portfolio", revision: 0, createdAt: "c", updatedAt: "u", ordinal: 1 },
        { id: "portfolio", kind: "portfolio", revision: 1, createdAt: "c", updatedAt: "u2", ordinal: 1 },
      );
      const previous = { id: "aggregate", kind: "work-item", revision: 1, createdAt: "c", updatedAt: "u", attributes: { owner: "a" }, dimensions: { phase: "queued", other: true } };
      const context = { transitionId: "transition", transitionName: "advance", occurredAt: "u2", actorRef: "actor", reasonRef: null, evidenceRefs: [] };
      const transition = domain.applyPrimitiveTransition({ previous, expectedRevision: 1, dimension: "phase", nextDimension: "running", context });
      const staleTransition = domain.applyPrimitiveTransition({ previous, expectedRevision: 0, dimension: "phase", nextDimension: "running", context });
      const guard = !staleTransition.ok && domain.isTypedDomainRejection(staleTransition.rejection);
      const conformance = domain.checkSingleDimensionConformance({ previous, dimension: "phase", invoke: (value, expectedRevision) => domain.applyPrimitiveTransition({ previous: value, expectedRevision, dimension: "phase", nextDimension: "running", context }) });
      checks = [parsed.ok, canonical.ok, created.ok, restored.ok, hierarchy.ok, ownership.ok, transition.ok, guard, conformance.ok];
    } catch (error) {
      thrown = String(error && error.stack || error);
    } finally {
      for (const undo of restore.reverse()) undo();
      const restoredEventNames = process.eventNames();
      restoration = {
        globalKeys: isDeepStrictEqual(Reflect.ownKeys(globalThis), originalGlobalKeys),
        globalDescriptors: isDeepStrictEqual(
          Object.getOwnPropertyDescriptors(globalThis),
          originalGlobalDescriptors,
        ),
        environment: isDeepStrictEqual(
          Object.fromEntries(Object.entries(process.env)),
          originalEnvironment,
        ),
        cwd: process.cwd() === originalCwd,
        eventNames: isDeepStrictEqual(restoredEventNames, originalEventNames),
        rawListeners: isDeepStrictEqual(
          restoredEventNames.map((eventName) => [
            eventName,
            process.rawListeners(eventName),
          ]),
          originalRawListeners,
        ),
      };
    }
    process.stdout.write(JSON.stringify({ events, thrown, checks, restoration }));
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { cwd: packageRoot, encoding: "utf8", env: { ...process.env } },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result, {
    events: [],
    thrown: null,
    checks: [true, true, true, true, true, true, true, true, true],
    restoration: {
      globalKeys: true,
      globalDescriptors: true,
      environment: true,
      cwd: true,
      eventNames: true,
      rawListeners: true,
    },
  });
});

function hierarchyNode(id, kind, ordinal, fields = {}) {
  return {
    id,
    kind,
    revision: 0,
    createdAt: "created",
    updatedAt: "updated",
    ordinal,
    ...fields,
  };
}

function hierarchyPortfolio(id, ordinal = 1) {
  return hierarchyNode(id, "portfolio", ordinal);
}

function hierarchyInitiative(id, portfolioId, ordinal = 1) {
  return hierarchyNode(id, "initiative", ordinal, { portfolioId });
}

function hierarchyEpic(
  id,
  initiativeId,
  repositoryId,
  ordinal = 1,
  fields = {},
) {
  return hierarchyNode(id, "epic", ordinal, {
    initiativeId,
    repositoryId,
    ...fields,
  });
}

test("hierarchy descriptors recover symmetric locators and ordering uses every tie-break", () => {
  let getterCalls = 0;
  const accessorNode = hierarchyInitiative("initiative", "portfolio");
  Object.defineProperty(accessorNode, "portfolioId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "portfolio";
    },
  });
  const accessorOwner = { taskAttemptId: "attempt" };
  Object.defineProperty(accessorOwner, "taskId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "task";
    },
  });
  const malformed = domain.validateHierarchy({
    nodes: [accessorNode],
    taskAttemptOwners: [accessorOwner],
  });
  assert.deepEqual(malformed, {
    ok: false,
    rejections: [
      {
        code: "invalid_record",
        path: "/nodes/0",
        id: "initiative",
        relatedId: null,
      },
      {
        code: "invalid_record",
        path: "/taskAttemptOwners/0",
        id: "attempt",
        relatedId: null,
      },
    ],
  });
  assert.equal(getterCalls, 0);
  assert.equal(Object.isFrozen(malformed), true);
  assert.equal(Object.isFrozen(malformed.rejections), true);
  assert.equal(malformed.rejections.every(Object.isFrozen), true);

  const ordered = domain.validateHierarchy({
    nodes: [
      hierarchyInitiative("initiative-z", "portfolio-a", 2),
      hierarchyPortfolio("portfolio-a", 2),
      hierarchyInitiative("initiative-for-z", "portfolio-z", 1),
      hierarchyPortfolio("portfolio-z", 1),
      hierarchyInitiative("initiative-c", "portfolio-a", 1),
      hierarchyInitiative("initiative-b", "portfolio-a", 1),
    ],
    taskAttemptOwners: [],
  });
  assert.equal(ordered.ok, true);
  assert.deepEqual(
    ordered.value.nodes.map(({ id }) => id),
    [
      "portfolio-z",
      "portfolio-a",
      "initiative-b",
      "initiative-c",
      "initiative-z",
      "initiative-for-z",
    ],
  );

  const duplicates = domain.validateHierarchy({
    nodes: [
      hierarchyPortfolio("portfolio"),
      hierarchyInitiative("initiative", "portfolio"),
      hierarchyEpic("duplicate-repository", "initiative", "repo-z"),
      hierarchyEpic("duplicate-repository", "initiative", "repo-a"),
      hierarchyEpic(
        "duplicate-canonical",
        "initiative",
        "repo",
        1,
        { revision: 1 },
      ),
      hierarchyEpic(
        "duplicate-canonical",
        "initiative",
        "repo",
        1,
        { revision: 0 },
      ),
      hierarchyEpic("duplicate-index", "initiative", "repo"),
      hierarchyEpic("duplicate-index", "initiative", "repo"),
    ],
    taskAttemptOwners: [],
  });
  assert.deepEqual(duplicates, {
    ok: false,
    rejections: [
      {
        code: "duplicate_sibling_identity",
        path: "/nodes/2",
        id: "duplicate-repository",
        relatedId: "initiative",
      },
      {
        code: "duplicate_sibling_identity",
        path: "/nodes/4",
        id: "duplicate-canonical",
        relatedId: "initiative",
      },
      {
        code: "duplicate_sibling_identity",
        path: "/nodes/7",
        id: "duplicate-index",
        relatedId: "initiative",
      },
    ],
  });

  const kindChange = domain.validateOwnershipNext(
    hierarchyPortfolio("same-id"),
    hierarchyNode("same-id", "task", 1, { deliveryUnitId: "unit" }),
  );
  assert.deepEqual(kindChange, {
    ok: false,
    rejections: [
      { code: "immutable_identity_changed", path: "/next/kind" },
    ],
  });
});

function primitivePrevious(overrides = {}) {
  return {
    id: "aggregate",
    kind: "work-item",
    revision: 2,
    createdAt: "created",
    updatedAt: "updated",
    attributes: { owner: "alpha" },
    dimensions: {
      other: true,
      phase: { rank: 1, state: "queued" },
    },
    ...overrides,
  };
}

function primitiveContext(overrides = {}) {
  return {
    transitionId: "transition",
    transitionName: "advance",
    occurredAt: "occurred",
    actorRef: "actor",
    reasonRef: null,
    evidenceRefs: [],
    ...overrides,
  };
}

function primitiveRequest(overrides = {}) {
  return {
    previous: primitivePrevious(),
    expectedRevision: 2,
    dimension: "phase",
    nextDimension: { rank: 2, state: "running" },
    context: primitiveContext(),
    ...overrides,
  };
}

test("primitive transition covers the complete first-error ladder with one exact failure", () => {
  const sparseEvidence = new Array(1);
  const exhausted = primitivePrevious({ revision: Number.MAX_SAFE_INTEGER });
  const cases = [
    [() => [], "invalid_envelope", { field: "request", constraint: "plain_object" }],
    [() => primitiveRequest({ previous: [] }), "invalid_envelope", { field: "previous", constraint: "plain_object" }],
    [() => primitiveRequest({ previous: { ...primitivePrevious(), extra: true } }), "invalid_envelope", { field: "previous", constraint: "exact_fields" }],
    [() => primitiveRequest({ previous: primitivePrevious({ id: "" }) }), "invalid_envelope", { field: "id", constraint: "non_empty_string" }],
    [() => primitiveRequest({ previous: primitivePrevious({ kind: "" }) }), "invalid_envelope", { field: "kind", constraint: "non_empty_string" }],
    [() => primitiveRequest({ previous: primitivePrevious({ createdAt: "" }) }), "invalid_envelope", { field: "createdAt", constraint: "non_empty_string" }],
    [() => primitiveRequest({ previous: primitivePrevious({ updatedAt: "" }) }), "invalid_envelope", { field: "updatedAt", constraint: "non_empty_string" }],
    [() => primitiveRequest({ previous: primitivePrevious({ revision: -1 }), expectedRevision: -1 }), "invalid_revision", { field: "previous.revision", constraint: "non_negative_safe_integer" }],
    [() => primitiveRequest({ expectedRevision: -1 }), "invalid_revision", { field: "expectedRevision", constraint: "non_negative_safe_integer" }],
    [() => primitiveRequest({ context: [] }), "invalid_transition_context", { field: "context", constraint: "plain_exact_object" }],
    [() => primitiveRequest({ context: primitiveContext({ transitionId: "" }) }), "invalid_transition_context", { field: "transitionId", constraint: "non_empty_string" }],
    [() => primitiveRequest({ context: primitiveContext({ transitionName: "" }) }), "invalid_transition_context", { field: "transitionName", constraint: "non_empty_string" }],
    [() => primitiveRequest({ context: primitiveContext({ occurredAt: "" }) }), "invalid_transition_context", { field: "occurredAt", constraint: "non_empty_string" }],
    [() => primitiveRequest({ context: primitiveContext({ actorRef: "" }) }), "invalid_transition_context", { field: "actorRef", constraint: "non_empty_string" }],
    [() => primitiveRequest({ context: primitiveContext({ reasonRef: "" }) }), "invalid_transition_context", { field: "reasonRef", constraint: "null_or_non_empty_string" }],
    [() => primitiveRequest({ context: primitiveContext({ evidenceRefs: sparseEvidence }) }), "invalid_transition_context", { field: "evidenceRefs", constraint: "dense_array_of_evidence_refs" }],
    [() => primitiveRequest({ previous: primitivePrevious({ attributes: [] }) }), "invalid_envelope", { field: "attributes", constraint: "plain_object" }],
    [() => primitiveRequest({ previous: primitivePrevious({ attributes: { invalid: undefined } }) }), "invalid_canonical_value", { target: "previous.attributes", rejection: { code: "invalid_canonical_value", path: "/invalid", reason: "unsupported_type" } }],
    [() => primitiveRequest({ previous: primitivePrevious({ dimensions: [] }) }), "invalid_envelope", { field: "dimensions", constraint: "plain_object" }],
    [() => primitiveRequest({ previous: primitivePrevious({ dimensions: { phase: { invalid: undefined } } }) }), "invalid_canonical_value", { target: "previous.dimensions", rejection: { code: "invalid_canonical_value", path: "/phase/invalid", reason: "unsupported_type" } }],
    [() => primitiveRequest({ dimension: "missing" }), "invalid_dimension", { availableDimensions: ["other", "phase"] }],
    [() => primitiveRequest({ expectedRevision: 1 }), "expected_revision_mismatch", { expected: 1, actual: 2 }],
    [() => primitiveRequest({ previous: exhausted, expectedRevision: Number.MAX_SAFE_INTEGER }), "revision_exhausted", { revision: Number.MAX_SAFE_INTEGER }],
    [() => primitiveRequest({ nextDimension: undefined }), "invalid_canonical_value", { target: "nextDimension", rejection: { code: "invalid_canonical_value", path: "", reason: "unsupported_type" } }],
    [() => primitiveRequest({ nextDimension: { state: "queued", rank: 1 } }), "unchanged_dimension", { canonicalText: '{"rank":1,"state":"queued"}' }],
  ];

  for (const [makeRequest, code, details] of cases) {
    const result = domain.applyPrimitiveTransition(makeRequest());
    assert.equal(result.ok, false);
    assert.equal(result.rejection.code, code);
    assert.deepEqual(result.rejection.details, details);
    assert.deepEqual(Object.keys(result), ["ok", "rejection"]);
    assert.equal("previous" in result, false);
    assert.equal("next" in result, false);
    assert.equal("transitionRecord" in result, false);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.rejection), true);
    assert.equal(Object.isFrozen(result.rejection.details), true);
  }
});

function freezeRecursively(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) {
      freezeRecursively(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}

function typedFailure(previous, expectedRevision, code, details) {
  return freezeRecursively({
    ok: false,
    rejection: {
      kind: "domain-rejection",
      code,
      aggregateKind: previous.kind,
      aggregateId: previous.id,
      dimension: "phase",
      transitionId: "transition",
      transitionName: "advance",
      details,
    },
  });
}

function correctConformanceSuccess(previous, expectedRevision) {
  return domain.applyPrimitiveTransition({
    previous,
    expectedRevision,
    dimension: "phase",
    nextDimension: { rank: 2, state: "running" },
    context: primitiveContext(),
  });
}

test("conformance reports exact cardinality for current failures, partials, and stale variants", () => {
  const previous = primitivePrevious();
  let calls = 0;
  const currentFailure = domain.checkSingleDimensionConformance({
    previous,
    dimension: "phase",
    invoke(value, expectedRevision) {
      calls += 1;
      return expectedRevision === value.revision
        ? typedFailure(value, expectedRevision, "invalid_dimension", {
            availableDimensions: ["other", "phase"],
          })
        : typedFailure(value, expectedRevision, "expected_revision_mismatch", {
            expected: expectedRevision,
            actual: value.revision,
          });
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(currentFailure, {
    ok: false,
    violations: [
      { code: "success_expected", path: "/invoke/0", detail: "current_revision_not_success" },
      { code: "success_expected", path: "/invoke/1", detail: "current_revision_not_success" },
    ],
  });

  const staleSuccess = domain.checkSingleDimensionConformance({
    previous,
    dimension: "phase",
    invoke(value, expectedRevision) {
      return correctConformanceSuccess(value, value.revision);
    },
  });
  assert.deepEqual(staleSuccess, {
    ok: false,
    violations: [
      {
        code: "typed_stale_rejection_missing",
        path: "/invoke/stale/rejection",
        detail: "stale_not_rejected",
      },
    ],
  });

  const staleWrongCode = domain.checkSingleDimensionConformance({
    previous,
    dimension: "phase",
    invoke(value, expectedRevision) {
      return expectedRevision === value.revision
        ? correctConformanceSuccess(value, expectedRevision)
        : typedFailure(value, expectedRevision, "invalid_dimension", {
            availableDimensions: ["other", "phase"],
          });
    },
  });
  assert.deepEqual(staleWrongCode, {
    ok: false,
    violations: [
      {
        code: "typed_stale_rejection_missing",
        path: "/invoke/stale/rejection",
        detail: "wrong_code",
      },
    ],
  });

  const stalePartial = domain.checkSingleDimensionConformance({
    previous,
    dimension: "phase",
    invoke(value, expectedRevision) {
      if (expectedRevision === value.revision) {
        return correctConformanceSuccess(value, expectedRevision);
      }
      const failure = typedFailure(
        value,
        expectedRevision,
        "expected_revision_mismatch",
        { expected: expectedRevision, actual: value.revision },
      );
      return freezeRecursively({
        ...failure,
        next: { leaked: "next" },
        previous: { leaked: "previous" },
        transitionRecord: { leaked: "record" },
      });
    },
  });
  assert.deepEqual(stalePartial, {
    ok: false,
    violations: [
      {
        code: "partial_next_on_rejection",
        path: "/invoke/stale/next",
        detail: "next_present",
      },
      {
        code: "partial_next_on_rejection",
        path: "/invoke/stale/previous",
        detail: "previous_present",
      },
      {
        code: "partial_next_on_rejection",
        path: "/invoke/stale/transitionRecord",
        detail: "record_present",
      },
    ],
  });
  assert.equal(Object.isFrozen(stalePartial), true);
  assert.equal(Object.isFrozen(stalePartial.violations), true);
  assert.equal(stalePartial.violations.every(Object.isFrozen), true);
});
