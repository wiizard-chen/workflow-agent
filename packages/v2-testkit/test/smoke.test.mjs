import assert from "node:assert/strict";
import test from "node:test";
import * as entrypoint from "@pi-workflow/v2-testkit";

test("v2-testkit public entrypoint is native ESM", () => {
  assert.equal(Object.prototype.toString.call(entrypoint), "[object Module]");
  assert.equal(Object.getPrototypeOf(entrypoint), null);
});
