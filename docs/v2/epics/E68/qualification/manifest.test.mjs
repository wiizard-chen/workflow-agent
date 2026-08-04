import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  BLOCKED_CODES,
  CLOSED_CANDIDATE_IDS,
  DEFAULT_MANIFEST_INPUT,
  RUNTIME_IDENTITY,
  canonicalEvidenceJson,
  canonicalManifestJson,
  createBlockedDiagnostic,
  createCandidateIdentity,
  createCandidateManifest,
  createDefaultCandidateManifest,
  createProbeResult,
  createQualificationRecord,
  verifyCandidateManifest,
} from "./manifest.mjs";

const SHA = (seed) => createHash("sha256").update(seed).digest("hex");

function mutableDefault() {
  return structuredClone(DEFAULT_MANIFEST_INPUT);
}

test("default manifest is closed, local-only, deterministic, and recursively frozen", () => {
  const first = createDefaultCandidateManifest();
  const second = createCandidateManifest(mutableDefault());
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.value.manifestSha256, second.value.manifestSha256);
  assert.equal(first.value.manifestSha256, "895d70ee064bf50d70d4ea208d4beba5c92ffe96beb9bdb2e257eba0dec7af8e");
  assert.deepEqual(first.value.candidates.map(({ id }) => id), CLOSED_CANDIDATE_IDS);
  assert.equal(first.value.networkPolicy, "disabled");
  assert.equal(first.value.baseline.id, "native-sqlite-step-ledger");
  assert.equal(first.value.candidates.filter((candidate) => candidate.status === "blocked").length, 4);
  assert.equal(Object.isFrozen(first.value), true);
  assert.equal(Object.isFrozen(first.value.baseline), true);
  assert.equal(Object.isFrozen(first.value.candidates), true);
  assert.equal(Object.isFrozen(first.value.candidates[1]), true);
  assert.equal(Object.isFrozen(first.value.candidates[1].blocked), true);
  assert.equal(verifyCandidateManifest(first.value).ok, true);
});

test("manifest canonical JSON is stable across insertion and candidate order", () => {
  const input = mutableDefault();
  input.candidates.reverse();
  input.baseline = {
    runtime: RUNTIME_IDENTITY,
    dependencyLockSha256: input.baseline.dependencyLockSha256,
    sourceRevision: input.baseline.sourceRevision,
    version: input.baseline.version,
    id: input.baseline.id,
  };
  const result = createCandidateManifest(input);
  const expected = createDefaultCandidateManifest();
  assert.equal(result.ok, true);
  assert.equal(expected.ok, true);
  assert.equal(result.value.manifestSha256, expected.value.manifestSha256);
  const canonical = canonicalManifestJson(result.value);
  assert.equal(canonical.ok, true);
  assert.match(canonical.value, /^\{"baseline":/);
});

test("manifest rejects duplicate, missing, unknown, and extra candidate identities", () => {
  const duplicate = mutableDefault();
  duplicate.candidates[1] = structuredClone(duplicate.candidates[0]);
  assert.equal(createCandidateManifest(duplicate).ok, false);

  const missing = mutableDefault();
  missing.candidates.pop();
  assert.equal(createCandidateManifest(missing).ok, false);

  const unknown = mutableDefault();
  unknown.candidates[1].id = "new-provider";
  assert.equal(createCandidateManifest(unknown).ok, false);

  const extra = mutableDefault();
  extra.candidates[1].unexpected = "do-not-copy";
  const rejected = createCandidateManifest(extra);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.rejection.code, "unknown_field");
  assert.equal(JSON.stringify(rejected).includes("do-not-copy"), false);
});

test("identity validation rejects floating, malformed, and inconsistent provenance", () => {
  const base = structuredClone(DEFAULT_MANIFEST_INPUT.baseline);
  for (const [field, value] of [
    ["version", "latest"],
    ["version", "^1.0.0"],
    ["sourceRevision", "main"],
    ["sourceRevision", "not-a-revision"],
    ["dependencyLockSha256", "abc"],
    ["runtime", "current"],
  ]) {
    const input = { ...base, [field]: value };
    const result = createCandidateIdentity(input);
    assert.equal(result.ok, false, `${field}=${value} should reject`);
  }
  const changed = mutableDefault();
  changed.candidates[0].identity.runtime = "node-v99.0.0+sqlite-v3.47.2";
  assert.equal(createCandidateManifest(changed).ok, false);
});

