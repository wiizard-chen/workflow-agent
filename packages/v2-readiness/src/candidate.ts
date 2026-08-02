import type {
  BundleRef,
  EpicId,
  EvidenceRef,
  InitiativeId,
  RepositoryId,
  Revision,
} from "@pi-workflow/v2-domain";

import {
  accept,
  canonicalHash,
  childPath,
  field,
  inspectExactObject,
  reject,
  validateDomainScalar,
  validateEnum,
  validateSha256,
  validateSourceRevision,
} from "./internal.js";
import type {
  CreateReadinessCandidateBindingInput,
  ReadinessApplicability,
  ReadinessCandidateBinding,
  ReadinessResult,
  ReadinessSubject,
  Sha256Digest,
  SourceRevision,
} from "./types.js";

const APPLICABILITY = ["applicable", "not_applicable"] as const;
const SUBJECT_KINDS = ["initiative", "epic"] as const;

type CandidateParts = Readonly<{
  input: CreateReadinessCandidateBindingInput;
  claimedDigest: Sha256Digest | null;
}>;

function validateSubject(value: unknown, path: string): ReadinessResult<ReadinessSubject> {
  const inspected = inspectExactObject(
    value,
    ["kind", "id", "revision"],
    "invalid_input",
    path,
  );
  if (!inspected.ok) return inspected;

  const kind = validateEnum(
    field(inspected.value, "kind"),
    SUBJECT_KINDS,
    "invalid_input",
    childPath(path, "kind"),
  );
  if (!kind.ok) return kind;
  const idKind = kind.value === "epic" ? "EpicId" : "InitiativeId";
  const id = validateDomainScalar(
    idKind,
    field(inspected.value, "id"),
    "invalid_input",
    childPath(path, "id"),
  );
  if (!id.ok) return id;
  const revision = validateDomainScalar(
    "Revision",
    field(inspected.value, "revision"),
    "invalid_input",
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

function validateCandidateParts(
  value: unknown,
  path: string,
  withDigest: boolean,
  enforceApplicability: boolean,
): ReadinessResult<CandidateParts> {
  const fields = [
    "subject",
    "bundle",
    "repository",
    "policy",
    "requirementSet",
    "applicability",
    ...(withDigest ? ["canonicalSha256"] : []),
  ];
  const inspected = inspectExactObject(value, fields, "invalid_input", path);
  if (!inspected.ok) return inspected;

  const subject = validateSubject(field(inspected.value, "subject"), childPath(path, "subject"));
  if (!subject.ok) return subject;

  const bundlePath = childPath(path, "bundle");
  const bundleFields = inspectExactObject(
    field(inspected.value, "bundle"),
    ["ref", "manifestSha256"],
    "invalid_input",
    bundlePath,
  );
  if (!bundleFields.ok) return bundleFields;
  const bundleRef = validateDomainScalar(
    "BundleRef",
    field(bundleFields.value, "ref"),
    "invalid_input",
    childPath(bundlePath, "ref"),
  );
  if (!bundleRef.ok) return bundleRef;
  const manifestSha256 = validateSha256(
    field(bundleFields.value, "manifestSha256"),
    "invalid_input",
    childPath(bundlePath, "manifestSha256"),
  );
  if (!manifestSha256.ok) return manifestSha256;

  const repositoryPath = childPath(path, "repository");
  const repositoryFields = inspectExactObject(
    field(inspected.value, "repository"),
    ["id", "baseRevision"],
    "invalid_input",
    repositoryPath,
  );
  if (!repositoryFields.ok) return repositoryFields;
  const repositoryId = validateDomainScalar(
    "RepositoryId",
    field(repositoryFields.value, "id"),
    "invalid_input",
    childPath(repositoryPath, "id"),
  );
  if (!repositoryId.ok) return repositoryId;
  const baseRevision = validateSourceRevision(
    field(repositoryFields.value, "baseRevision"),
    "invalid_input",
    childPath(repositoryPath, "baseRevision"),
  );
  if (!baseRevision.ok) return baseRevision;

  const policyPath = childPath(path, "policy");
  const policyFields = inspectExactObject(
    field(inspected.value, "policy"),
    ["ref", "profileRevision"],
    "invalid_input",
    policyPath,
  );
  if (!policyFields.ok) return policyFields;
  const policyRef = validateDomainScalar(
    "EvidenceRef",
    field(policyFields.value, "ref"),
    "invalid_input",
    childPath(policyPath, "ref"),
  );
  if (!policyRef.ok) return policyRef;
  const profileRevision = validateSourceRevision(
    field(policyFields.value, "profileRevision"),
    "invalid_input",
    childPath(policyPath, "profileRevision"),
  );
  if (!profileRevision.ok) return profileRevision;

  const requirementPath = childPath(path, "requirementSet");
  const requirementFields = inspectExactObject(
    field(inspected.value, "requirementSet"),
    ["ref", "revision"],
    "invalid_input",
    requirementPath,
  );
  if (!requirementFields.ok) return requirementFields;
  const requirementRef = validateDomainScalar(
    "EvidenceRef",
    field(requirementFields.value, "ref"),
    "invalid_input",
    childPath(requirementPath, "ref"),
  );
  if (!requirementRef.ok) return requirementRef;
  const requirementRevision = validateSourceRevision(
    field(requirementFields.value, "revision"),
    "invalid_input",
    childPath(requirementPath, "revision"),
  );
  if (!requirementRevision.ok) return requirementRevision;

  const applicability = validateEnum(
    field(inspected.value, "applicability"),
    APPLICABILITY,
    "invalid_input",
    childPath(path, "applicability"),
  );
  if (!applicability.ok) return applicability;
  if (
    enforceApplicability &&
    subject.value.kind === "epic" &&
    applicability.value === "not_applicable"
  ) {
    return reject("invalid_binding", childPath(path, "applicability"), "epic_not_applicable");
  }

  let claimedDigest: Sha256Digest | null = null;
  if (withDigest) {
    const digest = validateSha256(
      field(inspected.value, "canonicalSha256"),
      "invalid_binding",
      childPath(path, "canonicalSha256"),
    );
    if (!digest.ok) return digest;
    claimedDigest = digest.value;
  }

  const input: CreateReadinessCandidateBindingInput = Object.freeze({
    subject: subject.value,
    bundle: Object.freeze({
      ref: bundleRef.value as BundleRef,
      manifestSha256: manifestSha256.value,
    }),
    repository: Object.freeze({
      id: repositoryId.value as RepositoryId,
      baseRevision: baseRevision.value as SourceRevision,
    }),
    policy: Object.freeze({
      ref: policyRef.value as EvidenceRef,
      profileRevision: profileRevision.value as SourceRevision,
    }),
    requirementSet: Object.freeze({
      ref: requirementRef.value as EvidenceRef,
      revision: requirementRevision.value as SourceRevision,
    }),
    applicability: applicability.value as ReadinessApplicability,
  });
  return accept(Object.freeze({ input, claimedDigest }));
}

export function createReadinessCandidateBinding(
  input: CreateReadinessCandidateBindingInput,
): ReadinessResult<ReadinessCandidateBinding> {
  const validated = validateCandidateParts(input, "", false, true);
  if (!validated.ok) return validated;
  const canonical = canonicalHash(validated.value.input, "invalid_input");
  if (!canonical.ok) return canonical;
  return accept(Object.freeze({
    ...(canonical.value.value as CreateReadinessCandidateBindingInput),
    canonicalSha256: canonical.value.digest,
  }));
}

export function validateCandidateBinding(
  value: unknown,
  path = "",
): ReadinessResult<ReadinessCandidateBinding> {
  const inspected = inspectCandidateBinding(value, path);
  if (!inspected.ok) return inspected;
  if (
    inspected.value.subject.kind === "epic" &&
    inspected.value.applicability === "not_applicable"
  ) {
    return reject(
      "invalid_binding",
      childPath(path, "applicability"),
      "epic_not_applicable",
    );
  }
  return inspected;
}

export function inspectCandidateBinding(
  value: unknown,
  path = "",
): ReadinessResult<ReadinessCandidateBinding> {
  const validated = validateCandidateParts(value, path, true, false);
  if (!validated.ok) return validated;
  const canonical = canonicalHash(validated.value.input, "invalid_binding", path);
  if (!canonical.ok) return canonical;
  if (canonical.value.digest !== validated.value.claimedDigest) {
    return reject(
      "invalid_binding",
      childPath(path, "canonicalSha256"),
      "invalid_canonical_hash",
    );
  }
  return accept(Object.freeze({
    ...(canonical.value.value as CreateReadinessCandidateBindingInput),
    canonicalSha256: canonical.value.digest,
  }));
}
