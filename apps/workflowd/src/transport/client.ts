import { isAbsolute, resolve } from "node:path";
import net, { type Socket } from "node:net";

import type { CommandCommitValue, JournalEvent, JournalInspection } from "../journal/index.js";
import { FrameDecoder, encodeFrame } from "./framing.js";
import {
  WORKFLOW_PROTOCOL_VERSION,
  type HandshakeResult,
  type HealthResult,
  type TransportRejection,
  type WorkflowClient,
  type WorkflowClientOptions,
  type WorkflowResult,
} from "./types.js";

type RecordValue = Readonly<Record<string, unknown>>;
type RequestId = number;
type Pending = Readonly<{ readonly resolve: (result: WorkflowResult<unknown>) => void; readonly timer: ReturnType<typeof setTimeout> }>;

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
    const allowed = new Set([...required, ...optional]);
    if (Object.getOwnPropertySymbols(value).length > 0 || keys.some((key) => !allowed.has(key))) return undefined;
    for (const key of required) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
    }
    return Object.freeze(Object.fromEntries(keys.map((key) => [key, (Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor).value])));
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");
}

function validateOptions(input: unknown): WorkflowResult<WorkflowClientOptions> {
  const exact = ownRecord(input, ["socketPath", "clientName"], ["supportedProtocolVersions"]);
  if (!exact || typeof exact.socketPath !== "string" || !isAbsolute(exact.socketPath) || !nonEmptyString(exact.clientName)) return rejection("invalid_options", "client_options_invalid");
  const versions = exact.supportedProtocolVersions;
  if (versions !== undefined && (!Array.isArray(versions) || versions.length === 0 || versions.some((value) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0))) return rejection("invalid_options", "supported_versions_invalid");
  return success(Object.freeze({ socketPath: resolve(exact.socketPath), clientName: exact.clientName, ...(versions === undefined ? {} : { supportedProtocolVersions: Object.freeze([...versions] as number[]) }) }));
}

function transportError(value: unknown): TransportRejection {
  const exact = ownRecord(value, ["code", "diagnostic"]);
  const code = exact?.code;
  const diagnostic = exact?.diagnostic;
  return Object.freeze({ code: typeof code === "string" ? code as TransportRejection["code"] : "transport_failed", diagnostic: typeof diagnostic === "string" ? diagnostic.slice(0, 256) : "remote_error" });
}

function validateHandshake(value: unknown): WorkflowResult<HandshakeResult> {
  const exact = ownRecord(value, ["protocolVersion", "compatible", "diagnosticsOnly", "connectionId", "connectionGeneration", "daemonEpoch", "capabilities"]);
  if (!exact || exact.protocolVersion !== WORKFLOW_PROTOCOL_VERSION || exact.compatible !== true || exact.diagnosticsOnly !== false || !nonEmptyString(exact.connectionId) || typeof exact.connectionGeneration !== "number" || !Number.isSafeInteger(exact.connectionGeneration) || exact.connectionGeneration < 1 || !nonEmptyString(exact.daemonEpoch) || !Array.isArray(exact.capabilities) || !exact.capabilities.every(nonEmptyString)) return rejection("transport_failed", "handshake_result_invalid");
  return success(Object.freeze({ protocolVersion: WORKFLOW_PROTOCOL_VERSION, compatible: true, diagnosticsOnly: false, connectionId: exact.connectionId, connectionGeneration: exact.connectionGeneration, daemonEpoch: exact.daemonEpoch, capabilities: Object.freeze([...exact.capabilities] as string[]) }));
}

function validateEvents(value: unknown): WorkflowResult<readonly JournalEvent[]> {
  if (!Array.isArray(value)) return rejection("transport_failed", "event_result_invalid");
  const events: JournalEvent[] = [];
  for (const item of value) {
    const exact = ownRecord(item, ["eventId", "aggregateType", "aggregateId", "sequence", "globalCursor", "schemaId", "schemaVersion", "payload", "principal", "correlationId", "causationId", "occurredAt"]);
    if (!exact || !nonEmptyString(exact.eventId) || !nonEmptyString(exact.aggregateType) || !nonEmptyString(exact.aggregateId) || typeof exact.sequence !== "number" || !Number.isSafeInteger(exact.sequence) || exact.sequence < 1 || typeof exact.globalCursor !== "number" || !Number.isSafeInteger(exact.globalCursor) || exact.globalCursor < 1 || !nonEmptyString(exact.schemaId) || typeof exact.schemaVersion !== "number" || !Number.isSafeInteger(exact.schemaVersion) || exact.schemaVersion < 1 || !nonEmptyString(exact.correlationId) || !nonEmptyString(exact.causationId) || !nonEmptyString(exact.occurredAt)) return rejection("transport_failed", "event_result_invalid");
    events.push(Object.freeze({ eventId: exact.eventId, aggregateType: exact.aggregateType, aggregateId: exact.aggregateId, sequence: exact.sequence, globalCursor: exact.globalCursor, schemaId: exact.schemaId, schemaVersion: exact.schemaVersion, payload: exact.payload as JournalEvent["payload"], principal: exact.principal as JournalEvent["principal"], correlationId: exact.correlationId, causationId: exact.causationId, occurredAt: exact.occurredAt }));
  }
  return success(Object.freeze(events));
}