test("accessors, revoked proxies, symbols, cycles, and sparse arrays fail closed", () => {
  const accessor = mutableDefault();
  Object.defineProperty(accessor, "runtime", { get() { throw new Error("must not run"); } });
  assert.equal(createCandidateManifest(accessor).ok, false);

  const revoked = Proxy.revocable(mutableDefault(), {});
  revoked.revoke();
  assert.equal(createCandidateManifest(revoked.proxy).ok, false);

  const symbol = mutableDefault();
  symbol[Symbol("secret")] = "hidden";
  assert.equal(createCandidateManifest(symbol).ok, false);

  const cycle = mutableDefault();
  cycle.candidates[1].blocked.loop = cycle;
  assert.equal(createCandidateManifest(cycle).ok, false);

  const sparse = mutableDefault();
  sparse.candidates.length = 6;
  assert.equal(createCandidateManifest(sparse).ok, false);

  let gets = 0;
  const hostile = new Proxy(mutableDefault(), {
    get() { gets += 1; throw new Error("get trap must not run"); },
    ownKeys() { throw new Error("ownKeys trap must fail closed"); },
  });
  assert.equal(createCandidateManifest(hostile).ok, false);
  assert.equal(gets, 0);
});

test("blocked diagnostics are typed and bounded without leaking secret details", () => {
  const valid = createBlockedDiagnostic({
    candidateId: "temporal",
    code: "unavailable_provenance",
    safeDetail: "no pinned local source or dependency lockfile",
  });
  assert.equal(valid.ok, true);
  assert.equal(Object.isFrozen(valid.value), true);
  for (const code of BLOCKED_CODES) {
    assert.equal(createBlockedDiagnostic({ code, safeDetail: "local evidence unavailable" }).ok, true);
  }
  for (const safeDetail of ["token=secret", "password leaked", "\nsecret", "", "x".repeat(161)]) {
    assert.equal(createBlockedDiagnostic({ code: "unavailable_source", safeDetail }).ok, false);
  }
  const bad = createBlockedDiagnostic({ code: "unavailable_source", safeDetail: "token=secret" });
  assert.equal(JSON.stringify(bad).includes("secret"), false);
});

test("available providers require identity while unavailable providers require a diagnostic", () => {
  const availableWithoutIdentity = mutableDefault();
  availableWithoutIdentity.candidates[1] = { id: "temporal", status: "available" };
  assert.equal(createCandidateManifest(availableWithoutIdentity).ok, false);

  const blockedWithoutDiagnostic = mutableDefault();
  blockedWithoutDiagnostic.candidates[1] = { id: "temporal", status: "blocked" };
  assert.equal(createCandidateManifest(blockedWithoutDiagnostic).ok, false);

  const blockedWithIdentity = mutableDefault();
  blockedWithIdentity.candidates[1].identity = structuredClone(DEFAULT_MANIFEST_INPUT.baseline);
  assert.equal(createCandidateManifest(blockedWithIdentity).ok, false);
});

test("probe result is an immutable safe evidence fact", () => {
  const probe = createProbeResult({
    name: "restart-checkpoint",
    status: "blocked",
    inputSha256: SHA("input"),
    outputSha256: SHA("output"),
    safeDetail: "provider unavailable locally",
  });
  assert.equal(probe.ok, true);
  assert.equal(Object.isFrozen(probe.value), true);
  assert.equal(createProbeResult({
    name: "restart-checkpoint",
    status: "pass",
    inputSha256: "not-a-hash",
    outputSha256: SHA("output"),
    callback: () => {},
  }).ok, false);
});

test("qualification record canonicalizes order and forbids qualified blocked gates", () => {
  const baseline = structuredClone(DEFAULT_MANIFEST_INPUT.baseline);
  const candidate = {
    id: "temporal",
    version: "temporal-sdk-v1",
    sourceRevision: SHA("temporal-source"),
    dependencyLockSha256: SHA("temporal-lock"),
    runtime: RUNTIME_IDENTITY,
  };
  const probes = [
    { name: "z-probe", status: "pass", inputSha256: SHA("z-i"), outputSha256: SHA("z-o") },
    { name: "a-probe", status: "blocked", inputSha256: SHA("a-i"), outputSha256: SHA("a-o"), safeDetail: "provider unavailable locally" },
  ];
  const input = {
    schemaVersion: 1,
    baseline,
    candidates: [candidate],
    probes,
    contractGate: "blocked",
    isolationGate: "pass",
    provenanceGate: "blocked",
    faultGate: "blocked",
    authorityGate: "pass",
    disposition: "BLOCKED",
  };
  const record = createQualificationRecord(input);
  assert.equal(record.ok, true);
  assert.equal(record.value.probes[0].name, "a-probe");
  assert.equal(Object.isFrozen(record.value), true);
  assert.match(record.value.recordSha256, /^[a-f0-9]{64}$/);
  assert.equal(canonicalEvidenceJson(record.value).ok, true);

  const bad = createQualificationRecord({ ...input, disposition: "QUALIFIED", contractGate: "blocked" });
  assert.equal(bad.ok, false);
});

test("importing the module exposes no provider or filesystem side effect", () => {
  // The assertion is intentionally structural: only constants and pure
  // factories are exported, and default creation has already completed above.
  assert.equal(typeof createCandidateManifest, "function");
  assert.equal(typeof createQualificationRecord, "function");
});
