import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import * as domain from "../dist/index.js";

const {
  applyPrimitiveTransition,
  checkSingleDimensionConformance,
  isTypedDomainRejection,
} = domain;

function makePrevious(overrides = {}) {
  return {
    id: "aggregate-1",
    kind: "work-item",
    revision: 3,
    createdAt: "2026-08-02T00:00:00Z",
    updatedAt: "2026-08-02T00:01:00Z",
    attributes: {
      owner: "alpha",
      nested: { enabled: true },
    },
    dimensions: {
      phase: { state: "queued", rank: 1 },
      "a/b": { retained: true },
      "~meta": [1, 2],
    },
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return {
    transitionId: "transition-1",
    transitionName: "advance",
    occurredAt: "2026-08-02T00:02:00Z",
    actorRef: "actor-1",
    reasonRef: null,
    evidenceRefs: ["z-evidence", "a-evidence", "a-evidence"],
    ...overrides,
  };
}

function apply(previous, expectedRevision = previous.revision, overrides = {}) {
  return applyPrimitiveTransition({
    previous,
    expectedRevision,
    dimension: "phase",
    nextDimension: { state: "running", rank: 2 },
    context: makeContext(),
    ...overrides,
  });
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) {
      deepFreeze(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) {
      assertDeepFrozen(descriptor.value, seen);
    }
  }
}

function assertFailure(result, code, details) {
  assert.equal(result.ok, false);
  assert.equal(result.rejection.code, code);
  assert.deepEqual(result.rejection.details, details);
  assert.deepEqual(Object.keys(result), ["ok", "rejection"]);
  assert.equal("next" in result, false);
  assertDeepFrozen(result);
  return result.rejection;
}

function staleFailure(previous, expectedRevision) {
  return deepFreeze({
    ok: false,
    rejection: {
      kind: "domain-rejection",
      code: "expected_revision_mismatch",
      aggregateKind: previous.kind,
      aggregateId: previous.id,
      dimension: "phase",
      transitionId: "transition-1",
      transitionName: "advance",
      details: {
        expected: expectedRevision,
        actual: previous.revision,
      },
    },
  });
}

function formatDiagnostics(diagnostics, host) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: host.getCurrentDirectory,
    getNewLine: () => "\n",
  });
}

test("T3 public types reject invalid dimension members and invalid detail pairs", () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const virtualPath = path.join(testDirectory, "__t3_type_fixture__.ts");
  const source = `
    import type {
      DimensionMap,
      PrimitiveTransitionRejection,
    } from "../dist/index.js";

    interface ValidDimensions {
      phase: { state: string; note?: string };
      tuple: readonly [string, number];
      list: readonly { enabled: boolean }[];
    }
    declare const validDimensions: ValidDimensions;
    const validMap: DimensionMap<ValidDimensions> = validDimensions;
    void validMap;

    interface OptionalDimension { phase?: string }
    declare const optionalDimension: OptionalDimension;
    // @ts-expect-error optional top-level dimensions are outside the contract
    const rejectedOptional: DimensionMap<OptionalDimension> = optionalDimension;

    interface FunctionDimension { phase: { run: () => void } }
    declare const functionDimension: FunctionDimension;
    // @ts-expect-error functions are not JSON values
    const rejectedFunction: DimensionMap<FunctionDimension> = functionDimension;

    declare const nestedSymbol: unique symbol;
    interface SymbolDimension { phase: { value: string; [nestedSymbol]: string } }
    declare const symbolDimension: SymbolDimension;
    // @ts-expect-error nested symbol keys are outside the contract
    const rejectedSymbol: DimensionMap<SymbolDimension> = symbolDimension;

    interface ExplicitUndefined { phase: { value: string | undefined } }
    declare const explicitUndefined: ExplicitUndefined;
    // @ts-expect-error explicitly declared undefined remains invalid
    const rejectedUndefined: DimensionMap<ExplicitUndefined> = explicitUndefined;

    type InvalidEnvelope = Extract<PrimitiveTransitionRejection, { code: "invalid_envelope" }>;
    const validEnvelopePair: InvalidEnvelope = { kind: "domain-rejection", code: "invalid_envelope", aggregateKind: null, aggregateId: null, dimension: null, transitionId: null, transitionName: null, details: { field: "id", constraint: "non_empty_string" } };
    void validEnvelopePair;
    // @ts-expect-error id/plain_object is not a closed valid pair
    const invalidEnvelopePair: InvalidEnvelope = { kind: "domain-rejection", code: "invalid_envelope", aggregateKind: null, aggregateId: null, dimension: null, transitionId: null, transitionName: null, details: { field: "id", constraint: "plain_object" } };

    type InvalidContext = Extract<PrimitiveTransitionRejection, { code: "invalid_transition_context" }>;
    const validContextPair: InvalidContext = { kind: "domain-rejection", code: "invalid_transition_context", aggregateKind: null, aggregateId: null, dimension: null, transitionId: null, transitionName: null, details: { field: "context", constraint: "plain_exact_object" } };
    void validContextPair;
    // @ts-expect-error context/non_empty_string is not a closed valid pair
    const invalidContextPair: InvalidContext = { kind: "domain-rejection", code: "invalid_transition_context", aggregateKind: null, aggregateId: null, dimension: null, transitionId: null, transitionName: null, details: { field: "context", constraint: "non_empty_string" } };
  `;
  const options = {
    exactOptionalPropertyTypes: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(options);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) =>
    fileName === virtualPath || originalFileExists(fileName);
  host.readFile = (fileName) =>
    fileName === virtualPath ? source : originalReadFile(fileName);
  host.getSourceFile = (
    fileName,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) => fileName === virtualPath
    ? ts.createSourceFile(fileName, source, languageVersion, true)
    : originalGetSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );

  const program = ts.createProgram([virtualPath], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, formatDiagnostics(diagnostics, host));
});

