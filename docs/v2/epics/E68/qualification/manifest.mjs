import { createHash } from "node:crypto";

/**
 * E68 candidate/provenance manifest.
 *
 * This module deliberately has no provider imports and no startup side
 * effects.  It only validates caller supplied, serialisable facts and
 * returns a recursively frozen snapshot.  The default manifest records the
 * native fixture and typed BLOCKED facts for providers which are not pinned
 * in this local checkout; it never tries to install or contact one.
 */

export const MANIFEST_SCHEMA_VERSION = 1;
export const EVIDENCE_SCHEMA_VERSION = 1;
export const FIXTURE_VERSION = "e68-qualification-fixture-v1";
export const RUNTIME_IDENTITY = "node-v23.6.0+sqlite-v3.47.2+os-independent";

export const CLOSED_CANDIDATE_IDS = Object.freeze([
  "native-sqlite-step-ledger",
  "temporal",
  "restate",
  "dbos-transact-ts",
  "hatchet",
]);

export const EXTERNAL_CANDIDATE_IDS = Object.freeze(CLOSED_CANDIDATE_IDS.slice(1));

export const QUALIFICATION_STATUSES = Object.freeze([
  "QUALIFIED",
  "ADAPT",
  "REFERENCE",
  "REJECTED",
  "BLOCKED",
]);

export const PROBE_STATUSES = Object.freeze(["pass", "fail", "blocked"]);
export const GATE_STATUSES = PROBE_STATUSES;

export const BLOCKED_CODES = Object.freeze([
  "unavailable_provenance",
  "unavailable_source",
  "unavailable_dependency",
  "unavailable_runtime",
  "unsupported_capability",
  "unreproducible_evidence",
]);

const HEX64 = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+:/-]{0,127}$/;
const SOURCE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64})$/;
const SAFE_DETAIL = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,159}$/;
const FLOATING_MARKERS = new Set([
  "latest", "main", "master", "head", "HEAD", "trunk", "tip", "*",
  "unversioned", "unknown", "floating", "current",
]);
const MAX_DEPTH = 64;
const MAX_ITEMS = 4096;

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fixtureRevision(label) {
  return sha256(`workflow-agent-e68:${label}`);
}

const NATIVE_SOURCE_REVISION = fixtureRevision("native-sqlite-step-ledger-source-v1");
const NATIVE_LOCK_SHA256 = fixtureRevision("native-sqlite-step-ledger-lock-v1");

function frozen(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) Object.freeze(value);
  return value;
}

function freezeDeep(value, seen = new WeakSet()) {
  if (value && typeof value === "object") {
    if (seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) freezeDeep(item, seen);
    } else {
      for (const key of Object.keys(value)) freezeDeep(value[key], seen);
    }
    Object.freeze(value);
  }
  return value;
}

function success(value) {
  return frozen({ ok: true, value: freezeDeep(value) });
}

function failure(code, path = "[root]", detail = "invalid_value") {
  return frozen({
    ok: false,
    rejection: frozen({ code, path, detail }),
  });
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

function safeOwnKeys(value) {
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return null;
    return keys;
  } catch {
    return null;
  }
}

function safeDescriptor(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) return null;
    return descriptor;
  } catch {
    return null;
  }
}

/**
 * Snapshot arbitrary JSON-like input without invoking accessors, callbacks,
 * provider objects, or user supplied toJSON methods.  It intentionally rejects
 * sparse arrays, symbols, cycles, non-plain objects, and proxies which cannot
 * be inspected safely.
 */
