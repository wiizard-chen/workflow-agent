declare const scalarBrand: unique symbol;

type Branded<T, K extends string> = T & {
  readonly [scalarBrand]: K;
};

export type PortfolioId = Branded<string, "PortfolioId">;
export type InitiativeId = Branded<string, "InitiativeId">;
export type EpicId = Branded<string, "EpicId">;
export type DeliveryUnitId = Branded<string, "DeliveryUnitId">;
export type TaskId = Branded<string, "TaskId">;
export type TaskAttemptId = Branded<string, "TaskAttemptId">;
export type StepAttemptId = Branded<string, "StepAttemptId">;
export type RoleRunId = Branded<string, "RoleRunId">;
export type LaunchPermitId = Branded<string, "LaunchPermitId">;
export type ApprovalAttemptId = Branded<string, "ApprovalAttemptId">;
export type ChangeRequestId = Branded<string, "ChangeRequestId">;
export type RepositoryId = Branded<string, "RepositoryId">;
export type TransitionId = Branded<string, "TransitionId">;
export type EvidenceRef = Branded<string, "EvidenceRef">;
export type BundleRef = Branded<string, "BundleRef">;
export type DecisionRef = Branded<string, "DecisionRef">;
export type ActorRef = Branded<string, "ActorRef">;
export type ReasonRef = Branded<string, "ReasonRef">;
export type DomainTimestamp = Branded<string, "DomainTimestamp">;
export type TransitionName = Branded<string, "TransitionName">;
export type Revision = Branded<number, "Revision">;
export type PositiveOrdinal = Branded<number, "PositiveOrdinal">;

export type ScalarByKind = Readonly<{
  readonly PortfolioId: PortfolioId;
  readonly InitiativeId: InitiativeId;
  readonly EpicId: EpicId;
  readonly DeliveryUnitId: DeliveryUnitId;
  readonly TaskId: TaskId;
  readonly TaskAttemptId: TaskAttemptId;
  readonly StepAttemptId: StepAttemptId;
  readonly RoleRunId: RoleRunId;
  readonly LaunchPermitId: LaunchPermitId;
  readonly ApprovalAttemptId: ApprovalAttemptId;
  readonly ChangeRequestId: ChangeRequestId;
  readonly RepositoryId: RepositoryId;
  readonly TransitionId: TransitionId;
  readonly EvidenceRef: EvidenceRef;
  readonly BundleRef: BundleRef;
  readonly DecisionRef: DecisionRef;
  readonly ActorRef: ActorRef;
  readonly ReasonRef: ReasonRef;
  readonly DomainTimestamp: DomainTimestamp;
  readonly TransitionName: TransitionName;
  readonly Revision: Revision;
  readonly PositiveOrdinal: PositiveOrdinal;
}>;

export type ScalarKind = keyof ScalarByKind;

export type EntityIdScalarKind =
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

export type ScalarRejection = Readonly<{
  code: "invalid_scalar";
  scalarKind: ScalarKind;
  constraint:
    | "non_empty_string"
    | "non_negative_safe_integer"
    | "positive_safe_integer";
}>;

export type ScalarResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; rejection: ScalarRejection }>;

export const INITIAL_REVISION: Revision = 0 as Revision;

function scalarRejection<K extends ScalarKind>(
  scalarKind: K,
  constraint: ScalarRejection["constraint"],
): ScalarResult<ScalarByKind[K]> {
  const rejection: ScalarRejection = Object.freeze({
    code: "invalid_scalar",
    scalarKind,
    constraint,
  });

  return Object.freeze({ ok: false, rejection });
}

export function parseScalar<K extends ScalarKind>(
  kind: K,
  input: unknown,
): ScalarResult<ScalarByKind[K]> {
  if (kind === "Revision") {
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
      return scalarRejection(kind, "non_negative_safe_integer");
    }
  } else if (kind === "PositiveOrdinal") {
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0) {
      return scalarRejection(kind, "positive_safe_integer");
    }
  } else if (typeof input !== "string" || input.length === 0) {
    return scalarRejection(kind, "non_empty_string");
  }

  return Object.freeze({
    ok: true,
    value: input as ScalarByKind[K],
  });
}

export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;

export type DeepReadonly<T> =
  T extends JsonPrimitive
    ? T
    : T extends readonly (infer U)[]
      ? readonly DeepReadonly<U>[]
      : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : never;

export type CanonicalJsonReason =
  | "unsupported_type"
  | "non_finite_number"
  | "sparse_array"
  | "cycle"
  | "symbol_key"
  | "accessor"
  | "non_plain_object"
  | "lone_surrogate";

export type CanonicalJsonRejection = Readonly<{
  code: "invalid_canonical_value";
  path: string;
  reason: CanonicalJsonReason;
}>;

export type CanonicalJsonResult<T> =
  | Readonly<{ ok: true; value: DeepReadonly<T>; text: string }>
  | Readonly<{ ok: false; rejection: CanonicalJsonRejection }>;

type CanonicalVisitSuccess = Readonly<{
  ok: true;
  value: JsonValue;
  text: string;
}>;

type CanonicalVisitResult =
  | CanonicalVisitSuccess
  | Readonly<{ ok: false; rejection: CanonicalJsonRejection }>;

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPath(path: string, token: string): string {
  return `${path}/${escapePointerToken(token)}`;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }

  return false;
}

function serializeString(value: string): string {
  let text = '"';

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    switch (codeUnit) {
      case 0x08:
        text += "\\b";
        break;
      case 0x09:
        text += "\\t";
        break;
      case 0x0a:
        text += "\\n";
        break;
      case 0x0c:
        text += "\\f";
        break;
      case 0x0d:
        text += "\\r";
        break;
      case 0x22:
        text += '\\"';
        break;
      case 0x5c:
        text += "\\\\";
        break;
      default:
        if (codeUnit <= 0x1f) {
          text += `\\u${codeUnit.toString(16).padStart(4, "0")}`;
        } else {
          text += value[index];
        }
    }
  }

  return `${text}"`;
}

function canonicalFailure(
  path: string,
  reason: CanonicalJsonReason,
): Readonly<{ ok: false; rejection: CanonicalJsonRejection }> {
  const rejection: CanonicalJsonRejection = Object.freeze({
    code: "invalid_canonical_value",
    path,
    reason,
  });

  return Object.freeze({ ok: false, rejection });
}

function ownStringDescriptors(
  value: object,
): readonly Readonly<{ key: string; descriptor: PropertyDescriptor }>[] {
  return Object.getOwnPropertyNames(value)
    .sort(compareUtf16)
    .map((key) => ({
      key,
      descriptor: Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor,
    }));
}

function canonicalArrayIndex(key: string): number | undefined {
  if (key === "0") {
    return 0;
  }
  if (!/^[1-9][0-9]*$/.test(key)) {
    return undefined;
  }

  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 0xffff_ffff
    ? index
    : undefined;
}

function compareArrayProperty(
  left: Readonly<{ key: string }>,
  right: Readonly<{ key: string }>,
): number {
  const leftIndex = canonicalArrayIndex(left.key);
  const rightIndex = canonicalArrayIndex(right.key);

  if (leftIndex !== undefined && rightIndex !== undefined) {
    return leftIndex - rightIndex;
  }
  if (leftIndex !== undefined) {
    return -1;
  }
  if (rightIndex !== undefined) {
    return 1;
  }
  return compareUtf16(left.key, right.key);
}

function accessorPath(path: string, key: string): string {
  return hasLoneSurrogate(key) ? path : childPath(path, key);
}

function findAccessor(
  descriptors: readonly Readonly<{
    key: string;
    descriptor: PropertyDescriptor;
  }>[],
): string | undefined {
  return descriptors.find(({ descriptor }) =>
    !("value" in descriptor)
  )?.key;
}

function visitCanonical(
  input: unknown,
  path: string,
  active: Set<object>,
): CanonicalVisitResult {
  if (
    input !== null &&
    (typeof input === "object" || typeof input === "function") &&
    active.has(input)
  ) {
    return canonicalFailure(path, "cycle");
  }

  if (input === null) {
    return { ok: true, value: null, text: "null" };
  }

  switch (typeof input) {
    case "boolean":
      return {
        ok: true,
        value: input,
        text: input ? "true" : "false",
      };
    case "number":
      if (!Number.isFinite(input)) {
        return canonicalFailure(path, "non_finite_number");
      }
      return { ok: true, value: input, text: String(input) };
    case "string":
      if (hasLoneSurrogate(input)) {
        return canonicalFailure(path, "lone_surrogate");
      }
      return { ok: true, value: input, text: serializeString(input) };
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      return canonicalFailure(path, "unsupported_type");
    case "object":
      break;
  }

  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype) {
      return canonicalFailure(path, "non_plain_object");
    }

    const symbols = Object.getOwnPropertySymbols(input);
    if (symbols.length > 0) {
      return canonicalFailure(path, "symbol_key");
    }

    const descriptors = [...ownStringDescriptors(input)].sort(compareArrayProperty);
    const accessor = findAccessor(descriptors);
    if (accessor !== undefined) {
      return canonicalFailure(accessorPath(path, accessor), "accessor");
    }

    for (let index = 0; index < input.length; index += 1) {
      if (!Object.hasOwn(input, index)) {
        return canonicalFailure(childPath(path, String(index)), "sparse_array");
      }
    }

    const invalidPropertyName = descriptors.find(
      ({ key }) => key !== "length" && hasLoneSurrogate(key),
    );
    if (invalidPropertyName !== undefined) {
      return canonicalFailure(path, "lone_surrogate");
    }

    active.add(input);
    const copy: JsonValue[] = [];
    const texts: string[] = [];

    for (let index = 0; index < input.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      const visited = visitCanonical(
        descriptor?.value,
        childPath(path, String(index)),
        active,
      );
      if (!visited.ok) {
        return visited;
      }
      copy.push(visited.value);
      texts.push(visited.text);
    }

    active.delete(input);
    return {
      ok: true,
      value: Object.freeze(copy),
      text: `[${texts.join(",")}]`,
    };
  }

  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return canonicalFailure(path, "non_plain_object");
  }

  const symbols = Object.getOwnPropertySymbols(input);
  if (symbols.length > 0) {
    return canonicalFailure(path, "symbol_key");
  }

  const descriptors = ownStringDescriptors(input);
  const accessor = findAccessor(descriptors);
  if (accessor !== undefined) {
    return canonicalFailure(accessorPath(path, accessor), "accessor");
  }

  if (descriptors.some(({ key }) => hasLoneSurrogate(key))) {
    return canonicalFailure(path, "lone_surrogate");
  }

  active.add(input);
  const copy = Object.create(prototype) as Record<string, JsonValue>;
  const texts: string[] = [];

  for (const { key, descriptor } of descriptors) {
    const visited = visitCanonical(
      descriptor.value,
      childPath(path, key),
      active,
    );
    if (!visited.ok) {
      return visited;
    }

    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: visited.value,
      writable: true,
    });
    texts.push(`${serializeString(key)}:${visited.text}`);
  }

  active.delete(input);
  return {
    ok: true,
    value: Object.freeze(copy),
    text: `{${texts.join(",")}}`,
  };
}