test("T3 runtime exports match the approved value allowlist", () => {
  assert.deepEqual(Object.keys(domain).sort(), [
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
  ]);
});

test("primitive transition preserves independent locators before first-error selection", () => {
  const previous = { ...makePrevious(), unexpected: true };
  const context = { ...makeContext(), unexpected: true };
  const rejection = assertFailure(
    apply(previous, -1, { context, nextDimension: undefined }),
    "invalid_envelope",
    { field: "previous", constraint: "exact_fields" },
  );
  assert.deepEqual(
    {
      aggregateKind: rejection.aggregateKind,
      aggregateId: rejection.aggregateId,
      dimension: rejection.dimension,
      transitionId: rejection.transitionId,
      transitionName: rejection.transitionName,
    },
    {
      aggregateKind: "work-item",
      aggregateId: "aggregate-1",
      dimension: "phase",
      transitionId: "transition-1",
      transitionName: "advance",
    },
  );

  let getterCalls = 0;
  const accessorPrevious = makePrevious();
  Object.defineProperty(accessorPrevious, "kind", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "work-item";
    },
  });
  const accessorContext = makeContext();
  Object.defineProperty(accessorContext, "transitionId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "transition-1";
    },
  });
  const accessorRejection = assertFailure(
    apply(accessorPrevious, 3, { context: accessorContext }),
    "invalid_envelope",
    { field: "previous", constraint: "exact_fields" },
  );
  assert.equal(getterCalls, 0);
  assert.equal(accessorRejection.aggregateKind, null);
  assert.equal(accessorRejection.aggregateId, "aggregate-1");
  assert.equal(accessorRejection.transitionId, null);
  assert.equal(accessorRejection.transitionName, "advance");
});