function snapshot(value, path = "[root]", active = new WeakSet(), depth = 0) {
  if (depth > MAX_DEPTH) return failure("unsafe_value", path, "maximum_depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return success(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return failure("unsafe_value", path, "non_finite_number");
    return success(Object.is(value, -0) ? 0 : value);
  }
  if (value === undefined) return failure("unsafe_value", path, "undefined");
  if (typeof value === "function") return failure("unsafe_value", path, "callback");
  if (typeof value === "symbol" || typeof value === "bigint") {
    return failure("unsafe_value", path, "non_serializable");
  }
  if (typeof value !== "object") return failure("unsafe_value", path, "unsupported_type");

  try {
    if (active.has(value)) return failure("unsafe_value", path, "cycle");
    active.add(value);

    if (Array.isArray(value)) {
      const lengthDescriptor = safeDescriptor(value, "length");
      if (!lengthDescriptor || typeof lengthDescriptor.value !== "number" ||
          !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
          lengthDescriptor.value > MAX_ITEMS) {
        return failure("unsafe_value", path, "invalid_array");
      }
      const length = lengthDescriptor.value;
      const keys = safeOwnKeys(value);
      if (!keys || keys.length !== length + 1 || !keys.includes("length")) {
        return failure("unsafe_value", path, "sparse_or_extra_array_property");
      }
      const result = [];
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        if (!keys.includes(key)) return failure("unsafe_value", `${path}[${index}]`, "sparse_array");
        const descriptor = safeDescriptor(value, key);
        if (!descriptor) return failure("unsafe_value", `${path}[${index}]`, "accessor");
        const child = snapshot(descriptor.value, `${path}[${index}]`, active, depth + 1);
        if (!child.ok) return child;
        result.push(child.value);
      }
      active.delete(value);
      return success(result);
    }

    if (!isPlainObject(value)) return failure("unsafe_value", path, "non_plain_object");
    const keys = safeOwnKeys(value);
    if (!keys || keys.length > MAX_ITEMS) return failure("unsafe_value", path, "invalid_object");
    const result = {};
    for (const key of keys.sort()) {
      // A symbol key was rejected by safeOwnKeys.  Keep a defensive guard in
      // case a hostile Proxy changes its ownKeys result between operations.
      if (typeof key !== "string") return failure("unsafe_value", path, "symbol_key");
      const descriptor = safeDescriptor(value, key);
      if (!descriptor) return failure("unsafe_value", `${path}.${key}`, "accessor");
      const child = snapshot(descriptor.value, `${path}.${key}`, active, depth + 1);
      if (!child.ok) return child;
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: child.value,
      });
    }
    active.delete(value);
    return success(result);
  } catch {
    return failure("unsafe_value", path, "unreadable_value");
  } finally {
    // Returning early above may leave the object in active.  Deleting it here
    // is safe because cycles are detected while the recursive call is active.
    active.delete(value);
  }
}

function canonicalStringify(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (!isPlainObject(value)) throw new Error("non-plain canonical value");
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
}

function canonicalHash(value) {
  return sha256(canonicalStringify(value));
}

function readExact(value, required, optional = []) {
  try {
    if (!isPlainObject(value)) return failure("invalid_manifest", "[root]", "plain_object");
    const keys = safeOwnKeys(value);
    if (!keys) return failure("unsafe_value", "[root]", "unreadable_object");
    const allowed = new Set([...required, ...optional]);
    for (const key of keys) {
      if (typeof key !== "string") return failure("unsafe_value", "[root]", "symbol_key");
      if (!allowed.has(key)) return failure("unknown_field", key, "unknown_field");
      if (!safeDescriptor(value, key)) return failure("unsafe_value", key, "accessor");
    }
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return failure("invalid_manifest", key, "missing_field");
    }
    const raw = {};
    for (const key of keys) {
      const descriptor = safeDescriptor(value, key);
      if (!descriptor) return failure("unsafe_value", key, "accessor");
      raw[key] = descriptor.value;
    }
    return success(raw);
  } catch {
    return failure("unsafe_value", "[root]", "unreadable_object");
  }
}

function nonEmptySafeToken(value, floating = true) {
  return typeof value === "string" && value.length > 0 && SAFE_TOKEN.test(value) &&
    (!floating || !FLOATING_MARKERS.has(value) && !/[\^~*<>=|]/.test(value));
}

function validateSha256(value) {
  return typeof value === "string" && HEX64.test(value);
}

function validateCandidateId(value) {
  return typeof value === "string" && ID.test(value) && CLOSED_CANDIDATE_IDS.includes(value);
}

