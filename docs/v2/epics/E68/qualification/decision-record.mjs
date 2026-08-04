import { createHash } from "node:crypto";
import {
  FIXTURE_VERSION,
  RUNTIME_IDENTITY,
  createDefaultCandidateManifest,
  createProbeResult,
  createQualificationRecord,
  verifyCandidateManifest,
} from "./manifest.mjs";
import { runAndCleanFaultAuthorityMatrix } from "./fault-matrix.mjs";

export const DECISION_SCHEMA_VERSION = 1;
export const GLOBAL_RECOMMENDATION = "NATIVE_ONLY";

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("non_canonical_value");
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

function buildQualificationRecord(manifest, matrix) {
  const probes = matrix.matrix.observations.map((observation) => createProbeResult(observation));
  if (probes.some((probe) => !probe.ok)) return failure("invalid_evidence", "probes", "native_probe_invalid");
  const normalizedProbes = probes.map((probe) => probe.value);
  const record = createQualificationRecord({
    schemaVersion: 1,
    baseline: manifest.baseline,
    candidates: [],
    probes: normalizedProbes,
    contractGate: "pass",
    isolationGate: "pass",
    provenanceGate: "blocked",
    faultGate: "pass",
    authorityGate: "pass",
    disposition: "BLOCKED",
  });
  return record.ok ? record : failure("invalid_evidence", "qualificationRecord", "qualification_record_invalid");
}

/**
 * Aggregate the native fixture, candidate probes, and authority matrix into a
 * deterministic recommendation. BLOCKED external evidence never becomes an
 * implicit adoption or a QUALIFIED record; native SQLite remains explicit.
 */
export function createDecisionRecord(options = {}) {
  const manifestResult = options?.manifest === undefined
    ? createDefaultCandidateManifest()
    : verifyCandidateManifest(options.manifest);
  if (!manifestResult.ok) return manifestResult;
  const matrixResult = runAndCleanFaultAuthorityMatrix({ root: options?.root, manifest: manifestResult.value, candidateRoots: options?.candidateRoots });
  if (!matrixResult.ok) return matrixResult;
  const matrix = matrixResult.value;
  const qualificationResult = buildQualificationRecord(manifestResult.value, matrix);
  if (!qualificationResult.ok) return qualificationResult;
  const qualificationRecord = qualificationResult.value;

  const candidateDispositions = matrix.candidates.map((candidate) => candidate.status === "blocked"
    ? { id: candidate.id, disposition: "BLOCKED", detail: candidate.blocked }
    : candidate.id === "native-sqlite-step-ledger"
      ? { id: candidate.id, disposition: "NATIVE_BASELINE", matrixSha256: candidate.matrixSha256 }
      : { id: candidate.id, disposition: "ADAPT_PENDING", probeSha256: candidate.probeSha256 });

  const body = {
    schemaVersion: DECISION_SCHEMA_VERSION,
    fixtureVersion: FIXTURE_VERSION,
    runtime: RUNTIME_IDENTITY,
    networkPolicy: "disabled",
    manifestSha256: matrix.manifestSha256,
    matrixSha256: matrix.matrixSha256,
    probeSha256: matrix.probeSha256,
    qualificationRecord,
    candidateDispositions,
    gates: {
      contract: "pass",
      isolation: "pass",
      provenance: "blocked",
      fault: "pass",
      authority: "pass",
    },
    globalRecommendation: GLOBAL_RECOMMENDATION,
    productionAdapterSelected: false,
    separateAdrRequired: true,
  };
  return success({ ...body, decisionSha256: digest(body) });
}

export const createQualificationDecision = createDecisionRecord;

export function canonicalDecisionJson(record) {
  if (!record || typeof record !== "object" || typeof record.decisionSha256 !== "string") {
    return failure("invalid_evidence", "decisionSha256", "decision_digest_required");
  }
  try {
    const body = { ...record };
    delete body.decisionSha256;
    if (digest(body) !== record.decisionSha256) return failure("invalid_evidence", "decisionSha256", "digest_mismatch");
    return success(canonicalJson(record));
  } catch {
    return failure("invalid_evidence", "[root]", "decision_not_canonical");
  }
}
