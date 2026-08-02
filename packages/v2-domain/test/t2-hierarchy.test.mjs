import assert from "node:assert/strict";
import test from "node:test";
import {
  validateHierarchy,
  validateOwnershipNext,
} from "@pi-workflow/v2-domain";

function node(id, kind, ordinal, fields = {}) {
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

function portfolio(id, ordinal = 1) {
  return node(id, "portfolio", ordinal);
}

function initiative(id, portfolioId, ordinal = 1) {
  return node(id, "initiative", ordinal, { portfolioId });
}

function epic(id, initiativeId, repositoryId = "repo", ordinal = 1) {
  return node(id, "epic", ordinal, { initiativeId, repositoryId });
}

function unit(id, epicId, repositoryId = "repo", ordinal = 1) {
  return node(id, "delivery-unit", ordinal, { epicId, repositoryId });
}

function task(id, deliveryUnitId, ordinal = 1) {
  return node(id, "task", ordinal, { deliveryUnitId });
}

function snapshot(nodes, taskAttemptOwners = []) {
  return { nodes, taskAttemptOwners };
}

function rejection(code, path, id = null, relatedId = null) {
  return { code, path, id, relatedId };
}

function assertFrozenFailure(result) {
  assert.equal(result.ok, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.rejections), true);
  assert.equal(result.rejections.every(Object.isFrozen), true);
}

test("validateHierarchy returns a canonical recursively frozen snapshot", () => {
  const inputNodes = [
    task("task-z", "unit", 2),
    portfolio("portfolio-z", 2),
    unit("unit", "epic", "repo", 1),
    initiative("initiative-z", "portfolio-z", 1),
    epic("epic", "initiative-a", "repo", 1),
    portfolio("portfolio-a", 1),
    initiative("initiative-a", "portfolio-a", 9),
    task("task-a", "unit", 2),
  ];
  const owners = [
    { taskAttemptId: "attempt-z", taskId: "task-z" },
    { taskAttemptId: "attempt-b", taskId: "task-a" },
    { taskAttemptId: "attempt-a", taskId: "task-a" },
  ];
  const input = snapshot(inputNodes, owners);
  const result = validateHierarchy(input);

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.nodes.map(({ kind, id }) => [kind, id]),
    [
      ["portfolio", "portfolio-a"],
      ["portfolio", "portfolio-z"],
      ["initiative", "initiative-a"],
      ["initiative", "initiative-z"],
      ["epic", "epic"],
      ["delivery-unit", "unit"],
      ["task", "task-a"],
      ["task", "task-z"],
    ],
  );
  assert.deepEqual(result.value.taskAttemptOwners, [
    { taskAttemptId: "attempt-a", taskId: "task-a" },
    { taskAttemptId: "attempt-b", taskId: "task-a" },
    { taskAttemptId: "attempt-z", taskId: "task-z" },
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.nodes), true);
  assert.equal(Object.isFrozen(result.value.taskAttemptOwners), true);
  assert.equal(result.value.nodes.every(Object.isFrozen), true);
  assert.equal(result.value.taskAttemptOwners.every(Object.isFrozen), true);
  assert.notEqual(result.value.nodes[0], inputNodes[5]);
  assert.notEqual(result.value.taskAttemptOwners[0], owners[2]);
  assert.deepEqual(input.nodes, inputNodes);
  assert.deepEqual(input.taskAttemptOwners, owners);
});

test("invalid snapshot roots and collections stop with one exact rejection", () => {
  for (const [input, path] of [
    [null, ""],
    [[], ""],
    [{ taskAttemptOwners: [] }, "/nodes"],
    [{ nodes: [], taskAttemptOwners: [], "a/b~": true }, "/a~1b~0"],
    [{ nodes: new Array(1), taskAttemptOwners: [] }, "/nodes"],
  ]) {
    const result = validateHierarchy(input);
    assert.deepEqual(result, {
      ok: false,
      rejections: [rejection("invalid_snapshot", path)],
    });
    assertFrozenFailure(result);
  }

  const symbolRoot = snapshot([], []);
  symbolRoot[Symbol("hidden")] = true;
  assert.deepEqual(validateHierarchy(symbolRoot), {
    ok: false,
    rejections: [rejection("invalid_snapshot", "")],
  });

  class NodeCollection extends Array {}
  assert.deepEqual(validateHierarchy(snapshot(new NodeCollection(), [])), {
    ok: false,
    rejections: [rejection("invalid_snapshot", "/nodes")],
  });

  const accessorRoot = { taskAttemptOwners: [] };
  Object.defineProperty(accessorRoot, "nodes", {
    get() {
      throw new Error("must not be invoked");
    },
  });
  assert.deepEqual(validateHierarchy(accessorRoot), {
    ok: false,
    rejections: [rejection("invalid_snapshot", "/nodes")],
  });
});

