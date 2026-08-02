import type { EvidenceRef } from "@pi-workflow/v2-domain";

import {
  inspectReadinessAssessment,
  validateAssessmentSemanticConsistency,
} from "./assessment.js";
import { inspectAssessmentHead, READINESS_STALE_REASON_ORDER } from "./freshness.js";
import {
  accept,
  childPath,
  field,
  inspectExactArray,
  inspectExactObject,
  reject,
  remapRejection,
  validateDomainScalar,
  validateEnum,
  validateSha256,
} from "./internal.js";
import type {
  QualifyReadinessForConsumptionInput,
  ReadinessConsumerPurpose,
  ReadinessFreshnessProjection,
  ReadinessQualification,
  ReadinessQualificationReason,
  ReadinessResult,
  ReadinessStaleReason,
} from "./types.js";

const PURPOSES = ["product_approval", "scheduling_eligibility_input"] as const;
const FRESHNESS = ["current", "stale"] as const;

const QUALIFICATION_REASON_ORDER = Object.freeze([
  "projection_binding_mismatch",
  "assessment_not_head",
  "assessment_head_hash_mismatch",
  "readiness_stale",
  "disposition_blocked",
  "disposition_needs_refinement",
  "disposition_must_decompose",
  "epic_cannot_be_not_applicable",
] as const satisfies readonly ReadinessQualificationReason[]);

function inspectFreshnessProjection(
  value: unknown,
  path: string,
): ReadinessResult<ReadinessFreshnessProjection> {
  const code = "qualification_mismatch" as const;
  const object = inspectExactObject(
    value,
    ["freshness", "reasons", "assessmentRef", "assessmentSha256"],
    code,
    path,
  );
  if (!object.ok) return object;
  const freshness = validateEnum(field(object.value, "freshness"), FRESHNESS, code, childPath(path, "freshness"));
  if (!freshness.ok) return freshness;
  const reasonsValue = inspectExactArray(field(object.value, "reasons"), code, childPath(path, "reasons"));
  if (!reasonsValue.ok) return reasonsValue;
  const reasons: ReadinessStaleReason[] = [];
  for (let index = 0; index < reasonsValue.value.length; index += 1) {
    const reason = validateEnum(
      reasonsValue.value[index],
      READINESS_STALE_REASON_ORDER,
      code,
      childPath(childPath(path, "reasons"), String(index)),
    );
    if (!reason.ok) return reason;
    reasons.push(reason.value);
  }
  const seen = new Set<ReadinessStaleReason>();
  for (let index = 0; index < reasons.length; index += 1) {
    const reason = reasons[index] as ReadinessStaleReason;
    if (seen.has(reason)) {
      return reject(code, childPath(childPath(path, "reasons"), String(index)), "duplicate_entry", reason);
    }
    seen.add(reason);
    if (index > 0) {
      const previous = reasons[index - 1] as ReadinessStaleReason;
      if (READINESS_STALE_REASON_ORDER.indexOf(previous) >= READINESS_STALE_REASON_ORDER.indexOf(reason)) {
        return reject(code, childPath(childPath(path, "reasons"), String(index)), "projection_assessment_mismatch", reason);
      }
    }
  }
  if ((freshness.value === "current") !== (reasons.length === 0)) {
    return reject(code, childPath(path, "reasons"), "projection_assessment_mismatch");
  }
  const assessmentRef = validateDomainScalar("EvidenceRef", field(object.value, "assessmentRef"), code, childPath(path, "assessmentRef"));
  if (!assessmentRef.ok) return assessmentRef;
  const assessmentSha256 = validateSha256(field(object.value, "assessmentSha256"), code, childPath(path, "assessmentSha256"));
  if (!assessmentSha256.ok) return assessmentSha256;
  return accept(Object.freeze({
    freshness: freshness.value,
    reasons: Object.freeze(reasons),
    assessmentRef: assessmentRef.value as EvidenceRef,
    assessmentSha256: assessmentSha256.value,
  }));
}

export function qualifyReadinessForConsumption(
  input: QualifyReadinessForConsumptionInput,
): ReadinessResult<ReadinessQualification> {
  const code = "qualification_mismatch" as const;
  const root = inspectExactObject(
    input,
    ["assessment", "freshness", "currentHead", "purpose"],
    code,
    "",
  );
  if (!root.ok) return root;
  const assessment = remapRejection(
    inspectReadinessAssessment(field(root.value, "assessment"), "/assessment"),
    code,
  );
  if (!assessment.ok) return assessment;
  const semantic = validateAssessmentSemanticConsistency(
    assessment.value,
    "/assessment",
    code,
    true,
  );
  if (!semantic.ok) {
    return reject(code, "/assessment", "projection_assessment_mismatch", assessment.value.assessmentRef);
  }
  const freshness = inspectFreshnessProjection(field(root.value, "freshness"), "/freshness");
  if (!freshness.ok) return freshness;
  const currentHead = inspectAssessmentHead(field(root.value, "currentHead"), "/currentHead", code);
  if (!currentHead.ok) return currentHead;
  const purposeValue = field(root.value, "purpose");
  if (typeof purposeValue !== "string" || !PURPOSES.includes(purposeValue as ReadinessConsumerPurpose)) {
    return reject(code, "/purpose", "invalid_purpose");
  }
  const purpose = purposeValue as ReadinessConsumerPurpose;

  const found = new Set<ReadinessQualificationReason>();
  if (
    freshness.value.assessmentRef !== assessment.value.assessmentRef ||
    freshness.value.assessmentSha256 !== assessment.value.canonicalSha256
  ) found.add("projection_binding_mismatch");
  if (currentHead.value.assessmentRef !== assessment.value.assessmentRef) found.add("assessment_not_head");
  if (currentHead.value.canonicalSha256 !== assessment.value.canonicalSha256) found.add("assessment_head_hash_mismatch");
  if (freshness.value.freshness === "stale") found.add("readiness_stale");
  if (assessment.value.disposition === "blocked") found.add("disposition_blocked");
  if (assessment.value.disposition === "needs_refinement") found.add("disposition_needs_refinement");
  if (assessment.value.disposition === "must_decompose") found.add("disposition_must_decompose");
  if (assessment.value.candidate.subject.kind === "epic" && assessment.value.applicability === "not_applicable") {
    found.add("epic_cannot_be_not_applicable");
  }

  const reasons = Object.freeze(QUALIFICATION_REASON_ORDER.filter((reason) => found.has(reason)));
  const qualified = reasons.length === 0;
  const requirement = qualified
    ? assessment.value.applicability === "not_applicable"
      ? "not_required" as const
      : "satisfied" as const
    : "unsatisfied" as const;
  return accept(Object.freeze({
    qualified,
    purpose,
    requirement,
    assessmentRef: assessment.value.assessmentRef,
    assessmentSha256: assessment.value.canonicalSha256,
    applicability: assessment.value.applicability,
    disposition: assessment.value.disposition,
    freshness: freshness.value.freshness,
    reasons,
  }));
}
