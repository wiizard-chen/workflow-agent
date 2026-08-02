import type {
  BundleRef,
  EpicId,
  EvidenceRef,
  InitiativeId,
  RepositoryId,
  Revision,
} from "@pi-workflow/v2-domain";

import { inspectReadinessAssessment } from "./assessment.js";
import {
  accept,
  childPath,
  compareUtf16,
  field,
  inspectExactArray,
  inspectExactObject,
  reject,
  remapRejection,
  validateDomainScalar,
  validateEnum,
  validateSha256,
  validateSourceRevision,
} from "./internal.js";
import type {
  EvidenceKind,
  ProjectReadinessFreshnessInput,
  ReadinessAssessment,
  ReadinessAssessmentHead,
  ReadinessCurrentContext,
  ReadinessEvidenceCurrentState,
  ReadinessFreshness,
  ReadinessFreshnessProjection,
  ReadinessRejectionCode,
  ReadinessResult,
  ReadinessStaleReason,
  ReadinessSubject,
  Sha256Digest,
  SourceRevision,
} from "./types.js";

const EVIDENCE_KINDS = [
  "semantic",
  "quantitative",
  "repository_feasibility",
  "applicability_policy",
  "quantitative_exception",
  "authority",
] as const;

const EVIDENCE_STATES = ["current", "invalidated", "missing"] as const;
const SUBJECT_KINDS = ["initiative", "epic"] as const;

export const READINESS_STALE_REASON_ORDER = Object.freeze([
  "subject_revision_changed",
  "bundle_changed",
  "repository_base_changed",
  "policy_changed",
  "requirement_set_changed",
  "evidence_invalidated",
  "exception_invalidated",
  "source_missing",
  "assessment_head_changed",
] as const satisfies readonly ReadinessStaleReason[]);

function inspectSubject(
  value: unknown,
  path: string,
  code: ReadinessRejectionCode,
): ReadinessResult<ReadinessSubject> {
  const object = inspectExactObject(value, ["kind", "id", "revision"], code, path);
  if (!object.ok) return object;
  const kind = validateEnum(
    field(object.value, "kind"),
    SUBJECT_KINDS,
    code,
    childPath(path, "kind"),
  );
  if (!kind.ok) return kind;
  const id = validateDomainScalar(
    kind.value === "epic" ? "EpicId" : "InitiativeId",
    field(object.value, "id"),
    code,
    childPath(path, "id"),
  );
  if (!id.ok) return id;
  const revision = validateDomainScalar(
    "Revision",
    field(object.value, "revision"),
    code,
    childPath(path, "revision"),
  );
  if (!revision.ok) return revision;
  return kind.value === "epic"
    ? accept(Object.freeze({
        kind: "epic" as const,
        id: id.value as EpicId,
        revision: revision.value as Revision,
      }))
    : accept(Object.freeze({
        kind: "initiative" as const,
        id: id.value as InitiativeId,
        revision: revision.value as Revision,
      }));
}

export function inspectAssessmentHead(
  value: unknown,
  path: string,
  code: ReadinessRejectionCode,
): ReadinessResult<ReadinessAssessmentHead> {
  const object = inspectExactObject(
    value,
    ["assessmentRef", "canonicalSha256"],
    code,
    path,
  );
  if (!object.ok) return object;
  const assessmentRef = validateDomainScalar(
    "EvidenceRef",
    field(object.value, "assessmentRef"),
    code,
    childPath(path, "assessmentRef"),
  );
  if (!assessmentRef.ok) return assessmentRef;
  const canonicalSha256 = validateSha256(
    field(object.value, "canonicalSha256"),
    code,
    childPath(path, "canonicalSha256"),
  );
  if (!canonicalSha256.ok) return canonicalSha256;
  return accept(Object.freeze({
    assessmentRef: assessmentRef.value as EvidenceRef,
    canonicalSha256: canonicalSha256.value,
  }));
}

