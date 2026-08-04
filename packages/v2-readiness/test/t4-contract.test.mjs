import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import * as readiness from "@pi-workflow/v2-readiness";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDirectory, "..");
const workspaceRoot = path.resolve(packageRoot, "../..");
const declarationPath = path.join(packageRoot, "dist/index.d.ts");
const packageJsonPath = path.join(packageRoot, "package.json");
const sourceDirectory = path.join(packageRoot, "src");
const typeContractConfig = path.join(testDirectory, "type-contract/tsconfig.json");

const expectedValues = [
  "assessReadiness",
  "createGovernanceEvidence",
  "createReadinessCandidateBinding",
  "projectReadinessFreshness",
  "qualifyReadinessForConsumption",
].sort();

const expectedTypes = [
  "Sha256Digest",
  "SourceRevision",
  "ReadinessSubject",
  "ReadinessApplicability",
  "CreateReadinessCandidateBindingInput",
  "ReadinessCandidateBinding",
  "EvidenceKind",
  "EvidenceProducerKind",
  "EvidenceProducer",
  "SemanticEvidencePayload",
  "QuantitativeEvidencePayload",
  "RepositoryFeasibilityEvidencePayload",
  "ApplicabilityPolicyEvidencePayload",
  "QuantitativeExceptionEvidencePayload",
  "AuthorityEvidencePayload",
  "GovernanceEvidencePayload",
  "CreateGovernanceEvidenceInput",
  "GovernanceEvidence",
  "ReadinessDisposition",
  "ReadinessReasonCode",
  "ReadinessEvidenceBinding",
  "ReadinessAssessment",
  "AssessReadinessInput",
  "ReadinessFreshness",
  "ReadinessStaleReason",
  "ReadinessEvidenceCurrentState",
  "ReadinessAssessmentHead",
  "ReadinessCurrentContext",
  "ReadinessFreshnessProjection",
  "ProjectReadinessFreshnessInput",
  "ReadinessConsumerPurpose",
  "ReadinessRequirement",
  "ReadinessQualificationReason",
  "ReadinessQualification",
  "QualifyReadinessForConsumptionInput",
  "ReadinessResult",
  "ReadinessRejectionCode",
  "ReadinessRejectionReason",
  "ReadinessRejection",
].sort();

function formatDiagnostics(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => workspaceRoot,
    getNewLine: () => "\n",
  });
}

test("public declaration namespace is exactly 39 types and 5 values", () => {
  assert.equal(expectedTypes.length, 39);
  assert.equal(new Set(expectedTypes).size, 39);
  assert.equal(expectedValues.length, 5);
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
  assert.equal(formatDiagnostics(ts.getPreEmitDiagnostics(program)), "");
  const source = program.getSourceFile(declarationPath);
  assert.ok(source);
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  assert.ok(moduleSymbol);
  const exports = checker.getExportsOfModule(moduleSymbol);
  const resolved = exports.map((symbol) => ({
    exported: symbol,
    resolved: (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol)
      : symbol,
  }));
  const values = resolved
    .filter(({ resolved: symbol }) => (symbol.flags & ts.SymbolFlags.Value) !== 0)
    .map(({ exported }) => exported.name)
    .sort();
  const types = resolved
    .filter(({ resolved: symbol }) => (symbol.flags & ts.SymbolFlags.Type) !== 0)
    .map(({ exported }) => exported.name)
    .sort();
  assert.deepEqual(values, expectedValues);
  assert.deepEqual(types, expectedTypes);
  assert.deepEqual(exports.map((item) => item.name).sort(), [...expectedTypes, ...expectedValues].sort());
});

test("positive and negative TypeScript contract fixture compiles cleanly", () => {
  const configFile = ts.readConfigFile(typeContractConfig, ts.sys.readFile);
  assert.equal(configFile.error, undefined, configFile.error ? ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n") : "");
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(typeContractConfig),
    undefined,
    typeContractConfig,
  );
  assert.equal(formatDiagnostics(parsed.errors), "");
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  assert.equal(formatDiagnostics(ts.getPreEmitDiagnostics(program)), "");
});

