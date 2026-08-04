import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  BLOCKED_CODES,
  CLOSED_CANDIDATE_IDS,
  FIXTURE_VERSION,
  RUNTIME_IDENTITY,
  createBlockedDiagnostic,
  createDefaultCandidateManifest,
  createProbeResult,
  verifyCandidateManifest,
} from "./manifest.mjs";

/**
 * E68 candidate capability probes.
 *
 * A probe is deliberately a static, read-only inspection.  It never imports
 * a provider, invokes a package manager, starts a child process, opens a
 * socket, or consults an ambient checkout.  A caller may provide an explicit
 * temporary root containing an `e68-candidate.json` descriptor for a pinned
 * candidate.  The descriptor is evidence, not executable provider code.
 */

export const PROBE_SCHEMA_VERSION = 1;
export const CANDIDATE_DESCRIPTOR_FILENAME = "e68-candidate.json";
export const MAX_DESCRIPTOR_BYTES = 64 * 1024;

/** The only operations a future V2-owned durable adapter may expose. */
export const REQUIRED_SPI_OPERATIONS = Object.freeze([
  "prepare",
  "append",
  "checkpoint",
  "recover",
]);

/** Logical capabilities used by the common E68 qualification fixture. */
export const REQUIRED_CAPABILITIES = Object.freeze([
  "checkpoint-replay",
  "timer-wakeup",
  "retry",
  "cancellation",
  "duplicate-idempotency",
  "stale-fencing",
  "schema-drift",
  "unknown-effect",
  "artifact-integrity",
]);

export const PROBE_NAMES = Object.freeze(["source", "api", "availability"]);

const SAFE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+:/-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_ARRAY_ITEMS = 256;
const MAX_DETAIL_LENGTH = 160;
const PROTECTED_SEGMENTS = new Set([
  ".beads",
  ".git",
  ".pi-subagents",
  ".codex",
  ".ssh",
]);

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isPlainObject(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownData(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) return null;
    return descriptor.value;
  } catch {
    return null;
  }
}

function ownKeys(value) {
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return null;
    return keys;
  } catch {
    return null;
  }
}

function frozen(value, seen = new WeakSet()) {
  if (value && typeof value === "object") {
    if (seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) frozen(item, seen);
    } else {
      for (const key of Object.keys(value)) frozen(value[key], seen);
    }
    Object.freeze(value);
  }
  return value;
}

function ok(value) {
  return frozen({ ok: true, value: frozen(value) });
}

function fail(code, path = "[root]", detail = "invalid_value") {
  return frozen({ ok: false, rejection: frozen({ code, path, detail }) });
}

function safeDetail(detail) {
  return typeof detail === "string" && detail.length > 0 && detail.length <= MAX_DETAIL_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/.test(detail) &&
    !/(?:token|secret|password|credential|authorization|bearer|api[_ -]?key|home=|cookie)/i.test(detail);
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non_finite_number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) throw new Error("non_canonical_value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function digest(value) {
  return sha256(canonicalJson(value));
}

function snapshot(value, path = "[root]", active = new WeakSet(), depth = 0) {
  if (depth > 32) return fail("invalid_probe_input", path, "maximum_depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return ok(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? ok(Object.is(value, -0) ? 0 : value) : fail("invalid_probe_input", path, "non_finite_number");
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return fail("invalid_probe_input", path, "non_serializable");
  }
  if (!value || typeof value !== "object") return fail("invalid_probe_input", path, "unsupported_type");
  try {
    if (active.has(value)) return fail("invalid_probe_input", path, "cycle");
    active.add(value);
    const keys = ownKeys(value);
    if (!keys || keys.length > MAX_ARRAY_ITEMS) return fail("invalid_probe_input", path, "unsafe_object");
    if (Array.isArray(value)) {
      const length = ownData(value, "length");
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARRAY_ITEMS || keys.length !== length + 1) {
        return fail("invalid_probe_input", path, "unsafe_array");
      }
      const result = [];
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        if (!keys.includes(key)) return fail("invalid_probe_input", `${path}[${index}]`, "sparse_array");
        const child = snapshot(ownData(value, key), `${path}[${index}]`, active, depth + 1);
        if (!child.ok) return child;
        result.push(child.value);
      }
      return ok(result);
    }
    if (!isPlainObject(value)) return fail("invalid_probe_input", path, "non_plain_object");
    const result = {};
    for (const key of keys.sort()) {
      const child = snapshot(ownData(value, key), `${path}.${key}`, active, depth + 1);
      if (!child.ok) return child;
      Object.defineProperty(result, key, { configurable: true, enumerable: true, writable: true, value: child.value });
    }
    return ok(result);
  } catch {
    return fail("invalid_probe_input", path, "unreadable_value");
  } finally {
    active.delete(value);
  }
}