function inspectEvidenceStates(
  value: unknown,
  path: string,
  code: ReadinessRejectionCode,
): ReadinessResult<readonly ReadinessEvidenceCurrentState[]> {
  const array = inspectExactArray(value, code, path);
  if (!array.ok) return array;
  const states: ReadinessEvidenceCurrentState[] = [];

  for (let index = 0; index < array.value.length; index += 1) {
    const itemPath = childPath(path, String(index));
    const object = inspectExactObject(
      array.value[index],
      ["evidenceRef", "kind", "state", "canonicalSha256"],
      code,
      itemPath,
    );
    if (!object.ok) return object;
    const evidenceRef = validateDomainScalar(
      "EvidenceRef",
      field(object.value, "evidenceRef"),
      code,
      childPath(itemPath, "evidenceRef"),
    );
    if (!evidenceRef.ok) return evidenceRef;
    const kind = validateEnum(
      field(object.value, "kind"),
      EVIDENCE_KINDS,
      code,
      childPath(itemPath, "kind"),
    );
    if (!kind.ok) return kind;
    const state = validateEnum(
      field(object.value, "state"),
      EVIDENCE_STATES,
      code,
      childPath(itemPath, "state"),
    );
    if (!state.ok) return state;

    const digestValue = field(object.value, "canonicalSha256");
    let canonicalSha256: Sha256Digest | null = null;
    if (state.value === "missing") {
      if (digestValue !== null) {
        return reject(
          code,
          childPath(itemPath, "canonicalSha256"),
          "invalid_context_state",
          evidenceRef.value,
        );
      }
    } else {
      if (digestValue === null) {
        return reject(
          code,
          childPath(itemPath, "canonicalSha256"),
          "invalid_context_state",
          evidenceRef.value,
        );
      }
      const digest = validateSha256(
        digestValue,
        code,
        childPath(itemPath, "canonicalSha256"),
      );
      if (!digest.ok) return digest;
      canonicalSha256 = digest.value;
    }

    states.push(Object.freeze({
      evidenceRef: evidenceRef.value as EvidenceRef,
      kind: kind.value as EvidenceKind,
      state: state.value,
      canonicalSha256,
    }));
  }

  const seen = new Set<string>();
  for (let index = 0; index < states.length; index += 1) {
    const current = states[index] as ReadinessEvidenceCurrentState;
    if (seen.has(current.evidenceRef)) {
      return reject(
        code,
        childPath(childPath(path, String(index)), "evidenceRef"),
        "duplicate_entry",
        current.evidenceRef,
      );
    }
    seen.add(current.evidenceRef);
  }
  for (let index = 1; index < states.length; index += 1) {
    const previous = states[index - 1] as ReadinessEvidenceCurrentState;
    const current = states[index] as ReadinessEvidenceCurrentState;
    if (compareUtf16(previous.evidenceRef, current.evidenceRef) >= 0) {
      return reject(
        code,
        childPath(childPath(path, String(index)), "evidenceRef"),
        "context_evidence_mismatch",
        current.evidenceRef,
      );
    }
  }
  return accept(Object.freeze(states));
}

function inspectCurrentContext(
  value: unknown,
  path: string,
): ReadinessResult<ReadinessCurrentContext> {
  const code = "invalid_freshness_context" as const;
  const object = inspectExactObject(
    value,
    [
      "subject",
      "bundle",
      "repository",
      "policy",
      "requirementSet",
      "evidence",
      "assessmentHead",
    ],
    code,
    path,
  );
  if (!object.ok) return object;
  const subject = inspectSubject(field(object.value, "subject"), childPath(path, "subject"), code);
  if (!subject.ok) return subject;

  const bundlePath = childPath(path, "bundle");
  const bundle = inspectExactObject(field(object.value, "bundle"), ["ref", "manifestSha256"], code, bundlePath);
  if (!bundle.ok) return bundle;
  const bundleRef = validateDomainScalar("BundleRef", field(bundle.value, "ref"), code, childPath(bundlePath, "ref"));
  if (!bundleRef.ok) return bundleRef;
  const manifestSha256 = validateSha256(field(bundle.value, "manifestSha256"), code, childPath(bundlePath, "manifestSha256"));
  if (!manifestSha256.ok) return manifestSha256;

  const repositoryPath = childPath(path, "repository");
  const repository = inspectExactObject(field(object.value, "repository"), ["id", "baseRevision"], code, repositoryPath);
  if (!repository.ok) return repository;
  const repositoryId = validateDomainScalar("RepositoryId", field(repository.value, "id"), code, childPath(repositoryPath, "id"));
  if (!repositoryId.ok) return repositoryId;
  const baseRevision = validateSourceRevision(field(repository.value, "baseRevision"), code, childPath(repositoryPath, "baseRevision"));
  if (!baseRevision.ok) return baseRevision;

  const policyPath = childPath(path, "policy");
  const policy = inspectExactObject(field(object.value, "policy"), ["ref", "profileRevision"], code, policyPath);
  if (!policy.ok) return policy;
  const policyRef = validateDomainScalar("EvidenceRef", field(policy.value, "ref"), code, childPath(policyPath, "ref"));
  if (!policyRef.ok) return policyRef;
  const profileRevision = validateSourceRevision(field(policy.value, "profileRevision"), code, childPath(policyPath, "profileRevision"));
  if (!profileRevision.ok) return profileRevision;

  const requirementPath = childPath(path, "requirementSet");
  const requirement = inspectExactObject(field(object.value, "requirementSet"), ["ref", "revision"], code, requirementPath);
  if (!requirement.ok) return requirement;
  const requirementRef = validateDomainScalar("EvidenceRef", field(requirement.value, "ref"), code, childPath(requirementPath, "ref"));
  if (!requirementRef.ok) return requirementRef;
  const requirementRevision = validateSourceRevision(field(requirement.value, "revision"), code, childPath(requirementPath, "revision"));
  if (!requirementRevision.ok) return requirementRevision;

  const evidence = inspectEvidenceStates(field(object.value, "evidence"), childPath(path, "evidence"), code);
  if (!evidence.ok) return evidence;
  const assessmentHead = inspectAssessmentHead(field(object.value, "assessmentHead"), childPath(path, "assessmentHead"), code);
  if (!assessmentHead.ok) return assessmentHead;

  return accept(Object.freeze({
    subject: subject.value,
    bundle: Object.freeze({ ref: bundleRef.value as BundleRef, manifestSha256: manifestSha256.value }),
    repository: Object.freeze({ id: repositoryId.value as RepositoryId, baseRevision: baseRevision.value as SourceRevision }),
    policy: Object.freeze({ ref: policyRef.value as EvidenceRef, profileRevision: profileRevision.value as SourceRevision }),
    requirementSet: Object.freeze({ ref: requirementRef.value as EvidenceRef, revision: requirementRevision.value as SourceRevision }),
    evidence: evidence.value,
    assessmentHead: assessmentHead.value,
  }));
}