test("runtime and package exports expose only the approved entrypoint", async () => {
  assert.deepEqual(Object.keys(readiness).sort(), expectedValues);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  assert.deepEqual(Object.keys(packageJson.exports), ["."]);
  assert.deepEqual(packageJson.exports["."], {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  });
  assert.deepEqual(packageJson.dependencies, {
    "@pi-workflow/v2-domain": "file:../v2-domain",
  });
  const internalSubpath = ["@pi-workflow/v2-readiness", "internal"].join("/");
  await assert.rejects(
    import(internalSubpath),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
});

function sourcePaths(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...sourcePaths(target));
    if (entry.isFile() && entry.name.endsWith(".ts")) result.push(target);
  }
  return result.sort();
}

test("source dependencies stay inside the pure E70 boundary", () => {
  const specifiers = new Set();
  let dynamicImports = 0;
  for (const fileName of sourcePaths(sourceDirectory)) {
    const source = ts.createSourceFile(
      fileName,
      readFileSync(fileName, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifiers.add(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        dynamicImports += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.equal(dynamicImports, 0);
  assert.deepEqual(
    [...specifiers].filter((item) => !item.startsWith("./")).sort(),
    ["@pi-workflow/v2-domain", "node:crypto"],
  );
});

test("fresh-process import and all five values produce zero observable effects", () => {
  const script = `
    import childProcess from "node:child_process";
    import crypto from "node:crypto";
    import dgram from "node:dgram";
    import fs from "node:fs";
    import http from "node:http";
    import https from "node:https";
    import net from "node:net";
    import { isDeepStrictEqual } from "node:util";
    // Node lazily creates its internal Undici dispatcher on the first fetch
    // access. Materialize that runtime-owned symbol before taking the
    // descriptor baseline and exclude it from the contract snapshot.
    void globalThis.fetch;
    function globalDescriptorsWithoutLazyRuntimeState() {
      const descriptors = Object.getOwnPropertyDescriptors(globalThis);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === "symbol" && String(key).includes("undici.globalDispatcher")) {
          delete descriptors[key];
        }
      }
      return descriptors;
    }
    const originalKeys = Reflect.ownKeys(globalThis);
    const originalDescriptors = globalDescriptorsWithoutLazyRuntimeState();
    const originalEnvironment = Object.fromEntries(Object.entries(process.env));
    const originalCwd = process.cwd();
    const originalEvents = process.eventNames();
    const originalListeners = originalEvents.map((name) => [name, process.rawListeners(name)]);
    const events = [];
    const restore = [];
    function patch(object, key, replacement) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor) return;
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
    const trap = (name, value) => (..._args) => { events.push(name); return value; };
    // Leave openSync available to Node's ESM loader; it is runtime plumbing,
    // not an observable effect of the readiness module itself.
    for (const key of ["readFileSync", "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync", "renameSync", "createReadStream", "createWriteStream"]) patch(fs, key, trap("fs." + key));
    for (const key of ["writeFile", "appendFile", "mkdir", "rm", "unlink", "rename", "open"]) patch(fs.promises, key, trap("fs.promises." + key, Promise.resolve()));
    for (const key of ["spawn", "spawnSync", "exec", "execSync", "fork"]) patch(childProcess, key, trap("child_process." + key));
    for (const [object, prefix, keys] of [[http, "http", ["request", "get", "createServer"]], [https, "https", ["request", "get", "createServer"]], [net, "net", ["connect", "createConnection", "createServer"]], [dgram, "dgram", ["createSocket"]]]) for (const key of keys) patch(object, key, trap(prefix + "." + key));
    for (const key of ["randomUUID", "randomBytes", "randomInt"]) patch(crypto, key, trap("crypto." + key, "random"));
    for (const key of ["setTimeout", "setInterval", "setImmediate", "queueMicrotask"]) patch(globalThis, key, trap("global." + key, Object.freeze({})));
    for (const key of ["fetch", "WebSocket"]) if (key in globalThis) patch(globalThis, key, trap("global." + key, Object.freeze({})));
    patch(Date, "now", trap("Date.now", 0));
    patch(Math, "random", trap("Math.random", 0.5));
    patch(JSON, "stringify", trap("JSON.stringify", "trapped"));
    patch(process, "cwd", trap("process.cwd", "/effect-trap"));
    patch(process, "chdir", trap("process.chdir"));
    for (const key of ["log", "warn", "error", "info", "debug"]) patch(console, key, trap("console." + key));
    let thrown = null;
    let checks = null;
    let restoration = null;
    try {
      const api = await import("@pi-workflow/v2-readiness");
      patch(fs.promises, "readFile", trap("fs.promises.readFile", Promise.resolve()));
      const candidate = api.createReadinessCandidateBinding({
        subject: { kind: "epic", id: "epic:effect", revision: 1 },
        bundle: { ref: "bundle:effect", manifestSha256: "${"a".repeat(64)}" },
        repository: { id: "repository:effect", baseRevision: "base" },
        policy: { ref: "policy:effect", profileRevision: "v1" },
        requirementSet: { ref: "requirements:effect", revision: "v1" },
        applicability: "applicable",
      });
      const evidence = candidate.ok && api.createGovernanceEvidence({
        evidenceRef: "evidence:semantic",
        kind: "semantic",
        candidateSha256: candidate.value.canonicalSha256,
        sourceRef: "source:semantic",
        sourceRevision: "v1",
        producer: { kind: "deterministic_evaluator", actorRef: "actor:1", authorityEvidenceRef: null, selfReportedTrust: null },
        payload: { kind: "semantic", finding: "pass", requirementRefs: ["requirement:1"] },
      });
      const assessment = candidate.ok && api.assessReadiness({ assessmentRef: "assessment:1", candidate: candidate.value, evidence: [], history: [] });
      const current = assessment.ok && api.projectReadinessFreshness({
        assessment: assessment.value,
        current: {
          subject: assessment.value.candidate.subject,
          bundle: assessment.value.candidate.bundle,
          repository: assessment.value.candidate.repository,
          policy: assessment.value.candidate.policy,
          requirementSet: assessment.value.candidate.requirementSet,
          evidence: [],
          assessmentHead: { assessmentRef: assessment.value.assessmentRef, canonicalSha256: assessment.value.canonicalSha256 },
        },
      });
      const qualified = assessment.ok && current.ok && api.qualifyReadinessForConsumption({
        assessment: assessment.value,
        freshness: current.value,
        currentHead: { assessmentRef: assessment.value.assessmentRef, canonicalSha256: assessment.value.canonicalSha256 },
        purpose: "product_approval",
      });
      checks = [candidate.ok, evidence.ok, assessment.ok, current.ok, qualified.ok && !qualified.value.qualified];
    } catch (error) {
      thrown = String(error?.stack ?? error);
    } finally {
      for (const undo of restore.reverse()) undo();
      const eventNames = process.eventNames();
      const afterDescriptors = globalDescriptorsWithoutLazyRuntimeState();
      const descriptorKeys = new Set([
        ...Reflect.ownKeys(originalDescriptors),
        ...Reflect.ownKeys(afterDescriptors),
      ]);
      const descriptorDiffs = [...descriptorKeys].filter((key) =>
        !isDeepStrictEqual(originalDescriptors[key], afterDescriptors[key]));
      restoration = {
        keys: isDeepStrictEqual(Reflect.ownKeys(globalThis), originalKeys),
        descriptors: descriptorDiffs.length === 0,
        environment: isDeepStrictEqual(Object.fromEntries(Object.entries(process.env)), originalEnvironment),
        cwd: process.cwd() === originalCwd,
        events: isDeepStrictEqual(eventNames, originalEvents),
        listeners: isDeepStrictEqual(eventNames.map((name) => [name, process.rawListeners(name)]), originalListeners),
      };
    }
    process.stdout.write(JSON.stringify({ events, thrown, checks, restoration }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  assert.deepEqual(JSON.parse(child.stdout), {
    events: [],
    thrown: null,
    checks: [true, true, true, true, true],
    restoration: {
      keys: true,
      descriptors: true,
      environment: true,
      cwd: true,
      events: true,
      listeners: true,
    },
  });
});
