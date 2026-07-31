import assert from "node:assert/strict";
import test from "node:test";
import * as entrypoint from "@pi-workflow/workflow-worker";

test("workflow-worker public entrypoint is native ESM", () => {
  assert.equal(Object.prototype.toString.call(entrypoint), "[object Module]");
  assert.equal(Object.getPrototypeOf(entrypoint), null);
});
