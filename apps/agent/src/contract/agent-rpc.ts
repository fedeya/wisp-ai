// @effect-migrated
import { Schema, Tuple } from 'effect';
import type { StandardSchemaV1 } from 'effect/StandardSchema';
import { panelInput } from './panels.ts';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import { routineInput } from '@wisp/protocol/routines';
import { simulationInput } from './simulation.ts';
import { databaseRequest } from './database.ts';
import { wowheadQuery } from '@wisp/protocol/search';
import { providerId } from '@wisp/protocol/providers';
import { replyPresentation } from './reply-presentation.ts';
import { KeyedRecord, LimitedString } from './tool-inputs.ts';

const agentSession = Schema.String.check(Schema.isMinLength(1));
/**
 * A request built on `@wisp/protocol` schemas, strict like them. The agent and
 * the bridge check every request with `parse`, as they do the zod ones, which
 * here decodes with Schema and rejects unknown keys.
 */
function protocolRequest<S extends Schema.Codec<unknown, unknown>>(schema: S) {
  return Object.assign(Schema.toStandardSchemaV1(schema, { parseOptions: rejectUnknownKeys }), {
    parse: Schema.decodeUnknownSync(schema, rejectUnknownKeys),
  });
}
/** A request or response on Schema that drops unknown keys, as zod's `z.object` did. */
function openMessage<S extends Schema.Codec<unknown, unknown>>(schema: S) {
  return Object.assign(Schema.toStandardSchemaV1(schema), {
    parse: Schema.decodeUnknownSync(schema),
  });
}
export const rpcRequests = {
  title: openMessage(Schema.Struct({ agentSession, title: LimitedString(1, 500) })),
  present: openMessage(
    Schema.Struct({ agentSession, callId: LimitedString(1, 200), presentation: replyPresentation }),
  ),
  panels: openMessage(Schema.Struct({ agentSession, input: panelInput })),
  routines: protocolRequest(Schema.Struct({ agentSession, input: routineInput })),
  // zod's `extend` kept the checks, which read only the simulation's own fields.
  simulate: protocolRequest(
    simulationInput.mapFields((fields) => ({ ...fields, agentSession }), {
      unsafePreserveChecks: true,
    }),
  ),
  database: protocolRequest(
    databaseRequest.mapMembers(Tuple.map(Schema.fieldsAssign({ agentSession }))),
  ),
  wowhead: protocolRequest(Schema.Struct({ ...wowheadQuery.fields, agentSession })),
};
export type RpcEndpoint = keyof typeof rpcRequests;
export type RpcInput<K extends RpcEndpoint> = StandardSchemaV1.InferInput<(typeof rpcRequests)[K]>;
// What the bridge read or did, checked only as an object. `KeyedRecord` drops an
// own `__proto__` key, as zod's `z.record` did and `Schema.Record` does not.
const reading = openMessage(KeyedRecord(Schema.String, Schema.Unknown));
export const rpcResponses = {
  title: openMessage(Schema.Struct({ title: Schema.String })),
  present: openMessage(replyPresentation),
  panels: reading,
  routines: reading,
  simulate: reading,
  database: reading,
  wowhead: reading,
};
export type RpcOutput<K extends RpcEndpoint> = ReturnType<(typeof rpcResponses)[K]['parse']>;
/** Names the agent session on model requests, so the bridge can tell which turn a failure belongs to. */
export const MODEL_SESSION_HEADER = 'x-wisp-session';
export const selectedModel = Schema.Struct({
  model: Schema.String.check(Schema.isMinLength(1)),
  effort: Schema.String.check(Schema.isMinLength(1)),
  contextWindow: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
  connectionId: Schema.optional(Schema.String.check(Schema.isUUID())),
  provider: Schema.optional(providerId),
  modelId: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  webSearchAvailable: Schema.optional(Schema.Boolean),
});
export type SelectedModel = typeof selectedModel.Type;
