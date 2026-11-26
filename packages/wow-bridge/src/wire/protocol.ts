import { Option, Schema, SchemaGetter } from 'effect';
import { SLOT_COUNT } from '@wisp/protocol/addon-helpers';
import { inflateMessage, type MailboxMessage } from './mailbox.ts';

export { BIT_COUNT, SLOT_COUNT, luaJson } from '@wisp/protocol/addon-helpers';
export const PREFIX = 'WispAI';

const optional = Schema.optional;
const identifier = Schema.String.check(Schema.isBetweenLength(1, 200));
const nonnegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const milliseconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const delivery = Schema.Struct({
  messageId: identifier,
  ms: milliseconds,
  queueMs: optional(milliseconds),
  transmitMs: optional(milliseconds),
  ackMs: optional(milliseconds),
  bytes: optional(nonnegativeInt),
  frames: optional(nonnegativeInt),
  retries: optional(nonnegativeInt),
});
const telemetry = Schema.Struct({ delivery: optional(delivery) });
// WoW SerializeJSON emits [] for an empty Lua table.
const transport = Schema.Union([
  telemetry,
  Schema.Tuple([]).pipe(
    Schema.decodeTo(telemetry, {
      decode: SchemaGetter.transform(() => ({})),
      encode: SchemaGetter.transform(() => [] as const),
    }),
  ),
]);
const envelope = Schema.Struct({
  transportVersion: optional(Schema.Literal(2)),
  mailboxVersion: optional(Schema.Literal(1)),
  compactAck: optional(Schema.Boolean),
  bulkAvailable: optional(Schema.Boolean),
  session: Schema.String.check(Schema.isBetweenLength(1, 100)),
  seq: Schema.Int.check(Schema.isGreaterThan(0)),
  at: Schema.Int,
  nextSlot: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SLOT_COUNT }))),
  receivedRev: optional(nonnegativeInt),
  chat: optional(identifier),
  nextChat: optional(identifier),
  text: optional(Schema.String.check(Schema.isMaxLength(16000))),
  messageId: optional(identifier),
  requestId: optional(identifier),
  data: optional(Schema.Unknown),
  context: optional(Schema.Unknown),
  transport: optional(transport),
  slot: optional(Schema.Literals(['preferences', 'character'])),
  key: optional(identifier),
  enabled: optional(Schema.Boolean),
  heartbeat: optional(Schema.Boolean),
  // A hello triggered by the player can take over from another window.
  takeover: optional(Schema.Boolean),
  integrations: optional(Schema.Unknown),
  nodeId: optional(identifier),
  values: optional(Schema.Unknown),
});
const packet = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  envelope.pipe(Schema.fieldsAssign(fields));

export const packetSchema = Schema.Union([
  packet({
    type: Schema.Literals([
      'hello',
      'poll',
      'quest_sync',
      'model_catalog',
      'capabilities_list',
      'memory_list',
    ]),
  }),
  packet({
    type: Schema.Literals([
      'new',
      'select',
      'delete',
      'cancel',
      'retry',
      'dismiss_tip',
      'promote_inline',
    ]),
    chat: identifier,
  }),
  packet({
    type: Schema.Literals(['say', 'inline_say']),
    chat: identifier,
    text: Schema.String.check(Schema.isBetweenLength(1, 16000)),
  }),
  packet({ type: Schema.Literal('state_result'), requestId: identifier, chat: identifier }),
  packet({
    type: Schema.Literal('capability_set'),
    key: identifier,
    enabled: Schema.Boolean,
    requestId: identifier,
  }),
  packet({
    type: Schema.Literals(['memory_save', 'memory_remove']),
    slot: Schema.Literals(['preferences', 'character']),
    key: identifier,
  }),
  packet({
    type: Schema.Literal('chat_model_set'),
    chat: identifier,
    requestId: identifier,
    data: Schema.Struct({
      model: Schema.NonEmptyString,
      effort: optional(Schema.String),
      inline: optional(Schema.Boolean),
    }),
  }),
  packet({
    type: Schema.Literal('inline_status'),
    data: Schema.Record(Schema.String, Schema.Unknown),
  }),
  packet({
    type: Schema.Literals(['routine_tick', 'routine_event']),
    data: Schema.Struct({
      ready: Schema.Boolean,
      event: optional(Schema.String),
      values: optional(Schema.Unknown),
    }),
  }),
  packet({ type: Schema.Literal('routine_action'), data: Schema.Unknown }),
  packet({ type: Schema.Literal('panel_ask'), key: identifier, nodeId: identifier }),
  packet({
    type: Schema.Literal('ui_action'),
    chat: identifier,
    messageId: identifier,
    nodeId: identifier,
  }),
]);
export type Packet = typeof packetSchema.Type;

const downlinkAckSchema = Schema.Struct({
  a: Schema.Tuple([
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 0xffffffff })),
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffff })),
    nonnegativeInt,
  ]),
  b: Schema.Boolean,
  n: optional(Schema.Boolean),
});
export type DownlinkAck = typeof downlinkAckSchema.Type;
const decodeAck = Schema.decodeUnknownOption(downlinkAckSchema, { onExcessProperty: 'error' });

export function parseDownlinkAck(value: unknown): DownlinkAck | null {
  return Option.getOrNull(decodeAck(value));
}

const decodePacket = Schema.decodeUnknownOption(packetSchema);

export function decodeUplink(message: MailboxMessage) {
  let value: unknown;
  try {
    value = JSON.parse(inflateMessage(message).toString('utf8'));
  } catch {
    // Partial and corrupt messages are retried by the addon.
    return undefined;
  }
  const ack = message.flags === 0 ? parseDownlinkAck(value) : null;
  if (ack) return { kind: 'ack' as const, ack };
  const packet = Option.getOrUndefined(decodePacket(value));
  if (packet) return { kind: 'packet' as const, packet };
}