function exactObject(value, required, optional = []) {
  if (!isPlainObject(value)) return fail("invalid_descriptor", "[root]", "plain_object_required");
  const keys = ownKeys(value);
  if (!keys) return fail("invalid_descriptor", "[root]", "unreadable_object");
  const allowed = new Set([...required, ...optional]);
  for (const key of keys) {
    if (!allowed.has(key)) return fail("invalid_descriptor", key, "unknown_field");
    if (Object.getOwnPropertyDescriptor(value, key)?.get || Object.getOwnPropertyDescriptor(value, key)?.set) {
      return fail("invalid_descriptor", key, "accessor");
    }
  }
  for (const key of required) {
    if (!keys.includes(key)) return fail("invalid_descriptor", key, "missing_field");
  }
  const copy = {};
  for (const key of keys) copy[key] = ownData(value, key);
  return ok(copy);
}

function validateStringList(value, path, allowed = null) {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return fail("invalid_descriptor", path, "array_required");
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const item = ownData(value, String(index));
    if (typeof item !== "string" || !SAFE_ID.test(item) || seen.has(item)) {
      return fail("invalid_descriptor", `${path}.${index}`, "safe_unique_identifier_required");
    }
    if (allowed && !allowed.includes(item)) return fail("invalid_descriptor", `${path}.${index}`, "unknown_identifier");
    seen.add(item);
  }
  const normalized = [...value];
  normalized.sort((left, right) => allowed
    ? allowed.indexOf(left) - allowed.indexOf(right)
    : left < right ? -1 : left > right ? 1 : 0);
  return ok(Object.freeze(normalized));
}

function validatePathRoot(root) {
  if (typeof root !== "string" || !root || !resolve(root).startsWith(sep)) {
    return fail("invalid_probe_root", "root", "absolute_path_required");
  }
  const resolved = resolve(root);
  const tempRoot = resolve(tmpdir());
  const relativeToTemp = relative(tempRoot, resolved);
  if (relativeToTemp === "" || relativeToTemp === ".." || relativeToTemp.startsWith(`..${sep}`) || relativeToTemp.startsWith("../")) {
    return fail("invalid_probe_root", "root", "temporary_root_required");
  }
  const segments = resolved.split(sep).filter(Boolean);
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment))) {
    return fail("invalid_probe_root", "root", "protected_state_path");
  }
  try {
    if (!existsSync(resolved)) return fail("invalid_probe_root", "root", "root_not_found");
    const stat = lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return fail("invalid_probe_root", "root", "directory_required");
    const real = realpathSync.native(resolved);
    const realTempRoot = realpathSync.native(tempRoot);
    const realRelative = relative(realTempRoot, real);
    if (realRelative === "" || realRelative === ".." || realRelative.startsWith(`..${sep}`) || realRelative.startsWith("../")) {
      return fail("invalid_probe_root", "root", "root_symlink_escape");
    }
    return ok(resolved);
  } catch {
    return fail("invalid_probe_root", "root", "root_unreadable");
  }
}