function normalizeIdentity(input, expectedId = null) {
  const exact = readExact(input, ["id", "version", "sourceRevision", "dependencyLockSha256", "runtime"]);
  if (!exact.ok) return exact;
  const value = exact.value;
  if (!validateCandidateId(value.id)) return failure("invalid_candidate", "id", "unknown_candidate");
  if (expectedId !== null && value.id !== expectedId) return failure("invalid_candidate", "id", "candidate_id_mismatch");
  if (!nonEmptySafeToken(value.version) || FLOATING_MARKERS.has(value.version)) {
    return failure("floating_identity", "version", "version_must_be_pinned");
  }
  if (!SOURCE_REVISION.test(value.sourceRevision)) {
    return failure("floating_identity", "sourceRevision", "source_revision_must_be_immutable");
  }
  if (!validateSha256(value.dependencyLockSha256)) {
    return failure("invalid_candidate", "dependencyLockSha256", "sha256_required");
  }
  if (!nonEmptySafeToken(value.runtime) || FLOATING_MARKERS.has(value.runtime)) {
    return failure("floating_identity", "runtime", "runtime_must_be_pinned");
  }
  const copy = snapshot({
    id: value.id,
    version: value.version,
    sourceRevision: value.sourceRevision,
    dependencyLockSha256: value.dependencyLockSha256,
    runtime: value.runtime,
  });
  if (!copy.ok) return copy;
  return success(copy.value);
}

function normalizeBlocked(input, candidateId = null) {
  const exact = readExact(input, ["code", "safeDetail"], ["candidateId"]);
  if (!exact.ok) return failure("invalid_blocked_diagnostic", exact.rejection.path, exact.rejection.detail);
  const value = exact.value;
  if (!BLOCKED_CODES.includes(value.code)) return failure("invalid_blocked_diagnostic", "code", "unknown_blocked_code");
  if (candidateId !== null && value.candidateId !== undefined && value.candidateId !== candidateId) {
    return failure("invalid_blocked_diagnostic", "candidateId", "candidate_id_mismatch");
  }
  if (value.candidateId !== undefined && !validateCandidateId(value.candidateId)) {
    return failure("invalid_blocked_diagnostic", "candidateId", "unknown_candidate");
  }
  if (typeof value.safeDetail !== "string" || !SAFE_DETAIL.test(value.safeDetail) ||
      /(?:token|secret|password|credential|authorization|bearer|api[_ -]?key|home=|cookie)/i.test(value.safeDetail)) {
    return failure("invalid_blocked_diagnostic", "safeDetail", "unsafe_detail");
  }
  const copy = snapshot({
    ...(value.candidateId === undefined ? {} : { candidateId: value.candidateId }),
    code: value.code,
    safeDetail: value.safeDetail,
  });
  if (!copy.ok) return copy;
  return success(copy.value);
}

function normalizeEntry(input, expectedId) {
  const exact = readExact(input, ["id", "status"], ["identity", "blocked"]);
  if (!exact.ok) return exact;
  const value = exact.value;
  if (value.id !== expectedId || !validateCandidateId(value.id)) {
    return failure("invalid_candidate", "id", "candidate_id_mismatch");
  }
  if (value.status !== "available" && value.status !== "blocked") {
    return failure("invalid_candidate", "status", "invalid_status");
  }
  if (value.status === "available") {
    if (value.identity === undefined || value.blocked !== undefined) {
      return failure("invalid_candidate", "identity", "available_identity_required");
    }
    const identity = normalizeIdentity(value.identity, expectedId);
    if (!identity.ok) return identity;
    return success({ id: expectedId, status: "available", identity: identity.value });
  }
  if (value.blocked === undefined || value.identity !== undefined && value.identity !== null) {
    return failure("invalid_candidate", "blocked", "blocked_diagnostic_required");
  }
  const blocked = normalizeBlocked(value.blocked, expectedId);
  if (!blocked.ok) return blocked;
  return success({ id: expectedId, status: "blocked", identity: null, blocked: blocked.value });
}

const DEFAULT_NATIVE_IDENTITY = Object.freeze({
  id: "native-sqlite-step-ledger",
  version: "native-step-ledger-v1",
  sourceRevision: NATIVE_SOURCE_REVISION,
  dependencyLockSha256: NATIVE_LOCK_SHA256,
  runtime: RUNTIME_IDENTITY,
});

