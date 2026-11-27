import { z } from 'zod';
import { panelInput } from './panels.ts';
import { routineInput } from '@wisp/protocol/routines';
import { simulationInput } from './simulation.ts';
import { databaseRequest } from './database.ts';
import { wowheadQuery } from '@wisp/protocol/search';
import { providerId } from '@wisp/protocol/providers';
import { replyPresentation } from './reply-presentation.ts';

const session = { agentSession: z.string().min(1) };
export const rpcRequests = {
  title: z.object({ ...session, title: z.string().min(1).max(500) }),
  present: z.object({
    ...session,
    callId: z.string().min(1).max(200),
    presentation: replyPresentation,
  }),
  panels: z.object({ ...session, input: panelInput }),
  routines: z.object({ ...session, input: routineInput }),
  simulate: simulationInput.extend(session),
  database: z.discriminatedUnion('operation', [
    databaseRequest.options[0].extend(session),
    databaseRequest.options[1].extend(session),
  ]),
  wowhead: wowheadQuery.extend(session),
};
export type RpcEndpoint = keyof typeof rpcRequests;
export type RpcInput<K extends RpcEndpoint> = z.input<(typeof rpcRequests)[K]>;
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
export const selectedModel = z.object({
  model: z.string().min(1),
  effort: z.string().min(1),
  contextWindow: z.number().positive().optional(),
  connectionId: z.string().uuid().optional(),
  provider: providerId.optional(),
  modelId: z.string().min(1).optional(),
  webSearchAvailable: z.boolean().optional(),
});