function safeChildPath(root, child) {
  if (typeof child !== "string" || !child || child.includes("\0") || child.startsWith("/") || child.includes("\\")) {
    return fail("invalid_probe_root", "candidateRoots", "relative_path_required");
  }
  const resolvedRoot = resolve(root);
  const path = resolve(resolvedRoot, child);
  const rel = relative(resolvedRoot, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../")) {
    return fail("invalid_probe_root", "candidateRoots", "path_escape");
  }
  return ok(path);
}

function safeReadDescriptor(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DESCRIPTOR_BYTES) {
      return fail("unavailable_source", "descriptor", stat.isSymbolicLink() ? "descriptor_symlink" : "descriptor_unavailable");
    }
    const text = readFileSync(path, { encoding: "utf8" });
    if (text.length > MAX_DESCRIPTOR_BYTES) return fail("unavailable_source", "descriptor", "descriptor_too_large");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail("unreproducible_evidence", "descriptor", "invalid_json");
    }
    const checked = snapshot(parsed, "descriptor");
    if (!checked.ok) return fail("unreproducible_evidence", "descriptor", "unsafe_json");
    return ok(checked.value);
  } catch {
    return fail("unavailable_source", "descriptor", "descriptor_not_found");
  }
}

function blockedDiagnostic(candidateId, code, detail) {
  const normalizedCode = BLOCKED_CODES.includes(code) ? code : "unreproducible_evidence";
  const normalizedDetail = safeDetail(detail) ? detail : "local evidence unavailable";
  const result = createBlockedDiagnostic({ candidateId, code: normalizedCode, safeDetail: normalizedDetail });
  return result.ok ? result.value : { candidateId, code: "unreproducible_evidence", safeDetail: "local evidence unavailable" };
}

function probeFact(candidateId, name, status, input, output, detail = undefined) {
  const result = createProbeResult({
    name: `${candidateId}-${name}`,
    status,
    inputSha256: digest(input),
    outputSha256: digest(output),
    ...(detail === undefined ? {} : { safeDetail: detail }),
  });
  if (!result.ok) return fail("invalid_evidence", `${candidateId}.${name}`, "probe_result_failed");
  return result;
}

function blockedProbe(candidateId, name, diagnostic, input = {}) {
  return probeFact(candidateId, name, "blocked", {
    candidateId,
    name,
    ...input,
  }, {
    status: "blocked",
    code: diagnostic.code,
  }, diagnostic.safeDetail);
}

function passProbe(candidateId, name, input, output) {
  return probeFact(candidateId, name, "pass", { candidateId, name, ...input }, { status: "pass", ...output });
}

function descriptorValidation(candidateId, identity, descriptor) {
  const exact = exactObject(descriptor, ["schemaVersion", "candidateId", "identity", "operations", "capabilities"], ["available", "networkRequired"]);
  if (!exact.ok) return exact;
  const value = exact.value;
  if (value.schemaVersion !== PROBE_SCHEMA_VERSION) return fail("unreproducible_evidence", "descriptor.schemaVersion", "unsupported_schema_version");
  if (value.candidateId !== candidateId || !SAFE_ID.test(value.candidateId)) return fail("unavailable_provenance", "descriptor.candidateId", "candidate_id_mismatch");
  const identityKeys = ["id", "version", "sourceRevision", "dependencyLockSha256", "runtime"];
  const descriptorIdentity = exactObject(value.identity, identityKeys);
  if (!descriptorIdentity.ok) return fail("unavailable_provenance", "descriptor.identity", "identity_unavailable");
  for (const key of identityKeys) {
    if (descriptorIdentity.value[key] !== identity[key]) return fail("unavailable_provenance", `descriptor.identity.${key}`, "identity_mismatch");
  }
  const operations = validateStringList(value.operations, "descriptor.operations", REQUIRED_SPI_OPERATIONS);
  if (!operations.ok) return fail("unsupported_capability", "descriptor.operations", "unsupported_spi_operation");
  const capabilities = validateStringList(value.capabilities, "descriptor.capabilities", REQUIRED_CAPABILITIES);
  if (!capabilities.ok) return fail("unsupported_capability", "descriptor.capabilities", "unsupported_fixture_capability");
  if (REQUIRED_SPI_OPERATIONS.some((operation) => !operations.value.includes(operation))) {
    return fail("unsupported_capability", "descriptor.operations", "required_spi_operation_missing");
  }
  if (REQUIRED_CAPABILITIES.some((capability) => !capabilities.value.includes(capability))) {
    return fail("unsupported_capability", "descriptor.capabilities", "required_fixture_capability_missing");
  }
  if (value.available !== undefined && typeof value.available !== "boolean") return fail("unavailable_runtime", "descriptor.available", "boolean_required");
  if (value.networkRequired !== undefined && typeof value.networkRequired !== "boolean") return fail("unavailable_runtime", "descriptor.networkRequired", "boolean_required");
  if (value.networkRequired === true) return fail("unavailable_runtime", "descriptor.networkRequired", "network_required_disabled");
  return ok({
    identity: descriptorIdentity.value,
    operations: operations.value,
    capabilities: capabilities.value,
    available: value.available === undefined ? true : value.available,
    networkRequired: value.networkRequired === true,
  });
}