const DEFAULT_BLOCKED = Object.freeze({
  temporal: Object.freeze({
    candidateId: "temporal",
    code: "unavailable_provenance",
    safeDetail: "no pinned local source or dependency lockfile",
  }),
  restate: Object.freeze({
    candidateId: "restate",
    code: "unavailable_provenance",
    safeDetail: "no pinned local source or dependency lockfile",
  }),
  "dbos-transact-ts": Object.freeze({
    candidateId: "dbos-transact-ts",
    code: "unavailable_provenance",
    safeDetail: "no pinned local source or dependency lockfile",
  }),
  hatchet: Object.freeze({
    candidateId: "hatchet",
    code: "unavailable_provenance",
    safeDetail: "no pinned local source or dependency lockfile",
  }),
});

export const DEFAULT_MANIFEST_INPUT = freezeDeep({
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  fixtureVersion: FIXTURE_VERSION,
  runtime: RUNTIME_IDENTITY,
  networkPolicy: "disabled",
  baseline: DEFAULT_NATIVE_IDENTITY,
  candidates: [
    { id: "native-sqlite-step-ledger", status: "available", identity: DEFAULT_NATIVE_IDENTITY },
    { id: "temporal", status: "blocked", blocked: DEFAULT_BLOCKED.temporal },
    { id: "restate", status: "blocked", blocked: DEFAULT_BLOCKED.restate },
    { id: "dbos-transact-ts", status: "blocked", blocked: DEFAULT_BLOCKED["dbos-transact-ts"] },
    { id: "hatchet", status: "blocked", blocked: DEFAULT_BLOCKED.hatchet },
  ],
});

function manifestInput(input) {
  const exact = readExact(input, ["schemaVersion", "fixtureVersion", "runtime", "networkPolicy", "baseline", "candidates"]);
  if (!exact.ok) return exact;
  const value = exact.value;
  if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return failure("invalid_manifest", "schemaVersion", "unsupported_schema_version");
  }
  if (!nonEmptySafeToken(value.fixtureVersion) || FLOATING_MARKERS.has(value.fixtureVersion)) {
    return failure("floating_identity", "fixtureVersion", "fixture_version_must_be_pinned");
  }
  if (!nonEmptySafeToken(value.runtime) || FLOATING_MARKERS.has(value.runtime)) {
    return failure("floating_identity", "runtime", "runtime_must_be_pinned");
  }
  if (value.networkPolicy !== "disabled") return failure("invalid_manifest", "networkPolicy", "network_must_be_disabled");
  const baseline = normalizeIdentity(value.baseline, "native-sqlite-step-ledger");
  if (!baseline.ok) return baseline;
  if (baseline.value.runtime !== value.runtime) return failure("invalid_manifest", "runtime", "baseline_runtime_mismatch");
  if (!Array.isArray(value.candidates)) return failure("invalid_manifest", "candidates", "array_required");
  if (value.candidates.length !== CLOSED_CANDIDATE_IDS.length) return failure("invalid_manifest", "candidates", "closed_candidate_set_required");
  const seen = new Set();
  const entries = [];
  for (const candidate of value.candidates) {
    const id = (() => {
      try {
        return isPlainObject(candidate) && typeof Object.getOwnPropertyDescriptor(candidate, "id")?.value === "string"
          ? Object.getOwnPropertyDescriptor(candidate, "id").value
          : null;
      } catch {
        return null;
      }
    })();
    if (!id || !validateCandidateId(id)) return failure("invalid_candidate", "candidates", "unknown_candidate");
    if (seen.has(id)) return failure("duplicate_candidate", `candidates.${id}`, "duplicate_candidate");
    seen.add(id);
    const entry = normalizeEntry(candidate, id);
    if (!entry.ok) return entry;
    if (entry.value.status === "available" && entry.value.identity.runtime !== value.runtime) {
      return failure("invalid_manifest", `candidates.${id}.identity.runtime`, "runtime_mismatch");
    }
    entries.push(entry.value);
  }
  if (seen.size !== CLOSED_CANDIDATE_IDS.length || CLOSED_CANDIDATE_IDS.some((id) => !seen.has(id))) {
    return failure("invalid_manifest", "candidates", "closed_candidate_set_required");
  }
  entries.sort((left, right) => CLOSED_CANDIDATE_IDS.indexOf(left.id) - CLOSED_CANDIDATE_IDS.indexOf(right.id));
  const native = entries.find((entry) => entry.id === "native-sqlite-step-ledger");
  if (!native || native.status !== "available" || canonicalStringify(native.identity) !== canonicalStringify(baseline.value)) {
    return failure("invalid_manifest", "baseline", "baseline_candidate_mismatch");
  }
  return success({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    fixtureVersion: value.fixtureVersion,
    runtime: value.runtime,
    networkPolicy: "disabled",
    baseline: baseline.value,
    candidates: entries,
  });
}

