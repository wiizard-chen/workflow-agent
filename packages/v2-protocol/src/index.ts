import { createHash } from "node:crypto";
import {
  canonicalizeJson,
  type JsonValue,
  type Revision,
} from "@pi-workflow/v2-domain";
import { Type, type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";

export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type MessageKind = "command" | "query" | "event";
export type SchemaVersion = number & { readonly __schemaVersion: unique symbol };
export type SchemaId = string & { readonly __schemaId: unique symbol };

export type ProtocolResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; rejection: ProtocolRejection }>;

export type ProtocolRejectionCode =
  | "invalid_envelope"
  | "invalid_protocol_version"
  | "invalid_schema_tuple"
  | "unknown_schema"
  | "invalid_payload"
  | "missing_aggregate_revision"
  | "invalid_principal"
  | "invalid_human_presence_grant"
  | "grant_not_allowed"
  | "grant_binding_mismatch"
  | "duplicate_schema"
  | "invalid_schema"
  | "registry_error";

export type ProtocolRejection = Readonly<{
  code: ProtocolRejectionCode;
  path?: string;
  detail?: string;
}>;

function reject(
  code: ProtocolRejectionCode,
  path?: string,
  detail?: string,
): ProtocolResult<never> {
  return Object.freeze({
    ok: false as const,
    rejection: Object.freeze({ code, ...(path ? { path } : {}), ...(detail ? { detail } : {}) }),
  });
}

function success<T>(value: T): ProtocolResult<T> {
  return Object.freeze({ ok: true as const, value });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

type ExactObjectResult =
  | Readonly<{ ok: true; values: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; path: string; detail: string }>;

function readExactObject(value: unknown, keys: readonly string[]): ExactObjectResult {
  if (!isPlainObject(value)) return { ok: false, path: "[root]", detail: "plain_object" };
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return { ok: false, path: "[symbol]", detail: "symbol_key" };
    }
    const descriptors = Object.getOwnPropertyNames(value).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(value, key),
    ] as const);
    const allowed = new Set(keys);
    for (const [key, descriptor] of descriptors) {
      if (!descriptor || !("value" in descriptor)) {
        return { ok: false, path: key, detail: "accessor" };
      }
      if (!allowed.has(key)) return { ok: false, path: key, detail: "unknown_field" };
    }
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        return { ok: false, path: key, detail: "missing_field" };
      }
    }
    return {
      ok: true,
      values: Object.freeze(Object.fromEntries(
        descriptors.map(([key, descriptor]) => [key, (descriptor as PropertyDescriptor).value]),
      )),
    };
  } catch {
    return { ok: false, path: "[root]", detail: "unreadable_object" };
  }
}

