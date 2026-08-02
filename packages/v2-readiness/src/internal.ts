import { createHash } from "node:crypto";

import {
  canonicalizeJson,
  parseScalar,
  type JsonValue,
  type ScalarByKind,
  type ScalarKind,
} from "@pi-workflow/v2-domain";

import type {
  ReadinessRejectionCode,
  ReadinessRejectionReason,
  ReadinessResult,
  Sha256Digest,
} from "./types.js";

export type ObjectFields = ReadonlyMap<string, PropertyDescriptor>;

export function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function childPath(path: string, token: string): string {
  return `${path}/${escapePointerToken(token)}`;
}

export function reject<T = never>(
  code: ReadinessRejectionCode,
  path: string,
  reason: ReadinessRejectionReason,
  relatedRef: string | null = null,
): ReadinessResult<T> {
  return Object.freeze({
    ok: false,
    rejection: Object.freeze({ code, path, reason, relatedRef }),
  });
}

export function accept<T>(value: T): ReadinessResult<T> {
  return Object.freeze({ ok: true, value });
}

export function remapRejection<T>(
  result: ReadinessResult<T>,
  code: ReadinessRejectionCode,
): ReadinessResult<T> {
  return result.ok
    ? result
    : reject(
        code,
        result.rejection.path,
        result.rejection.reason,
        result.rejection.relatedRef,
      );
}

export function inspectExactObject(
  value: unknown,
  expectedFields: readonly string[],
  code: ReadinessRejectionCode,
  path: string,
): ReadinessResult<ObjectFields> {
  if (value === null || typeof value !== "object") {
    return reject(code, path, "plain_object");
  }
  let prototype: object | null;
  let symbols: symbol[];
  let ownNames: string[];
  try {
    if (Array.isArray(value)) return reject(code, path, "plain_object");
    prototype = Object.getPrototypeOf(value);
    symbols = Object.getOwnPropertySymbols(value);
    ownNames = Object.getOwnPropertyNames(value);
  } catch {
    return reject(code, path, "plain_object");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return reject(code, path, "plain_object");
  }
  if (symbols.length > 0) {
    return reject(code, path, "symbol_key");
  }

  const expected = new Set(expectedFields);
  const descriptors = new Map<string, PropertyDescriptor>();
  try {
    for (const name of ownNames) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined) return reject(code, path, "plain_object");
      descriptors.set(name, descriptor);
    }
  } catch {
    return reject(code, path, "plain_object");
  }

  const candidates = new Set([...ownNames, ...expectedFields]);
  for (const name of [...candidates].sort(compareUtf16)) {
    const descriptor = descriptors.get(name);
    if (descriptor !== undefined && !("value" in descriptor)) {
      return reject(code, childPath(path, name), "accessor");
    }
    if (!expected.has(name) || descriptor === undefined) {
      return reject(code, childPath(path, name), "exact_fields");
    }
  }

  return accept(descriptors);
}

export function field(fields: ObjectFields, name: string): unknown {
  return fields.get(name)?.value;
}

export function inspectExactArray(
  value: unknown,
  code: ReadinessRejectionCode,
  path: string,
): ReadinessResult<readonly unknown[]> {
  let isArray: boolean;
  let prototype: object | null;
  let symbols: symbol[];
  let descriptors: Record<string, PropertyDescriptor>;
  let ownNames: string[];
  try {
    isArray = Array.isArray(value);
    prototype = isArray ? Object.getPrototypeOf(value) : null;
    symbols = isArray ? Object.getOwnPropertySymbols(value) : [];
    descriptors = isArray ? Object.getOwnPropertyDescriptors(value) : {};
    ownNames = isArray ? Object.getOwnPropertyNames(value) : [];
  } catch {
    return reject(code, path, "invalid_scalar");
  }
  if (!isArray || prototype !== Array.prototype) {
    return reject(code, path, "invalid_scalar");
  }
  if (symbols.length > 0) {
    return reject(code, path, "symbol_key");
  }

  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
    return reject(code, childPath(path, "length"), "accessor");
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    return reject(code, childPath(path, "length"), "invalid_scalar");
  }
  for (const name of [...ownNames].sort(compareUtf16)) {
    const descriptor = descriptors[name];
    if (descriptor !== undefined && !("value" in descriptor)) {
      return reject(code, childPath(path, name), "accessor");
    }
    if (name === "length") continue;
    if (!/^(0|[1-9][0-9]*)$/.test(name) || Number(name) >= length) {
      return reject(code, childPath(path, name), "exact_fields");
    }
  }
  if (ownNames.length !== length + 1) {
    if (length <= ownNames.length + 1_024) {
      for (let index = 0; index < length; index += 1) {
        if (descriptors[String(index)] === undefined) {
          return reject(code, childPath(path, String(index)), "exact_fields");
        }
      }
    }
    return reject(code, path, "exact_fields");
  }

  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    copy.push((descriptor as PropertyDescriptor & { value: unknown }).value);
  }
  return accept(copy);
}

