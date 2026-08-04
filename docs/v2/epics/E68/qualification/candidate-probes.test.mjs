import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANDIDATE_DESCRIPTOR_FILENAME,
  PROBE_NAMES,
  REQUIRED_CAPABILITIES,
  REQUIRED_SPI_OPERATIONS,
  canonicalProbeJson,
  runCandidateCapabilityProbes,
} from "./candidate-probes.mjs";
import {
  CLOSED_CANDIDATE_IDS,
  DEFAULT_MANIFEST_INPUT,
  RUNTIME_IDENTITY,
  createCandidateManifest,
} from "./manifest.mjs";

const SHA = (seed) => createHash("sha256").update(seed).digest("hex");

function defaultInput() {
  return structuredClone(DEFAULT_MANIFEST_INPUT);
}

function availableManifest(candidateId = "temporal") {
  const input = defaultInput();
  const identity = {
    id: candidateId,
    version: `${candidateId}-sdk-v1`,
    sourceRevision: SHA(`${candidateId}-source`),
    dependencyLockSha256: SHA(`${candidateId}-lock`),
    runtime: RUNTIME_IDENTITY,
  };
  const index = input.candidates.findIndex(({ id }) => id === candidateId);
  input.candidates[index] = { id: candidateId, status: "available", identity };
  const manifest = createCandidateManifest(input);
  assert.equal(manifest.ok, true);
  return { manifest: manifest.value, identity };
}

function writeDescriptor(root, candidateId, identity, overrides = {}) {
  const candidateRoot = join(root, candidateId);
  mkdirSync(candidateRoot);
  const descriptor = {
    schemaVersion: 1,
    candidateId,
    identity,
    operations: [...REQUIRED_SPI_OPERATIONS],
    capabilities: [...REQUIRED_CAPABILITIES],
    ...overrides,
  };
  writeFileSync(join(candidateRoot, CANDIDATE_DESCRIPTOR_FILENAME), `${JSON.stringify(descriptor)}\n`, "utf8");
  return candidateRoot;
}

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "e68-probe-test-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("default probes are local-only, closed, typed, and deterministic", () => {
  const first = runCandidateCapabilityProbes();
  const second = runCandidateCapabilityProbes();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.value.probeSha256, second.value.probeSha256);
  assert.deepEqual(first.value.candidates.map(({ candidateId }) => candidateId), CLOSED_CANDIDATE_IDS);
  assert.equal(first.value.candidates[0].status, "available");
  assert.ok(first.value.candidates.slice(1).every(({ status, blocked }) => status === "blocked" && blocked.code === "unavailable_provenance"));
  assert.ok(first.value.candidates.every(({ probes }) => probes.length === PROBE_NAMES.length));
  assert.ok(first.value.candidates.flatMap(({ probes }) => probes).every(({ inputSha256, outputSha256 }) => /^[a-f0-9]{64}$/.test(inputSha256) && /^[a-f0-9]{64}$/.test(outputSha256)));
  assert.equal(Object.isFrozen(first.value), true);
  assert.equal(Object.isFrozen(first.value.candidates), true);
  assert.equal(Object.isFrozen(first.value.candidates[1].blocked), true);
  assert.equal(JSON.stringify(first.value).includes("/"), false, "ambient paths must not enter evidence");
  assert.equal(canonicalProbeJson(first.value).ok, true);
});

