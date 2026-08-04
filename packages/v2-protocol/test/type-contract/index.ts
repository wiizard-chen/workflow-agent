import {
  PROTOCOL_VERSION,
  acceptCommandIntent,
  acceptQueryIntent,
  createEventEnvelope,
  createSchemaRegistry,
  createSyntheticE11Registry,
  type AcceptedCommandEnvelope,
  type AcceptedQueryEnvelope,
  type AggregateRef,
  type CommandIntent,
  type EventEnvelope,
  type MessageKind,
  type ProtocolRejection,
  type ProtocolRejectionCode,
  type ProtocolResult,
  type ProtocolVersion,
  type QueryIntent,
  type SchemaDefinition,
  type SchemaId,
  type SchemaRegistry,
  type SchemaVersion,
  type ServerPrincipalContext,
  type SyntheticE11ReadPayload,
  type SyntheticE11StartPayload,
  type VerifiedHumanPresenceGrant,
} from "@pi-workflow/v2-protocol";

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? true
    : false;
type Assert<T extends true> = T;

type PublicTypes = [
  ProtocolVersion,
  MessageKind,
  SchemaVersion,
  SchemaId,
  ProtocolResult<unknown>,
  ProtocolRejectionCode,
  ProtocolRejection,
  AggregateRef,
  ServerPrincipalContext,
  VerifiedHumanPresenceGrant,
  CommandIntent,
  QueryIntent,
  AcceptedCommandEnvelope,
  AcceptedQueryEnvelope,
  EventEnvelope,
  SchemaDefinition,
  SchemaRegistry,
  SyntheticE11StartPayload,
  SyntheticE11ReadPayload,
];

type _PublicTypeCount = Assert<Equal<PublicTypes["length"], 19>>;
type _ProtocolVersion = Assert<Equal<typeof PROTOCOL_VERSION, 1>>;
type _CreateRegistry = Assert<Equal<
  typeof createSchemaRegistry,
  (definitions: readonly SchemaDefinition[]) => ProtocolResult<SchemaRegistry>
>>;
type _AcceptCommand = Assert<Equal<
  typeof acceptCommandIntent,
  (registry: SchemaRegistry, input: unknown, principal: unknown, verifiedGrant?: unknown) => ProtocolResult<AcceptedCommandEnvelope>
>>;
type _AcceptQuery = Assert<Equal<
  typeof acceptQueryIntent,
  (registry: SchemaRegistry, input: unknown, principal: unknown, verifiedGrant?: unknown) => ProtocolResult<AcceptedQueryEnvelope>
>>;
type _CreateEvent = Assert<Equal<
  typeof createEventEnvelope,
  (registry: SchemaRegistry, input: unknown, principalInput: unknown) => ProtocolResult<EventEnvelope>
>>;
type _CreateSynthetic = Assert<Equal<
  typeof createSyntheticE11Registry,
  () => ProtocolResult<SchemaRegistry>
>>;

declare const registry: SchemaRegistry;
declare const definitions: readonly SchemaDefinition[];
declare const command: CommandIntent;
declare const query: QueryIntent;
declare const principal: ServerPrincipalContext;
declare const grant: VerifiedHumanPresenceGrant;
declare const aggregate: AggregateRef;
declare const acceptedCommand: AcceptedCommandEnvelope;
declare const acceptedQuery: AcceptedQueryEnvelope;
declare const event: EventEnvelope;

createSchemaRegistry(definitions);
acceptCommandIntent(registry, command, principal, grant);
acceptQueryIntent(registry, query, principal);
createEventEnvelope(registry, event, principal);
createSyntheticE11Registry();
void aggregate;
void acceptedCommand;
void acceptedQuery;
void event;
void (null as unknown as _PublicTypeCount);
void (null as unknown as _ProtocolVersion);
void (null as unknown as _CreateRegistry);
void (null as unknown as _AcceptCommand);
void (null as unknown as _AcceptQuery);
void (null as unknown as _CreateEvent);
void (null as unknown as _CreateSynthetic);

// @ts-expect-error protocol version is a closed literal
const futureProtocolVersion: ProtocolVersion = 2;
// @ts-expect-error message kind is a closed vocabulary
const unknownKind: MessageKind = "notification";
// @ts-expect-error successful envelopes are immutable
acceptedCommand.commandId = "mutated";
// @ts-expect-error nested payloads are readonly
acceptedQuery.payload.foo = "mutated";
// @ts-expect-error principal capabilities are readonly
principal.capabilityRefs.push("forbidden");
// @ts-expect-error internal registry dispatch is not public
registry.dispatch;
// @ts-expect-error E02 internals are not re-exported
type NoEpicId = import("@pi-workflow/v2-protocol").EpicId;
// @ts-expect-error no internal subpath is exported
type NoInternal = import("@pi-workflow/v2-protocol/internal").ObjectFields;

void futureProtocolVersion;
void unknownKind;
