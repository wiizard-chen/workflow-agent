import assert from "node:assert/strict";
import test from "node:test";

import { runWalkingSkeleton } from "../scripts/e11-walking-skeleton.mjs";

test("E11 local walking skeleton composes recovery and fault boundaries", async () => {
  const result = await runWalkingSkeleton();
  assert.equal(result.jobId, "e11-job-001");
  assert.equal(result.stepId, "e11-step-001");
  assert.equal(result.roleInvocations, 1);
  assert.equal(result.eventCount, 2);
  assert.equal(result.recoveryStatus, "clean");
});