test("a pinned static descriptor passes source, API, and availability probes", () => withRoot((root) => {
  const { manifest, identity } = availableManifest();
  writeDescriptor(root, "temporal", identity);
  const result = runCandidateCapabilityProbes({ manifest, root, candidateRoots: { temporal: "temporal" } });
  assert.equal(result.ok, true);
  const temporal = result.value.candidates.find(({ candidateId }) => candidateId === "temporal");
  assert.equal(temporal.status, "available");
  assert.deepEqual(temporal.operations, REQUIRED_SPI_OPERATIONS);
  assert.deepEqual(temporal.capabilities, REQUIRED_CAPABILITIES);
  assert.deepEqual(temporal.probes.map(({ status }) => status), ["pass", "pass", "pass"]);
  assert.equal(JSON.stringify(result.value).includes(root), false);
}));
test("missing or malformed local source blocks without package installation", () => withRoot((root) => {
  const { manifest } = availableManifest();
  mkdirSync(join(root, "temporal"));
  const result = runCandidateCapabilityProbes({ manifest, root, candidateRoots: { temporal: "temporal" } });
  assert.equal(result.ok, true);
  const temporal = result.value.candidates.find(({ candidateId }) => candidateId === "temporal");
  assert.equal(temporal.status, "blocked");
  assert.equal(temporal.blocked.code, "unavailable_source");
  assert.equal(existsSync(join(root, "temporal", "node_modules")), false);

  writeFileSync(join(root, "temporal", CANDIDATE_DESCRIPTOR_FILENAME), "not json", "utf8");
  const malformed = runCandidateCapabilityProbes({ manifest, root, candidateRoots: { temporal: "temporal" } });
  assert.equal(malformed.ok, true);
  assert.equal(malformed.value.candidates.find(({ candidateId }) => candidateId === "temporal").blocked.code, "unreproducible_evidence");
}));

test("unsupported API and network-required candidates fail closed", () => withRoot((root) => {
  const { manifest, identity } = availableManifest();
  writeDescriptor(root, "temporal", identity, {
    operations: ["prepare", "append"],
    networkRequired: true,
  });
  const result = runCandidateCapabilityProbes({ manifest, root, candidateRoots: { temporal: "temporal" } });
  assert.equal(result.ok, true);
  const temporal = result.value.candidates.find(({ candidateId }) => candidateId === "temporal");
  assert.equal(temporal.status, "blocked");
  assert.equal(temporal.blocked.code, "unsupported_capability");
  assert.equal(temporal.probes[1].status, "blocked");
}));

test("identity drift and unavailable declaration produce typed blocked facts", () => withRoot((root) => {
  const { manifest, identity } = availableManifest();
  writeDescriptor(root, "temporal", { ...identity, version: "other-v1" });
  const result = runCandidateCapabilityProbes({ manifest, root, candidateRoots: { temporal: "temporal" } });
  assert.equal(result.ok, true);
  const temporal = result.value.candidates.find(({ candidateId }) => candidateId === "temporal");
  assert.equal(temporal.status, "blocked");
  assert.equal(temporal.blocked.code, "unavailable_provenance");

  rmSync(join(root, "temporal"), { recursive: true, force: true });
  writeDescriptor(root, "temporal", identity, { available: false });
  const unavailable = runCandidateCapabilityProbes({ manifest, root, candidateRoots: { temporal: "temporal" } });
  assert.equal(unavailable.ok, true);
  const unavailableTemporal = unavailable.value.candidates.find(({ candidateId }) => candidateId === "temporal");
  assert.equal(unavailableTemporal.status, "blocked");
  assert.equal(unavailableTemporal.blocked.code, "unavailable_runtime");
  assert.equal(unavailableTemporal.probes[0].status, "pass");
  assert.equal(unavailableTemporal.probes[1].status, "pass");
  assert.equal(unavailableTemporal.probes[2].status, "blocked");
}));

test("probe roots are explicit temporary directories and cannot escape", () => {
  const { manifest } = availableManifest();
  assert.equal(runCandidateCapabilityProbes({ manifest, root: "/", candidateRoots: { temporal: "temporal" } }).ok, false);
  assert.equal(runCandidateCapabilityProbes({ manifest, root: tmpdir(), candidateRoots: { temporal: "../outside" } }).ok, false);
  assert.equal(runCandidateCapabilityProbes({ manifest, root: tmpdir(), candidateRoots: { temporal: "/absolute" } }).ok, false);
});

test("invalid manifests are rejected before any candidate source is read", () => withRoot((root) => {
  const { manifest } = availableManifest();
  const malformed = { ...manifest, manifestSha256: SHA("wrong") };
  const candidateRoot = join(root, "temporal");
  mkdirSync(candidateRoot);
  writeFileSync(join(candidateRoot, CANDIDATE_DESCRIPTOR_FILENAME), "{}", "utf8");
  const result = runCandidateCapabilityProbes({ manifest: malformed, root, candidateRoots: { temporal: "temporal" } });
  assert.equal(result.ok, false);
  assert.equal(readFileSync(join(candidateRoot, CANDIDATE_DESCRIPTOR_FILENAME), "utf8"), "{}", "probe must not mutate source");
}));
