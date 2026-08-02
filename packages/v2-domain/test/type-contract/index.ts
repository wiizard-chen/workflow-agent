import { parseScalar } from "@pi-workflow/v2-domain";
import type {
  ActorRef,
  ApprovalAttemptId,
  BundleRef,
  CanonicalJsonReason,
  CanonicalJsonRejection,
  CanonicalJsonResult,
  ChangeRequestId,
  ConformanceViolation,
  ConformanceViolationCode,
  DecisionRef,
  DeepReadonly,
  DeliveryUnitId,
  DeliveryUnitIdentityRecord,
  DimensionedDomainValue,
  DimensionMap,
  DomainTimestamp,
  DomainTransitionContext,
  DomainTransitionRecord,
  DomainTransitionResult,
  EntityIdScalarKind,
  EnvelopeRejection,
  EnvelopeResult,
  EpicId,
  EpicIdentityRecord,
  EvidenceRef,
  HierarchyIdentityRecord,
  HierarchyRejection,
  HierarchyRejectionCode,
  HierarchySnapshot,
  HierarchyValidationResult,
  ImmutableRevisionEnvelope,
  InitiativeId,
  InitiativeIdentityRecord,
  JsonPrimitive,
  JsonValue,
  LaunchPermitId,
  NewRevisionEnvelopeInput,
  OwnershipRejection,
  OwnershipValidationResult,
  PortfolioId,
  PortfolioIdentityRecord,
  PositiveOrdinal,
  PrimitiveTransitionRejection,
  PrimitiveTransitionRequest,
  ReasonRef,
  RepositoryId,
  Revision,
  RoleRunId,
  ScalarByKind,
  ScalarKind,
  ScalarRejection,
  ScalarResult,
  SingleDimensionConformanceCase,
  SingleDimensionConformanceResult,
  StepAttemptId,
  TaskAttemptId,
  TaskAttemptOwnerRef,
  TaskId,
  TaskIdentityRecord,
  TransitionId,
  TransitionName,
  TypedDomainRejection,
} from "@pi-workflow/v2-domain";

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? (<T>() => T extends Right ? 1 : 2) extends
      (<T>() => T extends Left ? 1 : 2)
      ? true
      : false
    : false;

type Assert<Condition extends true> = Condition;
type AssertNever<Value extends never> = Value;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Not<Condition extends boolean> = Condition extends true ? false : true;
type WritableKeys<T extends object> = {
  [K in keyof T]-?: Equal<
    { [P in K]: T[P] },
    { -readonly [P in K]: T[P] }
  > extends true ? K : never;
}[keyof T];

type _AttemptPair01 = Assert<Not<Equal<TaskAttemptId, StepAttemptId>>>;
type _AttemptPair02 = Assert<Not<Equal<TaskAttemptId, RoleRunId>>>;
type _AttemptPair03 = Assert<Not<Equal<TaskAttemptId, LaunchPermitId>>>;
type _AttemptPair12 = Assert<Not<Equal<StepAttemptId, RoleRunId>>>;
type _AttemptPair13 = Assert<Not<Equal<StepAttemptId, LaunchPermitId>>>;
type _AttemptPair23 = Assert<Not<Equal<RoleRunId, LaunchPermitId>>>;
type _TaskAttemptNotAssignableToStepAttempt = Assert<
  Not<IsAssignable<TaskAttemptId, StepAttemptId>>
>;
type _StepAttemptNotAssignableToTaskAttempt = Assert<
  Not<IsAssignable<StepAttemptId, TaskAttemptId>>
>;
type _TaskAttemptNotAssignableToRoleRun = Assert<
  Not<IsAssignable<TaskAttemptId, RoleRunId>>
>;
type _RoleRunNotAssignableToTaskAttempt = Assert<
  Not<IsAssignable<RoleRunId, TaskAttemptId>>
>;
type _TaskAttemptNotAssignableToLaunchPermit = Assert<
  Not<IsAssignable<TaskAttemptId, LaunchPermitId>>