export function canonicalizeJson<T extends JsonValue>(
  input: T,
): CanonicalJsonResult<T> {
  const visited = visitCanonical(input, "", new Set<object>());
  if (!visited.ok) {
    return visited;
  }

  return Object.freeze({
    ok: true,
    value: visited.value as DeepReadonly<T>,
    text: visited.text,
  });
}

export interface ImmutableRevisionEnvelope<
  I extends string,
  K extends string,
> {
  readonly id: I;
  readonly kind: K;
  readonly revision: Revision;
  readonly createdAt: DomainTimestamp;
  readonly updatedAt: DomainTimestamp;
}

export type NewRevisionEnvelopeInput<
  I extends string,
  K extends string,
> = Readonly<{
  id: I;
  kind: K;
  createdAt: DomainTimestamp;
  updatedAt: DomainTimestamp;
}>;

export type EnvelopeRejection = Readonly<{
  code: "invalid_envelope";
  field: string;
  constraint:
    | "plain_object"
    | "non_empty_string"
    | "non_negative_safe_integer"
    | "exact_fields"
    | "expected_kind";
}>;

export type EnvelopeResult<T> =
  | Readonly<{ ok: true; value: DeepReadonly<T> }>
  | Readonly<{ ok: false; rejection: EnvelopeRejection }>;

type EnvelopeConstraint = EnvelopeRejection["constraint"];
type EnvelopeDescriptors = ReadonlyMap<string, PropertyDescriptor>;
type EnvelopeFailure = Readonly<{
  ok: false;
  rejection: EnvelopeRejection;
}>;

function envelopeFailure(
  field: string,
  constraint: EnvelopeConstraint,
): EnvelopeFailure {
  const rejection: EnvelopeRejection = Object.freeze({
    code: "invalid_envelope",
    field,
    constraint,
  });

  return Object.freeze({ ok: false, rejection });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inspectEnvelopeObject(
  value: unknown,
  expectedFields: readonly string[],
): EnvelopeDescriptors | EnvelopeFailure {
  if (!isPlainObject(value)) {
    return envelopeFailure("[root]", "plain_object");
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    return envelopeFailure("[symbol]", "exact_fields");
  }

  const expected = new Set(expectedFields);
  const descriptors = new Map<string, PropertyDescriptor>();
  const invalidFields: string[] = [];

  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor;
    descriptors.set(key, descriptor);
    if (!expected.has(key) || !("value" in descriptor)) {
      invalidFields.push(key);
    }
  }

  invalidFields.sort(compareUtf16);
  const invalidField = invalidFields[0];
  if (invalidField !== undefined) {
    return envelopeFailure(invalidField, "exact_fields");
  }

  return descriptors;
}

function isEnvelopeFailure(
  value: EnvelopeDescriptors | EnvelopeFailure,
): value is EnvelopeFailure {
  return Object.hasOwn(value, "ok");
}

function fieldValue(
  descriptors: EnvelopeDescriptors,
  field: string,
): unknown {
  return descriptors.get(field)?.value;
}

function requireField(
  descriptors: EnvelopeDescriptors,
  field: string,
): EnvelopeFailure | undefined {
  return descriptors.has(field)
    ? undefined
    : envelopeFailure(field, "exact_fields");
}

function nonEmptyStringField(
  descriptors: EnvelopeDescriptors,
  field: string,
): EnvelopeFailure | undefined {
  const missing = requireField(descriptors, field);
  if (missing !== undefined) {
    return missing;
  }

  const value = fieldValue(descriptors, field);
  return typeof value === "string" && value.length > 0
    ? undefined
    : envelopeFailure(field, "non_empty_string");
}

function envelopeSuccess<T>(value: T): EnvelopeResult<T> {
  return Object.freeze({
    ok: true,
    value: Object.freeze(value) as DeepReadonly<T>,
  });
}

export function createRevisionEnvelope<I extends string, K extends string>(
  input: NewRevisionEnvelopeInput<I, K>,
): EnvelopeResult<ImmutableRevisionEnvelope<I, K>> {
  type Result = ImmutableRevisionEnvelope<I, K>;
  const inspected = inspectEnvelopeObject(input, [
    "id",
    "kind",
    "createdAt",
    "updatedAt",
  ]);
  if (isEnvelopeFailure(inspected)) {
    return inspected;
  }

  for (const field of ["id", "kind", "createdAt", "updatedAt"] as const) {
    const invalid = nonEmptyStringField(inspected, field);
    if (invalid !== undefined) {
      return invalid;
    }
  }

  return envelopeSuccess<Result>({
    id: fieldValue(inspected, "id") as I,
    kind: fieldValue(inspected, "kind") as K,
    revision: INITIAL_REVISION,
    createdAt: fieldValue(inspected, "createdAt") as DomainTimestamp,
    updatedAt: fieldValue(inspected, "updatedAt") as DomainTimestamp,
  });
}

export function validateRevisionEnvelope<
  IK extends EntityIdScalarKind,
  K extends string,
>(
  value: unknown,
  identity: Readonly<{ idKind: IK; expectedKind: K }>,
): EnvelopeResult<ImmutableRevisionEnvelope<ScalarByKind[IK], K>> {
  type Result = ImmutableRevisionEnvelope<ScalarByKind[IK], K>;
  const inspected = inspectEnvelopeObject(value, [
    "id",
    "kind",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  if (isEnvelopeFailure(inspected)) {
    return inspected;
  }

  const invalidId = nonEmptyStringField(inspected, "id");
  if (invalidId !== undefined) {
    return invalidId;
  }

  const parsedId = parseScalar(identity.idKind, fieldValue(inspected, "id"));
  if (!parsedId.ok) {
    return envelopeFailure("id", "non_empty_string");
  }

  const invalidKind = nonEmptyStringField(inspected, "kind");
  if (invalidKind !== undefined) {
    return invalidKind;
  }

  const kind = fieldValue(inspected, "kind") as string;
  if (kind !== identity.expectedKind) {
    return envelopeFailure("kind", "expected_kind");
  }

  const missingRevision = requireField(inspected, "revision");
  if (missingRevision !== undefined) {
    return missingRevision;
  }

  const parsedRevision = parseScalar(
    "Revision",
    fieldValue(inspected, "revision"),
  );
  if (!parsedRevision.ok) {
    return envelopeFailure("revision", "non_negative_safe_integer");
  }

  for (const field of ["createdAt", "updatedAt"] as const) {
    const invalid = nonEmptyStringField(inspected, field);
    if (invalid !== undefined) {
      return invalid;
    }
  }

  return envelopeSuccess<Result>({
    id: parsedId.value,
    kind: kind as K,
    revision: parsedRevision.value,
    createdAt: fieldValue(inspected, "createdAt") as DomainTimestamp,
    updatedAt: fieldValue(inspected, "updatedAt") as DomainTimestamp,
  });
}

export type PortfolioIdentityRecord = ImmutableRevisionEnvelope<
  PortfolioId,
  "portfolio"
> & Readonly<{ ordinal: PositiveOrdinal }>;

export type InitiativeIdentityRecord = ImmutableRevisionEnvelope<
  InitiativeId,
  "initiative"
> & Readonly<{
  portfolioId: PortfolioId;
  ordinal: PositiveOrdinal;
}>;

export type EpicIdentityRecord = ImmutableRevisionEnvelope<EpicId, "epic"> &
  Readonly<{
    initiativeId: InitiativeId;
    repositoryId: RepositoryId;
    ordinal: PositiveOrdinal;
  }>;

export type DeliveryUnitIdentityRecord = ImmutableRevisionEnvelope<
  DeliveryUnitId,
  "delivery-unit"
> & Readonly<{
  epicId: EpicId;
  repositoryId: RepositoryId;
  ordinal: PositiveOrdinal;
}>;

export type TaskIdentityRecord = ImmutableRevisionEnvelope<TaskId, "task"> &
  Readonly<{
    deliveryUnitId: DeliveryUnitId;
    ordinal: PositiveOrdinal;
  }>;

export type HierarchyIdentityRecord =
  | PortfolioIdentityRecord
  | InitiativeIdentityRecord
  | EpicIdentityRecord
  | DeliveryUnitIdentityRecord
  | TaskIdentityRecord;

export type TaskAttemptOwnerRef = Readonly<{
  taskAttemptId: TaskAttemptId;
  taskId: TaskId;
}>;

export type HierarchySnapshot = Readonly<{
  nodes: readonly HierarchyIdentityRecord[];
  taskAttemptOwners: readonly TaskAttemptOwnerRef[];
}>;

export type HierarchyRejectionCode =
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

export type HierarchyRejection = Readonly<{
  code: HierarchyRejectionCode;
  path: string;
  id: string | null;
  relatedId: string | null;
}>;

export type HierarchyValidationResult =
  | Readonly<{ ok: true; value: HierarchySnapshot }>
  | Readonly<{ ok: false; rejections: readonly HierarchyRejection[] }>;

type HierarchyFailure = Extract<HierarchyValidationResult, { ok: false }>;

export type OwnershipRejection = Readonly<{
  code:
    | "invalid_record"
    | "invalid_envelope"
    | "invalid_scalar"
    | "immutable_identity_changed"
    | "immutable_parent_changed"
    | "immutable_repository_changed"
    | "invalid_ordinal";
  path: string;
}>;

export type OwnershipValidationResult =
  | Readonly<{ ok: true; value: HierarchyIdentityRecord }>
  | Readonly<{ ok: false; rejections: readonly OwnershipRejection[] }>;

type HierarchyKind = HierarchyIdentityRecord["kind"];
type NodeFieldCode =
  | "invalid_record"
  | "invalid_envelope"
  | "invalid_scalar"
  | "invalid_ordinal";

type NodeSpec = Readonly<{
  kind: HierarchyKind;
  idKind: EntityIdScalarKind;
  parentField: string | null;
  parentKind: HierarchyKind | null;
  parentIdKind: EntityIdScalarKind | null;
  hasRepository: boolean;
  expectedFields: readonly string[];
}>;

type NodeFieldIssue = Readonly<{
  code: NodeFieldCode;
  path: string;
}>;

type ValidNode = Readonly<{
  record: HierarchyIdentityRecord;
  kind: HierarchyKind;
  id: string;
  parentId: string | null;
  repositoryId: string | null;
  ordinal: number;
  inputIndex: number;
}>;

type NodeValidation =
  | Readonly<{ ok: true; value: ValidNode }>
  | Readonly<{
      ok: false;
      issues: readonly NodeFieldIssue[];
      id: string | null;
      relatedId: string | null;
    }>;

type ValidOwner = Readonly<{
  value: TaskAttemptOwnerRef;
  taskAttemptId: string;
  taskId: string;
  inputIndex: number;
}>;

type OwnerValidation =
  | Readonly<{ ok: true; value: ValidOwner }>
  | Readonly<{
      ok: false;
      issues: readonly NodeFieldIssue[];
      id: string | null;
      relatedId: string | null;
    }>;

const NODE_SPECS: Readonly<Record<HierarchyKind, NodeSpec>> = Object.freeze({
  portfolio: Object.freeze({
    kind: "portfolio",
    idKind: "PortfolioId",
    parentField: null,
    parentKind: null,
    parentIdKind: null,
    hasRepository: false,
    expectedFields: Object.freeze([
      "id",
      "kind",
      "revision",
      "createdAt",
      "updatedAt",
      "ordinal",
    ]),
  }),
  initiative: Object.freeze({
    kind: "initiative",
    idKind: "InitiativeId",
    parentField: "portfolioId",
    parentKind: "portfolio",
    parentIdKind: "PortfolioId",
    hasRepository: false,
    expectedFields: Object.freeze([
      "id",
      "kind",
      "revision",
      "createdAt",
      "updatedAt",
      "ordinal",
      "portfolioId",
    ]),
  }),
  epic: Object.freeze({
    kind: "epic",
    idKind: "EpicId",
    parentField: "initiativeId",
    parentKind: "initiative",
    parentIdKind: "InitiativeId",
    hasRepository: true,
    expectedFields: Object.freeze([
      "id",
      "kind",
      "revision",
      "createdAt",
      "updatedAt",
      "ordinal",
      "initiativeId",
      "repositoryId",
    ]),
  }),
  "delivery-unit": Object.freeze({
    kind: "delivery-unit",
    idKind: "DeliveryUnitId",
    parentField: "epicId",
    parentKind: "epic",
    parentIdKind: "EpicId",
    hasRepository: true,
    expectedFields: Object.freeze([
      "id",
      "kind",
      "revision",
      "createdAt",
      "updatedAt",
      "ordinal",
      "epicId",
      "repositoryId",
    ]),
  }),
  task: Object.freeze({
    kind: "task",
    idKind: "TaskId",
    parentField: "deliveryUnitId",
    parentKind: "delivery-unit",
    parentIdKind: "DeliveryUnitId",
    hasRepository: false,
    expectedFields: Object.freeze([
      "id",
      "kind",
      "revision",
      "createdAt",
      "updatedAt",
      "ordinal",
      "deliveryUnitId",
    ]),
  }),
});

const KIND_RANK: Readonly<Record<HierarchyKind, number>> = Object.freeze({
  portfolio: 0,
  initiative: 1,
  epic: 2,
  "delivery-unit": 3,
  task: 4,
});

function nodeSpec(value: unknown): NodeSpec | undefined {
  return typeof value === "string" && Object.hasOwn(NODE_SPECS, value)
    ? NODE_SPECS[value as HierarchyKind]
    : undefined;
}

function dataDescriptors(value: object): Map<string, PropertyDescriptor> {
  const descriptors = new Map<string, PropertyDescriptor>();
  for (const key of Object.getOwnPropertyNames(value)) {
    descriptors.set(
      key,
      Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor,
    );
  }
  return descriptors;
}

function ownDataValue(value: unknown, key: string): unknown {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function recoverString(value: unknown, key: string): string | null {
  const candidate = ownDataValue(value, key);
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

function recordShapeIsExact(
  value: unknown,
  spec: NodeSpec,
): value is Record<string, unknown> {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }

  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== spec.expectedFields.length ||
    names.some((name) => !spec.expectedFields.includes(name))
  ) {
    return false;
  }

  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && "value" in descriptor;
  });
}

