import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { Type } from "typebox";
import {
  PROTOCOL_VERSION,
  acceptCommandIntent,
  acceptQueryIntent,
  createEventEnvelope,
  createSchemaRegistry,
  createSyntheticE11Registry,
} from "../dist/index.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDirectory, "..");
const typeContractConfig = path.join(testDirectory, "type-contract/tsconfig.json");
const workspaceRoot = path.resolve(packageRoot, "../..");

function diagnostics(program) {
  const result = ts.getPreEmitDiagnostics(program);
  return result.length === 0
    ? ""
    : ts.formatDiagnosticsWithColorAndContext(result, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => workspaceRoot,
        getNewLine: () => "\n",
      });
}

const principal = Object.freeze({
  kind: "scheduler",
  principalId: "workflowd",
  connectionId: "sock-1",
  connectionGeneration: 1,
  daemonEpoch: "epoch-1",
  capabilityRefs: Object.freeze(["protocol.validate"]),
});

function command(overrides = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId: "cmd-1",
    schemaId: "synthetic.e11.job.start",
    schemaVersion: 1,
    payload: { jobId: "job-1", stepId: "step-1" },
    correlationId: "corr-1",
    aggregate: { type: "synthetic-job", id: "job-1", expectedRevision: 0 },
    ...overrides,
  };
}

test("synthetic E11 catalog is exact and independently composable", () => {
  const result = createSyntheticE11Registry();
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.manifest.map((entry) => [entry.messageKind, entry.schemaId]), [
    ["command", "synthetic.e11.job.start"],
    ["event", "synthetic.e11.job.completed"],
    ["event", "synthetic.e11.job.started"],
    ["query", "synthetic.e11.job.read"],
  ]);
  assert.match(result.value.manifestHash, /^[a-f0-9]{64}$/);
  assert.equal(result.value.resolve("command", "synthetic.e11.job.start", 2).ok, false);
  assert.equal(result.value.resolve("command", "synthetic.e11.job.missing", 1).ok, false);
});

test("command and query intents accept only server-derived principal context", () => {
  const registry = createSyntheticE11Registry();
  assert.equal(registry.ok, true);
  const accepted = acceptCommandIntent(registry.value, command(), principal);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.principal.principalId, "workflowd");
  assert.equal(Object.isFrozen(accepted.value), true);
  assert.equal(Object.isFrozen(accepted.value.payload), true);
  const callerPayload = { jobId: "job-copy", stepId: "step-copy" };
  const copied = acceptCommandIntent(registry.value, command({ payload: callerPayload }), principal);
  assert.equal(copied.ok, true);
  callerPayload.jobId = "mutated-after-accept";
  assert.equal(copied.value.payload.jobId, "job-copy");

  const query = acceptQueryIntent(registry.value, {
    protocolVersion: 1,
    queryId: "query-1",
    schemaId: "synthetic.e11.job.read",
    schemaVersion: 1,
    payload: { jobId: "job-1" },
    correlationId: "corr-1",
    aggregate: { type: "synthetic-job", id: "job-1", expectedRevision: 0 },
  }, principal);
  assert.equal(query.ok, true);
  assert.equal(query.value.kind, "query");
  const queryIntentWithoutAggregate = {
    protocolVersion: 1,
    queryId: "query-2",
    schemaId: "synthetic.e11.job.read",
    schemaVersion: 1,
    payload: { jobId: "job-1" },
    correlationId: "corr-2",
  };
  assert.equal(acceptQueryIntent(registry.value, queryIntentWithoutAggregate, principal).ok, true);

  assert.equal(acceptCommandIntent(registry.value, { ...command(), actor: { type: "human" } }, principal).ok, false);
  assert.equal(acceptCommandIntent(registry.value, { ...command(), principal }, principal).ok, false);
  assert.equal(acceptCommandIntent(registry.value, { ...command(), humanPresenceGrantContext: {} }, principal).ok, false);
  assert.equal(acceptCommandIntent(registry.value, { ...command(), humanPresenceGrantRef: "" }, principal).ok, false);
  assert.equal(acceptCommandIntent(registry.value, command(), { ...principal, kind: "service" }).ok, false);
});

