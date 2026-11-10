import { z } from 'zod';
import { inspectionSchema } from './game-inspection.js';
import { actionSchema } from './game-actions.js';
import { panelInput } from './panels.js';
import { routineInput } from './routines.js';
import { simulationInput } from './simulation.js';
import { databaseRequest } from './database.js';
import { wowheadQuery } from './search.js';
import { providerId } from './providers.js';
import { replyPresentation } from './reply-presentation.js';

export const characterSections = z
  .array(z.enum(['character', 'location', 'talents', 'spells', 'quests', 'gear', 'bags']))
  .min(1)
  .max(7);
const session = { eveSession: z.string().min(1) };
export const memoryRequest = z.discriminatedUnion('operation', [
  z.object({
    ...session,
    slot: z.enum(['preferences', 'character']),
    operation: z.literal('list'),
  }),
  z.object({
    ...session,
    slot: z.enum(['preferences', 'character']),
    operation: z.literal('save'),
    key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    text: z.string().trim().min(1).max(1000),
  }),
  z.object({
    ...session,
    slot: z.enum(['preferences', 'character']),
    operation: z.literal('remove'),
    key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  }),
]);
export const rpcRequests = {
  state: z.object({ ...session, sections: characterSections, refresh: z.boolean().optional() }),
  identity: z.object(session),
  title: z.object({ ...session, title: z.string().min(1).max(500) }),
  present: z.object({
    ...session,
    callId: z.string().min(1).max(200),
    presentation: replyPresentation,
  }),
  memory: memoryRequest,
  inspect: z.object({ ...session, inspection: inspectionSchema }),
  action: z.object({ ...session, action: actionSchema }),
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
export const memoryEntry = z.object({ key: z.string(), text: z.string(), updatedAt: z.string() });
const reading = z.record(z.string(), z.unknown());
export const rpcResponses = {
  state: reading,
  identity: z.object({ characterKey: z.string().nullable() }),
  title: z.object({ title: z.string() }),
  present: replyPresentation,
  memory: z.object({ entries: z.array(memoryEntry) }),
  inspect: reading,
  action: reading,
  panels: reading,
  routines: reading,
  simulate: reading,
  database: reading,
  wowhead: reading,
};
export type RpcOutput<K extends RpcEndpoint> = z.output<(typeof rpcResponses)[K]>;
export const selectedModel = z.object({
  model: z.string().min(1),
  effort: z.string().min(1),
  contextWindow: z.number().positive().optional(),
  connectionId: z.string().uuid().optional(),
  provider: providerId.optional(),
  modelId: z.string().min(1).optional(),
  webSearchAvailable: z.boolean().optional(),
});