function parseStringScalar(
  kind: ScalarKind,
  value: unknown,
): string | undefined {
  const parsed = parseScalar(kind, value);
  return parsed.ok && typeof parsed.value === "string"
    ? parsed.value
    : undefined;
}

function validateNode(
  input: unknown,
  path: string,
  inputIndex: number,
): NodeValidation {
  const rawKind = ownDataValue(input, "kind");
  const spec = nodeSpec(rawKind);
  const recoveredId = recoverString(input, "id");
  const recoveredParent = spec?.parentField === null || spec === undefined
    ? null
    : recoverString(input, spec.parentField);

  if (spec === undefined || !recordShapeIsExact(input, spec)) {
    return {
      ok: false,
      issues: Object.freeze([{ code: "invalid_record", path }]),
      id: recoveredId,
      relatedId: recoveredParent,
    };
  }

  const descriptors = dataDescriptors(input);
  const issues: NodeFieldIssue[] = [];
  const addIssue = (code: NodeFieldCode, field: string): void => {
    issues.push({ code, path: childPath(path, field) });
  };

  const id = parseStringScalar(spec.idKind, fieldValue(descriptors, "id"));
  if (id === undefined) {
    addIssue("invalid_scalar", "id");
  }

  const revisionResult = parseScalar(
    "Revision",
    fieldValue(descriptors, "revision"),
  );
  if (!revisionResult.ok) {
    addIssue("invalid_envelope", "revision");
  }

  const createdAt = parseStringScalar(
    "DomainTimestamp",
    fieldValue(descriptors, "createdAt"),
  );
  if (createdAt === undefined) {
    addIssue("invalid_envelope", "createdAt");
  }

  const updatedAt = parseStringScalar(
    "DomainTimestamp",
    fieldValue(descriptors, "updatedAt"),
  );
  if (updatedAt === undefined) {
    addIssue("invalid_envelope", "updatedAt");
  }

  const ordinalResult = parseScalar(
    "PositiveOrdinal",
    fieldValue(descriptors, "ordinal"),
  );
  if (!ordinalResult.ok) {
    addIssue("invalid_ordinal", "ordinal");
  }

  let parentId: string | null = null;
  if (spec.parentField !== null && spec.parentIdKind !== null) {
    parentId = parseStringScalar(
      spec.parentIdKind,
      fieldValue(descriptors, spec.parentField),
    ) ?? null;
    if (parentId === null) {
      addIssue("invalid_scalar", spec.parentField);
    }
  }

  let repositoryId: string | null = null;
  if (spec.hasRepository) {
    repositoryId = parseStringScalar(
      "RepositoryId",
      fieldValue(descriptors, "repositoryId"),
    ) ?? null;
    if (repositoryId === null) {
      addIssue("invalid_scalar", "repositoryId");
    }
  }

  if (
    id === undefined ||
    !revisionResult.ok ||
    createdAt === undefined ||
    updatedAt === undefined ||
    !ordinalResult.ok ||
    (spec.parentField !== null && parentId === null) ||
    (spec.hasRepository && repositoryId === null)
  ) {
    return {
      ok: false,
      issues: Object.freeze(issues),
      id: id ?? null,
      relatedId: null,
    };
  }

  const base = {
    id,
    kind: spec.kind,
    revision: revisionResult.value,
    createdAt: createdAt as DomainTimestamp,
    updatedAt: updatedAt as DomainTimestamp,
    ordinal: ordinalResult.value,
  };

  let record: HierarchyIdentityRecord;
  switch (spec.kind) {
    case "portfolio":
      record = Object.freeze(base) as PortfolioIdentityRecord;
      break;
    case "initiative":
      record = Object.freeze({
        ...base,
        portfolioId: parentId,
      }) as InitiativeIdentityRecord;
      break;
    case "epic":
      record = Object.freeze({
        ...base,
        initiativeId: parentId,
        repositoryId,
      }) as EpicIdentityRecord;
      break;
    case "delivery-unit":
      record = Object.freeze({
        ...base,
        epicId: parentId,
        repositoryId,
      }) as DeliveryUnitIdentityRecord;
      break;
    case "task":
      record = Object.freeze({
        ...base,
        deliveryUnitId: parentId,
      }) as TaskIdentityRecord;
      break;
  }

  return {
    ok: true,
    value: Object.freeze({
      record,
      kind: spec.kind,
      id,
      parentId,
      repositoryId,
      ordinal: ordinalResult.value,
      inputIndex,
    }),
  };
}

function ownerShapeIsExact(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== 2 ||
    !names.includes("taskAttemptId") ||
    !names.includes("taskId")
  ) {
    return false;
  }
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && "value" in descriptor;
  });
}

function validateOwner(
  input: unknown,
  path: string,
  inputIndex: number,
): OwnerValidation {
  const recoveredAttempt = recoverString(input, "taskAttemptId");
  const recoveredTask = recoverString(input, "taskId");
  if (!ownerShapeIsExact(input)) {
    return {
      ok: false,
      issues: Object.freeze([{ code: "invalid_record", path }]),
      id: recoveredAttempt,
      relatedId: recoveredTask,
    };
  }

  const descriptors = dataDescriptors(input);
  const issues: NodeFieldIssue[] = [];
  const taskAttemptId = parseStringScalar(
    "TaskAttemptId",
    fieldValue(descriptors, "taskAttemptId"),
  );
  if (taskAttemptId === undefined) {
    issues.push({
      code: "invalid_scalar",
      path: childPath(path, "taskAttemptId"),
    });
  }

  const taskId = parseStringScalar(
    "TaskId",
    fieldValue(descriptors, "taskId"),
  );
  if (taskId === undefined) {
    issues.push({ code: "invalid_scalar", path: childPath(path, "taskId") });
  }

  if (taskAttemptId === undefined || taskId === undefined) {
    return {
      ok: false,
      issues: Object.freeze(issues),
      id: taskAttemptId ?? null,
      relatedId: null,
    };
  }

  const value: TaskAttemptOwnerRef = Object.freeze({
    taskAttemptId: taskAttemptId as TaskAttemptId,
    taskId: taskId as TaskId,
  });
  return {
    ok: true,
    value: Object.freeze({ value, taskAttemptId, taskId, inputIndex }),
  };
}

function invalidSnapshot(path: string): HierarchyFailure {
  const rejection: HierarchyRejection = Object.freeze({
    code: "invalid_snapshot",
    path,
    id: null,
    relatedId: null,
  });
  return Object.freeze({
    ok: false,
    rejections: Object.freeze([rejection]),
  });
}

function denseDataArray(value: unknown): value is readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    return false;
  }

  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return false;
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      return false;
    }
  }
  return true;
}