test("exact versions, payloads, and hostile object shapes fail closed", () => {
  const registry = createSyntheticE11Registry();
  assert.equal(registry.ok, true);
  for (const version of [0, 2, "1", 1.5, -1]) {
    assert.equal(acceptCommandIntent(registry.value, command({ protocolVersion: version }), principal).ok, false);
  }
  assert.equal(acceptCommandIntent(registry.value, command({
    payload: { jobId: "job-1", stepId: "step-1", extra: "reject" },
  }), principal).ok, false);
  assert.equal(acceptCommandIntent(registry.value, command({
    schemaId: "synthetic.e11.job.start@^1",
  }), principal).ok, false);
  assert.equal(acceptCommandIntent(registry.value, command({
    aggregate: { type: "synthetic-job", id: "job-1" },
  }), principal).ok, false);

  const getterInput = command();
  Object.defineProperty(getterInput, "payload", { get() { throw new Error("must not run"); } });
  assert.equal(acceptCommandIntent(registry.value, getterInput, principal).ok, false);

  const polluted = Object.create({ inherited: true });
  Object.assign(polluted, command());
  assert.equal(acceptCommandIntent(registry.value, polluted, principal).ok, false);

  const cyclic = command({ payload: { jobId: "job-1", stepId: "step-1" } });
  cyclic.payload.loop = cyclic.payload;
  assert.equal(acceptCommandIntent(registry.value, cyclic, principal).ok, false);

  const sparse = command({ payload: { jobId: "job-1", stepId: "step-1", list: [] } });
  sparse.payload.list.length = 100000;
  assert.equal(acceptCommandIntent(registry.value, sparse, principal).ok, false);

  const revoked = Proxy.revocable(command(), {});
  revoked.revoke();
  assert.equal(acceptCommandIntent(registry.value, revoked.proxy, principal).ok, false);
});