/**
 * Build the deterministic closed candidate manifest.  Passing no argument
 * uses the local-only default (native baseline + typed BLOCKED providers).
 */
export function createCandidateManifest(input = DEFAULT_MANIFEST_INPUT) {
  try {
    const normalized = manifestInput(input);
    if (!normalized.ok) return normalized;
    const body = normalized.value;
    const manifestSha256 = canonicalHash(body);
    return success({ ...body, manifestSha256 });
  } catch {
    return failure("invalid_manifest", "[root]", "unreadable_manifest");
  }
}

export const createProvenanceManifest = createCandidateManifest;

export function createDefaultCandidateManifest() {
  return createCandidateManifest();
}

/** Return canonical JSON for a manifest, validating its digest first. */
export function canonicalManifestJson(manifest) {
  const checked = verifyCandidateManifest(manifest);
  if (!checked.ok) return checked;
  return success(canonicalStringify(checked.value));
}

/** Verify both the manifest schema and its body digest. */
export function verifyCandidateManifest(manifest) {
  try {
    const exact = readExact(manifest, [
      "schemaVersion", "fixtureVersion", "runtime", "networkPolicy", "baseline", "candidates", "manifestSha256",
    ]);
    if (!exact.ok) return exact;
    if (!validateSha256(exact.value.manifestSha256)) return failure("invalid_manifest", "manifestSha256", "sha256_required");
    const normalized = manifestInput({
      schemaVersion: exact.value.schemaVersion,
      fixtureVersion: exact.value.fixtureVersion,
      runtime: exact.value.runtime,
      networkPolicy: exact.value.networkPolicy,
      baseline: exact.value.baseline,
      candidates: exact.value.candidates,
    });
    if (!normalized.ok) return normalized;
    if (canonicalHash(normalized.value) !== exact.value.manifestSha256) {
      return failure("invalid_manifest", "manifestSha256", "digest_mismatch");
    }
    return success({ ...normalized.value, manifestSha256: exact.value.manifestSha256 });
  } catch {
    return failure("invalid_manifest", "[root]", "unreadable_manifest");
  }
}

export function createCandidateIdentity(input) {
  return normalizeIdentity(input);
}

export function createBlockedDiagnostic(input) {
  return normalizeBlocked(input);
}

function normalizeProbe(input) {
  const exact = readExact(input, ["name", "status", "inputSha256", "outputSha256"], ["safeDetail"]);
  if (!exact.ok) return failure("invalid_evidence", exact.rejection.path, exact.rejection.detail);
  const value = exact.value;
  if (typeof value.name !== "string" || !ID.test(value.name)) return failure("invalid_evidence", "name", "invalid_probe_name");
  if (!PROBE_STATUSES.includes(value.status)) return failure("invalid_evidence", "status", "invalid_probe_status");
  if (!validateSha256(value.inputSha256) || !validateSha256(value.outputSha256)) {
    return failure("invalid_evidence", "hash", "sha256_required");
  }
  if (value.safeDetail !== undefined &&
      (typeof value.safeDetail !== "string" || !SAFE_DETAIL.test(value.safeDetail) ||
       /(?:token|secret|password|credential|authorization|bearer|api[_ -]?key|home=|cookie)/i.test(value.safeDetail))) {
    return failure("invalid_evidence", "safeDetail", "unsafe_detail");
  }
  return success({
    name: value.name,
    status: value.status,
    inputSha256: value.inputSha256,
    outputSha256: value.outputSha256,
    ...(value.safeDetail === undefined ? {} : { safeDetail: value.safeDetail }),
  });
}