function candidateRootFor(candidateRoots, candidateId, root) {
  if (candidateRoots === undefined) return ok(null);
  if (root === null) return fail("invalid_probe_root", "root", "root_required_for_candidate_sources");
  if (!isPlainObject(candidateRoots)) return fail("invalid_probe_root", "candidateRoots", "plain_object_required");
  const keys = ownKeys(candidateRoots);
  if (!keys || keys.some((key) => !CLOSED_CANDIDATE_IDS.includes(key))) return fail("invalid_probe_root", "candidateRoots", "unknown_candidate");
  const raw = ownData(candidateRoots, candidateId);
  if (raw === undefined) return ok(null);
  if (typeof raw !== "string") return fail("invalid_probe_root", `candidateRoots.${candidateId}`, "path_required");
  const child = safeChildPath(root, raw);
  if (!child.ok) return child;
  try {
    const stat = lstatSync(child.value);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return fail("invalid_probe_root", `candidateRoots.${candidateId}`, "directory_required");
    const realRoot = realpathSync.native(resolve(root));
    const realChild = realpathSync.native(child.value);
    const rel = relative(realRoot, realChild);
    if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../")) {
      return fail("invalid_probe_root", `candidateRoots.${candidateId}`, "path_escape");
    }
    return ok(child.value);
  } catch {
    return fail("invalid_probe_root", `candidateRoots.${candidateId}`, "candidate_root_not_found");
  }
}

function staticNativeResult(manifestEntry, manifestSha256) {
  const candidateId = manifestEntry.id;
  const capabilities = [...REQUIRED_CAPABILITIES];
  const operations = [...REQUIRED_SPI_OPERATIONS];
  const source = passProbe(candidateId, "source", { source: "builtin-fixture", manifestSha256 }, {
    source: "builtin-fixture",
    sourceRevision: manifestEntry.identity.sourceRevision,
  });
  const api = passProbe(candidateId, "api", { operations, capabilities }, { operations, capabilities });
  const availability = passProbe(candidateId, "availability", { networkPolicy: "disabled" }, {
    local: true,
    network: false,
  });
  return ok({
    candidateId,
    status: "available",
    identity: manifestEntry.identity,
    capabilities,
    operations,
    probes: [source.value, api.value, availability.value],
  });
}

function blockedCandidateResult(manifestEntry, manifestSha256) {
  const diagnostic = manifestEntry.blocked;
  const candidateId = manifestEntry.id;
  const probes = PROBE_NAMES.map((name) => blockedProbe(candidateId, name, diagnostic, { manifestSha256 }));
  return ok({
    candidateId,
    status: "blocked",
    identity: null,
    capabilities: [],
    operations: [],
    blocked: diagnostic,
    probes: probes.map((probe) => probe.value),
  });
}