>;
type _LaunchPermitNotAssignableToTaskAttempt = Assert<
  Not<IsAssignable<LaunchPermitId, TaskAttemptId>>
>;
type _StepAttemptNotAssignableToRoleRun = Assert<
  Not<IsAssignable<StepAttemptId, RoleRunId>>
>;
type _RoleRunNotAssignableToStepAttempt = Assert<
  Not<IsAssignable<RoleRunId, StepAttemptId>>
>;
type _StepAttemptNotAssignableToLaunchPermit = Assert<
  Not<IsAssignable<StepAttemptId, LaunchPermitId>>
>;
type _LaunchPermitNotAssignableToStepAttempt = Assert<
  Not<IsAssignable<LaunchPermitId, StepAttemptId>>
>;
type _RoleRunNotAssignableToLaunchPermit = Assert<
  Not<IsAssignable<RoleRunId, LaunchPermitId>>
>;
type _LaunchPermitNotAssignableToRoleRun = Assert<
  Not<IsAssignable<LaunchPermitId, RoleRunId>>
>;

declare const taskAttemptId: TaskAttemptId;
declare const stepAttemptId: StepAttemptId;
declare const roleRunId: RoleRunId;
declare const launchPermitId: LaunchPermitId;
// @ts-expect-error pairwise opaque brands are not assignable
const wrongStepAttempt: StepAttemptId = taskAttemptId;
// @ts-expect-error pairwise opaque brands are not assignable
const wrongRoleRun: RoleRunId = stepAttemptId;
// @ts-expect-error pairwise opaque brands are not assignable
const wrongLaunchPermit: LaunchPermitId = roleRunId;
// @ts-expect-error pairwise opaque brands are not assignable
const wrongTaskAttempt: TaskAttemptId = launchPermitId;
void [wrongStepAttempt, wrongRoleRun, wrongLaunchPermit, wrongTaskAttempt];

const parsedTask = parseScalar("TaskId", "task-1");
if (parsedTask.ok) {
  const inferredTaskId: TaskId = parsedTask.value;
  // @ts-expect-error parser inference retains the exact scalar brand
  const inferredEpicId: EpicId = parsedTask.value;
  void [inferredTaskId, inferredEpicId];
}

type ExpectedScalarKinds =
  | "PortfolioId"
  | "InitiativeId"
  | "EpicId"
  | "DeliveryUnitId"
  | "TaskId"
  | "TaskAttemptId"
  | "StepAttemptId"
  | "RoleRunId"
  | "LaunchPermitId"
  | "ApprovalAttemptId"
  | "ChangeRequestId"
  | "RepositoryId"
  | "TransitionId"
  | "EvidenceRef"
  | "BundleRef"
  | "DecisionRef"
  | "ActorRef"
  | "ReasonRef"
  | "DomainTimestamp"
  | "TransitionName"
  | "Revision"
  | "PositiveOrdinal";
type ExpectedEntityKinds =
  | "PortfolioId"
  | "InitiativeId"
  | "EpicId"
  | "DeliveryUnitId"
  | "TaskId"
  | "TaskAttemptId"
  | "StepAttemptId"
  | "RoleRunId"
  | "LaunchPermitId"
  | "ApprovalAttemptId"
  | "ChangeRequestId"
  | "RepositoryId"
  | "TransitionId";
type _ScalarKindsExact = Assert<Equal<ScalarKind, ExpectedScalarKinds>>;
type _ScalarMapKeysExact = Assert<Equal<keyof ScalarByKind, ExpectedScalarKinds>>;
type _EntityKindsExact = Assert<Equal<EntityIdScalarKind, ExpectedEntityKinds>>;

type ExpectedCanonicalReasons =
  | "unsupported_type"
  | "non_finite_number"
  | "sparse_array"
  | "cycle"
  | "symbol_key"
  | "accessor"
  | "non_plain_object"
  | "lone_surrogate";
type _CanonicalReasonsExact = Assert<
  Equal<CanonicalJsonReason, ExpectedCanonicalReasons>
>;