function inspectSnapshot(
  input: unknown,
):
  | Readonly<{ ok: true; nodes: readonly unknown[]; owners: readonly unknown[] }>
  | HierarchyFailure {
  if (!isPlainObject(input)) {
    return invalidSnapshot("");
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    return invalidSnapshot("");
  }

  const descriptors = dataDescriptors(input);
  const expected = new Set(["nodes", "taskAttemptOwners"]);
  const invalidFields = [...descriptors]
    .filter(([key, descriptor]) =>
      !expected.has(key) || !("value" in descriptor)
    )
    .map(([key]) => key)
    .sort(compareUtf16);
  if (invalidFields[0] !== undefined) {
    return invalidSnapshot(childPath("", invalidFields[0]));
  }

  for (const field of ["nodes", "taskAttemptOwners"] as const) {
    if (!descriptors.has(field)) {
      return invalidSnapshot(childPath("", field));
    }
  }

  const nodes = fieldValue(descriptors, "nodes");
  if (!denseDataArray(nodes)) {
    return invalidSnapshot("/nodes");
  }
  const owners = fieldValue(descriptors, "taskAttemptOwners");
  if (!denseDataArray(owners)) {
    return invalidSnapshot("/taskAttemptOwners");
  }

  return { ok: true, nodes, owners };
}

function compareNullable(left: string | null, right: string | null): number {
  if (left === null) {
    return right === null ? 0 : -1;
  }
  if (right === null) {
    return 1;
  }
  return compareUtf16(left, right);
}

function compareHierarchyRejection(
  left: HierarchyRejection,
  right: HierarchyRejection,
): number {
  return (
    compareUtf16(left.code, right.code) ||
    compareUtf16(left.path, right.path) ||
    compareNullable(left.id, right.id) ||
    compareNullable(left.relatedId, right.relatedId)
  );
}

function hierarchyFailure(
  rejections: readonly HierarchyRejection[],
): HierarchyValidationResult {
  const frozen = rejections
    .map((rejection) => Object.freeze({ ...rejection }))
    .sort(compareHierarchyRejection);
  return Object.freeze({
    ok: false,
    rejections: Object.freeze(frozen),
  });
}

function compareNodeSuccess(left: ValidNode, right: ValidNode): number {
  return (
    KIND_RANK[left.kind] - KIND_RANK[right.kind] ||
    compareNullable(left.parentId, right.parentId) ||
    left.ordinal - right.ordinal ||
    compareUtf16(left.id, right.id)
  );
}

function canonicalRecordText(node: ValidNode): string {
  const result = canonicalizeJson(node.record as unknown as JsonValue);
  return result.ok ? result.text : "";
}

function compareDuplicateRecord(left: ValidNode, right: ValidNode): number {
  return (
    compareNullable(left.parentId, right.parentId) ||
    left.ordinal - right.ordinal ||
    compareNullable(left.repositoryId, right.repositoryId) ||
    compareUtf16(canonicalRecordText(left), canonicalRecordText(right)) ||
    left.inputIndex - right.inputIndex
  );
}

function groupNodesByIdentity(
  nodes: readonly ValidNode[],
): ReadonlyMap<HierarchyKind, ReadonlyMap<string, ValidNode[]>> {
  const byKind = new Map<HierarchyKind, Map<string, ValidNode[]>>();
  for (const node of nodes) {
    let byId = byKind.get(node.kind);
    if (byId === undefined) {
      byId = new Map();
      byKind.set(node.kind, byId);
    }
    const group = byId.get(node.id) ?? [];
    group.push(node);
    byId.set(node.id, group);
  }
  return byKind;
}

function duplicateNodeRejections(
  nodes: readonly ValidNode[],
): HierarchyRejection[] {
  const rejections: HierarchyRejection[] = [];
  for (const [kind, byId] of groupNodesByIdentity(nodes)) {
    for (const [id, unsorted] of byId) {
      if (unsorted.length < 2) {
        continue;
      }
      const group = [...unsorted].sort(compareDuplicateRecord);
      const first = group[0] as ValidNode;
      const second = group[1] as ValidNode;
      const sameParent = group.every(
        (record) => record.parentId === first.parentId,
      );
      rejections.push({
        code: kind === "portfolio"
          ? "duplicate_identity"
          : sameParent
            ? "duplicate_sibling_identity"
            : "multiple_parent_ownership",
        path: `/nodes/${second.inputIndex}`,
        id,
        relatedId: kind === "portfolio" ? null : first.parentId,
      });
    }
  }
  return rejections;
}

function nodesByRawId(nodes: readonly ValidNode[]): Map<string, ValidNode[]> {
  const index = new Map<string, ValidNode[]>();
  for (const node of nodes) {
    const group = index.get(node.id) ?? [];
    group.push(node);
    index.set(node.id, group);
  }
  return index;
}

function relationshipRejections(
  nodes: readonly ValidNode[],
  owners: readonly ValidOwner[],
): HierarchyRejection[] {
  const rejections: HierarchyRejection[] = [];
  const rawIndex = nodesByRawId(nodes);

  for (const node of nodes) {
    const spec = NODE_SPECS[node.kind];
    if (
      spec.parentField === null ||
      spec.parentKind === null ||
      node.parentId === null
    ) {
      continue;
    }

    const rawMatches = rawIndex.get(node.parentId) ?? [];
    const parentMatches = rawMatches
      .filter((candidate) => candidate.kind === spec.parentKind)
      .sort(compareDuplicateRecord);
    if (parentMatches.length === 0) {
      rejections.push({
        code: rawMatches.length > 0
          ? "parent_kind_mismatch"
          : "missing_parent",
        path: `/nodes/${node.inputIndex}/${spec.parentField}`,
        id: node.id,
        relatedId: node.parentId,
      });
      continue;
    }

    if (node.kind === "delivery-unit") {
      const parent = parentMatches[0] as ValidNode;
      if (node.repositoryId !== parent.repositoryId) {
        rejections.push({
          code: "repository_mismatch",
          path: `/nodes/${node.inputIndex}/repositoryId`,
          id: node.id,
          relatedId: parent.id,
        });
      }
    }
  }

  const taskIds = new Set(
    nodes.filter((node) => node.kind === "task").map((node) => node.id),
  );
  for (const owner of owners) {
    if (!taskIds.has(owner.taskId)) {
      rejections.push({
        code: "missing_task",
        path: `/taskAttemptOwners/${owner.inputIndex}/taskId`,
        id: owner.taskAttemptId,
        relatedId: owner.taskId,
      });
    }
  }

  const ownersByAttempt = new Map<string, ValidOwner[]>();
  for (const owner of owners) {
    const group = ownersByAttempt.get(owner.taskAttemptId) ?? [];
    group.push(owner);
    ownersByAttempt.set(owner.taskAttemptId, group);
  }
  for (const [taskAttemptId, unsorted] of ownersByAttempt) {
    if (unsorted.length < 2) {
      continue;
    }
    const group = [...unsorted].sort((left, right) =>
      compareUtf16(left.taskId, right.taskId) ||
      compareUtf16(left.taskAttemptId, right.taskAttemptId) ||
      left.inputIndex - right.inputIndex
    );
    const first = group[0] as ValidOwner;
    const second = group[1] as ValidOwner;
    rejections.push({
      code: "duplicate_task_attempt_ownership",
      path: `/taskAttemptOwners/${second.inputIndex}`,
      id: taskAttemptId,
      relatedId: first.taskId,
    });
  }

  return rejections;
}

export function validateHierarchy(input: unknown): HierarchyValidationResult {
  const inspected = inspectSnapshot(input);
  if (!inspected.ok) {
    return inspected;
  }

  const rejections: HierarchyRejection[] = [];
  const validNodes: ValidNode[] = [];
  const validOwners: ValidOwner[] = [];

  for (let inputIndex = 0; inputIndex < inspected.nodes.length; inputIndex += 1) {
    const candidate = Object.getOwnPropertyDescriptor(
      inspected.nodes,
      String(inputIndex),
    )?.value;
    const path = `/nodes/${inputIndex}`;
    const validated = validateNode(candidate, path, inputIndex);
    if (validated.ok) {
      validNodes.push(validated.value);
    } else {
      for (const issue of validated.issues) {
        rejections.push({
          code: issue.code,
          path: issue.path,
          id: validated.id,
          relatedId: issue.code === "invalid_record"
            ? validated.relatedId
            : null,
        });
      }
    }
  }

  for (let inputIndex = 0; inputIndex < inspected.owners.length; inputIndex += 1) {
    const candidate = Object.getOwnPropertyDescriptor(
      inspected.owners,
      String(inputIndex),
    )?.value;
    const path = `/taskAttemptOwners/${inputIndex}`;
    const validated = validateOwner(candidate, path, inputIndex);
    if (validated.ok) {
      validOwners.push(validated.value);
    } else {
      for (const issue of validated.issues) {
        rejections.push({
          code: issue.code,
          path: issue.path,
          id: validated.id,
          relatedId: issue.code === "invalid_record"
            ? validated.relatedId
            : null,
        });
      }
    }
  }

  rejections.push(...duplicateNodeRejections(validNodes));
  rejections.push(...relationshipRejections(validNodes, validOwners));

  if (rejections.length > 0) {
    return hierarchyFailure(rejections);
  }

  const nodes = validNodes
    .sort(compareNodeSuccess)
    .map((node) => node.record);
  const taskAttemptOwners = validOwners
    .sort((left, right) =>
      compareUtf16(left.taskId, right.taskId) ||
      compareUtf16(left.taskAttemptId, right.taskAttemptId)
    )
    .map((owner) => owner.value);
  const value: HierarchySnapshot = Object.freeze({
    nodes: Object.freeze(nodes),
    taskAttemptOwners: Object.freeze(taskAttemptOwners),
  });
  return Object.freeze({ ok: true, value });
}

function ownershipFailure(
  rejections: readonly OwnershipRejection[],
): OwnershipValidationResult {
  const frozen = rejections
    .map((rejection) => Object.freeze({ ...rejection }))
    .sort((left, right) =>
      compareUtf16(left.code, right.code) ||
      compareUtf16(left.path, right.path)
    );
  return Object.freeze({ ok: false, rejections: Object.freeze(frozen) });
}

export function validateOwnershipNext(
  previous: unknown,
  next: unknown,
): OwnershipValidationResult {
  const previousResult = validateNode(previous, "/previous", 0);
  const nextResult = validateNode(next, "/next", 1);
  const rejections: OwnershipRejection[] = [];

  if (!previousResult.ok) {
    rejections.push(...previousResult.issues);
  }
  if (!nextResult.ok) {
    rejections.push(...nextResult.issues);
  }
  if (!previousResult.ok || !nextResult.ok) {
    return ownershipFailure(rejections);
  }

  const before = previousResult.value;
  const after = nextResult.value;
  if (before.kind !== after.kind) {
    rejections.push({
      code: "immutable_identity_changed",
      path: "/next/kind",
    });
  }
  if (before.id !== after.id) {
    rejections.push({
      code: "immutable_identity_changed",
      path: "/next/id",
    });
  }
  if (before.record.createdAt !== after.record.createdAt) {
    rejections.push({
      code: "immutable_identity_changed",
      path: "/next/createdAt",
    });
  }

  if (before.kind === after.kind) {
    const spec = NODE_SPECS[before.kind];
    if (spec.parentField !== null && before.parentId !== after.parentId) {
      rejections.push({
        code: "immutable_parent_changed",
        path: `/next/${spec.parentField}`,
      });
    }
    if (spec.hasRepository && before.repositoryId !== after.repositoryId) {
      rejections.push({
        code: "immutable_repository_changed",
        path: "/next/repositoryId",
      });
    }
  }

  return rejections.length > 0
    ? ownershipFailure(rejections)
    : Object.freeze({ ok: true, value: after.record });
}

