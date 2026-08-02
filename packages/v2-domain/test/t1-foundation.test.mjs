import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_REVISION,
  canonicalizeJson,
  createRevisionEnvelope,
  parseScalar,
  validateRevisionEnvelope,
} from "@pi-workflow/v2-domain";

const stringScalarKinds = [
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
];

function assertCanonicalRejection(input, path, reason) {
  const result = canonicalizeJson(input);
  assert.deepEqual(result, {
    ok: false,
    rejection: {
      code: "invalid_canonical_value",
      path,
      reason,
    },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.rejection), true);
}

function assertEnvelopeRejection(result, field, constraint) {
  assert.deepEqual(result, {
    ok: false,
    rejection: {
      code: "invalid_envelope",
      field,
      constraint,
    },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.rejection), true);
}

function validEnvelope(overrides = {}) {
  return {
    id: "task-1",
    kind: "task",
    revision: 7,
    createdAt: "not parsed as a timestamp",
    updatedAt: "still caller supplied",
    ...overrides,
  };
}

test("parseScalar implements the closed string and number constraints", () => {
  assert.equal(INITIAL_REVISION, 0);

  for (const kind of stringScalarKinds) {
    const success = parseScalar(kind, " \t");
    assert.deepEqual(success, { ok: true, value: " \t" });
    assert.equal(Object.isFrozen(success), true);

    const rejection = parseScalar(kind, "");
    assert.deepEqual(rejection, {
      ok: false,
      rejection: {
        code: "invalid_scalar",
        scalarKind: kind,
        constraint: "non_empty_string",
      },
    });
    assert.equal(Object.isFrozen(rejection), true);
    assert.equal(Object.isFrozen(rejection.rejection), true);
  }

  for (const input of [-1, 1.5, Number.NaN, Infinity, "0", null]) {
    assert.deepEqual(parseScalar("Revision", input), {
      ok: false,
      rejection: {
        code: "invalid_scalar",
        scalarKind: "Revision",
        constraint: "non_negative_safe_integer",
      },
    });
  }

  for (const input of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    assert.deepEqual(parseScalar("PositiveOrdinal", input), {
      ok: false,
      rejection: {
        code: "invalid_scalar",
        scalarKind: "PositiveOrdinal",
        constraint: "positive_safe_integer",
      },
    });
  }

  assert.deepEqual(parseScalar("Revision", -0), { ok: true, value: -0 });
  assert.deepEqual(parseScalar("Revision", Number.MAX_SAFE_INTEGER), {
    ok: true,
    value: Number.MAX_SAFE_INTEGER,
  });
  assert.deepEqual(parseScalar("PositiveOrdinal", 1), { ok: true, value: 1 });
  assert.deepEqual(parseScalar("PositiveOrdinal", Number.MAX_SAFE_INTEGER), {
    ok: true,
    value: Number.MAX_SAFE_INTEGER,
  });
});

test("canonicalizeJson emits the RFC 8785 number and string spellings", () => {
  const numbers = canonicalizeJson([
    -0,
    333333333.33333329,
    1e30,
    4.5,
    2e-3,
    1e-27,
  ]);
  assert.equal(numbers.ok, true);
  assert.equal(
    numbers.text,
    "[0,333333333.3333333,1e+30,4.5,0.002,1e-27]",
  );

  const string = canonicalizeJson(
    "\u0000\b\t\n\f\r\"\\/ \u2028\u2029 \ud83d\ude00",
  );
  assert.equal(string.ok, true);
  assert.equal(
    string.text,
    '"\\u0000\\b\\t\\n\\f\\r\\"\\\\/ \u2028\u2029 \ud83d\ude00"',
  );
});

