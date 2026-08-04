import type {
  AllowlistedResourceLoader,
  WorkerFailureCode,
  WorkerResource,
  WorkerResult,
} from "./types.js";

const MAX_ID_BYTES = 256;
const FORBIDDEN_RESOURCE_ID = /(?:^|[\\/])\.\.?(?:[\\/]|$)|[\0\r\n]/;

function failure<T>(code: WorkerFailureCode, diagnostic: string): WorkerResult<T> {
  return Object.freeze({ ok: false as const, rejection: Object.freeze({ code, diagnostic }) });
}

function success<T>(value: T): WorkerResult<T> {
  return Object.freeze({ ok: true as const, value });
}

function canonicalResource(resource: unknown): WorkerResource | undefined {
  try {
    if (resource === null || typeof resource !== "object" || Array.isArray(resource)) return undefined;
    const prototype = Object.getPrototypeOf(resource);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(resource);
    if (keys.length !== 3 || keys.some((key) => typeof key !== "string" || !["id", "kind", "capabilities"].includes(key))) return undefined;
    const stringKeys = keys as string[];
    const descriptors = Object.fromEntries(stringKeys.map((key) => [key, Object.getOwnPropertyDescriptor(resource, key)]));
    if (Object.values(descriptors).some((descriptor) => !descriptor || !("value" in descriptor))) return undefined;
    const value = Object.fromEntries(stringKeys.map((key) => [key, (descriptors[key] as PropertyDescriptor).value])) as Record<string, unknown>;
    if (typeof value.id !== "string" || value.id.length === 0 || Buffer.byteLength(value.id, "utf8") > MAX_ID_BYTES || FORBIDDEN_RESOURCE_ID.test(value.id) || value.id.startsWith("/") || value.id.includes("\\")) return undefined;
    const capabilities = value.capabilities;
    if (value.kind !== "runtime" || !Array.isArray(capabilities) || Object.getPrototypeOf(capabilities) !== Array.prototype) return undefined;
    const capabilityKeys = Reflect.ownKeys(capabilities);
    if (capabilityKeys.length !== 2 || !capabilityKeys.includes("0") || !capabilityKeys.includes("length")) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(capabilities, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.value !== 1) return undefined;
    const capabilityDescriptor = Object.getOwnPropertyDescriptor(capabilities, "0");
    if (capabilityDescriptor === undefined || !("value" in capabilityDescriptor) || capabilityDescriptor.value !== "diagnostic-read") return undefined;
    return Object.freeze({ id: value.id, kind: "runtime", capabilities: Object.freeze(["diagnostic-read"] as const) });
  } catch {
    return undefined;
  }
}

export function createAllowlistedResourceLoader(resourcesInput: unknown): WorkerResult<AllowlistedResourceLoader> {
  try {
    if (!Array.isArray(resourcesInput) || resourcesInput.length === 0) {
      return failure("resource_denied", "resource_allowlist_invalid");
    }
    const ids = new Set<string>();
    const resources: WorkerResource[] = [];
    for (const input of resourcesInput) {
      const resource = canonicalResource(input);
      if (resource === undefined) return failure("resource_denied", "resource_allowlist_invalid");
      if (ids.has(resource.id)) return failure("resource_denied", "resource_id_duplicate");
      ids.add(resource.id);
      resources.push(resource);
    }
    const frozen = Object.freeze(resources);
    const loader: AllowlistedResourceLoader = Object.freeze({
      list: () => frozen,
      resolve: (resourceId: unknown): WorkerResult<WorkerResource> => {
        if (typeof resourceId !== "string") return failure("resource_denied", "resource_id_invalid");
        const resource = frozen.find((candidate) => candidate.id === resourceId);
        return resource === undefined ? failure("resource_denied", "resource_not_allowlisted") : success(resource);
      },
    });
    return success(loader);
  } catch {
    return failure("resource_denied", "resource_allowlist_invalid");
  }
}