type JsonInvalid<T> =
  [T] extends [JsonValue]
    ? [JsonValue] extends [T]
      ? false
      : JsonInvalidMember<T>
    : JsonInvalidMember<T>;

type ArrayBuiltinSymbolKeys = Extract<keyof readonly unknown[], symbol>;

type JsonPropertyValue<T extends object, P extends keyof T> =
  {} extends Pick<T, P> ? Required<T>[P] : T[P];

type TupleDeclaredKeys<T extends readonly unknown[]> =
  Exclude<keyof T, keyof readonly unknown[]>;

type IsTuple<T extends readonly unknown[]> =
  [TupleDeclaredKeys<T>] extends [never]
    ? number extends T["length"] ? false : true
    : true;

type JsonInvalidMember<T> =
  T extends (...args: never[]) => unknown ? true
  : T extends abstract new (...args: never[]) => unknown ? true
  : T extends readonly (infer U)[]
    ? Exclude<Extract<keyof T, symbol>, ArrayBuiltinSymbolKeys> extends never
      ? IsTuple<T> extends true
        ? [T] extends [Required<T>]
          ? true extends JsonInvalid<T[number]> ? true : false
          : true
        : true extends JsonInvalid<U> ? true : false
      : true
  : T extends object
    ? Extract<keyof T, symbol> extends never
      ? [keyof T] extends [never]
        ? true
        : true extends {
            [P in keyof T]-?: JsonInvalid<JsonPropertyValue<T, P>>
          }[keyof T] ? true : false
      : true
  : T extends JsonPrimitive ? false
  : true;

type DimensionMapInvalid<D extends object> =
  D extends unknown
    ? [keyof D] extends [string]
      ? [D] extends [Required<D>] ? JsonInvalid<D> : true
      : true
    : never;

export type DimensionMap<D extends object> =
  true extends DimensionMapInvalid<D> ? never : Readonly<D>;

export interface DimensionedDomainValue<
  I extends string,
  K extends string,
  D extends object,
> {
  readonly id: I;
  readonly kind: K;
  readonly revision: Revision;
  readonly createdAt: DomainTimestamp;
  readonly updatedAt: DomainTimestamp;
  readonly attributes: Readonly<Record<string, JsonValue>>;
  readonly dimensions: DimensionMap<D>;
}

interface DimensionedDomainValueShape {
  readonly id: string;
  readonly kind: string;
  readonly revision: Revision;
  readonly createdAt: DomainTimestamp;
  readonly updatedAt: DomainTimestamp;
  readonly attributes: Readonly<Record<string, JsonValue>>;
  readonly dimensions: object;
}

type JsonDimensionGuard<D extends object> =
  [D] extends [DimensionMap<D>] ? unknown : never;

export interface DomainTransitionContext {
  readonly transitionId: TransitionId;
  readonly transitionName: TransitionName;
  readonly occurredAt: DomainTimestamp;
  readonly actorRef: ActorRef;
  readonly reasonRef: ReasonRef | null;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface PrimitiveTransitionRequest<
  A extends DimensionedDomainValueShape,
  D extends keyof A["dimensions"] & string,
> {
  readonly previous: A & JsonDimensionGuard<A["dimensions"]>;
  readonly expectedRevision: Revision;
  readonly dimension: D;
  readonly nextDimension: A["dimensions"][D];
  readonly context: DomainTransitionContext;
}

export type DomainTransitionResult<A, R extends TypedDomainRejection> =
  | Readonly<{
      ok: true;
      previous: DeepReadonly<A>;
      next: DeepReadonly<A>;
      transitionRecord: DomainTransitionRecord;
    }>
  | Readonly<{ ok: false; rejection: R }>;

export interface DomainTransitionRecord {
  readonly kind: "domain-transition";
  readonly transitionId: TransitionId;
  readonly transitionName: TransitionName;
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly dimension: string;
  readonly beforeRevision: Revision;
  readonly afterRevision: Revision;
  readonly occurredAt: DomainTimestamp;
  readonly actorRef: ActorRef;
  readonly reasonRef: ReasonRef | null;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export type TypedDomainRejection<
  C extends string = string,
  D extends JsonValue = JsonValue,
> = Readonly<{
  kind: "domain-rejection";
  code: C;
  aggregateKind: string | null;
  aggregateId: string | null;
  dimension: string | null;
  transitionId: TransitionId | null;
  transitionName: TransitionName | null;
  details: DeepReadonly<D>;
}>;

type InvalidEnvelopeDetails =
  | Readonly<{ field: "request"; constraint: "plain_object" }>
  | Readonly<{
      field: "previous";
      constraint: "plain_object" | "exact_fields";
    }>
  | Readonly<{
      field: "id" | "kind" | "createdAt" | "updatedAt";
      constraint: "non_empty_string";
    }>
  | Readonly<{
      field: "attributes" | "dimensions";
      constraint: "plain_object";
    }>;

type InvalidRevisionDetails = Readonly<{
  field: "previous.revision" | "expectedRevision";
  constraint: "non_negative_safe_integer";
}>;

type ExpectedRevisionMismatchDetails = Readonly<{
  expected: number;
  actual: number;
}>;

type RevisionExhaustedDetails = Readonly<{ revision: number }>;
type InvalidDimensionDetails = Readonly<{
  availableDimensions: readonly string[];
}>;
type UnchangedDimensionDetails = Readonly<{ canonicalText: string }>;

type InvalidTransitionContextDetails =
  | Readonly<{ field: "context"; constraint: "plain_exact_object" }>
  | Readonly<{
      field: "transitionId" | "transitionName" | "occurredAt" | "actorRef";
      constraint: "non_empty_string";
    }>
  | Readonly<{
      field: "reasonRef";
      constraint: "null_or_non_empty_string";
    }>
  | Readonly<{
      field: "evidenceRefs";
      constraint: "dense_array_of_evidence_refs";
    }>;

type InvalidCanonicalValueDetails = Readonly<{
  target:
    | "previous.attributes"
    | "previous.dimensions"
    | "nextDimension"
    | "context.evidenceRefs";
  rejection: CanonicalJsonRejection;
}>;

export type PrimitiveTransitionRejection =
  | TypedDomainRejection<"invalid_envelope", InvalidEnvelopeDetails>
  | TypedDomainRejection<"invalid_revision", InvalidRevisionDetails>
  | TypedDomainRejection<
      "expected_revision_mismatch",
      ExpectedRevisionMismatchDetails
    >
  | TypedDomainRejection<"revision_exhausted", RevisionExhaustedDetails>
  | TypedDomainRejection<"invalid_dimension", InvalidDimensionDetails>
  | TypedDomainRejection<"unchanged_dimension", UnchangedDimensionDetails>
  | TypedDomainRejection<
      "invalid_transition_context",
      InvalidTransitionContextDetails
    >
  | TypedDomainRejection<
      "invalid_canonical_value",
      InvalidCanonicalValueDetails
    >;

type TransitionLocators = Readonly<{
  aggregateKind: string | null;
  aggregateId: string | null;
  dimension: string | null;
  transitionId: TransitionId | null;
  transitionName: TransitionName | null;
}>;

const PREVIOUS_FIELDS = Object.freeze([
  "id",
  "kind",
  "revision",
  "createdAt",
  "updatedAt",
  "attributes",
  "dimensions",
]);

const CONTEXT_FIELDS = Object.freeze([
  "transitionId",
  "transitionName",
  "occurredAt",
  "actorRef",
  "reasonRef",
  "evidenceRefs",
]);

function safeOwnDataValue(value: unknown, key: string): unknown {
  try {
    return ownDataValue(value, key);
  } catch {
    return undefined;
  }
}

function locatorString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function transitionLocators(request: unknown): TransitionLocators {
  const previous = safeOwnDataValue(request, "previous");
  const context = safeOwnDataValue(request, "context");
  const transitionId = locatorString(
    safeOwnDataValue(context, "transitionId"),
  );
  const transitionName = locatorString(
    safeOwnDataValue(context, "transitionName"),
  );
  return Object.freeze({
    aggregateKind: locatorString(safeOwnDataValue(previous, "kind")),
    aggregateId: locatorString(safeOwnDataValue(previous, "id")),
    dimension: locatorString(safeOwnDataValue(request, "dimension")),
    transitionId: transitionId as TransitionId | null,
    transitionName: transitionName as TransitionName | null,
  });
}

function exactDataObject(
  value: unknown,
  expectedFields: readonly string[],
): EnvelopeDescriptors | undefined {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
    return undefined;
  }
  const descriptors = dataDescriptors(value);
  if (
    descriptors.size !== expectedFields.length ||
    expectedFields.some((field) => !descriptors.has(field)) ||
    [...descriptors.values()].some((descriptor) => !("value" in descriptor))
  ) {
    return undefined;
  }
  return descriptors;
}

function canonicalDetails<D extends JsonValue>(details: D): DeepReadonly<D> {
  const result = canonicalizeJson(details);
  if (!result.ok) {
    throw new TypeError("internal rejection details must be canonical JSON");
  }
  return result.value;
}

function primitiveFailure<
  C extends PrimitiveTransitionRejection["code"],
  D extends JsonValue,
>(
  code: C,
  details: D,
  locators: TransitionLocators,
): DomainTransitionResult<never, PrimitiveTransitionRejection> {
  const rejection = Object.freeze({
    kind: "domain-rejection" as const,
    code,
    aggregateKind: locators.aggregateKind,
    aggregateId: locators.aggregateId,
    dimension: locators.dimension,
    transitionId: locators.transitionId,
    transitionName: locators.transitionName,
    details: canonicalDetails(details),
  }) as unknown as PrimitiveTransitionRejection;
  return Object.freeze({ ok: false, rejection });
}

function primitiveNonEmpty(
  descriptors: EnvelopeDescriptors,
  field: string,
): string | undefined {
  const value = fieldValue(descriptors, field);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeCanonicalize(value: unknown): CanonicalJsonResult<JsonValue> {
  try {
    return canonicalizeJson(value as JsonValue);
  } catch {
    const rejection: CanonicalJsonRejection = Object.freeze({
      code: "invalid_canonical_value",
      path: "",
      reason: "non_plain_object",
    });
    return Object.freeze({ ok: false, rejection });
  }
}

function readEvidenceRefs(value: unknown): readonly string[] | undefined {
  if (!denseDataArray(value)) {
    return undefined;
  }
  const refs: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const candidate = Object.getOwnPropertyDescriptor(value, String(index))?.value;
    if (typeof candidate !== "string" || candidate.length === 0) {
      return undefined;
    }
    refs.push(candidate);
  }
  return refs;
}

function enumerableDimensionKeys(value: object): string[] {
  return Object.getOwnPropertyNames(value)
    .filter((key) =>
      Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    )
    .sort(compareUtf16);
}

function replaceDimension(
  dimensions: Readonly<{ [key: string]: JsonValue }>,
  dimension: string,
  nextDimension: JsonValue,
): Readonly<{ [key: string]: JsonValue }> {
  const copy = Object.create(Object.getPrototypeOf(dimensions)) as Record<
    string,
    JsonValue
  >;
  for (const key of Object.getOwnPropertyNames(dimensions).sort(compareUtf16)) {
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: key === dimension ? nextDimension : dimensions[key] as JsonValue,
      writable: true,
    });
  }
  return Object.freeze(copy);
}

