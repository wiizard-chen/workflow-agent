import assert from "node:assert/strict";
import test from "node:test";
import * as entrypoint from "@pi-workflow/v2-protocol";

test("v2-protocol public entrypoint is native ESM", () => {
  assert.equal(Object.prototype.toString.call(entrypoint), "[object Module]");
  assert.equal(Object.getPrototypeOf(entrypoint), null);
});