export function validateDomainScalar<K extends ScalarKind>(
  kind: K,
  value: unknown,
  code: ReadinessRejectionCode,
  path: string,
): ReadinessResult<ScalarByKind[K]> {
  const parsed = parseScalar(kind, value);
  return parsed.ok ? accept(parsed.value) : reject(code, path, "invalid_scalar");
}

export function validateSha256(
  value: unknown,
  code: ReadinessRejectionCode,
  path: string,
): ReadinessResult<Sha256Digest> {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    ? accept(value)
    : reject(code, path, "invalid_sha256");
}

export function validateSourceRevision(
  value: unknown,
  code: ReadinessRejectionCode,
  path: string,
): ReadinessResult<string> {
  return typeof value === "string" && value.length > 0
    ? accept(value)
    : reject(code, path, "invalid_source_revision");
}

export function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  code: ReadinessRejectionCode,
  path: string,
): ReadinessResult<T> {
  return typeof value === "string" && allowed.includes(value as T)
    ? accept(value as T)
    : reject(code, path, "invalid_enum");
}

export function validatePositiveSafeInteger(
  value: unknown,
  code: ReadinessRejectionCode,
  path: string,
): ReadinessResult<number> {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? accept(value)
    : reject(code, path, "invalid_safe_integer");
}

function canonicalReason(
  reason: string,
): ReadinessRejectionReason {
  switch (reason) {
    case "non_plain_object":
      return "plain_object";
    case "symbol_key":
      return "symbol_key";
    case "accessor":
      return "accessor";
    default:
      return "invalid_scalar";
  }
}

export type CanonicalHash<T> = Readonly<{
  value: T;
  text: string;
  digest: Sha256Digest;
}>;

export function canonicalHash<T>(
  value: T,
  code: ReadinessRejectionCode,
  path = "",
): ReadinessResult<CanonicalHash<T>> {
  const canonical = canonicalizeJson(value as unknown as JsonValue);
  if (!canonical.ok) {
    const rejectionPath = canonical.rejection.path === ""
      ? path
      : `${path}${canonical.rejection.path}`;
    return reject(code, rejectionPath, canonicalReason(canonical.rejection.reason));
  }
  const digest = createHash("sha256")
    .update(canonical.text, "utf8")
    .digest("hex") as Sha256Digest;
  return accept(Object.freeze({
    value: canonical.value as unknown as T,
    text: canonical.text,
    digest,
  }));
}

export function hashCanonical(
  value: unknown,
  code: ReadinessRejectionCode = "invalid_input",
  path = "",
): ReadinessResult<Sha256Digest> {
  const canonical = canonicalHash(value, code, path);
  return canonical.ok ? accept(canonical.value.digest) : canonical;
}

export function deepFreezeCopy<T>(
  value: T,
  code: ReadinessRejectionCode = "invalid_input",
  path = "",
): ReadinessResult<T> {
  const canonical = canonicalHash(value, code, path);
  return canonical.ok ? accept(canonical.value.value) : canonical;
}

export function validateUniqueSortedStrings(
  value: unknown,
  scalarKind: Extract<ScalarKind, "EvidenceRef">,
  code: ReadinessRejectionCode,
  path: string,
  requireNonEmpty: boolean,
): ReadinessResult<readonly string[]> {
  const inspected = inspectExactArray(value, code, path);
  if (!inspected.ok) {
    return inspected;
  }
  if (requireNonEmpty && inspected.value.length === 0) {
    return reject(code, path, "invalid_scalar");
  }

  const parsed: string[] = [];
  for (let index = 0; index < inspected.value.length; index += 1) {
    const item = validateDomainScalar(
      scalarKind,
      inspected.value[index],
      code,
      childPath(path, String(index)),
    );
    if (!item.ok) {
      return item;
    }
    parsed.push(item.value);
  }
  const sorted = [...parsed].sort(compareUtf16);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) {
      return reject(code, path, "duplicate_entry", sorted[index] ?? null);
    }
  }
  return accept(Object.freeze(sorted));
}