type ExpectedHierarchyCodes =
  | "invalid_snapshot"
  | "invalid_record"
  | "invalid_envelope"
  | "invalid_scalar"
  | "invalid_ordinal"
  | "missing_parent"
  | "parent_kind_mismatch"
  | "duplicate_identity"
  | "duplicate_sibling_identity"
  | "multiple_parent_ownership"
  | "repository_mismatch"
  | "missing_task"
  | "duplicate_task_attempt_ownership";
type _HierarchyCodesExact = Assert<
  Equal<HierarchyRejectionCode, ExpectedHierarchyCodes>
>;

type ExpectedOwnershipCodes =
  | "invalid_record"
  | "invalid_envelope"
  | "invalid_scalar"
  | "immutable_identity_changed"
  | "immutable_parent_changed"
  | "immutable_repository_changed"
  | "invalid_ordinal";
type _OwnershipCodesExact = Assert<
  Equal<OwnershipRejection["code"], ExpectedOwnershipCodes>
>;

type ExpectedPrimitiveCodes =
  | "invalid_envelope"
  | "invalid_revision"
  | "expected_revision_mismatch"
  | "revision_exhausted"
  | "invalid_dimension"
  | "unchanged_dimension"
  | "invalid_transition_context"
  | "invalid_canonical_value";
type _PrimitiveCodesExact = Assert<
  Equal<PrimitiveTransitionRejection["code"], ExpectedPrimitiveCodes>
>;

type ExpectedConformanceCodes =
  | "success_expected"
  | "input_mutated"
  | "revision_increment_invalid"
  | "audit_field_invalid"
  | "declared_dimension_unchanged"
  | "undeclared_dimension_changed"
  | "attributes_changed"
  | "transition_record_mismatch"
  | "nondeterministic_result"
  | "typed_stale_rejection_missing"
  | "partial_next_on_rejection"
  | "output_not_frozen"
  | "invoke_threw"
  | "invalid_result";
type _ConformanceCodesExact = Assert<
  Equal<ConformanceViolationCode, ExpectedConformanceCodes>
>;

interface ValidDimensions {
  phase: {
    state: string;
    optionalNested?: { note: string };
  };
  requiredTuple: readonly [string, number];
  variadicTuple: readonly [string, ...number[]];
  values: readonly { enabled: boolean }[];
  recursiveBoundary: JsonValue;
  emptyRecord: Readonly<Record<string, never>>;
  union: { left: string } | { right: number };
}

declare const validDimensions: ValidDimensions;
const validDimensionMap: DimensionMap<ValidDimensions> = validDimensions;
void validDimensionMap;

interface OptionalTopLevelDimension { phase?: string }
declare const optionalTopLevelDimension: OptionalTopLevelDimension;
// @ts-expect-error top-level dimensions must all be required
const rejectedOptionalTopLevel: DimensionMap<OptionalTopLevelDimension> = optionalTopLevelDimension;

interface ExplicitUndefinedDimension { phase: { value?: string | undefined } }
declare const explicitUndefinedDimension: ExplicitUndefinedDimension;
// @ts-expect-error explicitly declared undefined is outside JSON
const rejectedExplicitUndefined: DimensionMap<ExplicitUndefinedDimension> = explicitUndefinedDimension;

declare const objectSymbol: unique symbol;
interface SymbolObjectDimension { phase: { value: string; [objectSymbol]: string } }
declare const symbolObjectDimension: SymbolObjectDimension;
// @ts-expect-error nested symbol keys are outside JSON
const rejectedObjectSymbol: DimensionMap<SymbolObjectDimension> = symbolObjectDimension;

declare const arraySymbol: unique symbol;
type SymbolArray = readonly string[] & { readonly [arraySymbol]: string };
interface SymbolArrayDimension { phase: SymbolArray }
declare const symbolArrayDimension: SymbolArrayDimension;
// @ts-expect-error arrays may not declare extra symbol keys
const rejectedArraySymbol: DimensionMap<SymbolArrayDimension> = symbolArrayDimension;

