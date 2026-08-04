import type {
  RuntimeOpenResult,
  RuntimePersistenceRejection,
  RuntimePersistenceRejectionCode,
} from "./types.js";

/**
 * Keep errors data-only.  In particular, never return an exception object or
 * SQL text: both can contain paths, secrets, or driver internals.
 */
export function rejection(
  code: RuntimePersistenceRejectionCode,
  diagnostic: string,
): RuntimePersistenceRejection {
  const safeDiagnostic = diagnostic
    .replaceAll(/[\r\n\t]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return Object.freeze({
    code,
    diagnostic: safeDiagnostic || code,
  });
}
export function reject<T = never>(
  code: RuntimePersistenceRejectionCode,
  diagnostic: string,
): RuntimeOpenResult<T> {
  return Object.freeze({ ok: false as const, rejection: rejection(code, diagnostic) });
}

export function safeDiagnostic(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const name = error.name.replaceAll(/[^A-Za-z0-9_-]/g, "");
  // Error messages are intentionally not returned verbatim.  They frequently
  // contain SQL, absolute paths, or operating-system details.
  if (name === "") return fallback;
  return `${fallback}:${name}`;
}