test("canonicalizeJson sorts object names by UTF-16 code units", () => {
  const result = canonicalizeJson({
    "\u20ac": "Euro Sign",
    "\r": "Carriage Return",
    "\ufb33": "Hebrew Letter Dalet With Dagesh",
    "1": "One",
    "\ud83d\ude00": "Emoji: Grinning Face",
    "\u0080": "Control",
    "\u00f6": "Latin Small Letter O With Diaeresis",
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.text,
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
  );

  const integerLikeKeys = canonicalizeJson({ 2: "two", 10: "ten", 1: "one" });
  assert.equal(integerLikeKeys.ok, true);
  assert.equal(integerLikeKeys.text, '{"1":"one","10":"ten","2":"two"}');
});

test("canonicalizeJson returns independent recursively frozen copies", () => {
  const shared = { child: [1, { ready: true }] };
  const input = { z: shared, a: shared };
  const result = canonicalizeJson(input);

  assert.equal(result.ok, true);
  assert.equal(
    result.text,
    '{"a":{"child":[1,{"ready":true}]},"z":{"child":[1,{"ready":true}]}}',
  );
  assert.notEqual(result.value, input);
  assert.notEqual(result.value.a, shared);
  assert.notEqual(result.value.a, result.value.z);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.a), true);
  assert.equal(Object.isFrozen(result.value.a.child), true);
  assert.equal(Object.isFrozen(result.value.a.child[1]), true);

  shared.child[1].ready = false;
  shared.child.push(2);
  assert.equal(result.value.a.child[1].ready, true);
  assert.equal(result.value.a.child.length, 2);

  const nullPrototype = Object.assign(Object.create(null), { value: 1 });
  const nullResult = canonicalizeJson(nullPrototype);
  assert.equal(nullResult.ok, true);
  assert.equal(Object.getPrototypeOf(nullResult.value), null);
  assert.equal(nullResult.text, '{"value":1}');

  const prototypeKey = {};
  Object.defineProperty(prototypeKey, "__proto__", {
    enumerable: true,
    value: { safe: true },
  });
  const prototypeResult = canonicalizeJson(prototypeKey);
  assert.equal(prototypeResult.ok, true);
  assert.equal(prototypeResult.text, '{"__proto__":{"safe":true}}');
  assert.equal(Object.getPrototypeOf(prototypeResult.value), Object.prototype);
  assert.equal(Object.hasOwn(prototypeResult.value, "__proto__"), true);
  assert.deepEqual(prototypeResult.value.__proto__, { safe: true });
});

test("canonicalizeJson reports malformed values at deterministic pointers", () => {
  assertCanonicalRejection(undefined, "", "unsupported_type");
  assertCanonicalRejection(1n, "", "unsupported_type");
  assertCanonicalRejection(Symbol("value"), "", "unsupported_type");
  assertCanonicalRejection(() => undefined, "", "unsupported_type");
  assertCanonicalRejection(Number.NaN, "", "non_finite_number");
  assertCanonicalRejection(Infinity, "", "non_finite_number");
  assertCanonicalRejection(new Date(0), "", "non_plain_object");
  assertCanonicalRejection("\ud800", "", "lone_surrogate");

  const sparse = [];
  sparse.length = 2;
  sparse[1] = "present";
  assertCanonicalRejection(sparse, "/0", "sparse_array");

  const cycle = { nested: {} };
  cycle.nested["a/b~"] = cycle;
  assertCanonicalRejection(cycle, "/nested/a~1b~0", "cycle");

  const symbolValue = { nested: { value: 1 } };
  symbolValue.nested[Symbol("hidden")] = 2;
  assertCanonicalRejection(symbolValue, "/nested", "symbol_key");

  const accessorValue = { nested: {} };
  Object.defineProperty(accessorValue.nested, "a/b~", {
    enumerable: true,
    get() {
      throw new Error("must not be invoked");
    },
  });
  assertCanonicalRejection(accessorValue, "/nested/a~1b~0", "accessor");

  const invalidName = { nested: {} };
  Object.defineProperty(invalidName.nested, "\udfff", {
    enumerable: true,
    value: "value",
  });
  assertCanonicalRejection(invalidName, "/nested", "lone_surrogate");

  assertCanonicalRejection(
    { z: Number.NaN, a: undefined },
    "/a",
    "unsupported_type",
  );
});

test("canonicalizeJson applies local rejection precedence without invoking accessors", () => {
  const symbolBeforeAccessor = {};
  symbolBeforeAccessor[Symbol("hidden")] = 1;
  Object.defineProperty(symbolBeforeAccessor, "accessor", {
    get() {
      throw new Error("must not be invoked");
    },
  });
  assertCanonicalRejection(symbolBeforeAccessor, "", "symbol_key");

  const accessorBeforeSparse = [];
  accessorBeforeSparse.length = 2;
  Object.defineProperty(accessorBeforeSparse, "extra", {
    get() {
      throw new Error("must not be invoked");
    },
  });
  assertCanonicalRejection(accessorBeforeSparse, "/extra", "accessor");

  const numericAccessorOrder = [];
  numericAccessorOrder.length = 11;
  for (const index of [10, 2]) {
    Object.defineProperty(numericAccessorOrder, index, {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error("must not be invoked");
      },
    });
  }
  assertCanonicalRejection(numericAccessorOrder, "/2", "accessor");

  class NonPlain {
    value = 1;
  }
  const classWithSymbol = new NonPlain();
  classWithSymbol[Symbol("hidden")] = 2;
  assertCanonicalRejection(classWithSymbol, "", "non_plain_object");

  class DomainArray extends Array {}
  const subclassArray = new DomainArray(1, 2);
  subclassArray[Symbol("hidden")] = 3;
  assertCanonicalRejection(subclassArray, "", "non_plain_object");

  const customPrototypeArray = [1, 2];
  Object.setPrototypeOf(customPrototypeArray, Object.create(Array.prototype));
  assertCanonicalRejection(customPrototypeArray, "", "non_plain_object");
});