interface CallableValue { (): void; readonly label: string }
interface CallableDimension { phase: CallableValue }
declare const callableDimension: CallableDimension;
// @ts-expect-error call signatures are outside JSON
const rejectedCallable: DimensionMap<CallableDimension> = callableDimension;

interface ConstructableValue { new (): object; readonly label: string }
interface ConstructableDimension { phase: ConstructableValue }
declare const constructableDimension: ConstructableDimension;
// @ts-expect-error construct signatures are outside JSON
const rejectedConstructable: DimensionMap<ConstructableDimension> = constructableDimension;

interface FunctionDimension { phase: { execute: () => void } }
declare const functionDimension: FunctionDimension;
// @ts-expect-error function members are outside JSON
const rejectedFunction: DimensionMap<FunctionDimension> = functionDimension;

interface OptionalTupleDimension { phase: readonly [string, number?] }
declare const optionalTupleDimension: OptionalTupleDimension;
// @ts-expect-error optional tuples are outside the static contract
const rejectedOptionalTuple: DimensionMap<OptionalTupleDimension> = optionalTupleDimension;

interface EmptyObjectDimension { phase: {} }
declare const emptyObjectDimension: EmptyObjectDimension;
// @ts-expect-error keyless object branches are outside the static contract
const rejectedEmptyObject: DimensionMap<EmptyObjectDimension> = emptyObjectDimension;

interface BroadObjectDimension { phase: object }
declare const broadObjectDimension: BroadObjectDimension;
// @ts-expect-error broad object branches are outside the static contract
const rejectedBroadObject: DimensionMap<BroadObjectDimension> = broadObjectDimension;

interface InvalidUnionBranch { invalid: undefined }
interface UnionDimension {
  phase: Readonly<Record<string, JsonValue>> | InvalidUnionBranch;
}
declare const unionDimension: UnionDimension;
// @ts-expect-error an observable invalid union branch cannot be absorbed
const rejectedUnion: DimensionMap<UnionDimension> = unionDimension;

interface SelfRecursiveValue { child: SelfRecursiveValue | null }
interface SelfRecursiveDimension { phase: SelfRecursiveValue }
declare const selfRecursiveDimension: SelfRecursiveDimension;
// @ts-expect-error custom recursive interfaces are outside the static contract
const rejectedSelfRecursive: DimensionMap<SelfRecursiveDimension> = selfRecursiveDimension;

type Aggregate = DimensionedDomainValue<TaskId, "work-item", ValidDimensions>;
declare const aggregate: Aggregate;
declare const context: DomainTransitionContext;
type PhaseRequest = PrimitiveTransitionRequest<Aggregate, "phase">;
type _RequestDimensionExact = Assert<Equal<PhaseRequest["dimension"], "phase">>;
type _RequestNextExact = Assert<
  Equal<PhaseRequest["nextDimension"], ValidDimensions["phase"]>
>;
const validRequest: PhaseRequest = {
  previous: aggregate,
  expectedRevision: aggregate.revision,
  dimension: "phase",
  nextDimension: { state: "running" },
  context,
};
void validRequest;

type TransitionSuccess = Extract<
  DomainTransitionResult<Aggregate, PrimitiveTransitionRejection>,
  { ok: true }
>;
type TransitionFailure = Extract<
  DomainTransitionResult<Aggregate, PrimitiveTransitionRejection>,
  { ok: false }
>;
type _TransitionSuccessKeys = Assert<
  Equal<keyof TransitionSuccess, "ok" | "previous" | "next" | "transitionRecord">
>;
type _TransitionFailureKeys = Assert<
  Equal<keyof TransitionFailure, "ok" | "rejection">
>;
type _TransitionSuccessReadonly = AssertNever<WritableKeys<TransitionSuccess>>;
type _TransitionFailureReadonly = AssertNever<WritableKeys<TransitionFailure>>;

