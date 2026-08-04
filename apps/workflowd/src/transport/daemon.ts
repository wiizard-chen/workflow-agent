import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import net, { type Server, type Socket } from "node:net";

import {
  acceptCommandIntent,
  createSyntheticE11Registry,
} from "@pi-workflow/v2-protocol";
import type { JsonValue } from "@pi-workflow/v2-domain";

import {
  openCommandJournal,
  type CommandJournal,
} from "../journal/index.js";
import { FrameDecoder, encodeFrame } from "./framing.js";
import {
  MAX_TRANSPORT_BATCH,
  WORKFLOW_PROTOCOL_VERSION,
  type ConnectionMaterial,
  type DaemonStatus,
  type HandshakeResult,
  type HealthResult,
  type TransportRejection,
  type WorkflowDaemon,
  type WorkflowDaemonOptions,
  type WorkflowResult,
} from "./types.js";

type RecordValue = Readonly<Record<string, unknown>>;
type RequestId = string | number;
type RpcRequest = Readonly<{ readonly id: RequestId; readonly method: string; readonly params?: unknown }>;
type ConnectionState = {
  readonly socket: Socket;
  readonly decoder: FrameDecoder;
  readonly material: ConnectionMaterial;
  handshaken: boolean;
  diagnosticsOnly: boolean;
  subscribed: boolean;
  cursor: number;
  queue: Promise<void>;
};
type SocketIdentity = Readonly<{ readonly dev: number; readonly ino: number }>;

function rejection(code: TransportRejection["code"], diagnostic: string): WorkflowResult<never> {
  return Object.freeze({ ok: false as const, rejection: Object.freeze({ code, diagnostic }) });
}

function success<T>(value: T): WorkflowResult<T> {
  return Object.freeze({ ok: true as const, value });
}

function ownRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): RecordValue | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Object.getOwnPropertyNames(value);
    const symbols = Object.getOwnPropertySymbols(value);
    const allowed = new Set([...required, ...optional]);
    if (symbols.length > 0 || keys.some((key) => !allowed.has(key))) return undefined;
    for (const key of required) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
    }
    return Object.freeze(Object.fromEntries(keys.map((key) => [key, (Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor).value])));
  } catch {
    return undefined;
  }
}