function probeAvailableCandidate(manifestEntry, manifestSha256, root, candidateRoots, descriptorFilename) {
  const candidateId = manifestEntry.id;
  const rootResult = candidateRootFor(candidateRoots, candidateId, root);
  if (!rootResult.ok) return rootResult;
  const candidateRoot = rootResult.value;
  const sourceInput = { manifestSha256, descriptorFilename, candidateRootProvided: candidateRoot !== null };
  if (candidateRoot === null) {
    const diagnostic = blockedDiagnostic(candidateId, "unavailable_source", "no explicit local candidate source");
    const probes = PROBE_NAMES.map((name) => blockedProbe(candidateId, name, diagnostic, sourceInput));
    return ok({ candidateId, status: "blocked", identity: manifestEntry.identity, capabilities: [], operations: [], blocked: diagnostic, probes: probes.map((probe) => probe.value) });
  }
  const descriptorPath = join(candidateRoot, descriptorFilename);
  const descriptorRead = safeReadDescriptor(descriptorPath);
  if (!descriptorRead.ok) {
    const diagnostic = blockedDiagnostic(candidateId, descriptorRead.rejection.code, descriptorRead.rejection.detail.replaceAll("_", " "));
    const probes = PROBE_NAMES.map((name) => blockedProbe(candidateId, name, diagnostic, sourceInput));
    return ok({ candidateId, status: "blocked", identity: manifestEntry.identity, capabilities: [], operations: [], blocked: diagnostic, probes: probes.map((probe) => probe.value) });
  }
  const checked = descriptorValidation(candidateId, manifestEntry.identity, descriptorRead.value);
  if (!checked.ok) {
    const diagnostic = blockedDiagnostic(candidateId, checked.rejection.code, checked.rejection.detail.replaceAll("_", " "));
    const source = blockedProbe(candidateId, "source", diagnostic, sourceInput);
    const api = blockedProbe(candidateId, "api", diagnostic, { descriptor: "not-qualified" });
    const availability = blockedProbe(candidateId, "availability", diagnostic, { descriptor: "not-qualified" });
    return ok({ candidateId, status: "blocked", identity: manifestEntry.identity, capabilities: [], operations: [], blocked: diagnostic, probes: [source.value, api.value, availability.value] });
  }
  const source = passProbe(candidateId, "source", sourceInput, {
    descriptor: "static",
    sourceRevision: manifestEntry.identity.sourceRevision,
  });
  const api = passProbe(candidateId, "api", { operations: checked.value.operations, capabilities: checked.value.capabilities }, {
    operations: checked.value.operations,
    capabilities: checked.value.capabilities,
  });
  const availability = passProbe(candidateId, "availability", { networkPolicy: "disabled" }, {
    local: checked.value.available,
    network: checked.value.networkRequired,
  });
  if (!checked.value.available) {
    const diagnostic = blockedDiagnostic(candidateId, "unavailable_runtime", "candidate declared unavailable");
    const blocked = blockedProbe(candidateId, "availability", diagnostic, { networkPolicy: "disabled" });
    return ok({ candidateId, status: "blocked", identity: manifestEntry.identity, capabilities: checked.value.capabilities, operations: checked.value.operations, blocked: diagnostic, probes: [source.value, api.value, blocked.value] });
  }
  return ok({
    candidateId,
    status: "available",
    identity: manifestEntry.identity,
    capabilities: checked.value.capabilities,
    operations: checked.value.operations,
    probes: [source.value, api.value, availability.value],
  });
}