type ScalarSuccess = Extract<ScalarResult<TaskId>, { ok: true }>;
type ScalarFailure = Extract<ScalarResult<TaskId>, { ok: false }>;
type _ScalarSuccessKeys = Assert<Equal<keyof ScalarSuccess, "ok" | "value">>;
type _ScalarFailureKeys = Assert<Equal<keyof ScalarFailure, "ok" | "rejection">>;
type CanonicalSuccess = Extract<CanonicalJsonResult<{ value: string }>, { ok: true }>;
type CanonicalFailure = Extract<CanonicalJsonResult<JsonValue>, { ok: false }>;
type _CanonicalSuccessKeys = Assert<Equal<keyof CanonicalSuccess, "ok" | "value" | "text">>;
type _CanonicalFailureKeys = Assert<Equal<keyof CanonicalFailure, "ok" | "rejection">>;
type EnvelopeSuccess = Extract<EnvelopeResult<Aggregate>, { ok: true }>;
type EnvelopeFailure = Extract<EnvelopeResult<Aggregate>, { ok: false }>;
type _EnvelopeSuccessKeys = Assert<Equal<keyof EnvelopeSuccess, "ok" | "value">>;
type _EnvelopeFailureKeys = Assert<Equal<keyof EnvelopeFailure, "ok" | "rejection">>;
type HierarchySuccess = Extract<HierarchyValidationResult, { ok: true }>;
type HierarchyFailure = Extract<HierarchyValidationResult, { ok: false }>;
type _HierarchySuccessKeys = Assert<Equal<keyof HierarchySuccess, "ok" | "value">>;
type _HierarchyFailureKeys = Assert<Equal<keyof HierarchyFailure, "ok" | "rejections">>;
type ConformanceSuccess = Extract<SingleDimensionConformanceResult, { ok: true }>;
type ConformanceFailure = Extract<SingleDimensionConformanceResult, { ok: false }>;
type _ConformanceSuccessKeys = Assert<Equal<keyof ConformanceSuccess, "ok">>;
type _ConformanceFailureKeys = Assert<Equal<keyof ConformanceFailure, "ok" | "violations">>;
type OwnershipSuccess = Extract<OwnershipValidationResult, { ok: true }>;
type OwnershipFailure = Extract<OwnershipValidationResult, { ok: false }>;
type _OwnershipSuccessKeys = Assert<Equal<keyof OwnershipSuccess, "ok" | "value">>;
type _OwnershipFailureKeys = Assert<Equal<keyof OwnershipFailure, "ok" | "rejections">>;
type PhaseConformanceCase = SingleDimensionConformanceCase<Aggregate, "phase">;

