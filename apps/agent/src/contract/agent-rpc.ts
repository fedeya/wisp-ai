import { z } from 'zod';
import { Schema } from 'effect';
import type { StandardSchemaV1 } from 'effect/StandardSchema';
import { panelInput } from './panels.ts';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import { routineInput } from '@wisp/protocol/routines';
import { simulationInput } from './simulation.ts';
import { databaseRequest } from './database.ts';
import { wowheadQuery } from '@wisp/protocol/search';
import { providerId } from '@wisp/protocol/providers';
import { replyPresentation } from './reply-presentation.ts';

const session = { agentSession: z.string().min(1) };
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
export const rpcRequests = {
  title: z.object({ ...session, title: z.string().min(1).max(500) }),
  present: z.object({
    ...session,
    callId: z.string().min(1).max(200),
    presentation: replyPresentation,
  }),
  panels: z.object({ ...session, input: panelInput }),
  routines: protocolRequest(Schema.Struct({ agentSession, input: routineInput })),
  // zod's `extend` kept the checks, which read only the simulation's own fields.
  simulate: protocolRequest(
    simulationInput.mapFields((fields) => ({ ...fields, agentSession }), {
      unsafePreserveChecks: true,
    }),
  ),
  database: z.discriminatedUnion('operation', [
    databaseRequest.options[0].extend(session),
    databaseRequest.options[1].extend(session),
  ]),
  wowhead: protocolRequest(Schema.Struct({ ...wowheadQuery.fields, agentSession })),
};
export type RpcEndpoint = keyof typeof rpcRequests;
export type RpcInput<K extends RpcEndpoint> = StandardSchemaV1.InferInput<(typeof rpcRequests)[K]>;
const reading = z.record(z.string(), z.unknown());
export const rpcResponses = {
  title: z.object({ title: z.string() }),
  present: replyPresentation,
  panels: reading,
  routines: reading,
  simulate: reading,
  database: reading,
  wowhead: reading,
};
export type RpcOutput<K extends RpcEndpoint> = z.output<(typeof rpcResponses)[K]>;
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