export function isTypedDomainRejection(
  value: unknown,
): value is TypedDomainRejection {
  try {
    const descriptors = exactDataObject(value, [
      "kind",
      "code",
      "aggregateKind",
      "aggregateId",
      "dimension",
      "transitionId",
      "transitionName",
      "details",
    ]);
    if (descriptors === undefined) {
      return false;
    }
    if (fieldValue(descriptors, "kind") !== "domain-rejection") {
      return false;
    }
    if (locatorString(fieldValue(descriptors, "code")) === null) {
      return false;
    }
    for (const field of [
      "aggregateKind",
      "aggregateId",
      "dimension",
      "transitionId",
      "transitionName",
    ]) {
      const candidate = fieldValue(descriptors, field);
      if (candidate !== null && locatorString(candidate) === null) {
        return false;
      }
    }
    return safeCanonicalize(fieldValue(descriptors, "details")).ok;
  } catch {
    return false;
  }
}

function applyPrimitiveTransitionInternal<
  A extends DimensionedDomainValueShape,
  D extends keyof A["dimensions"] & string,
>(
  request: PrimitiveTransitionRequest<A, D>,
  locators: TransitionLocators,
): DomainTransitionResult<A, PrimitiveTransitionRejection> {
  if (!isPlainObject(request)) {
    return primitiveFailure(
      "invalid_envelope",
      { field: "request", constraint: "plain_object" },
      locators,
    );
  }

  const requestDescriptors = dataDescriptors(request);
  const previousInput = fieldValue(requestDescriptors, "previous");
  if (!isPlainObject(previousInput)) {
    return primitiveFailure(
      "invalid_envelope",
      { field: "previous", constraint: "plain_object" },
      locators,
    );
  }
  const previousDescriptors = exactDataObject(previousInput, PREVIOUS_FIELDS);
  if (previousDescriptors === undefined) {
    return primitiveFailure(
      "invalid_envelope",
      { field: "previous", constraint: "exact_fields" },
      locators,
    );
  }

  const id = primitiveNonEmpty(previousDescriptors, "id");
  if (id === undefined) {
    return primitiveFailure(
      "invalid_envelope",
      { field: "id", constraint: "non_empty_string" },
      locators,
    );
  }
  const kind = primitiveNonEmpty(previousDescriptors, "kind");
  if (kind === undefined) {
    return primitiveFailure(
      "invalid_envelope",
      { field: "kind", constraint: "non_empty_string" },
      locators,
    );
  }
  const createdAt = primitiveNonEmpty(previousDescriptors, "createdAt");
  if (createdAt === undefined) {
    return primitiveFailure(
      "invalid_envelope",
      { field: "createdAt", constraint: "non_empty_string" },
      locators,
    );
  }
  const updatedAt = primitiveNonEmpty(previousDescriptors, "updatedAt");
  if (updatedAt === undefined) {
    return primitiveFailure(
      "invalid_envelope",
      { field: "updatedAt", constraint: "non_empty_string" },
      locators,
    );
  }

  const revisionResult = parseScalar(
    "Revision",
    fieldValue(previousDescriptors, "revision"),
  );
  if (!revisionResult.ok) {
    return primitiveFailure(
      "invalid_revision",
      {
        field: "previous.revision",
        constraint: "non_negative_safe_integer",
      },
      locators,
    );
  }
  const expectedRevisionResult = parseScalar(
    "Revision",
    fieldValue(requestDescriptors, "expectedRevision"),
  );
  if (!expectedRevisionResult.ok) {
    return primitiveFailure(
      "invalid_revision",
      { field: "expectedRevision", constraint: "non_negative_safe_integer" },
      locators,
    );
  }

  const contextInput = fieldValue(requestDescriptors, "context");
  const contextDescriptors = exactDataObject(contextInput, CONTEXT_FIELDS);
  if (contextDescriptors === undefined) {
    return primitiveFailure(
      "invalid_transition_context",
      { field: "context", constraint: "plain_exact_object" },
      locators,
    );
  }

  const transitionId = primitiveNonEmpty(contextDescriptors, "transitionId");
  if (transitionId === undefined) {
    return primitiveFailure(
      "invalid_transition_context",
      { field: "transitionId", constraint: "non_empty_string" },
      locators,
    );
  }
  const transitionName = primitiveNonEmpty(
    contextDescriptors,
    "transitionName",
  );
  if (transitionName === undefined) {
    return primitiveFailure(
      "invalid_transition_context",
      { field: "transitionName", constraint: "non_empty_string" },
      locators,
    );
  }
  const occurredAt = primitiveNonEmpty(contextDescriptors, "occurredAt");
  if (occurredAt === undefined) {
    return primitiveFailure(
      "invalid_transition_context",
      { field: "occurredAt", constraint: "non_empty_string" },
      locators,
    );
  }
  const actorRef = primitiveNonEmpty(contextDescriptors, "actorRef");
  if (actorRef === undefined) {
    return primitiveFailure(
      "invalid_transition_context",
      { field: "actorRef", constraint: "non_empty_string" },
      locators,
    );
  }
  const reasonCandidate = fieldValue(contextDescriptors, "reasonRef");
  const reasonRef = reasonCandidate === null
    ? null
    : locatorString(reasonCandidate);
  if (reasonCandidate !== null && reasonRef === null) {
    return primitiveFailure(
      "invalid_transition_context",
      { field: "reasonRef", constraint: "null_or_non_empty_string" },
      locators,
    );
  }
  const evidenceInput = fieldValue(contextDescriptors, "evidenceRefs");
  const evidenceRefs = readEvidenceRefs(evidenceInput);
  if (evidenceRefs === undefined) {
    return primitiveFailure(
      "invalid_transition_context",
      { field: "evidenceRefs", constraint: "dense_array_of_evidence_refs" },
      locators,
    );
  }
  const canonicalEvidence = safeCanonicalize(evidenceInput);
  if (!canonicalEvidence.ok) {
    return primitiveFailure(
      "invalid_canonical_value",
      {
        target: "context.evidenceRefs",
        rejection: canonicalEvidence.rejection,
      },
      locators,
    );
  }

  const attributesInput = fieldValue(previousDescriptors, "attributes");
  if (!isPlainObject(attributesInput)) {
    return primitiveFailure(
      "invalid_envelope",
      { field: "attributes", constraint: "plain_object" },
      locators,
    );
  }
  const canonicalAttributes = safeCanonicalize(attributesInput);
  if (!canonicalAttributes.ok) {
    return primitiveFailure(
      "invalid_canonical_value",
      {
        target: "previous.attributes",
        rejection: canonicalAttributes.rejection,
      },
      locators,
    );
  }

  const dimensionsInput = fieldValue(previousDescriptors, "dimensions");
  if (!isPlainObject(dimensionsInput)) {
    return primitiveFailure(
      "invalid_envelope",
      { field: "dimensions", constraint: "plain_object" },
      locators,
    );
  }
  const canonicalDimensions = safeCanonicalize(dimensionsInput);
  if (!canonicalDimensions.ok) {
    return primitiveFailure(
      "invalid_canonical_value",
      {
        target: "previous.dimensions",
        rejection: canonicalDimensions.rejection,
      },
      locators,
    );
  }

  const availableDimensions = enumerableDimensionKeys(dimensionsInput);
  const dimensionCandidate = fieldValue(requestDescriptors, "dimension");
  const dimension = locatorString(dimensionCandidate);
  const dimensionDescriptor = dimension === null
    ? undefined
    : Object.getOwnPropertyDescriptor(dimensionsInput, dimension);
  if (
    dimension === null ||
    dimensionDescriptor === undefined ||
    dimensionDescriptor.enumerable !== true
  ) {
    return primitiveFailure(
      "invalid_dimension",
      { availableDimensions: Object.freeze(availableDimensions) },
      locators,
    );
  }

  if (expectedRevisionResult.value !== revisionResult.value) {
    return primitiveFailure(
      "expected_revision_mismatch",
      {
        expected: expectedRevisionResult.value,
        actual: revisionResult.value,
      },
      locators,
    );
  }
  if (revisionResult.value === Number.MAX_SAFE_INTEGER) {
    return primitiveFailure(
      "revision_exhausted",
      { revision: revisionResult.value },
      locators,
    );
  }

  const nextDimensionInput = fieldValue(requestDescriptors, "nextDimension");
  const canonicalNextDimension = safeCanonicalize(nextDimensionInput);
  if (!canonicalNextDimension.ok) {
    return primitiveFailure(
      "invalid_canonical_value",
      { target: "nextDimension", rejection: canonicalNextDimension.rejection },
      locators,
    );
  }
  const canonicalPreviousDimension = safeCanonicalize(
    dimensionDescriptor.value,
  );
  if (!canonicalPreviousDimension.ok) {
    return primitiveFailure(
      "invalid_canonical_value",
      {
        target: "previous.dimensions",
        rejection: canonicalPreviousDimension.rejection,
      },
      locators,
    );
  }
  if (canonicalPreviousDimension.text === canonicalNextDimension.text) {
    return primitiveFailure(
      "unchanged_dimension",
      { canonicalText: canonicalPreviousDimension.text },
      locators,
    );
  }

  const previousDimensions = canonicalDimensions.value as Readonly<{
    [key: string]: JsonValue;
  }>;
  const nextDimensions = replaceDimension(
    previousDimensions,
    dimension,
    canonicalNextDimension.value,
  );
  const previous = Object.freeze({
    id,
    kind,
    revision: revisionResult.value,
    createdAt,
    updatedAt,
    attributes: canonicalAttributes.value,
    dimensions: previousDimensions,
  }) as DeepReadonly<A>;
  const afterRevision = (revisionResult.value + 1) as Revision;
  const next = Object.freeze({
    id,
    kind,
    revision: afterRevision,
    createdAt,
    updatedAt: occurredAt,
    attributes: canonicalAttributes.value,
    dimensions: nextDimensions,
  }) as DeepReadonly<A>;
  const sortedEvidence = Object.freeze(
    [...evidenceRefs].sort(compareUtf16) as EvidenceRef[],
  );
  const transitionRecord: DomainTransitionRecord = Object.freeze({
    kind: "domain-transition",
    transitionId: transitionId as TransitionId,
    transitionName: transitionName as TransitionName,
    aggregateKind: kind,
    aggregateId: id,
    dimension,
    beforeRevision: revisionResult.value,
    afterRevision,
    occurredAt: occurredAt as DomainTimestamp,
    actorRef: actorRef as ActorRef,
    reasonRef: reasonRef as ReasonRef | null,
    evidenceRefs: sortedEvidence,
  });
  return Object.freeze({
    ok: true,
    previous,
    next,
    transitionRecord,
  });
}