type _EnvelopeReadonly = AssertNever<WritableKeys<ImmutableRevisionEnvelope<string, string>>>;
type _NewEnvelopeReadonly = AssertNever<WritableKeys<NewRevisionEnvelopeInput<TaskId, "task">>>;
type _AggregateReadonly = AssertNever<WritableKeys<Aggregate>>;
type _DimensionMapReadonly = AssertNever<WritableKeys<DimensionMap<ValidDimensions>>>;
type _ScalarByKindReadonly = AssertNever<WritableKeys<ScalarByKind>>;
type _PhaseRequestReadonly = AssertNever<WritableKeys<PhaseRequest>>;
type _PhaseConformanceCaseReadonly = AssertNever<WritableKeys<PhaseConformanceCase>>;
type _ContextReadonly = AssertNever<WritableKeys<DomainTransitionContext>>;
type _RecordReadonly = AssertNever<WritableKeys<DomainTransitionRecord>>;
type _TypedRejectionReadonly = AssertNever<WritableKeys<TypedDomainRejection>>;
type _OwnerReadonly = AssertNever<WritableKeys<TaskAttemptOwnerRef>>;
type _SnapshotReadonly = AssertNever<WritableKeys<HierarchySnapshot>>;
type _ViolationReadonly = AssertNever<WritableKeys<ConformanceViolation>>;
type _CanonicalRejectionReadonly = AssertNever<WritableKeys<CanonicalJsonRejection>>;
type _EnvelopeRejectionReadonly = AssertNever<WritableKeys<EnvelopeRejection>>;
type _ScalarRejectionReadonly = AssertNever<WritableKeys<ScalarRejection>>;
type _HierarchyRejectionReadonly = AssertNever<WritableKeys<HierarchyRejection>>;
type _OwnershipRejectionReadonly = AssertNever<WritableKeys<OwnershipRejection>>;
type _ScalarSuccessReadonly = AssertNever<WritableKeys<ScalarSuccess>>;
type _ScalarFailureReadonly = AssertNever<WritableKeys<ScalarFailure>>;
type _CanonicalSuccessReadonly = AssertNever<WritableKeys<CanonicalSuccess>>;
type _CanonicalFailureReadonly = AssertNever<WritableKeys<CanonicalFailure>>;
type _EnvelopeSuccessReadonly = AssertNever<WritableKeys<EnvelopeSuccess>>;
type _EnvelopeFailureReadonly = AssertNever<WritableKeys<EnvelopeFailure>>;
type _HierarchySuccessReadonly = AssertNever<WritableKeys<HierarchySuccess>>;
type _HierarchyFailureReadonly = AssertNever<WritableKeys<HierarchyFailure>>;
type _OwnershipSuccessReadonly = AssertNever<WritableKeys<OwnershipSuccess>>;
type _OwnershipFailureReadonly = AssertNever<WritableKeys<OwnershipFailure>>;
type _ConformanceSuccessReadonly = AssertNever<WritableKeys<ConformanceSuccess>>;
type _ConformanceFailureReadonly = AssertNever<WritableKeys<ConformanceFailure>>;
type _PortfolioIdentityReadonly = AssertNever<WritableKeys<PortfolioIdentityRecord>>;
type _InitiativeIdentityReadonly = AssertNever<WritableKeys<InitiativeIdentityRecord>>;
type _EpicIdentityReadonly = AssertNever<WritableKeys<EpicIdentityRecord>>;
type _DeliveryUnitIdentityReadonly = AssertNever<WritableKeys<DeliveryUnitIdentityRecord>>;
type _TaskIdentityReadonly = AssertNever<WritableKeys<TaskIdentityRecord>>;

declare const snapshotValue: HierarchySnapshot;
// @ts-expect-error snapshot collections are readonly
snapshotValue.nodes.push({} as HierarchyIdentityRecord);
declare const record: DomainTransitionRecord;
// @ts-expect-error transition evidence is readonly
record.evidenceRefs.push({} as EvidenceRef);
declare const canonical: DeepReadonly<{ nested: { list: string[] } }>;
// @ts-expect-error DeepReadonly recursively protects object members
canonical.nested.list[0] = "changed";

declare const taskId: TaskId;
declare const portfolioId: PortfolioId;
declare const initiativeId: InitiativeId;
declare const epicId: EpicId;
declare const deliveryUnitId: DeliveryUnitId;
declare const repositoryId: RepositoryId;
declare const ordinal: PositiveOrdinal;
declare const revision: Revision;
declare const timestamp: DomainTimestamp;
const ownerRef: TaskAttemptOwnerRef = { taskAttemptId, taskId };
void ownerRef;
const portfolioRecord: PortfolioIdentityRecord = { id: portfolioId, kind: "portfolio", revision, createdAt: timestamp, updatedAt: timestamp, ordinal };
const initiativeRecord: InitiativeIdentityRecord = { id: initiativeId, kind: "initiative", revision, createdAt: timestamp, updatedAt: timestamp, portfolioId, ordinal };
const epicRecord: EpicIdentityRecord = { id: epicId, kind: "epic", revision, createdAt: timestamp, updatedAt: timestamp, initiativeId, repositoryId, ordinal };
const unitRecord: DeliveryUnitIdentityRecord = { id: deliveryUnitId, kind: "delivery-unit", revision, createdAt: timestamp, updatedAt: timestamp, epicId, repositoryId, ordinal };
const taskRecord: TaskIdentityRecord = { id: taskId, kind: "task", revision, createdAt: timestamp, updatedAt: timestamp, deliveryUnitId, ordinal };
void [portfolioRecord, initiativeRecord, epicRecord, unitRecord, taskRecord];