/** Build one safe, immutable probe fact for downstream qualification tasks. */
export function createProbeResult(input) {
  try {
    return normalizeProbe(input);
  } catch {
    return failure("invalid_evidence", "[root]", "unreadable_probe");
  }
}

const RECORD_GATE_KEYS = ["contractGate", "isolationGate", "provenanceGate", "faultGate", "authorityGate"];

/**
 * Build the PRD's serialisable QualificationRecord.  Digest input excludes
 * recordSha256 itself, and candidate/probe order is canonicalized so reruns
 * produce the same decision hash.
 */
export function createQualificationRecord(input) {
  try {
    const exact = readExact(input, [
      "schemaVersion", "baseline", "candidates", "probes",
      ...RECORD_GATE_KEYS, "disposition",
    ], ["recordSha256"]);
    if (!exact.ok) return failure("invalid_evidence", exact.rejection.path, exact.rejection.detail);
    const value = exact.value;
    if (value.schemaVersion !== EVIDENCE_SCHEMA_VERSION) return failure("invalid_evidence", "schemaVersion", "unsupported_schema_version");
    const baseline = normalizeIdentity(value.baseline, "native-sqlite-step-ledger");
    if (!baseline.ok) return baseline;
    if (!Array.isArray(value.candidates)) return failure("invalid_evidence", "candidates", "array_required");
    if (!Array.isArray(value.probes)) return failure("invalid_evidence", "probes", "array_required");
    const candidates = [];
    const candidateIds = new Set();
    for (const candidate of value.candidates) {
      const identity = normalizeIdentity(candidate);
      if (!identity.ok) return identity;
      if (candidateIds.has(identity.value.id)) return failure("duplicate_candidate", `candidates.${identity.value.id}`, "duplicate_candidate");
      candidateIds.add(identity.value.id);
      candidates.push(identity.value);
    }
    candidates.sort((left, right) => CLOSED_CANDIDATE_IDS.indexOf(left.id) - CLOSED_CANDIDATE_IDS.indexOf(right.id));
    const probes = [];
    const probeNames = new Set();
    for (const probe of value.probes) {
      const normalized = normalizeProbe(probe);
      if (!normalized.ok) return normalized;
      if (probeNames.has(normalized.value.name)) return failure("duplicate_probe", `probes.${normalized.value.name}`, "duplicate_probe");
      probeNames.add(normalized.value.name);
      probes.push(normalized.value);
    }
    probes.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const key of RECORD_GATE_KEYS) {
      if (!GATE_STATUSES.includes(value[key])) return failure("invalid_evidence", key, "invalid_gate_status");
    }
    if (!QUALIFICATION_STATUSES.includes(value.disposition)) return failure("invalid_evidence", "disposition", "invalid_disposition");
    if (value.disposition === "QUALIFIED" && RECORD_GATE_KEYS.some((key) => value[key] !== "pass")) {
      return failure("invalid_evidence", "disposition", "qualified_gate_not_pass");
    }
    const body = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      baseline: baseline.value,
      candidates,
      probes,
      ...Object.fromEntries(RECORD_GATE_KEYS.map((key) => [key, value[key]])),
      disposition: value.disposition,
    };
    const recordSha256 = canonicalHash(body);
    if (value.recordSha256 !== undefined && value.recordSha256 !== recordSha256) {
      return failure("invalid_evidence", "recordSha256", "digest_mismatch");
    }
    return success({ ...body, recordSha256 });
  } catch {
    return failure("invalid_evidence", "[root]", "unreadable_record");
  }
}

export function canonicalEvidenceJson(record) {
  const created = createQualificationRecord(record);
  if (!created.ok) return created;
  return success(canonicalStringify(created.value));
}

export const INTERNAL_FIXTURE_IDENTITIES = Object.freeze({
  nativeSourceRevision: NATIVE_SOURCE_REVISION,
  nativeDependencyLockSha256: NATIVE_LOCK_SHA256,
});