export function applyPrimitiveTransition<
  A extends DimensionedDomainValueShape,
  D extends keyof A["dimensions"] & string,
>(
  request: PrimitiveTransitionRequest<A, D>,
): DomainTransitionResult<A, PrimitiveTransitionRejection> {
  const locators = transitionLocators(request);
  try {
    return applyPrimitiveTransitionInternal(request, locators);
  } catch {
    return primitiveFailure(
      "invalid_envelope",
      { field: "request", constraint: "plain_object" },
      locators,
    );
  }
}

export interface SingleDimensionConformanceCase<
  A extends DimensionedDomainValueShape,
  D extends keyof A["dimensions"] & string,
> {
  readonly previous: A & JsonDimensionGuard<A["dimensions"]>;
  readonly dimension: D;
  readonly invoke: (previous: A, expectedRevision: Revision) => unknown;
}

export type ConformanceViolationCode =
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

export type ConformanceViolation = Readonly<{
  code: ConformanceViolationCode;
  path: string;
  detail: string;
}>;

export type SingleDimensionConformanceResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      violations: readonly ConformanceViolation[];
    }>;

const CONFORMANCE_SUCCESS_FIELDS = Object.freeze([
  "ok",
  "previous",
  "next",
  "transitionRecord",
]);

const TRANSITION_RECORD_FIELDS = Object.freeze([
  "kind",
  "transitionId",
  "transitionName",
  "aggregateKind",
  "aggregateId",
  "dimension",
  "beforeRevision",
  "afterRevision",
  "occurredAt",
  "actorRef",
  "reasonRef",
  "evidenceRefs",
]);

const CONFORMANCE_FAILURE_FIELDS = Object.freeze([
  "ok",
  "rejection",
  "next",
  "previous",
  "transitionRecord",
]);

type ClassifiedConformanceSuccess = Readonly<{
  kind: "success";
  result: Record<string, unknown>;
  previous: Record<string, unknown>;
  previousDescriptors: EnvelopeDescriptors;
  next: Record<string, unknown>;
  nextDescriptors: EnvelopeDescriptors;
  transitionRecord: Record<string, unknown>;
  recordDescriptors: EnvelopeDescriptors;
  canonicalText: string;
}>;

type ClassifiedConformanceFailure = Readonly<{
  kind: "failure";
  result: Record<string, unknown>;
  descriptors: EnvelopeDescriptors;
  rejection: TypedDomainRejection;
  invalidShape: boolean;
}>;

type ClassifiedUntypedFailure = Readonly<{
  kind: "untyped-failure";
}>;

type ClassifiedInvalidResult = Readonly<{
  kind: "invalid";
  detail:
    | "non_object"
    | "non_canonical"
    | "invalid_success_shape"
    | "invalid_rejection_shape";
}>;

type ClassifiedConformanceResult =
  | ClassifiedConformanceSuccess
  | ClassifiedConformanceFailure
  | ClassifiedUntypedFailure
  | ClassifiedInvalidResult;

function conformanceViolation(
  code: ConformanceViolationCode,
  path: string,
  detail: string,
): ConformanceViolation {
  return Object.freeze({ code, path, detail });
}

function appendConformanceViolation(
  violations: ConformanceViolation[],
  code: ConformanceViolationCode,
  path: string,
  detail: string,
): void {
  violations.push(conformanceViolation(code, path, detail));
}

function compareConformanceViolation(
  left: ConformanceViolation,
  right: ConformanceViolation,
): number {
  return compareUtf16(left.code, right.code) ||
    compareUtf16(left.path, right.path) ||
    compareUtf16(left.detail, right.detail);
}

function finishConformanceReport(
  violations: readonly ConformanceViolation[],
): SingleDimensionConformanceResult {
  if (violations.length === 0) {
    return Object.freeze({ ok: true });
  }

  const sorted = [...violations].sort(compareConformanceViolation);
  const deduplicated: ConformanceViolation[] = [];
  for (const violation of sorted) {
    const retained = deduplicated[deduplicated.length - 1];
    if (
      retained === undefined ||
      retained.code !== violation.code ||
      retained.path !== violation.path
    ) {
      deduplicated.push(violation);
    }
  }

  return Object.freeze({
    ok: false,
    violations: Object.freeze(deduplicated),
  });
}

function cloneCanonicalMutable(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const copy: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const element = Object.getOwnPropertyDescriptor(value, String(index))?.value;
      copy.push(cloneCanonicalMutable(element as JsonValue));
    }
    return copy;
  }

  const copy = Object.create(Object.getPrototypeOf(value)) as Record<
    string,
    JsonValue
  >;
  for (const key of Object.getOwnPropertyNames(value).sort(compareUtf16)) {
    const member = Object.getOwnPropertyDescriptor(value, key)?.value;
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: cloneCanonicalMutable(member as JsonValue),
      writable: true,
    });
  }
  return copy;
}

function conformanceCanonicalText(value: unknown): string | undefined {
  try {
    const result = canonicalizeJson(value as JsonValue);
    return result.ok ? result.text : undefined;
  } catch {
    return undefined;
  }
}

function conformanceValueEqual(left: unknown, right: unknown): boolean {
  const leftText = conformanceCanonicalText(left);
  return leftText !== undefined && leftText === conformanceCanonicalText(right);
}

function isRecursivelyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object") {
    return true;
  }
  try {
    if (!Object.isFrozen(value)) {
      return false;
    }
    if (seen.has(value)) {
      return true;
    }
    seen.add(value);
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return false;
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !isRecursivelyFrozen(descriptor.value, seen)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function isShallowFrozen(value: unknown): boolean {
  try {
    return value !== null && typeof value === "object" && Object.isFrozen(value);
  } catch {
    return false;
  }
}

function classifiableDomainValue(
  value: unknown,
): Readonly<{
  value: Record<string, unknown>;
  descriptors: EnvelopeDescriptors;
}> | undefined {
  const descriptors = exactDataObject(value, PREVIOUS_FIELDS);
  if (descriptors === undefined) {
    return undefined;
  }
  for (const field of ["id", "kind", "createdAt", "updatedAt"]) {
    if (primitiveNonEmpty(descriptors, field) === undefined) {
      return undefined;
    }
  }
  const revision = fieldValue(descriptors, "revision");
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    return undefined;
  }
  const attributes = fieldValue(descriptors, "attributes");
  const dimensions = fieldValue(descriptors, "dimensions");
  if (
    !isPlainObject(attributes) ||
    !safeCanonicalize(attributes).ok ||
    !isPlainObject(dimensions) ||
    !safeCanonicalize(dimensions).ok
  ) {
    return undefined;
  }
  return Object.freeze({
    value: value as Record<string, unknown>,
    descriptors,
  });
}

function classifiableTransitionRecord(
  value: unknown,
): Readonly<{
  value: Record<string, unknown>;
  descriptors: EnvelopeDescriptors;
}> | undefined {
  const descriptors = exactDataObject(value, TRANSITION_RECORD_FIELDS);
  if (
    descriptors === undefined ||
    fieldValue(descriptors, "kind") !== "domain-transition"
  ) {
    return undefined;
  }
  for (const field of [
    "transitionId",
    "transitionName",
    "aggregateKind",
    "aggregateId",
    "dimension",
    "occurredAt",
    "actorRef",
  ]) {
    if (primitiveNonEmpty(descriptors, field) === undefined) {
      return undefined;
    }
  }
  for (const field of ["beforeRevision", "afterRevision"]) {
    const revision = fieldValue(descriptors, field);
    if (
      typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    ) {
      return undefined;
    }
  }
  const reasonRef = fieldValue(descriptors, "reasonRef");
  if (reasonRef !== null && locatorString(reasonRef) === null) {
    return undefined;
  }
  const evidenceRefs = fieldValue(descriptors, "evidenceRefs");
  if (
    readEvidenceRefs(evidenceRefs) === undefined ||
    !safeCanonicalize(evidenceRefs).ok
  ) {
    return undefined;
  }
  return Object.freeze({
    value: value as Record<string, unknown>,
    descriptors,
  });
}

function classifyConformanceResult(value: unknown): ClassifiedConformanceResult {
  try {
    if (!isPlainObject(value)) {
      return Object.freeze({ kind: "invalid", detail: "non_object" });
    }

    const canonical = canonicalizeJson(value as JsonValue);
    if (!canonical.ok) {
      return Object.freeze({ kind: "invalid", detail: "non_canonical" });
    }

    const descriptors = dataDescriptors(value);
    const ok = fieldValue(descriptors, "ok");
    if (ok === true) {
      const resultDescriptors = exactDataObject(
        value,
        CONFORMANCE_SUCCESS_FIELDS,
      );
      if (resultDescriptors === undefined) {
        return Object.freeze({
          kind: "invalid",
          detail: "invalid_success_shape",
        });
      }
      const previous = classifiableDomainValue(
        fieldValue(resultDescriptors, "previous"),
      );
      const next = classifiableDomainValue(fieldValue(resultDescriptors, "next"));
      const transitionRecord = classifiableTransitionRecord(
        fieldValue(resultDescriptors, "transitionRecord"),
      );
      if (
        previous === undefined ||
        next === undefined ||
        transitionRecord === undefined
      ) {
        return Object.freeze({
          kind: "invalid",
          detail: "invalid_success_shape",
        });
      }
      return Object.freeze({
        kind: "success",
        result: value,
        previous: previous.value,
        previousDescriptors: previous.descriptors,
        next: next.value,
        nextDescriptors: next.descriptors,
        transitionRecord: transitionRecord.value,
        recordDescriptors: transitionRecord.descriptors,
        canonicalText: canonical.text,
      });
    }

    if (ok === false) {
      const rejection = fieldValue(descriptors, "rejection");
      if (!isTypedDomainRejection(rejection)) {
        return Object.freeze({ kind: "untyped-failure" });
      }
      const allowedFields = new Set(CONFORMANCE_FAILURE_FIELDS);
      const invalidShape = Object.getOwnPropertyNames(value).some(
        (field) => !allowedFields.has(field),
      );
      return Object.freeze({
        kind: "failure",
        result: value,
        descriptors,
        rejection,
        invalidShape,
      });
    }

    return Object.freeze({
      kind: "invalid",
      detail: "invalid_success_shape",
    });
  } catch {
    return Object.freeze({ kind: "invalid", detail: "non_canonical" });
  }
}