test("verified human grant is bound to the server principal and opaque ref", () => {
  const descriptor = {
    schemaId: "synthetic.test.human" ,
    schemaVersion: 1,
    messageKind: "command",
    payloadSchema: Type.Object({ value: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    requiresAggregateRevision: true,
    requiresHumanPresenceGrant: true,
  };
  const registry = createSchemaRegistry([descriptor]);
  assert.equal(registry.ok, true);
  const input = {
    protocolVersion: 1,
    commandId: "cmd-human",
    schemaId: descriptor.schemaId,
    schemaVersion: 1,
    payload: { value: "ok" },
    correlationId: "corr-human",
    aggregate: { type: "human-test", id: "a", expectedRevision: 0 },
    humanPresenceGrantRef: "grant-1",
  };
  const grant = {
    ref: "grant-1",
    principalId: "workflowd",
    connectionId: "sock-1",
    connectionGeneration: 1,
    daemonEpoch: "epoch-1",
    expiresAt: "2030-01-01T00:00:00Z",
    nonce: "nonce-1",
  };
  const humanPrincipal = { ...principal, kind: "human-interactive-client" };
  const accepted = acceptCommandIntent(registry.value, input, humanPrincipal, grant);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.humanPresenceGrant.ref, "grant-1");
  assert.equal(acceptCommandIntent(registry.value, input, humanPrincipal, { ...grant, principalId: "attacker" }).ok, false);
  assert.equal(acceptCommandIntent(registry.value, input, humanPrincipal, { ...grant, ref: "grant-2" }).ok, false);
  assert.equal(acceptCommandIntent(registry.value, input, humanPrincipal).ok, false);
  assert.equal(acceptCommandIntent(registry.value, input, principal, grant).ok, false);
});

test("registry rejects duplicate exact tuples and is order-independent", () => {
  const a = {
    schemaId: "synthetic.test.a",
    schemaVersion: 1,
    messageKind: "query",
    payloadSchema: Type.Object({ value: Type.String() }, { additionalProperties: false }),
    requiresAggregateRevision: false,
    requiresHumanPresenceGrant: false,
  };
  const b = {
    ...a,
    schemaId: "synthetic.test.b",
  };
  assert.equal(createSchemaRegistry([a, { ...a }]).ok, false);
  const first = createSchemaRegistry([a, b]);
  const second = createSchemaRegistry([b, a]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.value.manifestHash, second.value.manifestHash);
});

test("registry accepts JSON Schema boolean/empty and common TypeBox descriptors", () => {
  const schemas = [
    true,
    false,
    {},
    Type.String(),
    Type.Object({ value: Type.String() }),
    Type.Union([Type.String(), Type.Number()]),
    Type.Array(Type.String()),
  ];
  for (const [index, payloadSchema] of schemas.entries()) {
    const result = createSchemaRegistry([{
      schemaId: `synthetic.test.valid-${index}`,
      schemaVersion: 1,
      messageKind: "query",
      payloadSchema,
      requiresAggregateRevision: false,
      requiresHumanPresenceGrant: false,
    }]);
    assert.equal(result.ok, true, `schema ${index} should be accepted`);
  }
});

test("registry rejects malformed JSON Schema descriptors before compilation", () => {
  for (const [index, payloadSchema] of [
    [],
    [1],
    { type: "wat" },
    { foo: "x" },
    { type: "object", additionalProperties: [] },
    { type: "object", dependentRequired: { value: [1] } },
  ].entries()) {
    const result = createSchemaRegistry([{
      schemaId: `synthetic.test.invalid-${index}`,
      schemaVersion: 1,
      messageKind: "query",
      payloadSchema,
      requiresAggregateRevision: false,
      requiresHumanPresenceGrant: false,
    }]);
    assert.equal(result.ok, false, `schema ${index} should be rejected`);
    assert.equal(result.rejection.code, "invalid_schema");
  }
});

test("events are server-produced envelopes with trusted principal and exact sequence", () => {
  const registry = createSyntheticE11Registry();
  assert.equal(registry.ok, true);
  const event = createEventEnvelope(registry.value, {
    protocolVersion: 1,
    eventId: "event-1",
    schemaId: "synthetic.e11.job.started",
    schemaVersion: 1,
    payload: { jobId: "job-1", stepId: "step-1" },
    correlationId: "corr-1",
    causationId: "cmd-1",
    aggregate: { type: "synthetic-job", id: "job-1", sequence: 1 },
    occurredAt: "2030-01-01T00:00:00Z",
  }, principal);
  assert.equal(event.ok, true);
  assert.equal(event.value.kind, "event");
  assert.equal(createEventEnvelope(registry.value, {
    protocolVersion: 1,
    eventId: "event-2",
    schemaId: "synthetic.e11.job.started",
    schemaVersion: 1,
    payload: { jobId: "job-1", stepId: "step-1" },
    correlationId: "corr-1",
    causationId: "cmd-1",
    aggregate: { type: "synthetic-job", id: "job-1", sequence: 0 },
    occurredAt: "2030-01-01T00:00:00Z",
  }, principal).ok, false);
  assert.equal(createEventEnvelope(registry.value, {
    protocolVersion: 2,
    eventId: "event-3",
    schemaId: "synthetic.e11.job.started",
    schemaVersion: 1,
    payload: { jobId: "job-1", stepId: "step-1" },
    correlationId: "corr-1",
    causationId: "cmd-1",
    aggregate: { type: "synthetic-job", id: "job-1", sequence: 1 },
    occurredAt: "2030-01-01T00:00:00Z",
  }, principal).ok, false);
});

test("public package and TypeScript declaration contract stay closed", async () => {
  const configFile = ts.readConfigFile(typeContractConfig, ts.sys.readFile);
  assert.equal(configFile.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(typeContractConfig),
    undefined,
    typeContractConfig,
  );
  assert.equal(diagnostics(ts.createProgram(parsed.fileNames, parsed.options)), "");

  const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(packageJson.exports), ["."]);
  assert.deepEqual(packageJson.exports["."], {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  });
  const internalSubpath = ["@pi-workflow/v2-protocol", "internal"].join("/");
  await assert.rejects(
    import(internalSubpath),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
});

test("registry rejects descriptor accessors before reading caller values", () => {
  let invoked = false;
  const descriptor = Object.create(null);
  for (const key of [
    "schemaId", "schemaVersion", "messageKind", "payloadSchema",
    "requiresAggregateRevision", "requiresHumanPresenceGrant",
  ]) {
    Object.defineProperty(descriptor, key, {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        throw new Error("descriptor getter must not run");
      },
    });
  }
  const result = createSchemaRegistry([descriptor]);
  assert.equal(result.ok, false);
  assert.equal(invoked, false);
});

test("principal capability arrays are copied and hostile array shapes fail closed", () => {
  const registry = createSyntheticE11Registry();
  assert.equal(registry.ok, true);
  const copied = acceptCommandIntent(registry.value, command(), principal);
  assert.equal(copied.ok, true);
  assert.notEqual(copied.value.principal.capabilityRefs, principal.capabilityRefs);
  assert.equal(Object.isFrozen(copied.value.principal.capabilityRefs), true);

  const getterPrincipal = {
    ...principal,
    capabilityRefs: [],
  };
  Object.defineProperty(getterPrincipal.capabilityRefs, "0", {
    configurable: true,
    get() {
      throw new Error("capability getter must not run");
    },
  });
  Object.defineProperty(getterPrincipal.capabilityRefs, "length", { value: 1 });
  assert.equal(acceptCommandIntent(registry.value, command(), getterPrincipal).ok, false);

  const revoked = Proxy.revocable(["capability"], {});
  revoked.revoke();
  assert.equal(acceptCommandIntent(registry.value, command(), {
    ...principal,
    capabilityRefs: revoked.proxy,
  }).ok, false);
});