test("hierarchy validation never invokes collection-owned forEach values", () => {
  const nodes = [portfolio("portfolio")];
  Object.defineProperty(nodes, "forEach", {
    configurable: true,
    enumerable: true,
    value() {
      throw new Error("nodes.forEach must not be invoked");
    },
  });
  const nodesResult = validateHierarchy(snapshot(nodes));
  assert.equal(nodesResult.ok, true);
  assert.deepEqual(nodesResult.value.nodes.map(({ id }) => id), ["portfolio"]);

  const taskAttemptOwners = [];
  Object.defineProperty(taskAttemptOwners, "forEach", {
    configurable: true,
    enumerable: true,
    value() {
      throw new Error("taskAttemptOwners.forEach must not be invoked");
    },
  });
  const ownersResult = validateHierarchy(snapshot([], taskAttemptOwners));
  assert.equal(ownersResult.ok, true);
  assert.deepEqual(ownersResult.value.taskAttemptOwners, []);
});

test("exact node and owner records accumulate every invalid field", () => {
  const invalidNode = initiative("", "", 0);
  invalidNode.revision = -1;
  invalidNode.createdAt = "";
  invalidNode.updatedAt = null;
  const result = validateHierarchy(snapshot([invalidNode], [
    { taskAttemptId: "", taskId: 0 },
  ]));

  assert.deepEqual(result, {
    ok: false,
    rejections: [
      rejection("invalid_envelope", "/nodes/0/createdAt"),
      rejection("invalid_envelope", "/nodes/0/revision"),
      rejection("invalid_envelope", "/nodes/0/updatedAt"),
      rejection("invalid_ordinal", "/nodes/0/ordinal"),
      rejection("invalid_scalar", "/nodes/0/id"),
      rejection("invalid_scalar", "/nodes/0/portfolioId"),
      rejection("invalid_scalar", "/taskAttemptOwners/0/taskAttemptId"),
      rejection("invalid_scalar", "/taskAttemptOwners/0/taskId"),
    ],
  });
  assertFrozenFailure(result);

  const validIdInvalidFields = initiative("initiative", "", 0);
  validIdInvalidFields.revision = -1;
  const withLocator = validateHierarchy(snapshot([validIdInvalidFields]));
  assert.equal(withLocator.ok, false);
  assert.equal(withLocator.rejections.every(({ id }) => id === "initiative"), true);
  assert.equal(withLocator.rejections.every(({ relatedId }) => relatedId === null), true);
});

test("invalid record shapes emit once and recover only valid locators", () => {
  const badShape = {
    ...initiative("initiative", "portfolio"),
    extra: true,
  };
  const unknownKind = { ...portfolio("entity"), kind: "unknown" };
  const badOwner = {
    taskAttemptId: "attempt",
    taskId: "task",
    extra: true,
  };
  const result = validateHierarchy(snapshot([badShape, unknownKind], [badOwner]));

  assert.deepEqual(result, {
    ok: false,
    rejections: [
      rejection("invalid_record", "/nodes/0", "initiative", "portfolio"),
      rejection("invalid_record", "/nodes/1", "entity", null),
      rejection("invalid_record", "/taskAttemptOwners/0", "attempt", "task"),
    ],
  });
});

test("relationship checks distinguish missing, wrong-kind, repository, and Task ownership", () => {
  const nodes = [
    portfolio("portfolio"),
    initiative("initiative", "portfolio"),
    epic("epic", "initiative", "repo-a"),
    unit("unit", "epic", "repo-b"),
    task("missing-parent-task", "absent-unit"),
    task("wrong-kind-task", "portfolio"),
  ];
  const result = validateHierarchy(snapshot(nodes, [
    { taskAttemptId: "attempt", taskId: "absent-task" },
  ]));

  assert.deepEqual(result, {
    ok: false,
    rejections: [
      rejection(
        "missing_parent",
        "/nodes/4/deliveryUnitId",
        "missing-parent-task",
        "absent-unit",
      ),
      rejection(
        "missing_task",
        "/taskAttemptOwners/0/taskId",
        "attempt",
        "absent-task",
      ),
      rejection(
        "parent_kind_mismatch",
        "/nodes/5/deliveryUnitId",
        "wrong-kind-task",
        "portfolio",
      ),
      rejection(
        "repository_mismatch",
        "/nodes/3/repositoryId",
        "unit",
        "epic",
      ),
    ],
  });
});