test("createRevisionEnvelope validates exact input and returns a frozen copy", () => {
  const input = {
    id: "task-1",
    kind: "task",
    createdAt: "later than updatedAt is still opaque",
    updatedAt: " ",
  };
  const result = createRevisionEnvelope(input);

  assert.deepEqual(result, {
    ok: true,
    value: {
      id: "task-1",
      kind: "task",
      revision: 0,
      createdAt: "later than updatedAt is still opaque",
      updatedAt: " ",
    },
  });
  assert.notEqual(result.value, input);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(input), false);

  assertEnvelopeRejection(
    createRevisionEnvelope(null),
    "[root]",
    "plain_object",
  );
  assertEnvelopeRejection(
    createRevisionEnvelope({ ...input, revision: 0 }),
    "revision",
    "exact_fields",
  );
  assertEnvelopeRejection(
    createRevisionEnvelope({ kind: "task", createdAt: "c", updatedAt: "u" }),
    "id",
    "exact_fields",
  );
  assertEnvelopeRejection(
    createRevisionEnvelope({ ...input, id: "" }),
    "id",
    "non_empty_string",
  );
});

test("envelope shape rejection precedence is prototype, symbol, then canonical invalid field", () => {
  const array = [];
  assertEnvelopeRejection(
    createRevisionEnvelope(array),
    "[root]",
    "plain_object",
  );

  const symbolInput = {
    id: "task-1",
    kind: "task",
    createdAt: "c",
    updatedAt: "u",
    extra: true,
  };
  symbolInput[Symbol("hidden")] = true;
  assertEnvelopeRejection(
    createRevisionEnvelope(symbolInput),
    "[symbol]",
    "exact_fields",
  );

  const accessorAndExtra = {
    id: "task-1",
    kind: "task",
    createdAt: "c",
    extra: true,
  };
  Object.defineProperty(accessorAndExtra, "updatedAt", {
    get() {
      throw new Error("must not be invoked");
    },
  });
  assertEnvelopeRejection(
    createRevisionEnvelope(accessorAndExtra),
    "extra",
    "exact_fields",
  );
});

test("validateRevisionEnvelope restores valid revisions and enforces field order", () => {
  const input = validEnvelope();
  const identity = { idKind: "TaskId", expectedKind: "task" };
  const result = validateRevisionEnvelope(input, identity);

  assert.deepEqual(result, { ok: true, value: input });
  assert.notEqual(result.value, input);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(input), false);

  const nullPrototype = Object.assign(Object.create(null), input);
  const nullResult = validateRevisionEnvelope(nullPrototype, identity);
  assert.equal(nullResult.ok, true);
  assert.deepEqual({ ...nullResult.value }, input);

  assertEnvelopeRejection(
    validateRevisionEnvelope(validEnvelope({ id: "", revision: -1 }), identity),
    "id",
    "non_empty_string",
  );
  assertEnvelopeRejection(
    validateRevisionEnvelope(validEnvelope({ kind: "" }), identity),
    "kind",
    "non_empty_string",
  );
  assertEnvelopeRejection(
    validateRevisionEnvelope(validEnvelope({ kind: "epic" }), identity),
    "kind",
    "expected_kind",
  );

  for (const revision of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "7"]) {
    assertEnvelopeRejection(
      validateRevisionEnvelope(validEnvelope({ revision }), identity),
      "revision",
      "non_negative_safe_integer",
    );
  }

  assertEnvelopeRejection(
    validateRevisionEnvelope(validEnvelope({ createdAt: "", updatedAt: "" }), identity),
    "createdAt",
    "non_empty_string",
  );
  assertEnvelopeRejection(
    validateRevisionEnvelope(validEnvelope({ updatedAt: "" }), identity),
    "updatedAt",
    "non_empty_string",
  );

  const missingRevision = validEnvelope();
  delete missingRevision.revision;
  assertEnvelopeRejection(
    validateRevisionEnvelope(missingRevision, identity),
    "revision",
    "exact_fields",
  );
});