const newEnvelope: NewRevisionEnvelopeInput<TaskId, "task"> = {
  id: taskId,
  kind: "task",
  createdAt: timestamp,
  updatedAt: timestamp,
};
void newEnvelope;
// @ts-expect-error callers may not provide a revision to the new-envelope input
const newEnvelopeWithRevision: NewRevisionEnvelopeInput<TaskId, "task"> = { id: taskId, kind: "task", revision, createdAt: timestamp, updatedAt: timestamp };
// @ts-expect-error caller-supplied timestamps are required
const newEnvelopeWithoutTimestamp: NewRevisionEnvelopeInput<TaskId, "task"> = { id: taskId, kind: "task", updatedAt: timestamp };
void [newEnvelopeWithRevision, newEnvelopeWithoutTimestamp];

type InvalidEnvelope = Extract<PrimitiveTransitionRejection, { code: "invalid_envelope" }>;
const validInvalidEnvelope: InvalidEnvelope = { kind: "domain-rejection", code: "invalid_envelope", aggregateKind: null, aggregateId: null, dimension: null, transitionId: null, transitionName: null, details: { field: "id", constraint: "non_empty_string" } };
void validInvalidEnvelope;
// @ts-expect-error invalid_envelope details expose only closed field/constraint pairs
const invalidInvalidEnvelope: InvalidEnvelope = { kind: "domain-rejection", code: "invalid_envelope", aggregateKind: null, aggregateId: null, dimension: null, transitionId: null, transitionName: null, details: { field: "id", constraint: "plain_object" } };

type InvalidContext = Extract<PrimitiveTransitionRejection, { code: "invalid_transition_context" }>;
// @ts-expect-error invalid_transition_context details expose only closed pairs
const invalidInvalidContext: InvalidContext = { kind: "domain-rejection", code: "invalid_transition_context", aggregateKind: null, aggregateId: null, dimension: null, transitionId: null, transitionName: null, details: { field: "context", constraint: "non_empty_string" } };
void [invalidInvalidEnvelope, invalidInvalidContext];

type _PublicTypeWitness = [
  ActorRef,
  ApprovalAttemptId,
  BundleRef,
  ChangeRequestId,
  DecisionRef,
  DeliveryUnitId,
  EvidenceRef,
  InitiativeId,
  LaunchPermitId,
  PortfolioId,
  ReasonRef,
  RepositoryId,
  ScalarResult<TaskId>,
  SingleDimensionConformanceCase<Aggregate, "phase">,
  StepAttemptId,
  TransitionId,
  TransitionName,
  OwnershipValidationResult,
];

// @ts-expect-error no generic AttemptId is public
import type { AttemptId } from "@pi-workflow/v2-domain";
// @ts-expect-error the private brand helper is not public
import type { Branded } from "@pi-workflow/v2-domain";
// @ts-expect-error declaration-private recursive guard is not public
import type { JsonInvalid } from "@pi-workflow/v2-domain";
// @ts-expect-error declaration-private shape is not public
import type { DimensionedDomainValueShape } from "@pi-workflow/v2-domain";
// @ts-expect-error TaskAttempt records are deferred
import type { TaskAttempt } from "@pi-workflow/v2-domain";
// @ts-expect-error ApprovalAttempt records are deferred
import type { ApprovalAttempt } from "@pi-workflow/v2-domain";
// @ts-expect-error ChangeRequest records are deferred
import type { ChangeRequest } from "@pi-workflow/v2-domain";
// @ts-expect-error lifecycle contracts are deferred
import type { LifecycleState } from "@pi-workflow/v2-domain";
// @ts-expect-error projections are deferred
import type { Projection } from "@pi-workflow/v2-domain";
// @ts-expect-error plans are deferred
import type { Plan } from "@pi-workflow/v2-domain";

type _NegativeImportWitness = [
  AttemptId,
  Branded<string, string>,
  JsonInvalid<string>,
  DimensionedDomainValueShape,
  TaskAttempt,
  ApprovalAttempt,
  ChangeRequest,
  LifecycleState,
  Projection,
  Plan,
  JsonPrimitive,
];