test("duplicate groups emit exactly one family rejection with canonical second paths", () => {
  const nodes = [
    portfolio("duplicate-portfolio", 2),
    portfolio("duplicate-portfolio", 1),
    portfolio("parent"),
    initiative("duplicate-sibling", "parent", 2),
    initiative("duplicate-sibling", "parent", 1),
    portfolio("parent-a"),
    portfolio("parent-z"),
    initiative("multiple-owner", "parent-z", 1),
    initiative("multiple-owner", "parent-a", 9),
  ];
  const result = validateHierarchy(snapshot(nodes));

  assert.equal(result.ok, false);
  assert.deepEqual(result.rejections, [
    rejection("duplicate_identity", "/nodes/0", "duplicate-portfolio"),
    rejection(
      "duplicate_sibling_identity",
      "/nodes/3",
      "duplicate-sibling",
      "parent",
    ),
    rejection(
      "multiple_parent_ownership",
      "/nodes/7",
      "multiple-owner",
      "parent-a",
    ),
  ]);
});

test("duplicate TaskAttempt ownership sorts by Task then original index", () => {
  const nodes = [
    portfolio("p"),
    initiative("i", "p"),
    epic("e", "i"),
    unit("u", "e"),
    task("task-z", "u"),
    task("task-a", "u"),
  ];
  const owners = [
    { taskAttemptId: "attempt", taskId: "task-z" },
    { taskAttemptId: "attempt", taskId: "task-a" },
    { taskAttemptId: "attempt", taskId: "task-a" },
  ];
  const result = validateHierarchy(snapshot(nodes, owners));

  assert.deepEqual(result, {
    ok: false,
    rejections: [
      rejection(
        "duplicate_task_attempt_ownership",
        "/taskAttemptOwners/2",
        "attempt",
        "task-a",
      ),
    ],
  });
});

test("invalid records are excluded from every relationship index", () => {
  const invalidPortfolio = { ...portfolio("parent"), extra: true };
  const child = initiative("child", "parent");
  const result = validateHierarchy(snapshot([invalidPortfolio, child]));

  assert.deepEqual(result, {
    ok: false,
    rejections: [
      rejection("invalid_record", "/nodes/0", "parent"),
      rejection("missing_parent", "/nodes/1/portfolioId", "child", "parent"),
    ],
  });
});

test("validateOwnershipNext allows revision, updatedAt, and ordinal changes", () => {
  const previous = task("task", "unit", 1);
  const next = {
    ...previous,
    revision: 8,
    updatedAt: "next update",
    ordinal: 9,
  };
  const result = validateOwnershipNext(previous, next);

  assert.deepEqual(result, { ok: true, value: next });
  assert.notEqual(result.value, next);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.value), true);
});

test("validateOwnershipNext emits exact field and immutable comparison paths", () => {
  const previous = epic("epic", "initiative-a", "repo-a");
  const next = {
    ...epic("epic-next", "initiative-b", "repo-b"),
    createdAt: "different creation",
  };
  const result = validateOwnershipNext(previous, next);

  assert.deepEqual(result, {
    ok: false,
    rejections: [
      { code: "immutable_identity_changed", path: "/next/createdAt" },
      { code: "immutable_identity_changed", path: "/next/id" },
      { code: "immutable_parent_changed", path: "/next/initiativeId" },
      { code: "immutable_repository_changed", path: "/next/repositoryId" },
    ],
  });
  assertFrozenFailure(result);
});

test("validateOwnershipNext accumulates previous and next field errors and skips comparison", () => {
  const previous = task("", "", 0);
  previous.revision = -1;
  const next = { ...task("next", "unit"), extra: true };
  const result = validateOwnershipNext(previous, next);

  assert.deepEqual(result, {
    ok: false,
    rejections: [
      { code: "invalid_envelope", path: "/previous/revision" },
      { code: "invalid_ordinal", path: "/previous/ordinal" },
      { code: "invalid_record", path: "/next" },
      { code: "invalid_scalar", path: "/previous/deliveryUnitId" },
      { code: "invalid_scalar", path: "/previous/id" },
    ],
  });
  assertFrozenFailure(result);
});