function plainDataObject(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    return Object.getOwnPropertyNames(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && value.length <= 256;
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function requestId(value: unknown): value is RequestId {
  return (typeof value === "string" && nonEmptyString(value)) || safeInteger(value);
}

function validateOptions(input: unknown): WorkflowResult<WorkflowDaemonOptions> {
  const exact = ownRecord(input, ["runtimeRoot", "databasePath", "now"], ["socketPath", "resolvePrincipal"]);
  if (!exact || typeof exact.runtimeRoot !== "string" || !isAbsolute(exact.runtimeRoot) || typeof exact.databasePath !== "string" || !isAbsolute(exact.databasePath) ||
      typeof exact.now !== "function" || (exact.socketPath !== undefined && (typeof exact.socketPath !== "string" || !isAbsolute(exact.socketPath))) ||
      (exact.resolvePrincipal !== undefined && typeof exact.resolvePrincipal !== "function")) return rejection("invalid_options", "daemon_options_invalid");
  const runtimeRoot = resolve(exact.runtimeRoot);
  const databasePath = resolve(exact.databasePath);
  const socketPath = resolve(typeof exact.socketPath === "string" ? exact.socketPath : `${runtimeRoot}/workflowd.sock`);
  const relativeSocket = relative(runtimeRoot, socketPath);
  if (relativeSocket === "" || relativeSocket === ".." || relativeSocket.startsWith(`..${sep}`) || isAbsolute(relativeSocket) || dirname(socketPath) === "/" || socketPath.length > 100) return rejection("socket_path_invalid", "socket_path_outside_runtime_root");
  const base = { runtimeRoot, databasePath, socketPath, now: exact.now as () => number };
  return exact.resolvePrincipal
    ? success(Object.freeze({ ...base, resolvePrincipal: exact.resolvePrincipal as NonNullable<WorkflowDaemonOptions["resolvePrincipal"]> }))
    : success(Object.freeze(base));
}

function statIdentity(path: string): SocketIdentity | undefined {
  try {
    const value = lstatSync(path);
    return Object.freeze({ dev: value.dev, ino: value.ino });
  } catch {
    return undefined;
  }
}

function sameIdentity(left: SocketIdentity, right: SocketIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ownerAndMode(value: Stats): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return (uid === undefined || value.uid === uid) && (value.mode & 0o077) === 0;
}

function prepareSocketPath(path: string): WorkflowResult<true> {
  try {
    const value = lstatSync(path);
    if (!value.isSocket() || value.isSymbolicLink() || value.nlink !== 1 || !ownerAndMode(value)) return rejection("socket_conflict", "existing_socket_identity_rejected");
    unlinkSync(path);
    return success(true as const);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return success(true as const);
    return rejection("socket_permission_denied", "socket_preflight_failed");
  }
}

function verifySocket(path: string): WorkflowResult<SocketIdentity> {
  try {
    const value = lstatSync(path);
    if (!value.isSocket() || value.isSymbolicLink() || value.nlink !== 1 || !ownerAndMode(value)) return rejection("socket_permission_denied", "socket_postflight_failed");
    return success(Object.freeze({ dev: value.dev, ino: value.ino }));
  } catch {
    return rejection("socket_unavailable", "socket_missing_after_listen");
  }
}

function parseRequest(value: unknown): WorkflowResult<RpcRequest> {
  const exact = ownRecord(value, ["jsonrpc", "id", "method"], ["params"]);
  if (!exact || exact.jsonrpc !== "2.0" || !requestId(exact.id) || !nonEmptyString(exact.method) || (exact.params !== undefined && !plainDataObject(exact.params))) return rejection("protocol_error", "request_envelope_invalid");
  return success(Object.freeze({ id: exact.id, method: exact.method, ...(exact.params !== undefined ? { params: exact.params } : {}) }));
}

function errorResponse(id: RequestId, value: TransportRejection): RecordValue {
  return Object.freeze({ jsonrpc: "2.0", id, error: Object.freeze({ code: value.code, diagnostic: value.diagnostic }) });
}

function resultResponse(id: RequestId, value: JsonValue): RecordValue {
  return Object.freeze({ jsonrpc: "2.0", id, result: value });
}

function notification(value: JsonValue): RecordValue {
  return Object.freeze({ jsonrpc: "2.0", method: "events.event", params: value });
}

function journalError(value: { readonly code: string; readonly diagnostic: string }): TransportRejection {
  return Object.freeze({ code: "journal_rejection", diagnostic: `${value.code}:${value.diagnostic}` });
}

function replayOptions(value: unknown): WorkflowResult<Readonly<{ readonly afterGlobalCursor: number; readonly limit: number }>> {
  const exact: RecordValue | undefined = value === undefined ? Object.freeze({}) : ownRecord(value, [], ["afterGlobalCursor", "limit"]);
  if (!exact || (exact.afterGlobalCursor !== undefined && !safeInteger(exact.afterGlobalCursor)) || (exact.limit !== undefined && (!safeInteger(exact.limit, 1) || exact.limit > MAX_TRANSPORT_BATCH))) return rejection("invalid_request", "replay_options_invalid");
  return success(Object.freeze({ afterGlobalCursor: (exact.afterGlobalCursor as number | undefined) ?? 0, limit: (exact.limit as number | undefined) ?? MAX_TRANSPORT_BATCH }));
}

function connectionMaterial(daemonEpoch: string): ConnectionMaterial {
  return Object.freeze({ connectionId: `conn_${randomBytes(16).toString("hex")}`, connectionGeneration: 1, daemonEpoch });
}

export function createWorkflowDaemon(optionsInput: unknown): WorkflowResult<WorkflowDaemon> {
  const options = validateOptions(optionsInput);
  if (!options.ok) return options;
  const daemonEpoch = `epoch_${randomBytes(16).toString("hex")}`;
  let server: Server | undefined;
  let journal: CommandJournal | undefined;
  let socketIdentity: SocketIdentity | undefined;
  let running = false;
  let closing = false;
  const connections = new Set<ConnectionState>();
  const registryResult = createSyntheticE11Registry();
  if (!registryResult.ok) return rejection("transport_failed", "synthetic_registry_unavailable");
  const registry = registryResult.value;

  const status = (): DaemonStatus => Object.freeze({ running, socketPath: options.value.socketPath!, daemonEpoch, connectionCount: connections.size, journal: journal?.inspect() ?? null });

  const write = (state: ConnectionState, message: unknown): boolean => {
    const encoded = encodeFrame(message);
    if (!encoded.ok) {
      state.socket.destroy();
      return false;
    }
    try {
      state.socket.write(encoded.value);
      return true;
    } catch {
      state.socket.destroy();
      return false;
    }
  };

  const dispatch = async (state: ConnectionState, value: unknown): Promise<void> => {
    const parsed = parseRequest(value);
    if (!parsed.ok) {
      state.socket.destroy();
      return;
    }
    const request = parsed.value;
    if (!state.handshaken) {
      if (request.method !== "handshake") {
        write(state, errorResponse(request.id, Object.freeze({ code: "protocol_error", diagnostic: "handshake_required" })));
        state.socket.destroy();
        return;
      }
      const params = ownRecord(request.params, ["protocolVersion", "clientName"], ["supportedProtocolVersions"]);
      const supported = params?.supportedProtocolVersions;
      const compatible = !!params && params.protocolVersion === WORKFLOW_PROTOCOL_VERSION && nonEmptyString(params.clientName) &&
        (supported === undefined || (Array.isArray(supported) && supported.every((item) => safeInteger(item)) && supported.includes(WORKFLOW_PROTOCOL_VERSION)));
      state.handshaken = true;
      state.diagnosticsOnly = !compatible;
      if (!compatible) {
        write(state, errorResponse(request.id, Object.freeze({ code: "protocol_incompatible", diagnostic: "protocol_version_not_supported" })));
        return;
      }
      const handshake: HandshakeResult = Object.freeze({ protocolVersion: WORKFLOW_PROTOCOL_VERSION, compatible: true, diagnosticsOnly: false, ...state.material, capabilities: Object.freeze(["health", "events.replay", "events.subscribe", ...(options.value.resolvePrincipal ? ["command.commit"] : [])]) });
      write(state, resultResponse(request.id, handshake as unknown as JsonValue));
      return;
    }
    if (request.method === "handshake") {
      write(state, errorResponse(request.id, Object.freeze({ code: "protocol_error", diagnostic: "duplicate_handshake" })));
      return;
    }
    if (request.method === "health") {
      if (!journal) {
        write(state, errorResponse(request.id, Object.freeze({ code: "daemon_closed", diagnostic: "journal_unavailable" })));
        return;
      }
      const health: HealthResult = Object.freeze({ protocolVersion: WORKFLOW_PROTOCOL_VERSION, daemonEpoch, connectionCount: connections.size, journal: journal.inspect() });
      write(state, resultResponse(request.id, health as unknown as JsonValue));
      return;
    }
    const replay = request.method === "events.replay" || request.method === "events.subscribe";
    if (replay) {
      if (!journal) {
        write(state, errorResponse(request.id, Object.freeze({ code: "daemon_closed", diagnostic: "journal_unavailable" })));
        return;
      }
      const parsedOptions = replayOptions(request.params);
      if (!parsedOptions.ok) {
        write(state, errorResponse(request.id, parsedOptions.rejection));
        return;
      }
      const events = journal.readEvents(parsedOptions.value);
      if (!events.ok) {
        write(state, errorResponse(request.id, journalError(events.rejection)));
        return;
      }
      if (request.method === "events.subscribe") {
        state.subscribed = true;
        state.cursor = events.value.at(-1)?.globalCursor ?? parsedOptions.value.afterGlobalCursor;
      }
      write(state, resultResponse(request.id, events.value as unknown as JsonValue));
      return;
    }
    if (state.diagnosticsOnly || request.method === "command.commit") {
      if (state.diagnosticsOnly) {
        write(state, errorResponse(request.id, Object.freeze({ code: "read_only_diagnostics", diagnostic: "incompatible_client" })));
        return;
      }
    }
    if (request.method === "command.commit") {
      if (!journal || !options.value.resolvePrincipal) {
        write(state, errorResponse(request.id, Object.freeze({ code: "unauthorized", diagnostic: "principal_resolver_unavailable" })));
        return;
      }
      const params = ownRecord(request.params, ["intent", "result", "events", "outbox"], ["projections"]);
      if (!params || !Array.isArray(params.events) || !Array.isArray(params.outbox)) {
        write(state, errorResponse(request.id, Object.freeze({ code: "invalid_request", diagnostic: "command_params_invalid" })));
        return;
      }
      let principal: unknown;
      try {
        principal = options.value.resolvePrincipal(state.material, params.intent);
      } catch {
        write(state, errorResponse(request.id, Object.freeze({ code: "unauthorized", diagnostic: "principal_resolver_failed" })));
        return;
      }
      if (principal === undefined) {
        write(state, errorResponse(request.id, Object.freeze({ code: "unauthorized", diagnostic: "principal_unavailable" })));
        return;
      }
      const accepted = acceptCommandIntent(registry, params.intent, principal);
      if (!accepted.ok) {
        write(state, errorResponse(request.id, Object.freeze({ code: "unauthorized", diagnostic: `${accepted.rejection.code}:${accepted.rejection.detail ?? "invalid_intent"}` })));
        return;
      }
      const before = journal.inspect().highestGlobalCursor;
      const committed = journal.commit({ accepted: accepted.value, result: params.result as JsonValue, events: params.events, ...(params.projections !== undefined ? { projections: params.projections } : {}), outbox: params.outbox });
      if (!committed.ok) {
        write(state, errorResponse(request.id, journalError(committed.rejection)));
        return;
      }
      write(state, resultResponse(request.id, committed.value as unknown as JsonValue));
      broadcast(before);
      return;
    }
    write(state, errorResponse(request.id, Object.freeze({ code: "unknown_method", diagnostic: "method_not_supported" })));
  };

  const broadcast = (afterCursor: number): void => {
    if (!journal) return;
    const events = journal.readEvents({ afterGlobalCursor: afterCursor, limit: MAX_TRANSPORT_BATCH });
    if (!events.ok) return;
    for (const state of connections) {
      if (!state.subscribed) continue;
      for (const event of events.value) {
        if (event.globalCursor <= state.cursor) continue;
        if (write(state, notification(event as unknown as JsonValue))) state.cursor = event.globalCursor;
      }
    }
  };

  const onConnection = (socket: Socket): void => {
    socket.setNoDelay(true);
    const state: ConnectionState = { socket, decoder: new FrameDecoder(), material: connectionMaterial(daemonEpoch), handshaken: false, diagnosticsOnly: false, subscribed: false, cursor: 0, queue: Promise.resolve() };
    connections.add(state);
    socket.on("data", (chunk: Buffer) => {
      const decoded = state.decoder.push(chunk);
      if (!decoded.ok) {
        socket.destroy();
        return;
      }
      for (const message of decoded.value) {
        state.queue = state.queue.then(() => dispatch(state, message)).catch(() => { socket.destroy(); });
      }
    });
    socket.on("end", () => {
      const ended = state.decoder.end();
      if (!ended.ok) socket.destroy();
    });
    socket.on("error", () => { socket.destroy(); });
    socket.on("close", () => { connections.delete(state); });
  };

  const start = async (): Promise<WorkflowResult<DaemonStatus>> => {
    if (running) return success(status());
    if (closing) return rejection("daemon_closed", "daemon_is_closing");
    const pathReady = prepareSocketPath(options.value.socketPath!);
    if (!pathReady.ok) return pathReady;
    const opened = openCommandJournal({ runtimeRoot: options.value.runtimeRoot, databasePath: options.value.databasePath, mode: "read-write", now: options.value.now });
    if (!opened.ok) return rejection("transport_failed", `${opened.rejection.code}:${opened.rejection.diagnostic}`);
    journal = opened.value;
    server = net.createServer(onConnection);
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const onError = (error: Error): void => { server?.off("listening", onListening); rejectPromise(error); };
        const onListening = (): void => { server?.off("error", onError); resolvePromise(); };
        server?.once("error", onError);
        server?.once("listening", onListening);
        server?.listen(options.value.socketPath!);
      });
      chmodSync(options.value.socketPath!, 0o600);
      const verified = verifySocket(options.value.socketPath!);
      if (!verified.ok) throw new Error(verified.rejection.diagnostic);
      socketIdentity = verified.value;
      running = true;
      return success(status());
    } catch (error) {
      for (const connection of connections) connection.socket.destroy();
      try { server?.close(); } catch { /* preserve startup failure */ }
      server = undefined;
      journal.close();
      journal = undefined;
      return rejection("socket_unavailable", error instanceof Error ? error.message.replace(/[^a-z0-9_:-]/gi, "_").slice(0, 120) : "daemon_start_failed");
    }
  };

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    for (const connection of connections) connection.socket.destroy();
    if (server) await new Promise<void>((resolvePromise) => server?.close(() => resolvePromise()));
    server = undefined;
    running = false;
    journal?.close();
    journal = undefined;
    if (socketIdentity) {
      const current = statIdentity(options.value.socketPath!);
      if (current && sameIdentity(current, socketIdentity)) {
        try { unlinkSync(options.value.socketPath!); } catch { /* close is best effort */ }
      }
    }
    socketIdentity = undefined;
  };

  const daemon: WorkflowDaemon = Object.freeze({ start, status, close });
  return success(daemon);
}
