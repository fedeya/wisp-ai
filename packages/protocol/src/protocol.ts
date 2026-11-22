import { z } from 'zod';
import { SLOT_COUNT } from './addon-helpers.js';

export { BIT_COUNT, SLOT_COUNT, luaJson } from './addon-helpers.js';
export const PREFIX = 'WispAI';
const identifier = z.string().min(1).max(200);
const envelope = z.object({
  transportVersion: z.literal(2).optional(),
  mailboxVersion: z.literal(1).optional(),
  compactAck: z.boolean().optional(),
  bulkAvailable: z.boolean().optional(),
  session: z.string().min(1).max(100),
  seq: z.number().int().safe().positive(),
  at: z.number().int().safe(),
  nextSlot: z.number().int().min(1).max(SLOT_COUNT).optional(),
  receivedRev: z.number().int().nonnegative().optional(),
  chat: identifier.optional(),
  nextChat: identifier.optional(),
  text: z.string().max(16000).optional(),
  messageId: identifier.optional(),
  requestId: identifier.optional(),
  data: z.unknown().optional(),
  context: z.unknown().optional(),
  transport: z
    .preprocess(
      // WoW SerializeJSON emits [] for an empty Lua table. Before the first
      // delivery measurement, transport has no defined fields.
      (value) => (Array.isArray(value) && value.length === 0 ? {} : value),
      z.object({
        delivery: z
          .object({
            messageId: identifier,
            ms: z.number().nonnegative().finite(),
            queueMs: z.number().nonnegative().finite().optional(),
            transmitMs: z.number().nonnegative().finite().optional(),
            ackMs: z.number().nonnegative().finite().optional(),
            bytes: z.number().int().nonnegative().optional(),
            frames: z.number().int().nonnegative().optional(),
            retries: z.number().int().nonnegative().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  slot: z.enum(['preferences', 'character']).optional(),
  key: identifier.optional(),
  enabled: z.boolean().optional(),
  heartbeat: z.boolean().optional(),
  // A hello sent because the player's own request went unanswered: it may take the
  // bridge from another game window, which a periodic heartbeat never does.
  takeover: z.boolean().optional(),
  integrations: z.unknown().optional(),
  nodeId: identifier.optional(),
  values: z.unknown().optional(),
});
export const packetSchema = z.discriminatedUnion('type', [
  envelope.extend({
    type: z.enum([
      'hello',
      'poll',
      'quest_sync',
      'model_catalog',
      'capabilities_list',
      'memory_list',
    ]),
  }),
  envelope.extend({
    type: z.enum(['new', 'select', 'delete', 'cancel', 'retry', 'dismiss_tip', 'promote_inline']),
    chat: identifier,
  }),
  envelope.extend({
    type: z.enum(['say', 'inline_say']),
    chat: identifier,
    text: z.string().min(1).max(16000),
  }),
  envelope.extend({ type: z.literal('state_result'), requestId: identifier, chat: identifier }),
  envelope.extend({
    type: z.literal('capability_set'),
    key: identifier,
    enabled: z.boolean(),
    requestId: identifier,
  }),
  envelope.extend({
    type: z.enum(['memory_save', 'memory_remove']),
    slot: z.enum(['preferences', 'character']),
    key: identifier,
  }),
  envelope.extend({
    type: z.literal('chat_model_set'),
    chat: identifier,
    requestId: identifier,
    data: z.object({
      model: z.string().min(1),
      effort: z.string().optional(),
      inline: z.boolean().optional(),
    }),
  }),
  envelope.extend({ type: z.literal('inline_status'), data: z.record(z.string(), z.unknown()) }),
  envelope.extend({
    type: z.enum(['routine_tick', 'routine_event']),
    data: z.object({
      ready: z.boolean(),
      event: z.string().optional(),
      values: z.unknown().optional(),
    }),
  }),
  envelope.extend({ type: z.literal('routine_action'), data: z.unknown() }),
  envelope.extend({ type: z.literal('panel_ask'), key: identifier, nodeId: identifier }),
  envelope.extend({
    type: z.literal('ui_action'),
    chat: identifier,
    messageId: identifier,
    nodeId: identifier,
  }),
]);
export type Packet = z.infer<typeof packetSchema>;
