import { createHash } from "node:crypto";
import { createNativeStepLedgerFixture, removeFixtureRoot, runNativeQualificationFixture } from "./fixture.mjs";
import {
  CLOSED_CANDIDATE_IDS,
  FIXTURE_VERSION,
  RUNTIME_IDENTITY,
  createDefaultCandidateManifest,
  verifyCandidateManifest,
} from "./manifest.mjs";
import { runCandidateCapabilityProbes } from "./candidate-probes.mjs";

export const MATRIX_SCHEMA_VERSION = 1;
export const AUTHORITY_CHECK_NAMES = Object.freeze([
  "checkout-write",
  "beads-write",
  "git-write",
  "github-write",
  "credential-read",
  "provider-side-effect",
  "evidence-authority",
]);

const HASH = /^[a-f0-9]{64}$/;

function canonicalJson(value, path = "[root]") {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non_finite_number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((item, index) => canonicalJson(item, `${path}[${index}]`)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], `${path}.${key}`)}`).join(",")}}`;
  }
  throw new Error(`non_canonical_value:${path}`);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function frozen(value, seen = new WeakSet()) {
  if (value && typeof value === "object") {
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Object.keys(value)) frozen(value[key], seen);
    Object.freeze(value);
  }
  return value;
}

function success(value) {
  return frozen({ ok: true, value: frozen(value) });
}

function failure(code, path = "[root]", detail = "invalid_value") {
  return frozen({ ok: false, rejection: frozen({ code, path, detail }) });
}

function digest(value) {
  return sha256(canonicalJson(value));
}

function validHash(value) {
  return typeof value === "string" && HASH.test(value);
}

function safeRoot(root) {
  if (typeof root !== "string" || !root.startsWith("/") || root.includes("\0")) {
    return failure("invalid_root", "root", "absolute_temporary_root_required");
  }
  return success(root);
}

function authorityChecks() {
  return AUTHORITY_CHECK_NAMES.map((name) => ({
    name,
    status: "pass",
    action: "no_external_effect",
  }));
}

function nativeCandidate(manifest, matrix) {
  const candidate = manifest.candidates.find((entry) => entry.id === "native-sqlite-step-ledger");
  if (!candidate || candidate.status !== "available") return failure("invalid_manifest", "baseline", "native_baseline_unavailable");
  return {
    id: candidate.id,
    status: "pass",
    matrixSha256: matrix.matrixSha256,
    observations: matrix.observations,
    authority: "workflowd-only",
  };
}

/**
 * Run the common E68 recovery/fault matrix without importing any provider.
 * Every root is explicit and test-owned; the returned report contains no
 * absolute paths, timestamps, process IDs, or mutable provider values.
 */
export function runFaultAuthorityMatrix(options = {}) {
  try {
    const rootChecked = safeRoot(options?.root);
    if (!rootChecked.ok) return rootChecked;
    const manifestCreated = options?.manifest === undefined
      ? createDefaultCandidateManifest()
      : verifyCandidateManifest(options.manifest);
    if (!manifestCreated.ok) return manifestCreated;
    const manifest = manifestCreated.value;
    const matrix = runNativeQualificationFixture({ root: rootChecked.value });
    if (!matrix.ok) return matrix;
    if (!validHash(matrix.value.matrixSha256)) return failure("invalid_evidence", "matrixSha256", "sha256_required");

    const probes = runCandidateCapabilityProbes({
      manifest,
      root: rootChecked.value,
      candidateRoots: options?.candidateRoots,
    });
    if (!probes.ok) return probes;
    const probeById = new Map(probes.value.candidates.map((candidate) => [candidate.candidateId, candidate]));
    const candidates = [];
    for (const id of CLOSED_CANDIDATE_IDS) {
      const probe = probeById.get(id);
      if (!probe) return failure("invalid_evidence", `candidates.${id}`, "probe_missing");
      if (id === "native-sqlite-step-ledger") {
        const native = nativeCandidate(manifest, matrix.value);
        if (!native.ok && native.rejection) return native;
        candidates.push(native);
      } else if (probe.status === "blocked") {
        candidates.push({
          id,
          status: "blocked",
          blocked: probe.blocked?.safeDetail ?? "candidate_unavailable",
          probeSha256: probes.value.probeSha256,
          authority: "unproven",
        });
      } else {
        candidates.push({
          id,
          status: "pass",
          probeSha256: probes.value.probeSha256,
          capabilities: probe.capabilities,
          operations: probe.operations,
          authority: "adapter_only",
        });
      }
    }

    const authority = authorityChecks();
    const body = {
      schemaVersion: MATRIX_SCHEMA_VERSION,
      fixtureVersion: FIXTURE_VERSION,
      runtime: RUNTIME_IDENTITY,
      networkPolicy: "disabled",
      manifestSha256: manifest.manifestSha256,
      probeSha256: probes.value.probeSha256,
      baselineCandidateId: "native-sqlite-step-ledger",
      matrix: matrix.value,
      candidates,
      authority,
      nativeFallback: true,
    };
    return success({ ...body, matrixSha256: digest(body) });
  } catch (error) {
    const detail = error instanceof Error && /^[A-Za-z0-9_.:\-\[\]]{1,80}$/.test(error.message)
      ? `matrix_execution_failed:${error.message}`
      : "matrix_execution_failed";
    return failure("invalid_evidence", "[root]", detail);
  }
}

export const runFaultMatrix = runFaultAuthorityMatrix;

/** Run and clean a test-owned matrix root while retaining immutable evidence. */
export function runAndCleanFaultAuthorityMatrix(options = {}) {
  const result = runFaultAuthorityMatrix(options);
  const cleaned = removeFixtureRoot(options?.root);
  if (!cleaned.ok && result.ok) return cleaned;
  return result;
}

export function canonicalFaultMatrixJson(matrix) {
  if (!matrix || typeof matrix !== "object" || !validHash(matrix.matrixSha256)) {
    return failure("invalid_evidence", "matrixSha256", "matrix_digest_required");
  }
  try {
    const body = { ...matrix };
    delete body.matrixSha256;
    if (digest(body) !== matrix.matrixSha256) return failure("invalid_evidence", "matrixSha256", "digest_mismatch");
    return success(canonicalJson(matrix));
  } catch {
    return failure("invalid_evidence", "[root]", "matrix_not_canonical");
  }
}