function readObjectWithOptional(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): ExactObjectResult {
  if (!isPlainObject(value)) return { ok: false, path: "[root]", detail: "plain_object" };
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return { ok: false, path: "[symbol]", detail: "symbol_key" };
    }
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    const descriptors = Object.getOwnPropertyNames(value).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(value, key),
    ] as const);
    for (const [key, descriptor] of descriptors) {
      if (!descriptor || !("value" in descriptor)) return { ok: false, path: key, detail: "accessor" };
      if (!allowed.has(key)) return { ok: false, path: key, detail: "unknown_field" };
    }
    for (const key of requiredKeys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return { ok: false, path: key, detail: "missing_field" };
    }
    return {
      ok: true,
      values: Object.freeze(Object.fromEntries(
        descriptors.map(([key, descriptor]) => [key, (descriptor as PropertyDescriptor).value]),
      )),
    };
  } catch {
    return { ok: false, path: "[root]", detail: "unreadable_object" };
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function schemaVersion(value: unknown): value is SchemaVersion {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function canonicalCopy(value: unknown): ProtocolResult<JsonValue> {
  try {
    const result = canonicalizeJson(value as JsonValue);
    if (!result.ok) return reject("invalid_payload", result.rejection.path, result.rejection.reason);
    return success(result.value);
  } catch {
    return reject("invalid_payload", "[root]", "unreadable_value");
  }
}

export type AggregateRef = Readonly<{
  type: string;
  id: string;
  expectedRevision: Revision;
}>;

export type ServerPrincipalContext = Readonly<{
  kind:
    | "human-interactive-client"
    | "product-agent"
    | "engineering-worker"
    | "scheduler"
    | "github-reconciler"
    | "release-adapter"
    | "system-recovery";
  principalId: string;
  connectionId: string;
  connectionGeneration: number;
  daemonEpoch: string;
  capabilityRefs: readonly string[];
}>;

export type VerifiedHumanPresenceGrant = Readonly<{
  ref: string;
  principalId: string;
  connectionId: string;
  connectionGeneration: number;
  daemonEpoch: string;
  expiresAt: string;
  nonce: string;
}>;

type CommonIntentFields = Readonly<{
  protocolVersion: ProtocolVersion;
  schemaId: SchemaId;
  schemaVersion: SchemaVersion;
  payload: unknown;
  correlationId: string;
  aggregate?: AggregateRef;
  humanPresenceGrantRef?: string;
}>;

export type CommandIntent = CommonIntentFields & Readonly<{ commandId: string }>;
export type QueryIntent = CommonIntentFields & Readonly<{ queryId: string }>;

export type AcceptedCommandEnvelope = Readonly<{
  kind: "command";
  protocolVersion: ProtocolVersion;
  commandId: string;
  schemaId: SchemaId;
  schemaVersion: SchemaVersion;
  payload: JsonValue;
  correlationId: string;
  aggregate?: AggregateRef;
  principal: ServerPrincipalContext;
  humanPresenceGrant?: VerifiedHumanPresenceGrant;
}>;

export type AcceptedQueryEnvelope = Readonly<{
  kind: "query";
  protocolVersion: ProtocolVersion;
  queryId: string;
  schemaId: SchemaId;
  schemaVersion: SchemaVersion;
  payload: JsonValue;
  correlationId: string;
  aggregate?: AggregateRef;
  principal: ServerPrincipalContext;
  humanPresenceGrant?: VerifiedHumanPresenceGrant;
}>;

export type EventEnvelope = Readonly<{
  kind: "event";
  protocolVersion: ProtocolVersion;
  eventId: string;
  schemaId: SchemaId;
  schemaVersion: SchemaVersion;
  payload: JsonValue;
  correlationId: string;
  causationId: string;
  aggregate: Readonly<{ type: string; id: string; sequence: number }>;
  principal: ServerPrincipalContext;
  occurredAt: string;
}>;

export type SchemaDefinition = Readonly<{
  schemaId: SchemaId;
  schemaVersion: SchemaVersion;
  messageKind: MessageKind;
  payloadSchema: TSchema;
  requiresAggregateRevision: boolean;
  requiresHumanPresenceGrant: boolean;
}>;

export type SchemaRegistry = Readonly<{
  readonly manifest: readonly SchemaDefinition[];
  readonly manifestHash: string;
  resolve(
    messageKind: MessageKind,
    schemaId: string,
    schemaVersion: number,
  ): ProtocolResult<SchemaDefinition>;
  validatePayload(
    messageKind: MessageKind,
    schemaId: string,
    schemaVersion: number,
    payload: unknown,
  ): ProtocolResult<JsonValue>;
}>;

type CompiledDefinition = SchemaDefinition & Readonly<{ validator: { Check(value: unknown): boolean } }>;

// Accepted envelopes are authority-bearing runtime values, not merely TypeScript
// shapes.  The WeakSet brand prevents a caller from forging one by copying the
// enumerable fields into a plain object before a Runtime write.
const acceptedCommandValues = new WeakSet<object>();

const SCHEMA_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

const JSON_SCHEMA_TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const JSON_SCHEMA_KEYS = new Set([
  "$schema", "$id", "$anchor", "$ref", "$dynamicRef", "$dynamicAnchor", "$comment",
  "$defs", "definitions", "type", "enum", "const", "not", "allOf", "anyOf", "oneOf",
  "if", "then", "else", "properties", "patternProperties", "additionalProperties",
  "unevaluatedProperties", "required", "dependentRequired", "dependentSchemas", "propertyNames",
  "items", "prefixItems", "additionalItems", "contains", "minContains", "maxContains",
  "minProperties", "maxProperties", "minItems", "maxItems", "uniqueItems", "minLength",
  "maxLength", "pattern", "format", "contentEncoding", "contentMediaType", "minimum",
  "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "min", "max",
  "title", "description", "default", "examples", "readOnly", "writeOnly", "deprecated",
  // TypeBox keeps these metadata properties as non-enumerable own fields. They
  // survive our descriptor-safe canonical copy and are harmless to JSON Schema
  // validation, but arbitrary `~*` metadata must remain rejected.
  "~kind", "~optional", "~readonly",
]);

function schemaNumber(value: unknown, positive = false): boolean {
  return typeof value === "number" && Number.isFinite(value) && (!positive || value > 0);
}

function schemaInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function schemaStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") &&
    new Set(value).size === value.length;
}

function schemaMap(value: unknown): boolean {
  return isPlainObject(value) && Object.keys(value).every((key) => isValidSchema((value as Record<string, unknown>)[key]));
}

function schemaArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => isValidSchema(entry));
}