test("primitive transition follows the exact validation ladder", () => {
  assertFailure(
    apply(makePrevious({ revision: -1 }), -1, {
      context: makeContext({ actorRef: "" }),
    }),
    "invalid_revision",
    {
      field: "previous.revision",
      constraint: "non_negative_safe_integer",
    },
  );

  assertFailure(
    apply(makePrevious(), -1, { context: makeContext({ actorRef: "" }) }),
    "invalid_revision",
    { field: "expectedRevision", constraint: "non_negative_safe_integer" },
  );

  assertFailure(
    apply(makePrevious(), 3, {
      context: makeContext({ actorRef: "", reasonRef: "" }),
    }),
    "invalid_transition_context",
    { field: "actorRef", constraint: "non_empty_string" },
  );

  const sparseEvidence = new Array(1);
  assertFailure(
    apply(makePrevious(), 3, {
      context: makeContext({ evidenceRefs: sparseEvidence }),
    }),
    "invalid_transition_context",
    { field: "evidenceRefs", constraint: "dense_array_of_evidence_refs" },
  );

  assertFailure(
    apply(
      makePrevious({
        attributes: { invalid: undefined },
        dimensions: [],
      }),
      3,
    ),
    "invalid_canonical_value",
    {
      target: "previous.attributes",
      rejection: {
        code: "invalid_canonical_value",
        path: "/invalid",
        reason: "unsupported_type",
      },
    },
  );

  assertFailure(
    apply(
      makePrevious({
        dimensions: { phase: { invalid: undefined } },
      }),
      3,
      { dimension: "missing" },
    ),
    "invalid_canonical_value",
    {
      target: "previous.dimensions",
      rejection: {
        code: "invalid_canonical_value",
        path: "/phase/invalid",
        reason: "unsupported_type",
      },
    },
  );

  assertFailure(
    apply(makePrevious(), 2, { dimension: "missing" }),
    "invalid_dimension",
    { availableDimensions: ["a/b", "phase", "~meta"] },
  );

  const exhausted = makePrevious({ revision: Number.MAX_SAFE_INTEGER });
  assertFailure(
    apply(exhausted, Number.MAX_SAFE_INTEGER - 1),
    "expected_revision_mismatch",
    {
      expected: Number.MAX_SAFE_INTEGER - 1,
      actual: Number.MAX_SAFE_INTEGER,
    },
  );
  assertFailure(
    apply(exhausted, Number.MAX_SAFE_INTEGER),
    "revision_exhausted",
    { revision: Number.MAX_SAFE_INTEGER },
  );
});

test("evidence canonicality is checked on the original array metadata", () => {
  const evidenceRefs = [];
  Object.defineProperty(evidenceRefs, "\ud800", {
    configurable: true,
    enumerable: true,
    value: "metadata",
    writable: true,
  });
  assertFailure(
    apply(makePrevious(), 3, {
      context: makeContext({ evidenceRefs }),
    }),
    "invalid_canonical_value",
    {
      target: "context.evidenceRefs",
      rejection: {
        code: "invalid_canonical_value",
        path: "",
        reason: "lone_surrogate",
      },
    },
  );
});

test("primitive success is canonical, independent, recursively frozen, and one-dimensional", () => {
  const previous = makePrevious();
  const result = apply(previous);
  assert.equal(result.ok, true);
  assertDeepFrozen(result);
  assert.notEqual(result.previous, previous);
  assert.notEqual(result.next, previous);
  assert.deepEqual(result.previous, previous);
  assert.equal(result.next.revision, 4);
  assert.equal(result.next.updatedAt, "2026-08-02T00:02:00Z");
  assert.deepEqual(result.next.dimensions.phase, { state: "running", rank: 2 });
  assert.deepEqual(result.next.dimensions["a/b"], previous.dimensions["a/b"]);
  assert.deepEqual(result.next.dimensions["~meta"], previous.dimensions["~meta"]);
  assert.deepEqual(result.next.attributes, previous.attributes);
  assert.deepEqual(result.transitionRecord, {
    kind: "domain-transition",
    transitionId: "transition-1",
    transitionName: "advance",
    aggregateKind: "work-item",
    aggregateId: "aggregate-1",
    dimension: "phase",
    beforeRevision: 3,
    afterRevision: 4,
    occurredAt: "2026-08-02T00:02:00Z",
    actorRef: "actor-1",
    reasonRef: null,
    evidenceRefs: ["a-evidence", "a-evidence", "z-evidence"],
  });

  previous.attributes.nested.enabled = false;
  previous.dimensions["~meta"].push(3);
  assert.equal(result.previous.attributes.nested.enabled, true);
  assert.deepEqual(result.next.dimensions["~meta"], [1, 2]);

  assertFailure(
    apply(makePrevious(), 2),
    "expected_revision_mismatch",
    { expected: 2, actual: 3 },
  );
  assertFailure(
    apply(makePrevious(), 3, {
      nextDimension: { rank: 1, state: "queued" },
    }),
    "unchanged_dimension",
    { canonicalText: '{"rank":1,"state":"queued"}' },
  );
});

