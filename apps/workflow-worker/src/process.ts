import type { WorkerProcessOptions, WorkerProcessResult, WorkerSnapshot } from "./types.js";

function fallbackSnapshot(): WorkerSnapshot {
  return Object.freeze({ workerId: "unknown", generation: undefined, sessionId: undefined, state: "exited", heartbeatStatus: "none", failure: undefined, lease: undefined });
}

function snapshotOf(host: WorkerProcessOptions["host"]): WorkerSnapshot {
  try { return host.snapshot(); } catch { return fallbackSnapshot(); }
}

function startResultShape(value: unknown): value is { readonly ok: boolean; readonly rejection?: { readonly code?: unknown } } {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const ok = Object.getOwnPropertyDescriptor(value, "ok");
    if (!ok || !("value" in ok) || typeof ok.value !== "boolean") return false;
    if (ok.value) {
      const result = Object.getOwnPropertyDescriptor(value, "value");
      return result !== undefined && "value" in result;
    }
    const rejection = Object.getOwnPropertyDescriptor(value, "rejection");
    if (!rejection || !("value" in rejection) || rejection.value === null || typeof rejection.value !== "object" || Array.isArray(rejection.value)) return false;
    const code = Object.getOwnPropertyDescriptor(rejection.value, "code");
    return code !== undefined && "value" in code && typeof code.value === "string";
  } catch {
    return false;
  }
}

/**
 * Own the lifetime of one worker host. The caller decides how to translate the
 * returned code into process.exitCode; this function never calls exit itself,
 * so abort and persistence can finish deterministically in tests and launchers.
 */
export async function runWorkerProcess(options: WorkerProcessOptions): Promise<WorkerProcessResult> {
  const signalHandlers = options.installSignalHandlers !== false;
  let resolveStop: (reason: string) => void = () => undefined;
  const stopped = new Promise<string>((resolve) => { resolveStop = resolve; });
  const onAbort = (): void => { resolveStop("abort_signal"); };
  const onTerminate = (): void => { resolveStop("signal"); };
  options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (signalHandlers) {
    process.once("SIGINT", onTerminate);
    process.once("SIGTERM", onTerminate);
  }
  const cleanup = (): void => {
    options.abortSignal?.removeEventListener("abort", onAbort);
    if (signalHandlers) {
      process.removeListener("SIGINT", onTerminate);
      process.removeListener("SIGTERM", onTerminate);
    }
  };
  let started: Awaited<ReturnType<WorkerProcessOptions["host"]["start"]>>;
  try {
    started = await options.host.start();
  } catch {
    try { await options.host.close(); } catch { /* preserve stable exit code */ }
    cleanup();
    return Object.freeze({ exitCode: 1, snapshot: snapshotOf(options.host) });
  }
  if (!startResultShape(started)) {
    try { await options.host.close(); } catch { /* preserve stable exit code */ }
    cleanup();
    return Object.freeze({ exitCode: 1, snapshot: snapshotOf(options.host) });
  }
  if (!started.ok) {
    try { await options.host.close(); } catch { /* preserve stable exit code */ }
    cleanup();
    return Object.freeze({ exitCode: started.rejection.code === "lease_required" ? 78 : 1, snapshot: snapshotOf(options.host) });
  }
  const lifecycleTimer = setInterval(() => {
    if (snapshotOf(options.host).state === "exited") resolveStop("host_exited");
  }, 25);
  try {
    const reason = options.abortSignal?.aborted ? "abort_signal" : await stopped;
    try {
      const aborted = await options.host.abort(reason);
      try { await options.host.close(); } catch { return Object.freeze({ exitCode: 1, snapshot: snapshotOf(options.host) }); }
      return Object.freeze({ exitCode: aborted.ok && aborted.value.failure === undefined ? 0 : 1, snapshot: snapshotOf(options.host) });
    } catch {
      try { await options.host.close(); } catch { /* preserve stable exit code */ }
      return Object.freeze({ exitCode: 1, snapshot: snapshotOf(options.host) });
    }
  } finally {
    clearInterval(lifecycleTimer);
    cleanup();
  }
}