function isValidSchema(value: unknown): boolean {
  // JSON Schema permits boolean schemas. TypeBox Any/Unknown are represented
  // by an empty object, which is also valid and intentionally retained.
  if (typeof value === "boolean") return true;
  if (!isPlainObject(value)) return false;
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return false;
  }
  if (keys.some((key) => !JSON_SCHEMA_KEYS.has(key))) return false;
  const schema = value as Record<string, unknown>;
  if (schema.type !== undefined) {
    const validType = typeof schema.type === "string"
      ? JSON_SCHEMA_TYPES.has(schema.type)
      : Array.isArray(schema.type) && schema.type.length > 0 && schema.type.every((entry) => typeof entry === "string" && JSON_SCHEMA_TYPES.has(entry)) && new Set(schema.type).size === schema.type.length;
    if (!validType) return false;
  }
  if (schema.$schema !== undefined && typeof schema.$schema !== "string") return false;
  if (schema["~kind"] !== undefined && typeof schema["~kind"] !== "string") return false;
  if (schema["~optional"] !== undefined && typeof schema["~optional"] !== "boolean") return false;
  if (schema["~readonly"] !== undefined && typeof schema["~readonly"] !== "boolean") return false;
  for (const key of ["$id", "$anchor", "$ref", "$dynamicRef", "$dynamicAnchor", "$comment", "title", "description", "default", "format", "pattern", "contentEncoding", "contentMediaType"]) {
    if (schema[key] !== undefined && ["$id", "$anchor", "$ref", "$dynamicRef", "$dynamicAnchor", "$comment", "title", "description", "format", "pattern", "contentEncoding", "contentMediaType"].includes(key) && typeof schema[key] !== "string") return false;
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (schema[key] !== undefined && !schemaArray(schema[key])) return false;
  }
  for (const key of ["not", "if", "then", "else", "contains", "propertyNames", "additionalItems", "unevaluatedProperties"]) {
    if (schema[key] !== undefined && !isValidSchema(schema[key]) && typeof schema[key] !== "boolean") return false;
  }
  for (const key of ["$defs", "definitions", "properties", "patternProperties", "dependentSchemas"]) {
    if (schema[key] !== undefined && !schemaMap(schema[key])) return false;
  }
  if (schema.required !== undefined && !schemaStringArray(schema.required)) return false;
  if (schema.dependentRequired !== undefined &&
      (!isPlainObject(schema.dependentRequired) ||
       Object.values(schema.dependentRequired).some((required) => !schemaStringArray(required)))) return false;
  for (const key of ["additionalProperties", "unevaluatedProperties"]) {
    if (schema[key] !== undefined && typeof schema[key] !== "boolean" && !isValidSchema(schema[key])) return false;
  }
  if (schema.items !== undefined && !isValidSchema(schema.items) && !schemaArray(schema.items)) return false;
  if (schema.prefixItems !== undefined && !schemaArray(schema.prefixItems)) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) return false;
  if (schema.examples !== undefined && !Array.isArray(schema.examples)) return false;
  for (const key of ["additionalProperties", "unevaluatedProperties", "uniqueItems", "readOnly", "writeOnly", "deprecated"]) {
    if (schema[key] !== undefined && typeof schema[key] !== "boolean" && !["additionalProperties", "unevaluatedProperties"].includes(key)) return false;
  }
  for (const key of ["minProperties", "maxProperties", "minItems", "maxItems", "minLength", "maxLength", "minContains", "maxContains"]) {
    if (schema[key] !== undefined && !schemaInteger(schema[key])) return false;
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "min", "max"]) {
    if (schema[key] !== undefined && !schemaNumber(schema[key], key === "multipleOf")) return false;
  }
  return true;
}

function tupleKey(kind: MessageKind, schemaId: string, version: number): string {
  return `${kind}\u0000${schemaId}\u0000${version}`;
}

function freezeDefinition(definition: SchemaDefinition, validator: CompiledDefinition["validator"]): CompiledDefinition {
  return Object.freeze({
    ...definition,
    validator,
  });
}

function publicDefinition(definition: CompiledDefinition): SchemaDefinition {
  const { validator: _validator, ...publicValue } = definition;
  return Object.freeze(publicValue);
}