test("primitive transition never invokes caller-overridden helper methods", () => {
  let calls = 0;
  const evidenceRefs = ["b", "a"];
  Object.defineProperty(evidenceRefs, "sort", {
    configurable: true,
    value() {
      calls += 1;
      throw new Error("external sort must not be called");
    },
  });
  const success = apply(makePrevious(), 3, {
    context: makeContext({ evidenceRefs }),
  });
  assert.equal(success.ok, true);
  assert.deepEqual(success.transitionRecord.evidenceRefs, ["a", "b"]);
  assert.equal(calls, 0);

  const attributes = { owner: "alpha" };
  Object.defineProperty(attributes, "toJSON", {
    enumerable: true,
    get() {
      calls += 1;
      return () => ({ owner: "wrong" });
    },
  });
  const rejection = apply(makePrevious({ attributes }));
  assert.equal(rejection.ok, false);
  assert.equal(rejection.rejection.code, "invalid_canonical_value");
  assert.equal(rejection.rejection.details.rejection.reason, "accessor");
  assert.equal(calls, 0);
});

test("typed rejection guard validates the complete canonical structure without accessors", () => {
  const rejection = apply(makePrevious(), 2).rejection;
  assert.equal(isTypedDomainRejection(rejection), true);
  assert.equal(isTypedDomainRejection({ ...rejection, extra: true }), false);
  assert.equal(
    isTypedDomainRejection({ ...rejection, aggregateKind: "" }),
    false,
  );

  let calls = 0;
  const accessor = { ...rejection };
  Object.defineProperty(accessor, "details", {
    enumerable: true,
    get() {
      calls += 1;
      return {};
    },
  });
  assert.equal(isTypedDomainRejection(accessor), false);
  assert.equal(calls, 0);
});

test("conformance performs exactly three independent calls for a valid implementation", () => {
  const previous = makePrevious();
  const seenPrevious = [];
  const seenRevisions = [];
  const report = checkSingleDimensionConformance({
    previous,
    dimension: "phase",
    invoke(invocationPrevious, expectedRevision) {
      seenPrevious.push(invocationPrevious);
      seenRevisions.push(expectedRevision);
      return apply(invocationPrevious, expectedRevision);
    },
  });

  assert.deepEqual(report, { ok: true });
  assertDeepFrozen(report);
  assert.deepEqual(seenRevisions, [3, 3, 4]);
  assert.equal(new Set(seenPrevious).size, 3);
  assert.equal(seenPrevious.includes(previous), false);
  assert.equal(Object.isFrozen(previous), false);
  assert.deepEqual(previous, makePrevious());
});