function normalizeOptions(options) {
  if (options === undefined) return ok({ manifest: createDefaultCandidateManifest().value, root: null, candidateRoots: undefined, descriptorFilename: CANDIDATE_DESCRIPTOR_FILENAME });
  const exact = exactObject(options, [], ["manifest", "root", "candidateRoots", "descriptorFilename"]);
  if (!exact.ok) return fail("invalid_probe_input", exact.rejection.path, exact.rejection.detail);
  const manifest = exact.value.manifest === undefined ? createDefaultCandidateManifest() : verifyCandidateManifest(exact.value.manifest);
  if (!manifest.ok) return fail("invalid_probe_input", "manifest", "manifest_not_verified");
  const descriptorFilename = exact.value.descriptorFilename === undefined ? CANDIDATE_DESCRIPTOR_FILENAME : exact.value.descriptorFilename;
  if (typeof descriptorFilename !== "string" || !/^[a-z][a-z0-9-]{0,63}\.json$/.test(descriptorFilename)) {
    return fail("invalid_probe_input", "descriptorFilename", "safe_filename_required");
  }
  const rawRoot = exact.value.root;
  if (rawRoot === undefined) return ok({ manifest: manifest.value, root: null, candidateRoots: exact.value.candidateRoots, descriptorFilename });
  const checkedRoot = validatePathRoot(rawRoot);
  if (!checkedRoot.ok) return checkedRoot;
  return ok({ manifest: manifest.value, root: checkedRoot.value, candidateRoots: exact.value.candidateRoots, descriptorFilename });
}

/**
 * Run the closed candidate capability/availability probe set.
 *
 * The return value follows the repository's `{ ok, value }` convention.  All
 * candidate facts and probe facts are recursively frozen.  External entries
 * already typed `blocked` in the manifest remain blocked and are never
 * substituted by a package lookup.
 */
export function runCandidateCapabilityProbes(options = undefined) {
  try {
    const normalized = normalizeOptions(options);
    if (!normalized.ok) return normalized;
    const { manifest, root, candidateRoots, descriptorFilename } = normalized.value;
    const manifestSha256 = manifest.manifestSha256;
    const results = [];
    for (const candidateId of CLOSED_CANDIDATE_IDS) {
      const entry = manifest.candidates.find((candidate) => candidate.id === candidateId);
      if (!entry) return fail("invalid_probe_input", "manifest.candidates", "closed_candidate_set_required");
      let result;
      if (entry.status === "blocked") result = blockedCandidateResult(entry, manifestSha256);
      else if (candidateId === "native-sqlite-step-ledger") result = staticNativeResult(entry, manifestSha256);
      else result = probeAvailableCandidate(entry, manifestSha256, root, candidateRoots, descriptorFilename);
      if (!result.ok) return result;
      results.push(result.value);
    }
    const body = {
      schemaVersion: PROBE_SCHEMA_VERSION,
      fixtureVersion: manifest.fixtureVersion || FIXTURE_VERSION,
      runtime: manifest.runtime || RUNTIME_IDENTITY,
      networkPolicy: "disabled",
      manifestSha256,
      descriptorFilename,
      candidates: results,
    };
    return ok({ ...body, probeSha256: digest(body) });
  } catch {
    return fail("invalid_evidence", "[root]", "probe_execution_failed");
  }
}

export const runCandidateProbes = runCandidateCapabilityProbes;
export const probeCandidates = runCandidateCapabilityProbes;
export const probeCandidateCapabilities = runCandidateCapabilityProbes;

/** Return the stable canonical JSON after validating a probe record digest. */
export function canonicalProbeJson(record) {
  const checked = snapshot(record);
  if (!checked.ok || !isPlainObject(checked.value)) return fail("invalid_evidence", "record", "unsafe_probe_record");
  const keys = ownKeys(checked.value);
  if (!keys || !keys.includes("probeSha256")) return fail("invalid_evidence", "probeSha256", "missing_digest");
  const supplied = ownData(checked.value, "probeSha256");
  if (typeof supplied !== "string" || !HASH.test(supplied)) return fail("invalid_evidence", "probeSha256", "sha256_required");
  const body = { ...checked.value };
  delete body.probeSha256;
  if (digest(body) !== supplied) return fail("invalid_evidence", "probeSha256", "digest_mismatch");
  return ok(canonicalJson(checked.value));
}

export const CANDIDATE_PROBE_CODES = Object.freeze([
  "invalid_probe_input",
  "invalid_probe_root",
  "invalid_descriptor",
  ...BLOCKED_CODES,
  "invalid_evidence",
]);