function validateHealth(value: unknown): WorkflowResult<HealthResult> {
  const exact = ownRecord(value, ["protocolVersion", "daemonEpoch", "connectionCount", "journal"]);
  if (!exact || exact.protocolVersion !== WORKFLOW_PROTOCOL_VERSION || !nonEmptyString(exact.daemonEpoch) || typeof exact.connectionCount !== "number" || !Number.isSafeInteger(exact.connectionCount) || exact.connectionCount < 0 || ownRecord(exact.journal, ["status", "schemaVersion", "commandCount", "aggregateCount", "eventCount", "projectionCount", "outboxCount", "highestGlobalCursor"]) === undefined) return rejection("transport_failed", "health_result_invalid");
  return success(Object.freeze({ protocolVersion: WORKFLOW_PROTOCOL_VERSION, daemonEpoch: exact.daemonEpoch, connectionCount: exact.connectionCount, journal: exact.journal as JournalInspection }));
}

export function createWorkflowClient(optionsInput: unknown): WorkflowResult<WorkflowClient> {
  const options = validateOptions(optionsInput);
  if (!options.ok) return options;
  let socket: Socket | undefined;
  let connected = false;
  let closed = false;
  let requestSequence = 0;
  let decoder: FrameDecoder | undefined;
  let handshake: HandshakeResult | undefined;
  let diagnosticsMode = false;
  const pending = new Map<RequestId, Pending>();
  const listeners = new Set<(event: JournalEvent) => void>();

  const failPending = (value: TransportRejection): void => {
    for (const [id, item] of pending) {
      clearTimeout(item.timer);
      item.resolve(rejection(value.code, value.diagnostic));
      pending.delete(id);
    }
  };

  const onMessage = (message: unknown): void => {
    const exact = ownRecord(message, ["jsonrpc"], ["id", "result", "error", "method", "params"]);
    if (!exact || exact.jsonrpc !== "2.0") {
      socket?.destroy();
      return;
    }
    if (exact.method === "events.event") {
      // The daemon uses the event itself as the JSON-RPC notification params.
      // Keep the notification shape aligned with `events.replay`, rather than
      // requiring an extra `{ event }` wrapper that is not on the wire.
      const event = validateEvents([exact.params]);
      if (!event.ok) {
        socket?.destroy();
        return;
      }
      for (const listener of listeners) {
        try { listener(event.value[0]!); } catch { /* client callbacks cannot break transport */ }
      }
      return;
    }
    const id = exact.id;
    if (typeof id !== "number" || !pending.has(id)) {
      socket?.destroy();
      return;
    }
    const item = pending.get(id)!;
    pending.delete(id);
    clearTimeout(item.timer);
    if (exact.error !== undefined) {
      item.resolve(rejection(transportError(exact.error).code, transportError(exact.error).diagnostic));
      return;
    }
    if (!("result" in exact)) {
      item.resolve(rejection("protocol_error", "response_result_missing"));
      return;
    }
    item.resolve(success(exact.result));
  };

  const attach = (candidate: Socket): void => {
    socket = candidate;
    decoder = new FrameDecoder();
    candidate.setNoDelay(true);
    candidate.on("data", (chunk: Buffer) => {
      const decoded = decoder?.push(chunk);
      if (!decoded || !decoded.ok) {
        candidate.destroy();
        return;
      }
      for (const message of decoded.value) onMessage(message);
    });
    candidate.on("error", () => { failPending(Object.freeze({ code: "transport_failed", diagnostic: "socket_error" })); });
    candidate.on("close", () => {
      connected = false;
      socket = undefined;
      decoder = undefined;
      failPending(Object.freeze({ code: "transport_failed", diagnostic: "socket_closed" }));
    });
  };

  const sendRequest = (method: string, params?: unknown): Promise<WorkflowResult<unknown>> => {
    if (!socket || !connected && method !== "handshake") return Promise.resolve(rejection("not_connected", "client_not_connected"));
    if (closed) return Promise.resolve(rejection("daemon_closed", "client_closed"));
    const id = ++requestSequence;
    const encoded = encodeFrame({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    if (!encoded.ok) return Promise.resolve(encoded);
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolvePromise(rejection("transport_failed", "request_timeout"));
      }, 10_000);
      pending.set(id, Object.freeze({ resolve: resolvePromise, timer }));
      try {
        socket?.write(encoded.value);
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        resolvePromise(rejection("transport_failed", "request_write_failed"));
      }
    });
  };

  const connect = async (): Promise<WorkflowResult<HandshakeResult>> => {
    if (handshake && connected) return success(handshake);
    if (closed) return rejection("daemon_closed", "client_closed");
    try {
      const candidate = await new Promise<Socket>((resolvePromise, rejectPromise) => {
        const created = net.createConnection(options.value.socketPath!);
        const onError = (error: Error): void => { created.off("connect", onConnect); rejectPromise(error); };
        const onConnect = (): void => { created.off("error", onError); resolvePromise(created); };
        created.once("error", onError);
        created.once("connect", onConnect);
      });
      attach(candidate);
      connected = true;
      const response = await sendRequest("handshake", { protocolVersion: WORKFLOW_PROTOCOL_VERSION, clientName: options.value.clientName, supportedProtocolVersions: options.value.supportedProtocolVersions ?? [WORKFLOW_PROTOCOL_VERSION] });
      if (!response.ok) {
        if (response.rejection.code === "protocol_incompatible") diagnosticsMode = true;
        return response as WorkflowResult<HandshakeResult>;
      }
      const checked = validateHandshake(response.value);
      if (!checked.ok) return checked;
      handshake = checked.value;
      return success(handshake);
    } catch {
      return rejection("socket_unavailable", "client_connect_failed");
    }
  };

  const requireConnection = (): WorkflowResult<true> => connected && (handshake !== undefined || diagnosticsMode) ? success(true as const) : rejection("not_connected", "client_not_connected");

  const health = async (): Promise<WorkflowResult<HealthResult>> => {
    const ready = requireConnection();
    if (!ready.ok) return ready;
    const response = await sendRequest("health");
    if (!response.ok) return response;
    return validateHealth(response.value);
  };

  const replayEvents = async (input?: unknown): Promise<WorkflowResult<readonly JournalEvent[]>> => {
    const ready = requireConnection();
    if (!ready.ok) return ready;
    const response = await sendRequest("events.replay", input);
    if (!response.ok) return response;
    return validateEvents(response.value);
  };

  const commitCommand = async (input: unknown): Promise<WorkflowResult<CommandCommitValue>> => {
    const ready = requireConnection();
    if (!ready.ok) return ready;
    const response = await sendRequest("command.commit", input);
    if (!response.ok) return response;
    const exact = ownRecord(response.value, ["commandId", "replayed", "result", "revision", "eventIds", "outboxIds"]);
    if (!exact || !nonEmptyString(exact.commandId) || typeof exact.replayed !== "boolean" || typeof exact.revision !== "number" || !Number.isSafeInteger(exact.revision) || exact.revision < 0 || !Array.isArray(exact.eventIds) || !exact.eventIds.every(nonEmptyString) || !Array.isArray(exact.outboxIds) || !exact.outboxIds.every(nonEmptyString)) return rejection("transport_failed", "command_result_invalid");
    return success(Object.freeze({ commandId: exact.commandId, replayed: exact.replayed, result: exact.result as CommandCommitValue["result"], revision: exact.revision, eventIds: Object.freeze([...exact.eventIds] as string[]), outboxIds: Object.freeze([...exact.outboxIds] as string[]) }));
  };

  const subscribeEvents = async (input: unknown, onEvent: (event: JournalEvent) => void): Promise<WorkflowResult<true>> => {
    const ready = requireConnection();
    if (!ready.ok) return ready;
    if (typeof onEvent !== "function") return rejection("invalid_request", "event_listener_invalid");
    listeners.add(onEvent);
    const response = await sendRequest("events.subscribe", input);
    if (!response.ok) {
      listeners.delete(onEvent);
      return response as WorkflowResult<true>;
    }
    const events = validateEvents(response.value);
    if (!events.ok) {
      listeners.delete(onEvent);
      return events as WorkflowResult<true>;
    }
    return success(true as const);
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    listeners.clear();
    failPending(Object.freeze({ code: "daemon_closed", diagnostic: "client_closed" }));
    const current = socket;
    socket = undefined;
    connected = false;
    diagnosticsMode = false;
    if (current) await new Promise<void>((resolvePromise) => { current.once("close", () => resolvePromise()); current.end(); setTimeout(() => { current.destroy(); resolvePromise(); }, 1000); });
  };

  return success(Object.freeze({ connect, health, replayEvents, commitCommand, subscribeEvents, close }));
}