test("conformance invokes zero times and reports exhausted revision", () => {
  let calls = 0;
  const report = checkSingleDimensionConformance({
    previous: makePrevious({ revision: Number.MAX_SAFE_INTEGER }),
    dimension: "phase",
    invoke() {
      calls += 1;
      throw new Error("must not be invoked");
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(report, {
    ok: false,
    violations: [
      {
        code: "revision_increment_invalid",
        path: "/previous/revision",
        detail: "revision_exhausted",
      },
    ],
  });
  assertDeepFrozen(report);
});

test("conformance catches mutation and throws on every independent call and deduplicates", () => {
  let calls = 0;
  const report = checkSingleDimensionConformance({
    previous: makePrevious(),
    dimension: "phase",
    invoke(invocationPrevious) {
      calls += 1;
      invocationPrevious.attributes.owner = "mutated";
      throw new Error(`attacker text ${calls}`);
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(report, {
    ok: false,
    violations: [
      {
        code: "input_mutated",
        path: "/previous",
        detail: "previous_changed",
      },
      {
        code: "invoke_threw",
        path: "/invoke/0",
        detail: "threw",
      },
      {
        code: "invoke_threw",
        path: "/invoke/1",
        detail: "threw",
      },
      {
        code: "invoke_threw",
        path: "/invoke/stale",
        detail: "threw",
      },
    ],
  });
  assertDeepFrozen(report);
});

test("conformance classifies malformed, noncanonical, and partial failure results", () => {
  let calls = 0;
  const report = checkSingleDimensionConformance({
    previous: makePrevious(),
    dimension: "phase",
    invoke(invocationPrevious, expectedRevision) {
      const call = calls;
      calls += 1;
      if (call === 0) {
        return { ok: true };
      }
      if (call === 1) {
        const cyclic = { ok: true };
        cyclic.self = cyclic;
        return cyclic;
      }
      const failure = staleFailure(invocationPrevious, expectedRevision);
      return deepFreeze({
        ...failure,
        next: { leaked: true },
        attackerExtra: true,
      });
    },
  });

  assert.equal(calls, 3);
  assert.deepEqual(report, {
    ok: false,
    violations: [
      {
        code: "invalid_result",
        path: "/invoke/0",
        detail: "invalid_success_shape",
      },
      {
        code: "invalid_result",
        path: "/invoke/1",
        detail: "non_canonical",
      },
      {
        code: "invalid_result",
        path: "/invoke/stale",
        detail: "invalid_rejection_shape",
      },
      {
        code: "partial_next_on_rejection",
        path: "/invoke/stale/next",
        detail: "next_present",
      },
    ],
  });
  assertDeepFrozen(report);
});

test("conformance reports an untyped stale rejection at the stable rejection path", () => {
  let calls = 0;
  const report = checkSingleDimensionConformance({
    previous: makePrevious(),
    dimension: "phase",
    invoke(invocationPrevious, expectedRevision) {
      calls += 1;
      if (expectedRevision === invocationPrevious.revision) {
        return apply(invocationPrevious, expectedRevision);
      }
      return deepFreeze({
        ok: false,
        rejection: { code: "expected_revision_mismatch" },
      });
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(report, {
    ok: false,
    violations: [
      {
        code: "typed_stale_rejection_missing",
        path: "/invoke/stale/rejection",
        detail: "untyped_rejection",
      },
    ],
  });
});

test("conformance rejects an exact success whose transition record is structurally invalid", () => {
  const report = checkSingleDimensionConformance({
    previous: makePrevious(),
    dimension: "phase",
    invoke(invocationPrevious, expectedRevision) {
      if (expectedRevision !== invocationPrevious.revision) {
        return staleFailure(invocationPrevious, expectedRevision);
      }
      const success = structuredClone(
        apply(invocationPrevious, expectedRevision),
      );
      success.transitionRecord.kind = "not-domain-transition";
      return deepFreeze(success);
    },
  });
  assert.deepEqual(report, {
    ok: false,
    violations: [
      {
        code: "invalid_result",
        path: "/invoke/0",
        detail: "invalid_success_shape",
      },
      {
        code: "invalid_result",
        path: "/invoke/1",
        detail: "invalid_success_shape",
      },
    ],
  });
});

test("conformance detects exact single-dimension semantic violations with escaped paths", () => {
  const previous = makePrevious();
  const maliciousSuccess = (invocationPrevious) => {
    const valid = apply(invocationPrevious, invocationPrevious.revision);
    assert.equal(valid.ok, true);
    const result = structuredClone(valid);
    result.next.revision = invocationPrevious.revision;
    result.next.id = "aggregate-other";
    result.next.kind = "other-kind";
    result.next.createdAt = "other-created-at";
    result.next.updatedAt = "wrong-updated-at";
    result.next.attributes.owner = "changed";
    result.next.dimensions.phase = structuredClone(
      invocationPrevious.dimensions.phase,
    );
    delete result.next.dimensions["a/b"];
    result.next.dimensions["~meta"] = [9];
    result.next.dimensions["new/key"] = true;
    result.transitionRecord.aggregateKind = "other-kind";
    result.transitionRecord.aggregateId = "aggregate-other";
    result.transitionRecord.dimension = "other-dimension";
    result.transitionRecord.beforeRevision = 99;
    result.transitionRecord.afterRevision = 100;
    return deepFreeze(result);
  };

  const report = checkSingleDimensionConformance({
    previous,
    dimension: "phase",
    invoke(invocationPrevious, expectedRevision) {
      return expectedRevision === invocationPrevious.revision
        ? maliciousSuccess(invocationPrevious)
        : staleFailure(invocationPrevious, expectedRevision);
    },
  });
  assert.equal(report.ok, false);
  const keys = new Set(
    report.violations.map(
      ({ code, path, detail }) => `${code}|${path}|${detail}`,
    ),
  );
  for (const root of ["/invoke/0", "/invoke/1"]) {
    for (const expected of [
      `revision_increment_invalid|${root}/next/revision|not_plus_one`,
      `audit_field_invalid|${root}/next/id|id_changed`,
      `audit_field_invalid|${root}/next/kind|kind_changed`,
      `audit_field_invalid|${root}/next/createdAt|created_at_changed`,
      `audit_field_invalid|${root}/next/updatedAt|updated_at_mismatch`,
      `declared_dimension_unchanged|${root}/next/dimensions/phase|declared_value_equal`,
      `undeclared_dimension_changed|${root}/next/dimensions/a~1b|dimension_removed`,
      `undeclared_dimension_changed|${root}/next/dimensions/~0meta|undeclared_value_changed`,
      `undeclared_dimension_changed|${root}/next/dimensions/new~1key|dimension_added`,
      `attributes_changed|${root}/next/attributes|attributes_changed`,
      `transition_record_mismatch|${root}/transitionRecord/aggregateKind|aggregate_kind`,
      `transition_record_mismatch|${root}/transitionRecord/aggregateId|aggregate_id`,
      `transition_record_mismatch|${root}/transitionRecord/dimension|dimension`,
      `transition_record_mismatch|${root}/transitionRecord/beforeRevision|before_revision`,
      `transition_record_mismatch|${root}/transitionRecord/afterRevision|after_revision`,
    ]) {
      assert.equal(keys.has(expected), true, expected);
    }
  }
  assert.equal(
    report.violations.some(({ code }) => code === "nondeterministic_result"),
    false,
  );
  assertDeepFrozen(report);
});

test("conformance reports nondeterminism only for two classified current successes", () => {
  let currentCall = 0;
  const report = checkSingleDimensionConformance({
    previous: makePrevious(),
    dimension: "phase",
    invoke(invocationPrevious, expectedRevision) {
      if (expectedRevision !== invocationPrevious.revision) {
        return staleFailure(invocationPrevious, expectedRevision);
      }
      currentCall += 1;
      return apply(invocationPrevious, expectedRevision, {
        context: makeContext({
          transitionId: `transition-${currentCall}`,
        }),
      });
    },
  });
  assert.deepEqual(report, {
    ok: false,
    violations: [
      {
        code: "nondeterministic_result",
        path: "/invoke/1",
        detail: "result_bytes_differ",
      },
    ],
  });
});

test("conformance detects unfrozen success and rejection output objects", () => {
  const report = checkSingleDimensionConformance({
    previous: makePrevious(),
    dimension: "phase",
    invoke(invocationPrevious, expectedRevision) {
      const frozen = expectedRevision === invocationPrevious.revision
        ? apply(invocationPrevious, expectedRevision)
        : staleFailure(invocationPrevious, expectedRevision);
      return structuredClone(frozen);
    },
  });
  assert.equal(report.ok, false);
  const details = new Set(
    report.violations
      .filter(({ code }) => code === "output_not_frozen")
      .map(({ path, detail }) => `${path}|${detail}`),
  );
  assert.deepEqual(details, new Set([
    "/invoke/0|result",
    "/invoke/0/previous|previous",
    "/invoke/0/next|next",
    "/invoke/0/transitionRecord|record",
    "/invoke/1|result",
    "/invoke/1/previous|previous",
    "/invoke/1/next|next",
    "/invoke/1/transitionRecord|record",
    "/invoke/stale|result",
    "/invoke/stale/rejection|rejection",
  ]));
  assert.equal(
    report.violations.every(({ code }) => code === "output_not_frozen"),
    true,
  );
  assertDeepFrozen(report);
});
