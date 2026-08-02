# V2 E02 — Domain identities, hierarchy, and primitive transition kernel

| Field | Value |
|---|---|
| Initiative | `workflow-agent-c2b` |
| Epic | `workflow-agent-c2b.3` |
| Map ID | `E02` |
| Document version | `draft-v3` |
| Product status | **DRAFT** |
| Approval status | **NOT APPROVED** |
| Engineering eligibility | **INELIGIBLE** |
| Primary repository | `workflow-agent` |
| Primary package | `@pi-workflow/v2-domain` |
| Delivery Units | 1 |
| Target Active Engineering Time | `1.5-2h` |
| Maximum implementation tasks | 5 |
| Verification Profile | `strict` |
| Approval manifest | Not created |
| Authoritative approval hash | Not assigned |

> This is a documentation-only draft contract. It authorizes no implementation, Readiness run, task creation, branch/worktree creation, commit, push, pull request, dependency installation, or external effect. It is **DRAFT**, **NOT APPROVED**, and **INELIGIBLE**. E02 is the pure kernel only; every lifecycle family named below is owned by a later bounded Epic.

## 1. Related authority and frozen traceability

This PRD is subordinate to:

- [Initiative Charter](../../INITIATIVE_CHARTER.md)
- [Architecture RFC](../../ARCHITECTURE_RFC.md#11-state-model)
- [Initial Epic Map](../../INITIAL_EPIC_MAP.md#2-bounded-epic-rules)
- [Third-Party Reuse Survey](../../THIRD_PARTY_REUSE_SURVEY.md#1-decision-posture)
- [E01 Workspace and Package Boundaries PRD](../E01/PRD.md#17-verification-contract)

The following decisions are frozen inputs. The owner column records where each decision is implemented; E02 only owns the rows assigned to E02.

| Decision | Frozen rule | Implementing owner Epic |
|---|---|---:|
| D01 | Primitive transitions change one authoritative dimension; cross-dimension work is an explicit ordered plan. | E02 kernel; E73 plan/preflight |
| D02 | Lifecycle authority is layered by aggregate; summaries are projections, not duplicated writable facts. | E02 authority contracts; E70–E83 family owners |
| D03 | Derived state is produced by versioned pure projections; materialized projections are non-authoritative. | E70, E71, E72, E77, E78, E82, E83 |
| D04 | An approved product-contract change is a first-class `ChangeRequest`. | E75 |
| D05 | Terminality is dimension-local; closure is derived. | E72, E74–E82 |
| D06 | Attention uses first-class signals and a derived severity projection. | E77 |
| D07 | A TaskAttempt result never automatically accepts a Task. | E78 Task acceptance; E79 TaskAttempt result |
| D08 | Display state is structured, deterministic, explainable, and lossless. | E83 |
| D09 | Primitive transitions are immutable pure functions with expected revision and typed rejection results. | E02 |
| D10 | Readiness is immutable evidence and a projection, not a Product state. | E70; E74 consumes it |
| D11 | Eligibility, queue disposition, and Allocation are separate concepts. | E70; E71 |
| D12 | Delivery uses independent provider-neutral facets, not one PR status. | E72 |
| D13 | Release disposition and immutable Release operations are separate. | E80 |
| D14 | Outcome requirements, observation runs, and assessments are separate. | E81 |
| D15 | Plans use preflight, ordered execution, stop-on-failure, and explicit compensation/reconciliation. | E73; Runtime consumers |
| D16 | Every Task belongs to exactly one Delivery Unit. | E02 ownership invariant; E78 |
| D17 | `paused` is authoritative control; `blocked` is projected from structured blocker facts. | E78; E77 |
| D18 | The former broad E02 is decomposed into bounded domain epics. | E02 kernel; E70–E83 decomposition |
| D19 | Initial approval uses immutable `ApprovalAttempt` records; rejected submissions remain frozen. | E74 |
| D20 | Supersession is an explicit predecessor/successor relation and transfers no authority/evidence implicitly. | E76 |
| D21 | The approved decomposition is exactly E02 plus E70–E83: each epic has one bounded result, explicit non-goals, dependencies, and authority boundary. | E02 map contract; E70–E83 |

## 2. Bounded result

E02 delivers one independently usable, backend-neutral package vocabulary for:

1. branded identities and caller-supplied scalar references/timestamps;
2. immutable revisioned envelopes with deterministic canonical ordering;
3. `Portfolio → Initiative → Epic → DeliveryUnit → Task` ownership and parent/repository invariants;
4. identity-only seams for `TaskAttemptId`, `StepAttemptId`, `RoleRunId`, and `LaunchPermitId` without defining their records or lifecycles;
5. a generic expected-revision transition result with typed rejection, `DomainTransitionRecord`, and a single-dimension conformance helper;
6. deterministic public exports and zero-side-effect tests.

E02 is intentionally not a product or workflow lifecycle Epic. Its result can be reverted without a migration, broker compensation, process shutdown, or external cleanup.

## 3. Included scope

### 3.1 Identities and scalar inputs

Expose distinct opaque branded string types for:

```text
PortfolioId
InitiativeId
EpicId
DeliveryUnitId
TaskId
TaskAttemptId
StepAttemptId
RoleRunId
LaunchPermitId
ApprovalAttemptId
ChangeRequestId
RepositoryId
TransitionId
EvidenceRef
BundleRef
DecisionRef
ActorRef
ReasonRef
```

`AttemptId` is deliberately not a public type. E02 owns the `TaskAttemptId` identity seam and immutable owner reference; E79 consumes them and owns only the TaskAttempt record/lifecycle/result/evidence. E02 likewise owns the distinct `StepAttemptId`, `RoleRunId`, and `LaunchPermitId` seams; E10 consumes `StepAttemptId`, and E20 consumes `RoleRunId`/`LaunchPermitId` for their Runtime records. None is interchangeable with another.

Also expose `DomainTimestamp` and `TransitionName` as distinct branded strings, and `Revision` and `PositiveOrdinal` as distinct branded numbers. The private brand symbol and generic brand helper are not public exports. Therefore consumers cannot mint a new public generic `AttemptId` brand through an E02 helper. The closed mapping is exact:

```ts
type ScalarByKind = Readonly<{
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

type ScalarKind = keyof ScalarByKind;
type EntityIdScalarKind =
  | "PortfolioId" | "InitiativeId" | "EpicId" | "DeliveryUnitId"
  | "TaskId" | "TaskAttemptId" | "StepAttemptId" | "RoleRunId"
  | "LaunchPermitId" | "ApprovalAttemptId" | "ChangeRequestId"
  | "RepositoryId" | "TransitionId";
```

The only scalar parser surface is:

```ts
type ScalarResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; rejection: ScalarRejection }>;

type ScalarRejection = Readonly<{
  code: "invalid_scalar";
  scalarKind: ScalarKind;
  constraint:
    | "non_empty_string"
    | "non_negative_safe_integer"
    | "positive_safe_integer";
}>;

function parseScalar<K extends ScalarKind>(
  kind: K,
  input: unknown,
): ScalarResult<ScalarByKind[K]>;
```

`ScalarKind` is the closed union of the 18 listed ID/reference names plus `DomainTimestamp`, `TransitionName`, `Revision`, and `PositiveOrdinal`; `ScalarByKind` is the corresponding closed mapping. String scalars accept any JavaScript string whose `.length > 0`, including whitespace-only strings. They are not trimmed, Unicode-normalized, parsed, or derived. `Revision` accepts only non-negative safe integers. `PositiveOrdinal` accepts only positive safe integers. `INITIAL_REVISION` is the branded number `0`.

All values are caller supplied. E02 does not call a clock, generate IDs, hash external content, infer actors, parse timestamp chronology, or read environment/process state. A parser rejection is returned as data and never throws for invalid caller input.

### 3.2 Immutable envelopes and canonical values

The JSON value domain is closed as:

```ts
type JsonPrimitive = null | boolean | number | string;
type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;
```

`DeepReadonly<T>` is the recursive mapped type that leaves `JsonPrimitive` unchanged, maps `readonly (infer U)[]` to `readonly DeepReadonly<U>[]`, and maps every object key to `readonly DeepReadonly<T[K]>`. `CanonicalJsonResult<T>` is exactly `{ ok: true; value: DeepReadonly<T>; text: string } | { ok: false; rejection: CanonicalJsonRejection }`.

`canonicalizeJson<T extends JsonValue>(input: T): CanonicalJsonResult<T>` follows RFC 8785 JSON Canonicalization Scheme (JCS) for serialization. `CanonicalJsonRejection` is exactly `{ code: "invalid_canonical_value"; path: string; reason: CanonicalJsonReason }`, where the closed reason union is `unsupported_type | non_finite_number | sparse_array | cycle | symbol_key | accessor | non_plain_object | lone_surrogate`. On success, `value` is a recursively copied and frozen JSON value and `text` is the RFC 8785 canonical JSON text encoded as UTF-8 by any later byte consumer. The helper never freezes or mutates the caller's input and performs no hash.

The byte oracle is exact:

- object keys use ascending JavaScript UTF-16 code-unit order with a direct `<`/`>` comparator; locale-sensitive comparison is forbidden;
- JSON arrays preserve their input order because order is data; arrays with domain-set semantics are sorted explicitly by the owning constructor before canonicalization;
- strings and property names use RFC 8785/ECMAScript JSON escaping: control characters use the required short escape where defined or lowercase `\u00xx`; quote and reverse solidus are escaped; solidus, U+2028, and U+2029 are not escaped; all other valid Unicode code points are emitted unchanged; lone UTF-16 surrogates reject and no Unicode normalization occurs;
- finite numbers use the RFC 8785 reference to ECMAScript `NumberToString` shortest round-trippable representation; negative zero serializes as `0`; alternative fixed/exponent spellings are forbidden;
- only `null`, booleans, finite numbers, strings, dense arrays, and plain objects whose prototype is `Object.prototype` or `null` are accepted;
- `undefined`, `bigint`, symbols, functions, `NaN`, infinities, sparse arrays, recursion-stack cycles, symbol keys, accessors, class instances, `Date`, `Map`, and `Set` are rejected with `invalid_canonical_value`; repeated references that are not cycles are copied independently and accepted;
- the serializer is repository-owned and deterministic; it does not rely on object insertion order, `JSON.stringify` traversal order, timezone, locale, environment, cwd, or filesystem state.

Rejection `path` is an RFC 6901 JSON Pointer: root is the empty string, object tokens replace `~` with `~0` and `/` with `~1`, and array tokens are canonical unsigned decimal indexes. Exactly one rejection is returned. Validation is depth-first pre-order. At each node the local priority is cycle, unsupported runtime type/prototype, symbol key, accessor, sparse array, non-finite number, lone surrogate; then array indexes ascend numerically or object string keys ascend by the canonical comparator. For a symbol key or invalid property name that cannot be represented as a valid child token, `path` is the containing object. This priority is part of AC-008.

The immutable revision envelope is exactly:

```ts
interface ImmutableRevisionEnvelope<I extends string, K extends string> {
  readonly id: I;
  readonly kind: K;
  readonly revision: Revision;
  readonly createdAt: DomainTimestamp;
  readonly updatedAt: DomainTimestamp;
}
```

The two signatures are exact:

```ts
type NewRevisionEnvelopeInput<I extends string, K extends string> = Readonly<{
  id: I;
  kind: K;
  createdAt: DomainTimestamp;
  updatedAt: DomainTimestamp;
}>;

function createRevisionEnvelope<I extends string, K extends string>(
  input: NewRevisionEnvelopeInput<I, K>,
): EnvelopeResult<ImmutableRevisionEnvelope<I, K>>;

function validateRevisionEnvelope<
  IK extends EntityIdScalarKind,
  K extends string,
>(
  value: unknown,
  identity: Readonly<{ idKind: IK; expectedKind: K }>,
): EnvelopeResult<ImmutableRevisionEnvelope<ScalarByKind[IK], K>>;
```

`createRevisionEnvelope` is the only new-envelope entry and always returns revision `0`; callers do not supply a revision to it. `validateRevisionEnvelope` is the restoration/validation entry and accepts an existing non-negative safe-integer revision. `EnvelopeResult<T> = { ok: true; value: DeepReadonly<T> } | { ok: false; rejection: EnvelopeRejection }`. `EnvelopeRejection` is exactly `{ code: "invalid_envelope"; field: string; constraint: "plain_object" | "non_empty_string" | "non_negative_safe_integer" | "exact_fields" | "expected_kind" }`.

Both entries require a plain object with exactly their declared own string keys and no symbol/accessor keys. A root plain-object/prototype failure is exactly `field: "[root]", constraint: "plain_object"`; a symbol key uses the fixed field sentinel `[symbol]`; a string accessor or extra key uses its actual key. Extra or missing keys reject with `constraint: "exact_fields"`. Validation order is plain-object/prototype, symbol keys, accessors and extra string keys in canonical order, then `id`, `kind`, `revision` when applicable, `createdAt`, and `updatedAt`; exactly one rejection is returned. `validateRevisionEnvelope` validates `id` with `identity.idKind`; a non-empty `kind` unequal to `identity.expectedKind` is exactly `field: "kind", constraint: "expected_kind"`. Both entries copy/freeze their output, require non-empty `id` and `kind`, treat timestamps as opaque non-empty caller strings, and do not compare timestamp chronology. Missing or malformed fields return `invalid_envelope`; they do not throw. Successful transitions increment revision exactly once; rejection leaves every input byte unchanged.

### 3.3 Hierarchy and ownership

The exact identity records are:

```ts
type PortfolioIdentityRecord = ImmutableRevisionEnvelope<PortfolioId, "portfolio"> &
  Readonly<{ ordinal: PositiveOrdinal }>;
type InitiativeIdentityRecord = ImmutableRevisionEnvelope<InitiativeId, "initiative"> &
  Readonly<{ portfolioId: PortfolioId; ordinal: PositiveOrdinal }>;
type EpicIdentityRecord = ImmutableRevisionEnvelope<EpicId, "epic"> &
  Readonly<{ initiativeId: InitiativeId; repositoryId: RepositoryId; ordinal: PositiveOrdinal }>;
type DeliveryUnitIdentityRecord = ImmutableRevisionEnvelope<DeliveryUnitId, "delivery-unit"> &
  Readonly<{ epicId: EpicId; repositoryId: RepositoryId; ordinal: PositiveOrdinal }>;
type TaskIdentityRecord = ImmutableRevisionEnvelope<TaskId, "task"> &
  Readonly<{ deliveryUnitId: DeliveryUnitId; ordinal: PositiveOrdinal }>;

type TaskAttemptOwnerRef = Readonly<{
  taskAttemptId: TaskAttemptId;
  taskId: TaskId;
}>;

type HierarchySnapshot = Readonly<{
  nodes: readonly HierarchyIdentityRecord[];
  taskAttemptOwners: readonly TaskAttemptOwnerRef[];
}>;
```

`validateHierarchy(input: unknown): HierarchyValidationResult` validates the complete snapshot rather than an isolated child. Its result is `{ ok: true; value: HierarchySnapshot } | { ok: false; rejections: readonly HierarchyRejection[] }`. `HierarchyRejection` is exactly `{ code: HierarchyRejectionCode; path: string; id: string | null; relatedId: string | null }`. Paths are RFC 6901 pointers. It returns either a canonical, recursively frozen snapshot or a canonically sorted non-empty rejection list. Node success order is fixed by kind rank `portfolio`, `initiative`, `epic`, `delivery-unit`, `task`, then parent raw ID (empty for Portfolio), ordinal, and entity raw ID, all string comparisons using the canonical UTF-16 comparator. Task-attempt owner references sort by `taskId`, then `taskAttemptId`. Rejections sort by `code`, `path`, `id`, and `relatedId`, with `null` before strings.

The validator applies these exact rules and closed rejection codes:

- `invalid_snapshot`: the root is not a plain exact `{ nodes, taskAttemptOwners }` object or either collection is not a dense array; one root rejection is returned and validation stops;
- `invalid_record`: a node/owner-ref is not a plain object, has the wrong exact own-key set for its declared kind, has a symbol/accessor key, or has an unknown kind;
- `invalid_envelope`: a node revision, `createdAt`, or `updatedAt` is invalid under the Section 3.2 priority;
- `invalid_scalar`: a node ID, parent ID, repository ID, or owner-ref scalar fails its Section 3.1 parser;
- `invalid_ordinal`: any ordinal is not a positive safe integer;
- `missing_parent`: the required raw parent ID does not exist in any node;
- `parent_kind_mismatch`: the raw parent ID exists, but not at the required kind;
- `duplicate_identity`: the same `(kind, id)` appears more than once outside a valid single ownership position;
- `duplicate_sibling_identity`: duplicate `(kind, id)` records declare the same parent;
- `multiple_parent_ownership`: duplicate `(kind, id)` records declare different parents;
- `repository_mismatch`: a Delivery Unit repository differs byte-for-byte from its owning Epic repository;
- `missing_task`: a `TaskAttemptOwnerRef.taskId` does not identify a Task node;
- `duplicate_task_attempt_ownership`: the same `TaskAttemptId` appears more than once, even when the Task is the same.

Locator and cardinality rules are exact:

- root/prototype/key-set failure emits exactly one `invalid_snapshot`; path is empty for the root itself, `/nodes` or `/taskAttemptOwners` for a bad collection, or the RFC 6901 child path for a missing/extra root key; both IDs are null; validation stops;
- a non-plain, symbol/accessor-bearing, unknown-kind, missing-key, or extra-key node/owner ref emits exactly one `invalid_record` at `/nodes/<input-index>` or `/taskAttemptOwners/<input-index>`; `id` is the valid raw entity/attempt ID when recoverable, `relatedId` is the valid raw parent/Task ID when recoverable, otherwise null; field validation for that record stops;
- an exact-shape node validates fields in its declared type order: `id`, `kind`, `revision`, `createdAt`, `updatedAt`, then `ordinal`, then its parent and repository fields in declaration order; an exact-shape owner ref validates `taskAttemptId`, then `taskId`; every invalid field emits one field rejection at its input-index RFC 6901 path, `id` is the valid owning entity/attempt ID when available, and `relatedId` is null;
- relationship checks skip only invalid records and run against the remaining valid-record index.

For each valid `(kind, id)` group with more than one record, exactly one duplicate-family rejection is emitted: `duplicate_identity` for Portfolio duplicates, `duplicate_sibling_identity` when all non-Portfolio copies have the same valid parent raw ID, otherwise `multiple_parent_ownership`. These three codes are mutually exclusive for a group. Records in the group are ordered by parent raw ID, ordinal, repository raw ID when present, full canonical record text, then original input index. The rejection path names the original index of the second record in that order; `id` is the group ID; `relatedId` is null for Portfolio, the common parent for duplicate siblings, or the canonical first parent's raw ID for multiple ownership.

Missing-parent precedence is `parent_kind_mismatch` when the raw ID exists at any wrong kind, otherwise `missing_parent`. A TaskAttempt-owner duplicate emits exactly one `duplicate_task_attempt_ownership` for the group; its `path` is the original index of the second item after sorting by `taskId`, `taskAttemptId`, then input index; `id` is the attempt ID and `relatedId` is the canonical first Task ID. Repository mismatch uses the Unit repository-field path, Unit ID, and Epic ID. Other relationship paths point to the offending parent scalar field, with child ID and referenced raw ID. All applicable non-duplicate relationship rejections are accumulated, then globally sorted as specified.

Every Initiative has one `PortfolioId`; every Epic has one `InitiativeId` and one primary `RepositoryId`; every Delivery Unit has one `EpicId` and the same repository as its Epic; every Task has one `DeliveryUnitId`. Ordinals need not be unique and are used only for deterministic sibling ordering, with ID as the tie-breaker.

`validateOwnershipNext(previous: unknown, next: unknown): OwnershipValidationResult` checks an existing same-kind pair and returns `{ ok: true; value: HierarchyIdentityRecord } | { ok: false; rejections: readonly OwnershipRejection[] }`. `OwnershipRejection` is exactly `{ code: "invalid_record" | "invalid_envelope" | "invalid_scalar" | "immutable_identity_changed" | "immutable_parent_changed" | "immutable_repository_changed" | "invalid_ordinal"; path: string }`. It first validates `previous`, then `next`, using exact record/envelope/scalar/ordinal rules and emitting all field rejections; comparison runs only if both are valid. Comparison order is `kind`, `id`, `createdAt`, kind-specific parent, then repository. It rejects when identity, parent, or Epic/Delivery Unit repository changes. Rejections sort by `code`, then RFC 6901 path and are recursively frozen. Revision and `updatedAt` may change only under the primitive transition contract; this ownership validator does not define lifecycle legality.

E02 declares `TaskAttemptId → TaskId` only through `TaskAttemptOwnerRef`; it does not create a TaskAttempt envelope, result, retry, state, or lifecycle. No hierarchy constructor creates a branch, worktree, Beads issue, process, lease, permit, or external resource.

Required invariants therefore form exactly:

```text
Portfolio → Initiative → Epic → DeliveryUnit → Task
TaskAttemptId → TaskId (identity-only reference)
```

- parent IDs and repository ownership cannot be changed through a next-state value;
- no hierarchy constructor creates a branch, worktree, Beads issue, process, lease, permit, or external resource.

Portfolio has identity/ownership only here. Portfolio lifecycle is E74. Product lifecycle is E74. E02 owns neither.

### 3.4 Generic primitive transition kernel

Transitionable values use one exact container shape. The target dimension is one direct key of `dimensions`, never a dotted path or JSON Pointer:

```ts
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

type DimensionMap<D extends object> =
  true extends DimensionMapInvalid<D> ? never : Readonly<D>;

interface DimensionedDomainValue<I extends string, K extends string, D extends object> {
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

interface DomainTransitionContext {
  readonly transitionId: TransitionId;
  readonly transitionName: TransitionName;
  readonly occurredAt: DomainTimestamp;
  readonly actorRef: ActorRef;
  readonly reasonRef: ReasonRef | null;
  readonly evidenceRefs: readonly EvidenceRef[];
}

interface PrimitiveTransitionRequest<
  A extends DimensionedDomainValueShape,
  D extends keyof A["dimensions"] & string,
> {
  readonly previous: A & JsonDimensionGuard<A["dimensions"]>;
  readonly expectedRevision: Revision;
  readonly dimension: D;
  readonly nextDimension: A["dimensions"][D];
  readonly context: DomainTransitionContext;
}

type DomainTransitionResult<A, R extends TypedDomainRejection> =
  | Readonly<{ ok: true; previous: DeepReadonly<A>; next: DeepReadonly<A>; transitionRecord: DomainTransitionRecord }>
  | Readonly<{ ok: false; rejection: R }>;

function applyPrimitiveTransition<
  A extends DimensionedDomainValueShape,
  D extends keyof A["dimensions"] & string,
>(request: PrimitiveTransitionRequest<A, D>):
  DomainTransitionResult<A, PrimitiveTransitionRejection>;
```

`JsonInvalid`, `JsonInvalidMember`, `DimensionMapInvalid`, `ArrayBuiltinSymbolKeys`, `JsonPropertyValue`, `TupleDeclaredKeys`, `IsTuple`, `DimensionedDomainValueShape`, and `JsonDimensionGuard` are declaration-private helpers and are not package exports. Top-level dimension keys must all be required strings; an optional dimension key rejects so `nextDimension` never gains an implicit `undefined`. Recursion rejects symbol keys at every nested object; arrays retain only their standard library symbol keys and reject any additional declared symbol. Call and construct signatures are rejected. A type mutually assignable with the complete recursive `JsonValue` union is the only safe recursion terminator; narrower object aliases, `Readonly<Record<string, JsonValue>>`, and arrays are still traversed. Ordinary non-empty **acyclic** closed nested interfaces need no string index signature. With `exactOptionalPropertyTypes`, an optional nested object property is omission-or-present data: `JsonPropertyValue` uses `Required<T>[P]` only for an optional key, so implicit indexed-access `undefined` is removed while an explicitly declared `| undefined` remains invalid. TypeScript does not preserve that distinction reliably for optional tuple elements, especially with a rest tail; therefore optional tuples are outside the static contract and reject, while required tuples, required variadic tuples, and ordinary arrays are supported. A custom self-recursive interface is outside the static `DimensionMap` contract because TypeScript reports a circular mapped-type reference; consumers express its recursive property as `JsonValue`, while runtime canonicalization still accepts finite JSON values and rejects value cycles. Because TypeScript cannot distinguish the broad `object` type from an empty structural object by keys, an object branch with `keyof T = never` is rejected; an empty JSON object is expressed as `JsonValue` or `Readonly<Record<string, never>>`. `JsonInvalidMember` distributes over every statically observable union branch and `true extends ...` folds invalidity upward, so an observable invalid branch cannot be dropped or structurally absorbed by a broader valid branch such as `Readonly<Record<string, JsonValue>>`. TypeScript normalizes `JsonValue | X` to `JsonValue` whenever `X` is structurally assignable to it; that explicit full-domain widening erases `X` provenance and is accepted statically, but every runtime value still undergoes Section 3.2 canonical validation. A call/construct signature, function, optional top-level dimension, optional tuple, extra array symbol, symbol key at any object nesting depth, broad keyless object, explicit `undefined`, or other statically observable non-JSON member makes the corresponding `DimensionMap<D>` or guarded `previous` position uninhabitable (`never`); there is no `D = object` default that erases the known key set.

`DomainTransitionRecord` is exactly:

```ts
interface DomainTransitionRecord {
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
```

`TypedDomainRejection<C extends string = string, D extends JsonValue = JsonValue>` has readonly fields exactly `{ kind: "domain-rejection"; code: C; aggregateKind: string | null; aggregateId: string | null; dimension: string | null; transitionId: TransitionId | null; transitionName: TransitionName | null; details: DeepReadonly<D> }`. Locator fields contain the validated caller value or `null`; they are never generated or replaced with placeholders. `isTypedDomainRejection(value: unknown): value is TypedDomainRejection` validates this complete structure, including canonical JSON details.

`PrimitiveTransitionRejection` is the discriminated union below; its code/details pair is closed:

```text
invalid_envelope
  { field: "request" | "previous" | "id" | "kind" | "createdAt" | "updatedAt" | "attributes" | "dimensions", constraint: "non_empty_string" | "exact_fields" | "plain_object" }
invalid_revision
  { field: "previous.revision" | "expectedRevision", constraint: "non_negative_safe_integer" }
expected_revision_mismatch
  { expected: number, actual: number }
revision_exhausted
  { revision: number }
invalid_dimension
  { availableDimensions: readonly string[] }
unchanged_dimension
  { canonicalText: string }
invalid_transition_context
  { field: "context" | "transitionId" | "transitionName" | "occurredAt" | "actorRef" | "reasonRef" | "evidenceRefs", constraint: "plain_exact_object" | "non_empty_string" | "null_or_non_empty_string" | "dense_array_of_evidence_refs" }
invalid_canonical_value
  { target: "previous.attributes" | "previous.dimensions" | "nextDimension" | "context.evidenceRefs", rejection: CanonicalJsonRejection }
```

`invalid_envelope` is included in the closed E02 code union. Later Epics may extend the code union while retaining the nullable locator structure.

The valid `invalid_envelope` pairs are closed: `request/plain_object`; `previous/plain_object | exact_fields`; `id/non_empty_string`; `kind/non_empty_string`; `createdAt/non_empty_string`; `updatedAt/non_empty_string`; and `attributes|dimensions/plain_object`. The valid `invalid_transition_context` pairs are `context/plain_exact_object`; `transitionId|transitionName|occurredAt|actorRef/non_empty_string`; `reasonRef/null_or_non_empty_string`; and `evidenceRefs/dense_array_of_evidence_refs`.

Before choosing the first rejection, the function performs side-effect-free locator extraction from own data descriptors only: `aggregateKind` is the non-empty string `previous.kind` or null; `aggregateId` is the non-empty string `previous.id` or null; `dimension` is the non-empty string request dimension or null; `transitionId` and `transitionName` are their successfully parsed context scalars or null. These five decisions are independent: a valid nested locator is retained even when an earlier container has an extra key, but an accessor, symbol-only value, missing container, wrong type, or invalid scalar yields null. No other context field affects locators.

`applyPrimitiveTransition(request)` accepts runtime-invalid values without throwing and evaluates exactly one failure in this order: request plain object; previous plain object/exact key set; previous `id`, `kind`, `createdAt`, `updatedAt`; previous revision; expected revision; context plain exact object; context fields in declaration order; attributes plain object/canonicality; dimensions plain object/canonicality; dimension syntax/presence; stale revision; exhausted revision; next dimension canonicality; unchanged dimension. Container fields are exactly `id`, `kind`, `revision`, `createdAt`, `updatedAt`, `attributes`, and `dimensions`. A symbol/accessor/extra/missing key on previous returns `previous/exact_fields`; the same on context returns `context/plain_exact_object`. Either malformed revision returns `invalid_revision`. A dimension is valid only when it is a non-empty own enumerable string key of a plain `dimensions` object. `availableDimensions` is canonically sorted.

After validation, it rejects stale revisions before constructing a next value; rejects `Number.MAX_SAFE_INTEGER` as `revision_exhausted`; rejects byte-equal old/new dimension values; replaces only `dimensions[dimension]`; sets revision to exactly `previous.revision + 1`; sets `updatedAt` to `context.occurredAt`; and preserves `id`, `kind`, `createdAt`, every attribute, and every undeclared dimension byte-for-byte. Evidence references are copied and sorted by the canonical comparator without deduplication. Callers must explicitly supply `reasonRef: null` and `evidenceRefs: []` when empty.

Success returns canonical recursively frozen `previous`, `next`, and transition record. Failure returns exactly `{ ok: false, rejection }`: it has no `next`, `previous`, partial patch, or transition record and never invokes a caller mutation callback. Invalid caller data is represented by the typed rejection rather than thrown.

The conformance API is exact:

```ts
interface SingleDimensionConformanceCase<
  A extends DimensionedDomainValueShape,
  D extends keyof A["dimensions"] & string,
> {
  readonly previous: A & JsonDimensionGuard<A["dimensions"]>;
  readonly dimension: D;
  readonly invoke: (previous: A, expectedRevision: Revision) => unknown;
}

type ConformanceViolation = Readonly<{
  code: ConformanceViolationCode;
  path: string;
  detail: string;
}>;

type SingleDimensionConformanceResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; violations: readonly ConformanceViolation[] }>;

function checkSingleDimensionConformance<
  A extends DimensionedDomainValueShape,
  D extends keyof A["dimensions"] & string,
>(input: SingleDimensionConformanceCase<A, D>):
  SingleDimensionConformanceResult;
```

The helper is a pure runtime report over even adversarial implementations, so `invoke` returns `unknown`. It is called exactly twice with the current revision and once with `current revision + 1` for the stale case; each call is independent and caught. The helper returns `{ ok: true }` or `{ ok: false, violations }`. Call roots are `/invoke/0`, `/invoke/1`, and `/invoke/stale`; field paths append RFC 6901 tokens to those roots. `detail` is a closed stable token chosen by the violated check, not interpolated exception text or serialized attacker data. Violations sort by code/path/detail and duplicate code/path pairs retain the lexicographically smallest detail:

```text
success_expected
input_mutated
revision_increment_invalid
audit_field_invalid
declared_dimension_unchanged
undeclared_dimension_changed
attributes_changed
transition_record_mismatch
nondeterministic_result
typed_stale_rejection_missing
partial_next_on_rejection
output_not_frozen
invoke_threw
invalid_result
```

The closed detail tokens are: `success_expected=current_revision_not_success`; `input_mutated=previous_changed`; `revision_increment_invalid=not_plus_one | revision_exhausted`; `audit_field_invalid=id_changed | kind_changed | created_at_changed | updated_at_mismatch`; `declared_dimension_unchanged=declared_value_equal`; `undeclared_dimension_changed=undeclared_value_changed | dimension_added | dimension_removed`; `attributes_changed=attributes_changed`; `transition_record_mismatch=aggregate_kind | aggregate_id | dimension | before_revision | after_revision`; `nondeterministic_result=result_bytes_differ`; `typed_stale_rejection_missing=stale_not_rejected | wrong_code | untyped_rejection`; `partial_next_on_rejection=next_present | previous_present | record_present`; `output_not_frozen=result | previous | next | record | rejection | violations`; `invoke_threw=threw`; and `invalid_result=non_object | non_canonical | invalid_success_shape | invalid_rejection_shape`.

Before and after every invocation, including a throw, input bytes are compared; mutation adds `input_mutated` at `/previous`. A throw then adds only `invoke_threw` at the call root. A non-plain, cyclic, non-canonical, or unclassifiable return adds only `invalid_result` at the call root. Result classification checks `ok` first. A plain object with `ok: false` and a structurally valid typed `rejection` is classified as a failure even when it also contains forbidden `next`, `previous`, or `transitionRecord`; each present forbidden field adds its reachable `partial_next_on_rejection` violation at that field path. Any other extra/missing failure key also adds `invalid_result/invalid_rejection_shape`. Success shapes require exactly `ok`, `previous`, `next`, and `transitionRecord`; shape errors add `invalid_result/invalid_success_shape` and stop result-field checks.

For a classified success, `revision_increment_invalid` uses `/next/revision`; each changed immutable audit field uses `/next/<field>`; declared/undeclared dimension violations use `/next/dimensions/<escaped-key>` with one violation per canonical key; `attributes_changed` uses `/next/attributes`; transition-record mismatches use `/transitionRecord/<field>` with one violation per field; and unfrozen output objects each use their object path. A valid failure when success is expected adds `success_expected` at the call root. Stale-result violations use `/invoke/stale/rejection`; a stale success uses `stale_not_rejected`, a wrong code uses `wrong_code`, and a structurally untyped rejection uses `untyped_rejection`. `nondeterministic_result` is evaluated only when both current-revision calls are canonical classified successes and uses `/invoke/1`.

A case at exhausted revision reports `revision_increment_invalid` at `/previous/revision` with detail `revision_exhausted` and invokes zero times. The returned report and violations are recursively frozen. The helper is a test contract, not a lifecycle matrix or projection implementation.

### 3.5 Deterministic exports and tests

The package retains exactly one `"."` entrypoint and no public subpath. Its runtime value export allowlist is exactly `INITIAL_REVISION`, `parseScalar`, `canonicalizeJson`, `createRevisionEnvelope`, `validateRevisionEnvelope`, `validateHierarchy`, `validateOwnershipNext`, `applyPrimitiveTransition`, `isTypedDomainRejection`, and `checkSingleDimensionConformance`.

The type export allowlist is exactly the 18 listed ID/reference types; `DomainTimestamp`, `TransitionName`, `Revision`, `PositiveOrdinal`, `EntityIdScalarKind`, `ScalarKind`, `ScalarByKind`, `ScalarResult`, `ScalarRejection`, `JsonPrimitive`, `JsonValue`, `DeepReadonly`, `CanonicalJsonResult`, `CanonicalJsonRejection`, `CanonicalJsonReason`, `ImmutableRevisionEnvelope`, `NewRevisionEnvelopeInput`, `EnvelopeResult`, `EnvelopeRejection`, the five identity records, `HierarchyIdentityRecord`, `TaskAttemptOwnerRef`, `HierarchySnapshot`, `HierarchyValidationResult`, `HierarchyRejection`, `HierarchyRejectionCode`, `OwnershipValidationResult`, `OwnershipRejection`, `DimensionMap`, `DimensionedDomainValue`, `DomainTransitionContext`, `PrimitiveTransitionRequest`, `DomainTransitionResult`, `DomainTransitionRecord`, `TypedDomainRejection`, `PrimitiveTransitionRejection`, `SingleDimensionConformanceCase`, `SingleDimensionConformanceResult`, `ConformanceViolation`, and `ConformanceViolationCode`.

`ApprovalAttemptId` and `ChangeRequestId` are allowed identity seams; `ApprovalAttempt`/`ChangeRequest` records, states, transitions, and decisions are forbidden. `TaskAttemptId` is allowed; a `TaskAttempt` record/lifecycle is forbidden. No public `AttemptId`, generic brand constructor, lifecycle enum, projection, plan, persistence schema, adapter, clock, or side-effect helper exists.

Tests use Node's built-in `node:test` and an isolated strict TypeScript type-test project. They prove compile-time identity separation, readonly contracts, exact public symbol allowlists, ownership invariants, canonical byte output, stale/invalid rejection, exact revision behavior, malicious multi-dimension conformance failures, and zero side effects on import and helper execution.

## 4. Explicit non-goals and authority handoff

E02 does **not** implement, specify a transition matrix for, or claim authority over:

- Portfolio lifecycle or Product lifecycle;
- `ApprovalAttempt` records or approval decisions;
- `ChangeRequest` records, application, or approval;
- supersession behavior or predecessor/successor lifecycle;
- TaskAttempt records or lifecycle (E79 owns these; E02 only exposes `TaskAttemptId`);
- ordered plans or preflight (E73 owns these);
- Readiness or governance evidence (E70);
- Attention or Blocker facts (E77);
- Scheduling, eligibility, queue, or Allocation (E70/E71);
- Engineering lifecycle or Task lifecycle (E78);
- Delivery facets (E72);
- Release (E80);
- Outcome (E81);
- closure (E82);
- display (E83);
- persistence, RPC, Beads, Git, GitHub, Runtime orchestration, Worker execution, Scheduler, Lease, Permission, adapter, network, filesystem mutation, timers, or third-party backend selection.

Later owners may consume E02 types but may not redefine or duplicate E02 identity, revision, ownership, or primitive-result semantics.

## 5. Users and bounded implementation tasks

### User stories

- **US-01 — Domain consumer:** use one branded vocabulary without accidental identity interchange or hidden generated values.
- **US-02 — Runtime/protocol consumer:** wrap a pure expected-revision result without redefining rejection or audit semantics.
- **US-03 — Later domain owner:** add one lifecycle dimension without gaining authority over another dimension.
- **US-04 — Reviewer:** prove stale callers, parent migration, repository mismatch, and multi-dimension mutation fail closed.
- **US-05 — Maintainer:** import and remove the package without clocks, I/O, migrations, or external cleanup.

### Maximum five tasks

1. Define the closed scalar vocabulary, exact canonical JSON algorithm, and immutable envelope create/restore paths.
2. Define the five hierarchy records, complete-snapshot validator, TaskAttempt owner reference, and next-ownership validator.
3. Define the dimensions-container primitive transition, closed E02 rejection codes, `DomainTransitionRecord`, and conformance report helper.
4. Add compile-time negative contracts, deterministic runtime fixtures, exact export/scope audit, and zero-side-effect tests.
5. Wire only the frozen public entrypoint, strengthen the E01 boundary negatives, add the E02 worktree/evidence verifier, and record strict verification evidence.

## 6. Acceptance criteria (continuous reduced set)

- **AC-001 — Distinct identities:** `TaskAttemptId`, `StepAttemptId`, `RoleRunId`, and `LaunchPermitId` are distinct branded types; no public or documented generic `AttemptId` exists.
- **AC-002 — Caller-supplied scalars:** constructors/transitions require caller-supplied timestamps, revisions, actor/reason/evidence/bundle/decision references and perform no implicit clock, ID, hash, or actor generation.
- **AC-003 — Revisioned immutable envelopes:** `createRevisionEnvelope` always creates revision `0`; `validateRevisionEnvelope` accepts only non-negative safe-integer existing revisions; malformed inputs reject; outputs are defensive frozen copies; successful primitives produce exactly `revision + 1`.
- **AC-004 — Hierarchy invariants:** the exact Section 3.3 records validate as one canonical snapshot; missing/mismatched parents, duplicate/multiple ownership, invalid ordinals, parent/repository migration, missing Task ownership, and Unit repository mismatch return their frozen rejection codes.
- **AC-005 — Deferred TaskAttempt boundary:** E02 exports only `TaskAttemptId` identity/reference support; no TaskAttempt record, lifecycle, acceptance, retry, or execution matrix is present.
- **AC-006 — Generic typed result:** every primitive returns the exact Section 3.4 discriminated union; `DomainTransitionRecord` binds the full caller context and before/after revisions; E02 failures use only the closed kernel codes and contain no partial next state or record.
- **AC-007 — Single-dimension helper:** the reusable helper exercises the exact success/stale protocol and reports only the closed violation codes; it rejects changes to any attribute, undeclared dimension, or immutable/audit field other than revision and `updatedAt`.
- **AC-008 — Determinism:** Section 3.2 fixtures produce byte-identical canonical text across insertion order, timezone, locale, environment, cwd, and filesystem changes; every listed invalid JSON value fails at a deterministic path.
- **AC-009 — Zero side effects:** importing the public package and running canonicalization/validation/transition helpers performs no process, timer, network, filesystem, database, VCS, Beads, or Runtime effect.
- **AC-010 — Export boundary:** the runtime and type exports match the two exact Section 3.5 allowlists through the single package entrypoint; no public subpath, generic brand, private helper, or deferred record/lifecycle export exists.
- **AC-011 — Scope audit:** source/export inspection permits only the E02-owned shared identity seams named by the closed scalar contract; it confirms their records/lifecycles plus supersession, plans, Readiness, projections, Attention/Blocker, Scheduling, Engineering/Task, Delivery, Release, Outcome, closure, and display remain with their named later Epics.
- **AC-012 — Strict evidence:** every Section 7 gate passes; tracked and enumerated untracked files are whitespace-clean; the generated Bundle, source/authority/renderer hashes, E01 freeze, changed-path allowlist, and exact Manifest hash read back without mutation.

## 7. Strict verification contract

The required commands are deterministic and run without modifying authority documents:

```text
node docs/v2/epics/E02/generate-bundle.mjs --check
npm --workspace=@pi-workflow/v2-domain run test
npm --workspace=@pi-workflow/v2-domain run typecheck
npm run test:v2
npm run typecheck:v2
node scripts/validate-v2-boundaries.mjs
node scripts/verify-e02-worktree.mjs
git diff --check
git diff --exit-code -- docs/v2/epics/E01
npm ci && npm run check && node scripts/validate-v2-boundaries.mjs && git diff --check
```

`scripts/verify-e02-worktree.mjs` is a deterministic E02 evidence helper. It uses NUL-safe Git output to enumerate every tracked modification and untracked file, runs the equivalent of `git diff --no-index --check /dev/null <path>` for untracked regular files, rejects symlinks and paths outside the exact allowlist below, verifies that `docs/v2/epics/E01/**` is byte-identical to the E01 baseline, and invokes the Bundle generator `--check`. It performs no write.

```text
package.json
packages/v2-domain/**
scripts/validate-v2-boundaries.mjs
scripts/verify-e02-worktree.mjs
docs/v2/ARCHITECTURE_RFC.md
docs/v2/INITIAL_EPIC_MAP.md
docs/v2/INITIATIVE_CHARTER.md
docs/v2/THIRD_PARTY_REUSE_SURVEY.md
docs/v2/epics/E02/**
```

No `.beads/**`, `package-lock.json`, generated `dist/**`, E01 document, or other path is allowed in the engineering candidate. Manifest readback recomputes the generator, source, rendered Markdown/HTML, structured document, four authority-document hashes, every section hash, verification-contract hash, and the E01 PRD/Manifest dependency hashes. It also requires E01 final candidate commit `d5debd4d03114a80a45b14ccdb7439b944d6461d` as the implementation baseline; a later governed integration disposition must regenerate and reconfirm this Bundle.

The final E02 evidence records exact argv, exit code, tool versions, output hash/tail, test counts, type-test result, changed paths, export allowlist, canonical fixture bytes, zero-side-effect counters, Bundle readback, authority/section hashes, and E01 freeze confirmation. Before implementation exists, unavailable engineering commands are reported as preflight-only; no unavailable command is counted as an engineering pass.

## 8. Dependencies, stop boundary, and risks

- **Dependencies:** E01 workspace/package boundary and engineering-complete delivery branch; E02 implementation is based on exact E01 final candidate `d5debd4d03114a80a45b14ccdb7439b944d6461d` unless a later governed integration disposition supersedes it.
- **Downstream handoff:** E10 and E20 consume the E02-owned Runtime identity seams; E70, E73, E76, E77, and E79 consume the applicable domain-kernel contracts; E03 consumes the complete domain contract only after E83.
- **Stop boundary:** one pure package and its tests; no persistence schema, process, broker, network, VCS, Beads, or external resource may exist. Reverting E02 requires no migration or compensation.
- **Risk — identity drift:** later Epics might reintroduce a generic attempt identity. Mitigation: the four distinct branded IDs and no-generic-name rule are acceptance criteria and RFC/Map contract.
- **Risk — authority leakage:** later owners might add lifecycle fields to hierarchy records. Mitigation: only E02 owns identity/revision/parent/repository invariants; each later family has one owner in RFC-ADR-029 and the map.
- **Risk — non-deterministic helpers:** hidden clocks or insertion order could alter hashes. Mitigation: caller-supplied scalars, canonical ordering, and environment-independent tests.
- **Open decisions:** none. This draft has no unresolved product decision; any conflict with an approved higher-level authority blocks approval rather than being decided here.

## 9. Approval posture

This `draft-v3` PRD remains **DRAFT / NOT APPROVED / INELIGIBLE**. The earlier human approval and Manifest confirmation bind only the historical `draft-v2` source and its old authority documents; they do not approve this refinement. The regenerated candidate Bundle must identify itself as `candidate / pending-human-confirmation`, not `approved`. Engineering remains fail-closed until the user confirms its exact Manifest hash, Beads write/readback succeeds, and Readiness returns `READY`.