export function createSchemaRegistry(
  definitions: readonly SchemaDefinition[],
): ProtocolResult<SchemaRegistry> {
  try {
    const seen = new Set<string>();
    const compiled: CompiledDefinition[] = [];
    for (const definition of definitions) {
      const exact = readExactObject(definition, [
        "schemaId", "schemaVersion", "messageKind", "payloadSchema",
        "requiresAggregateRevision", "requiresHumanPresenceGrant",
      ]);
      if (!exact.ok) {
        return reject("invalid_schema", `definition${exact.path === "[root]" ? "" : `.${exact.path}`}`, exact.detail);
      }
      const {
        schemaId,
        schemaVersion: version,
        messageKind,
        payloadSchema,
        requiresAggregateRevision,
        requiresHumanPresenceGrant,
      } = exact.values;
      if (typeof schemaId !== "string" || !SCHEMA_ID_PATTERN.test(schemaId) ||
          !schemaVersion(version) ||
          !["command", "query", "event"].includes(messageKind as string) ||
          typeof requiresAggregateRevision !== "boolean" ||
          typeof requiresHumanPresenceGrant !== "boolean") {
        return reject("invalid_schema", "definition", "invalid_descriptor");
      }
      // Canonicalize before compiling. TypeBox's compiler may read schema
      // properties; compiling the caller's object first would run getters or
      // Proxy traps before the runtime boundary has rejected them.
      const canonicalSchema = canonicalCopy(payloadSchema);
      if (!canonicalSchema.ok) return reject("invalid_schema", "payloadSchema", "non_canonical_schema");
      if (!isValidSchema(canonicalSchema.value)) return reject("invalid_schema", "payloadSchema", "invalid_json_schema");
      let validator: CompiledDefinition["validator"];
      try {
        validator = Compile(canonicalSchema.value as TSchema);
      } catch {
        return reject("invalid_schema", "payloadSchema", "schema_compile_failed");
      }
      const key = tupleKey(messageKind as MessageKind, schemaId, version);
      if (seen.has(key)) return reject("duplicate_schema", "definition", key);
      seen.add(key);
      compiled.push(freezeDefinition(Object.freeze({
        schemaId: schemaId as SchemaId,
        schemaVersion: version,
        messageKind: messageKind as MessageKind,
        payloadSchema: canonicalSchema.value as TSchema,
        requiresAggregateRevision,
        requiresHumanPresenceGrant,
      }), validator));
    }
    compiled.sort((left, right) => {
      const leftKey = tupleKey(left.messageKind, left.schemaId, left.schemaVersion);
      const rightKey = tupleKey(right.messageKind, right.schemaId, right.schemaVersion);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const manifest = Object.freeze(compiled.map(publicDefinition));
    const manifestJson = canonicalizeJson(manifest as unknown as JsonValue);
    if (!manifestJson.ok) return reject("registry_error", "manifest", "canonicalization_failed");
    const manifestHash = createHash("sha256").update(manifestJson.text, "utf8").digest("hex");
    const byKey = new Map(compiled.map((definition) => [
      tupleKey(definition.messageKind, definition.schemaId, definition.schemaVersion),
      definition,
    ]));
    const registry: SchemaRegistry = Object.freeze({
      manifest,
      manifestHash,
      resolve(messageKind, schemaId, version) {
        if (!["command", "query", "event"].includes(messageKind) ||
            typeof schemaId !== "string" || !SCHEMA_ID_PATTERN.test(schemaId) || !schemaVersion(version)) {
          return reject("invalid_schema_tuple", "schema", "invalid_exact_tuple");
        }
        const found = byKey.get(tupleKey(messageKind, schemaId, version));
        return found ? success(publicDefinition(found)) : reject("unknown_schema", "schema", tupleKey(messageKind, schemaId, version));
      },
      validatePayload(messageKind, schemaId, version, payload) {
        if (!["command", "query", "event"].includes(messageKind) ||
            typeof schemaId !== "string" || !SCHEMA_ID_PATTERN.test(schemaId) || !schemaVersion(version)) {
          return reject("invalid_schema_tuple", "schema", "invalid_exact_tuple");
        }
        const found = byKey.get(tupleKey(messageKind, schemaId, version));
        if (!found) return reject("unknown_schema", "schema", tupleKey(messageKind, schemaId, version));
        const copied = canonicalCopy(payload);
        if (!copied.ok) return copied;
        try {
          return found.validator.Check(copied.value)
            ? copied
            : reject("invalid_payload", "payload", "schema_validation_failed");
        } catch {
          return reject("invalid_payload", "payload", "schema_validation_failed");
        }
      },
    });
    return success(registry);
  } catch {
    return reject("invalid_schema", "definition", "schema_compile_failed");
  }
}

function protocolVersion(value: unknown): value is ProtocolVersion {
  return value === PROTOCOL_VERSION;
}

function validateAggregate(value: unknown): ProtocolResult<AggregateRef> {
  const exact = readExactObject(value, ["type", "id", "expectedRevision"]);
  if (!exact.ok) return reject("invalid_envelope", exact.path, exact.detail);
  const { type, id, expectedRevision } = exact.values;
  if (!nonEmptyString(type) || !nonEmptyString(id) || typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return reject("invalid_envelope", "aggregate", "invalid_aggregate");
  }
  return success(Object.freeze({ type, id, expectedRevision: expectedRevision as Revision }));
}

function validatePrincipal(value: unknown): ProtocolResult<ServerPrincipalContext> {
  const exact = readExactObject(value, ["kind", "principalId", "connectionId", "connectionGeneration", "daemonEpoch", "capabilityRefs"]);
  if (!exact.ok) return reject("invalid_principal", exact.path, exact.detail);
  const { kind, principalId, connectionId, connectionGeneration, daemonEpoch, capabilityRefs } = exact.values;
  if (!["human-interactive-client", "product-agent", "engineering-worker", "scheduler",
    "github-reconciler", "release-adapter", "system-recovery"].includes(kind as string) ||
      !nonEmptyString(principalId) || !nonEmptyString(connectionId) ||
      !Number.isSafeInteger(connectionGeneration) || (connectionGeneration as number) <= 0 ||
      !nonEmptyString(daemonEpoch)) {
    return reject("invalid_principal", "principal", "invalid_server_context");
  }
  // Normalize the capability list through the same defensive canonicalizer
  // used for payloads. Calling `.some` or spreading an attacker-controlled
  // Proxy (or sparse array) directly can execute traps, throw, or silently
  // fill holes.
  const normalizedRefs = canonicalCopy(capabilityRefs);
  if (!normalizedRefs.ok || !Array.isArray(normalizedRefs.value) ||
      normalizedRefs.value.some((ref) => !nonEmptyString(ref))) {
    return reject("invalid_principal", "principal.capabilityRefs", "invalid_capability_refs");
  }
  return success(Object.freeze({
    kind: kind as ServerPrincipalContext["kind"],
    principalId,
    connectionId,
    connectionGeneration: connectionGeneration as number,
    daemonEpoch,
    capabilityRefs: Object.freeze([...normalizedRefs.value] as string[]),
  }));
}

function validateGrant(value: unknown): ProtocolResult<VerifiedHumanPresenceGrant> {
  const exact = readExactObject(value, ["ref", "principalId", "connectionId", "connectionGeneration", "daemonEpoch", "expiresAt", "nonce"]);
  if (!exact.ok) return reject("invalid_human_presence_grant", exact.path, exact.detail);
  const { ref, principalId, connectionId, connectionGeneration, daemonEpoch, expiresAt, nonce } = exact.values;
  if (![ref, principalId, connectionId, daemonEpoch, expiresAt, nonce].every(nonEmptyString) ||
      !Number.isSafeInteger(connectionGeneration) || (connectionGeneration as number) <= 0) {
    return reject("invalid_human_presence_grant", "humanPresenceGrant", "invalid_verified_grant");
  }
  return success(Object.freeze({
    ref: ref as string,
    principalId: principalId as string,
    connectionId: connectionId as string,
    connectionGeneration: connectionGeneration as number,
    daemonEpoch: daemonEpoch as string,
    expiresAt: expiresAt as string,
    nonce: nonce as string,
  }));
}

function validateIntentBase(
  registry: SchemaRegistry,
  input: unknown,
  kind: "command" | "query",
): ProtocolResult<Readonly<{ identity: string; schemaId: SchemaId; schemaVersion: SchemaVersion; payload: JsonValue; correlationId: string; aggregate?: AggregateRef; humanPresenceGrantRef?: string }>> {
  const exact = readObjectWithOptional(
    input,
    kind === "command"
      ? ["protocolVersion", "commandId", "schemaId", "schemaVersion", "payload", "correlationId"]
      : ["protocolVersion", "queryId", "schemaId", "schemaVersion", "payload", "correlationId"],
    ["aggregate", "humanPresenceGrantRef"],
  );
  if (!exact.ok) return reject("invalid_envelope", exact.path, exact.detail);
  const values = exact.values;
  const identity = values[kind === "command" ? "commandId" : "queryId"];
  if (!nonEmptyString(identity) || !protocolVersion(values.protocolVersion) ||
      typeof values.schemaId !== "string" || !SCHEMA_ID_PATTERN.test(values.schemaId) || !schemaVersion(values.schemaVersion) ||
      !nonEmptyString(values.correlationId) ||
      (values.humanPresenceGrantRef !== undefined && !nonEmptyString(values.humanPresenceGrantRef))) {
    return reject("invalid_envelope", "[root]", "invalid_identity_or_version");
  }
  const aggregate = values.aggregate === undefined ? success<AggregateRef | undefined>(undefined) : validateAggregate(values.aggregate);
  if (!aggregate.ok) return aggregate;
  const payload = registry.validatePayload(kind, values.schemaId as string, values.schemaVersion as number, values.payload);
  if (!payload.ok) return payload;
  return success(Object.freeze({
    identity,
    schemaId: values.schemaId as SchemaId,
    schemaVersion: values.schemaVersion as SchemaVersion,
    payload: payload.value,
    correlationId: values.correlationId,
    ...(aggregate.value ? { aggregate: aggregate.value } : {}),
    ...(values.humanPresenceGrantRef !== undefined ? { humanPresenceGrantRef: values.humanPresenceGrantRef } : {}),
  }));
}

function acceptIntent(
  registry: SchemaRegistry,
  input: unknown,
  kind: "command" | "query",
  principalInput: unknown,
  grantInput: unknown,
): ProtocolResult<AcceptedCommandEnvelope | AcceptedQueryEnvelope> {
  const base = validateIntentBase(registry, input, kind);
  if (!base.ok) return base;
  const resolved = registry.resolve(kind, base.value.schemaId, base.value.schemaVersion);
  if (!resolved.ok) return resolved;
  const descriptor = resolved.value;
  if (descriptor.requiresAggregateRevision && !base.value.aggregate) {
    return reject("missing_aggregate_revision", "aggregate.expectedRevision", "required");
  }
  if (!descriptor.requiresAggregateRevision && base.value.aggregate === undefined) {
    // Queries and descriptors without a revision gate may omit aggregate data.
  }
  const principal = validatePrincipal(principalInput);
  if (!principal.ok) return principal;
  let grant: VerifiedHumanPresenceGrant | undefined;
  if (grantInput !== undefined) {
    const parsed = validateGrant(grantInput);
    if (!parsed.ok) return parsed;
    grant = parsed.value;
  }
  if (descriptor.requiresHumanPresenceGrant && (!grant || !base.value.humanPresenceGrantRef)) {
    return reject("invalid_human_presence_grant", "humanPresenceGrant", "required");
  }
  if (grant && principal.value.kind !== "human-interactive-client") {
    return reject("grant_not_allowed", "humanPresenceGrant", "principal_not_human_interactive");
  }
  if (!descriptor.requiresHumanPresenceGrant && grant) {
    return reject("grant_not_allowed", "humanPresenceGrant", "descriptor_does_not_require_grant");
  }
  if (!descriptor.requiresHumanPresenceGrant && base.value.humanPresenceGrantRef) {
    return reject("grant_not_allowed", "humanPresenceGrantRef", "descriptor_does_not_require_grant");
  }
  if (descriptor.requiresHumanPresenceGrant && grant &&
      (grant.ref !== base.value.humanPresenceGrantRef || grant.principalId !== principal.value.principalId ||
       grant.connectionId !== principal.value.connectionId || grant.connectionGeneration !== principal.value.connectionGeneration ||
       grant.daemonEpoch !== principal.value.daemonEpoch)) {
    return reject("grant_binding_mismatch", "humanPresenceGrant", "server_context_mismatch");
  }
  if (kind === "command") {
    const accepted: AcceptedCommandEnvelope = {
      kind: "command",
      protocolVersion: PROTOCOL_VERSION,
      commandId: base.value.identity,
      schemaId: base.value.schemaId,
      schemaVersion: base.value.schemaVersion,
      payload: base.value.payload,
      correlationId: base.value.correlationId,
      ...(base.value.aggregate ? { aggregate: base.value.aggregate } : {}),
      principal: principal.value,
      ...(grant ? { humanPresenceGrant: grant } : {}),
    };
    const frozen = Object.freeze(accepted);
    acceptedCommandValues.add(frozen);
    return success(frozen);
  }
  const accepted: AcceptedQueryEnvelope = {
    kind: "query",
    protocolVersion: PROTOCOL_VERSION,
    queryId: base.value.identity,
    schemaId: base.value.schemaId,
    schemaVersion: base.value.schemaVersion,
    payload: base.value.payload,
    correlationId: base.value.correlationId,
    ...(base.value.aggregate ? { aggregate: base.value.aggregate } : {}),
    principal: principal.value,
    ...(grant ? { humanPresenceGrant: grant } : {}),
  };
  return success(Object.freeze(accepted));
}

/** Re-validate and require an envelope produced by acceptCommandIntent. */
export function validateAcceptedCommandEnvelope(
  registry: SchemaRegistry,
  input: unknown,
): ProtocolResult<AcceptedCommandEnvelope> {
  if (input === null || typeof input !== "object" || !acceptedCommandValues.has(input)) {
    return reject("invalid_principal", "accepted", "untrusted_server_envelope");
  }
  const exact = readObjectWithOptional(
    input,
    ["kind", "protocolVersion", "commandId", "schemaId", "schemaVersion", "payload", "correlationId", "principal"],
    ["aggregate", "humanPresenceGrant"],
  );
  if (!exact.ok) return reject("invalid_envelope", exact.path, exact.detail);
  const values = exact.values;
  if (values.kind !== "command" || !protocolVersion(values.protocolVersion) || !nonEmptyString(values.commandId) ||
      typeof values.schemaId !== "string" || !SCHEMA_ID_PATTERN.test(values.schemaId) || !schemaVersion(values.schemaVersion) ||
      !nonEmptyString(values.correlationId)) return reject("invalid_envelope", "accepted", "invalid_command_identity");
  const schema = registry.resolve("command", values.schemaId, values.schemaVersion);
  if (!schema.ok) return schema;
  const payload = registry.validatePayload("command", values.schemaId, values.schemaVersion, values.payload);
  if (!payload.ok) return payload;
  const principal = validatePrincipal(values.principal);
  if (!principal.ok) return principal;
  const aggregate = values.aggregate === undefined ? success<AggregateRef | undefined>(undefined) : validateAggregate(values.aggregate);
  if (!aggregate.ok) return aggregate;
  if (schema.value.requiresAggregateRevision && !aggregate.value) return reject("missing_aggregate_revision", "aggregate.expectedRevision", "required");
  let grant: VerifiedHumanPresenceGrant | undefined;
  if (values.humanPresenceGrant !== undefined) {
    const parsed = validateGrant(values.humanPresenceGrant);
    if (!parsed.ok) return parsed;
    grant = parsed.value;
    if (principal.value.kind !== "human-interactive-client" || grant.principalId !== principal.value.principalId ||
        grant.connectionId !== principal.value.connectionId || grant.connectionGeneration !== principal.value.connectionGeneration ||
        grant.daemonEpoch !== principal.value.daemonEpoch) return reject("grant_binding_mismatch", "humanPresenceGrant", "server_context_mismatch");
  }
  if (schema.value.requiresHumanPresenceGrant && !grant) return reject("invalid_human_presence_grant", "humanPresenceGrant", "required");
  if (!schema.value.requiresHumanPresenceGrant && grant) return reject("grant_not_allowed", "humanPresenceGrant", "descriptor_does_not_require_grant");
  return success(Object.freeze({
    kind: "command",
    protocolVersion: PROTOCOL_VERSION,
    commandId: values.commandId,
    schemaId: values.schemaId as SchemaId,
    schemaVersion: values.schemaVersion as SchemaVersion,
    payload: payload.value,
    correlationId: values.correlationId,
    ...(aggregate.value ? { aggregate: aggregate.value } : {}),
    principal: principal.value,
    ...(grant ? { humanPresenceGrant: grant } : {}),
  }));
}

export function acceptCommandIntent(
  registry: SchemaRegistry,
  input: unknown,
  principal: unknown,
  verifiedGrant?: unknown,
): ProtocolResult<AcceptedCommandEnvelope> {
  const result = acceptIntent(registry, input, "command", principal, verifiedGrant);
  return result.ok ? success(result.value as AcceptedCommandEnvelope) : result;
}

export function acceptQueryIntent(
  registry: SchemaRegistry,
  input: unknown,
  principal: unknown,
  verifiedGrant?: unknown,
): ProtocolResult<AcceptedQueryEnvelope> {
  const result = acceptIntent(registry, input, "query", principal, verifiedGrant);
  return result.ok ? success(result.value as AcceptedQueryEnvelope) : result;
}

export function createEventEnvelope(
  registry: SchemaRegistry,
  input: unknown,
  principalInput: unknown,
): ProtocolResult<EventEnvelope> {
  const exact = readExactObject(input, [
    "protocolVersion", "eventId", "schemaId", "schemaVersion", "payload", "correlationId", "causationId", "aggregate", "occurredAt",
  ]);
  if (!exact.ok) return reject("invalid_envelope", exact.path, exact.detail);
  const values = exact.values;
  if (!protocolVersion(values.protocolVersion) || !nonEmptyString(values.eventId) ||
      typeof values.schemaId !== "string" || !SCHEMA_ID_PATTERN.test(values.schemaId) || !schemaVersion(values.schemaVersion) ||
      !nonEmptyString(values.correlationId) || !nonEmptyString(values.causationId) || !nonEmptyString(values.occurredAt)) {
    return reject("invalid_envelope", "[root]", "invalid_event_identity");
  }
  const aggregate = readExactObject(values.aggregate, ["type", "id", "sequence"]);
  if (!aggregate.ok) return reject("invalid_envelope", `aggregate${aggregate.path === "[root]" ? "" : `.${aggregate.path}`}`, aggregate.detail);
  if (!nonEmptyString(aggregate.values.type) || !nonEmptyString(aggregate.values.id) ||
      typeof aggregate.values.sequence !== "number" || !Number.isSafeInteger(aggregate.values.sequence) ||
      aggregate.values.sequence <= 0) return reject("invalid_envelope", "aggregate", "invalid_sequence");
  const resolved = registry.resolve("event", values.schemaId as string, values.schemaVersion as number);
  if (!resolved.ok) return resolved;
  const payload = registry.validatePayload("event", values.schemaId as string, values.schemaVersion as number, values.payload);
  if (!payload.ok) return payload;
  const principal = validatePrincipal(principalInput);
  if (!principal.ok) return principal;
  return success(Object.freeze({
    kind: "event",
    protocolVersion: PROTOCOL_VERSION,
    eventId: values.eventId,
    schemaId: values.schemaId as SchemaId,
    schemaVersion: values.schemaVersion as SchemaVersion,
    payload: payload.value,
    correlationId: values.correlationId,
    causationId: values.causationId,
    aggregate: Object.freeze({
      type: aggregate.values.type,
      id: aggregate.values.id,
      sequence: aggregate.values.sequence,
    }),
    principal: principal.value,
    occurredAt: values.occurredAt,
  }));
}

const syntheticString = () => Type.String({ minLength: 1 });
const syntheticCatalogDefinitions: readonly SchemaDefinition[] = Object.freeze([
  {
    schemaId: "synthetic.e11.job.start" as SchemaId,
    schemaVersion: 1 as SchemaVersion,
    messageKind: "command",
    payloadSchema: Type.Object({ jobId: syntheticString(), stepId: syntheticString() }, { additionalProperties: false }),
    requiresAggregateRevision: true,
    requiresHumanPresenceGrant: false,
  },
  {
    schemaId: "synthetic.e11.job.read" as SchemaId,
    schemaVersion: 1 as SchemaVersion,
    messageKind: "query",
    payloadSchema: Type.Object({ jobId: syntheticString() }, { additionalProperties: false }),
    requiresAggregateRevision: false,
    requiresHumanPresenceGrant: false,
  },
  {
    schemaId: "synthetic.e11.job.started" as SchemaId,
    schemaVersion: 1 as SchemaVersion,
    messageKind: "event",
    payloadSchema: Type.Object({ jobId: syntheticString(), stepId: syntheticString() }, { additionalProperties: false }),
    requiresAggregateRevision: false,
    requiresHumanPresenceGrant: false,
  },
  {
    schemaId: "synthetic.e11.job.completed" as SchemaId,
    schemaVersion: 1 as SchemaVersion,
    messageKind: "event",
    payloadSchema: Type.Object({ jobId: syntheticString(), stepId: syntheticString(), artifactRef: syntheticString() }, { additionalProperties: false }),
    requiresAggregateRevision: false,
    requiresHumanPresenceGrant: false,
  },
]);

export function createSyntheticE11Registry(): ProtocolResult<SchemaRegistry> {
  return createSchemaRegistry(syntheticCatalogDefinitions);
}

export type SyntheticE11StartPayload = Static<typeof syntheticCatalogDefinitions[0]["payloadSchema"]>;
export type SyntheticE11ReadPayload = Static<typeof syntheticCatalogDefinitions[1]["payloadSchema"]>;