function appendSuccessFreezeViolations(
  violations: ConformanceViolation[],
  root: string,
  classified: ClassifiedConformanceSuccess,
): void {
  if (!isShallowFrozen(classified.result)) {
    appendConformanceViolation(
      violations,
      "output_not_frozen",
      root,
      "result",
    );
  }
  for (const [field, value, detail] of [
    ["previous", classified.previous, "previous"],
    ["next", classified.next, "next"],
    ["transitionRecord", classified.transitionRecord, "record"],
  ] as const) {
    if (!isRecursivelyFrozen(value)) {
      appendConformanceViolation(
        violations,
        "output_not_frozen",
        `${root}/${field}`,
        detail,
      );
    }
  }
}

function appendFailureViolations(
  violations: ConformanceViolation[],
  root: string,
  classified: ClassifiedConformanceFailure,
  expected: "success" | "stale",
): void {
  for (const [field, detail] of [
    ["next", "next_present"],
    ["previous", "previous_present"],
    ["transitionRecord", "record_present"],
  ] as const) {
    if (classified.descriptors.has(field)) {
      appendConformanceViolation(
        violations,
        "partial_next_on_rejection",
        `${root}/${field}`,
        detail,
      );
    }
  }
  if (classified.invalidShape) {
    appendConformanceViolation(
      violations,
      "invalid_result",
      root,
      "invalid_rejection_shape",
    );
  }
  if (!isShallowFrozen(classified.result)) {
    appendConformanceViolation(
      violations,
      "output_not_frozen",
      root,
      "result",
    );
  }
  if (!isRecursivelyFrozen(classified.rejection)) {
    appendConformanceViolation(
      violations,
      "output_not_frozen",
      `${root}/rejection`,
      "rejection",
    );
  }

  if (expected === "success") {
    appendConformanceViolation(
      violations,
      "success_expected",
      root,
      "current_revision_not_success",
    );
  } else if (classified.rejection.code !== "expected_revision_mismatch") {
    appendConformanceViolation(
      violations,
      "typed_stale_rejection_missing",
      `${root}/rejection`,
      "wrong_code",
    );
  }
}

function appendCurrentSuccessSemantics(
  violations: ConformanceViolation[],
  root: string,
  classified: ClassifiedConformanceSuccess,
  previousDescriptors: EnvelopeDescriptors,
  dimension: string,
  currentRevision: number,
): void {
  const nextRevision = fieldValue(classified.nextDescriptors, "revision");
  if (nextRevision !== currentRevision + 1) {
    appendConformanceViolation(
      violations,
      "revision_increment_invalid",
      `${root}/next/revision`,
      "not_plus_one",
    );
  }

  for (const [field, detail] of [
    ["id", "id_changed"],
    ["kind", "kind_changed"],
    ["createdAt", "created_at_changed"],
  ] as const) {
    if (
      fieldValue(classified.nextDescriptors, field) !==
      fieldValue(previousDescriptors, field)
    ) {
      appendConformanceViolation(
        violations,
        "audit_field_invalid",
        `${root}/next/${field}`,
        detail,
      );
    }
  }
  if (
    fieldValue(classified.nextDescriptors, "updatedAt") !==
    fieldValue(classified.recordDescriptors, "occurredAt")
  ) {
    appendConformanceViolation(
      violations,
      "audit_field_invalid",
      `${root}/next/updatedAt`,
      "updated_at_mismatch",
    );
  }

  const beforeDimensions = fieldValue(previousDescriptors, "dimensions") as object;
  const afterDimensions = fieldValue(
    classified.nextDescriptors,
    "dimensions",
  ) as object;
  const beforeDimensionDescriptors = dataDescriptors(beforeDimensions);
  const afterDimensionDescriptors = dataDescriptors(afterDimensions);
  const dimensionKeys = [...new Set([
    ...beforeDimensionDescriptors.keys(),
    ...afterDimensionDescriptors.keys(),
  ])].sort(compareUtf16);
  for (const key of dimensionKeys) {
    const beforePresent = beforeDimensionDescriptors.has(key);
    const afterPresent = afterDimensionDescriptors.has(key);
    const path = `${root}/next/dimensions/${escapePointerToken(key)}`;
    if (!beforePresent && afterPresent) {
      appendConformanceViolation(
        violations,
        "undeclared_dimension_changed",
        path,
        "dimension_added",
      );
    } else if (beforePresent && !afterPresent) {
      appendConformanceViolation(
        violations,
        "undeclared_dimension_changed",
        path,
        "dimension_removed",
      );
    } else if (beforePresent && afterPresent) {
      const equal = conformanceValueEqual(
        fieldValue(beforeDimensionDescriptors, key),
        fieldValue(afterDimensionDescriptors, key),
      );
      if (key === dimension && equal) {
        appendConformanceViolation(
          violations,
          "declared_dimension_unchanged",
          path,
          "declared_value_equal",
        );
      } else if (key !== dimension && !equal) {
        appendConformanceViolation(
          violations,
          "undeclared_dimension_changed",
          path,
          "undeclared_value_changed",
        );
      }
    }
  }

  if (
    !conformanceValueEqual(
      fieldValue(previousDescriptors, "attributes"),
      fieldValue(classified.nextDescriptors, "attributes"),
    )
  ) {
    appendConformanceViolation(
      violations,
      "attributes_changed",
      `${root}/next/attributes`,
      "attributes_changed",
    );
  }

  for (const [field, expectedValue, detail] of [
    ["aggregateKind", fieldValue(previousDescriptors, "kind"), "aggregate_kind"],
    ["aggregateId", fieldValue(previousDescriptors, "id"), "aggregate_id"],
    ["dimension", dimension, "dimension"],
    ["beforeRevision", currentRevision, "before_revision"],
    ["afterRevision", currentRevision + 1, "after_revision"],
  ] as const) {
    if (fieldValue(classified.recordDescriptors, field) !== expectedValue) {
      appendConformanceViolation(
        violations,
        "transition_record_mismatch",
        `${root}/transitionRecord/${field}`,
        detail,
      );
    }
  }
}

function runConformanceInvocation<A extends DimensionedDomainValueShape>(
  invoke: (previous: A, expectedRevision: Revision) => unknown,
  canonicalPrevious: JsonValue,
  previousDescriptors: EnvelopeDescriptors,
  dimension: string,
  currentRevision: number,
  expectedRevision: Revision,
  root: string,
  expected: "success" | "stale",
  violations: ConformanceViolation[],
): string | undefined {
  const invocationPrevious = cloneCanonicalMutable(
    canonicalPrevious,
  ) as unknown as A;
  const beforeText = conformanceCanonicalText(invocationPrevious);
  let result: unknown;
  let threw = false;
  try {
    result = invoke(invocationPrevious, expectedRevision);
  } catch {
    threw = true;
  }
  const afterText = conformanceCanonicalText(invocationPrevious);
  if (beforeText !== afterText) {
    appendConformanceViolation(
      violations,
      "input_mutated",
      "/previous",
      "previous_changed",
    );
  }
  if (threw) {
    appendConformanceViolation(violations, "invoke_threw", root, "threw");
    return undefined;
  }

  const classified = classifyConformanceResult(result);
  if (classified.kind === "invalid") {
    appendConformanceViolation(
      violations,
      "invalid_result",
      root,
      classified.detail,
    );
    return undefined;
  }
  if (classified.kind === "untyped-failure") {
    if (expected === "stale") {
      appendConformanceViolation(
        violations,
        "typed_stale_rejection_missing",
        `${root}/rejection`,
        "untyped_rejection",
      );
    } else {
      appendConformanceViolation(
        violations,
        "invalid_result",
        root,
        "invalid_rejection_shape",
      );
    }
    return undefined;
  }
  if (classified.kind === "failure") {
    appendFailureViolations(violations, root, classified, expected);
    return undefined;
  }

  appendSuccessFreezeViolations(violations, root, classified);
  if (expected === "stale") {
    appendConformanceViolation(
      violations,
      "typed_stale_rejection_missing",
      `${root}/rejection`,
      "stale_not_rejected",
    );
  } else {
    appendCurrentSuccessSemantics(
      violations,
      root,
      classified,
      previousDescriptors,
      dimension,
      currentRevision,
    );
  }
  return classified.canonicalText;
}

export function checkSingleDimensionConformance<
  A extends DimensionedDomainValueShape,
  D extends keyof A["dimensions"] & string,
>(
  input: SingleDimensionConformanceCase<A, D>,
): SingleDimensionConformanceResult {
  const violations: ConformanceViolation[] = [];
  const canonicalPreviousResult = canonicalizeJson(
    input.previous as unknown as JsonValue,
  );
  if (!canonicalPreviousResult.ok || !isPlainObject(canonicalPreviousResult.value)) {
    appendConformanceViolation(
      violations,
      "invalid_result",
      "/previous",
      canonicalPreviousResult.ok ? "non_object" : "non_canonical",
    );
    return finishConformanceReport(violations);
  }

  const previousDescriptors = dataDescriptors(canonicalPreviousResult.value);
  const currentRevision = fieldValue(previousDescriptors, "revision");
  if (currentRevision === Number.MAX_SAFE_INTEGER) {
    appendConformanceViolation(
      violations,
      "revision_increment_invalid",
      "/previous/revision",
      "revision_exhausted",
    );
    return finishConformanceReport(violations);
  }
  if (
    typeof currentRevision !== "number" ||
    !Number.isSafeInteger(currentRevision) ||
    currentRevision < 0
  ) {
    appendConformanceViolation(
      violations,
      "revision_increment_invalid",
      "/previous/revision",
      "not_plus_one",
    );
    return finishConformanceReport(violations);
  }

  const invoke = input.invoke;
  const dimension = input.dimension;
  const canonicalPrevious = canonicalPreviousResult.value as JsonValue;
  const currentExpected = currentRevision as Revision;
  const staleExpected = (currentRevision + 1) as Revision;
  const firstText = runConformanceInvocation(
    invoke,
    canonicalPrevious,
    previousDescriptors,
    dimension,
    currentRevision,
    currentExpected,
    "/invoke/0",
    "success",
    violations,
  );
  const secondText = runConformanceInvocation(
    invoke,
    canonicalPrevious,
    previousDescriptors,
    dimension,
    currentRevision,
    currentExpected,
    "/invoke/1",
    "success",
    violations,
  );
  runConformanceInvocation(
    invoke,
    canonicalPrevious,
    previousDescriptors,
    dimension,
    currentRevision,
    staleExpected,
    "/invoke/stale",
    "stale",
    violations,
  );

  if (
    firstText !== undefined &&
    secondText !== undefined &&
    firstText !== secondText
  ) {
    appendConformanceViolation(
      violations,
      "nondeterministic_result",
      "/invoke/1",
      "result_bytes_differ",
    );
  }

  return finishConformanceReport(violations);
}