function validateEvidenceInventory(
  assessment: ReadinessAssessment,
  current: ReadinessCurrentContext,
): ReadinessResult<ReadinessCurrentContext> {
  const code = "invalid_freshness_context" as const;
  const expected = new Map<string, ReadinessAssessment["evidence"][number]>();
  for (const binding of assessment.evidence) {
    if (expected.has(binding.evidenceRef)) {
      return reject(
        code,
        "/current/evidence",
        "context_evidence_mismatch",
        binding.evidenceRef,
      );
    }
    expected.set(binding.evidenceRef, binding);
  }
  for (let index = 0; index < current.evidence.length; index += 1) {
    const state = current.evidence[index] as ReadinessEvidenceCurrentState;
    const binding = expected.get(state.evidenceRef);
    if (binding === undefined) {
      return reject(code, childPath(childPath("/current/evidence", String(index)), "evidenceRef"), "context_evidence_mismatch", state.evidenceRef);
    }
    if (binding.kind !== state.kind) {
      return reject(code, childPath(childPath("/current/evidence", String(index)), "kind"), "context_evidence_mismatch", state.evidenceRef);
    }
    expected.delete(state.evidenceRef);
  }
  if (expected.size > 0) {
    const missingRef = [...expected.keys()].sort(compareUtf16)[0] as EvidenceRef;
    return reject(code, "/current/evidence", "context_evidence_mismatch", missingRef);
  }
  return accept(current);
}

export function projectReadinessFreshness(
  input: ProjectReadinessFreshnessInput,
): ReadinessResult<ReadinessFreshnessProjection> {
  const code = "invalid_freshness_context" as const;
  const root = inspectExactObject(input, ["assessment", "current"], code, "");
  if (!root.ok) return root;
  const assessment = remapRejection(
    inspectReadinessAssessment(field(root.value, "assessment"), "/assessment"),
    code,
  );
  if (!assessment.ok) return assessment;
  const current = inspectCurrentContext(field(root.value, "current"), "/current");
  if (!current.ok) return current;
  const inventory = validateEvidenceInventory(assessment.value, current.value);
  if (!inventory.ok) return inventory;

  const candidate = assessment.value.candidate;
  const context = current.value;
  const found = new Set<ReadinessStaleReason>();
  if (
    context.subject.kind !== candidate.subject.kind ||
    context.subject.id !== candidate.subject.id ||
    context.subject.revision !== candidate.subject.revision
  ) found.add("subject_revision_changed");
  if (context.bundle.ref !== candidate.bundle.ref || context.bundle.manifestSha256 !== candidate.bundle.manifestSha256) found.add("bundle_changed");
  if (context.repository.id !== candidate.repository.id || context.repository.baseRevision !== candidate.repository.baseRevision) found.add("repository_base_changed");
  if (context.policy.ref !== candidate.policy.ref || context.policy.profileRevision !== candidate.policy.profileRevision) found.add("policy_changed");
  if (context.requirementSet.ref !== candidate.requirementSet.ref || context.requirementSet.revision !== candidate.requirementSet.revision) found.add("requirement_set_changed");

  const bindingByRef = new Map(assessment.value.evidence.map((binding) => [binding.evidenceRef, binding]));
  for (const state of context.evidence) {
    const binding = bindingByRef.get(state.evidenceRef);
    if (binding === undefined) continue;
    if (state.state === "missing") {
      found.add("source_missing");
    } else if (state.state === "invalidated" || state.canonicalSha256 !== binding.canonicalSha256) {
      found.add(state.kind === "quantitative_exception" ? "exception_invalidated" : "evidence_invalidated");
    }
  }
  if (
    context.assessmentHead.assessmentRef !== assessment.value.assessmentRef ||
    context.assessmentHead.canonicalSha256 !== assessment.value.canonicalSha256
  ) found.add("assessment_head_changed");

  const reasons = Object.freeze(READINESS_STALE_REASON_ORDER.filter((reason) => found.has(reason)));
  const freshness: ReadinessFreshness = reasons.length === 0 ? "current" : "stale";
  return accept(Object.freeze({
    freshness,
    reasons,
    assessmentRef: assessment.value.assessmentRef,
    assessmentSha256: assessment.value.canonicalSha256,
  }));
}
